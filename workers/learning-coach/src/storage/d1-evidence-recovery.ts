import { snapshotGate } from "./snapshot-gate";
import { authenticate } from "../auth";
import { isLoopback, type Env } from "../config/index";
import { isCapacityModel, safeInteger, type CapacityProvider } from "../config/provider-policy";
import { HttpError } from "../errors/index";
import type { D1Binding, D1Statement } from "./d1-quota-admission";
import { canonicalJson, hashPattern, requestIdPattern, sha256 } from "./request-identity";
import { classifyRecovery, readRecoverySnapshot, recoverySnapshotQueries } from "./recovery-inspection";

export interface EvidenceRecoveryEnv extends Env { COACH_EVIDENCE_RECOVERY_SECRET?: string }
export interface EvidenceScope { quotaScopeId: string; provider: CapacityProvider; model: string }
export interface EvidenceResolution {
  operationId: string; reservationId: string; attemptId: string; expectedGeneration: number;
  method: "not_dispatched" | "accounted_with_hold";
}
type Denial = { state: "invalid_request" | "conflict" | "not_eligible" | "storage_unavailable" };
type Decision = Denial | { state: "resolved" | "already_resolved" };
type Row = Record<string, string | number | null>;
const invalid = (): Denial => ({ state: "invalid_request" });
const unavailable = (): Denial => ({ state: "storage_unavailable" });
const assertion = "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('evidence_resolution_conflict') END AS checked";
const RECOVERY_AUTHORITY = Symbol("provider evidence recovery");

export class D1EvidenceRecovery {
  readonly #db: D1Binding | undefined;
  readonly #scope: EvidenceScope;
  readonly #serviceId: string;
  private constructor(db: D1Binding | undefined, scope: EvidenceScope, serviceId: string, authority: symbol) {
    if (authority !== RECOVERY_AUTHORITY) throw new HttpError(403, "invalid_request", "Recovery authentication is required.");
    this.#db = db; this.#scope = structuredClone(scope); this.#serviceId = serviceId;
  }

  // Dedicated recovery credential, distinct from the generation-service secret.
  // This factory is only called by trusted internal composition; there is no route.
  static async authenticate(request: Request, env: EvidenceRecoveryEnv, scope: EvidenceScope): Promise<D1EvidenceRecovery> {
    if (!env.COACH_EVIDENCE_RECOVERY_SECRET || env.COACH_EVIDENCE_RECOVERY_SECRET === env.COACH_SERVICE_SECRET)
      throw new HttpError(503, "invalid_response", "Evidence recovery is unavailable.");
    const principal = await authenticate(request, { COACH_SERVICE_SECRET: env.COACH_EVIDENCE_RECOVERY_SECRET });
    const url = new URL(request.url);
    if (request.headers.has("Origin") || request.headers.has("Sec-Fetch-Site")) throw new HttpError(403, "invalid_request", "Recovery authentication is required.");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) throw new HttpError(400, "invalid_request", "HTTPS is required.");
    if (!scope || typeof scope.quotaScopeId !== "string" || !/^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,199}$/.test(scope.quotaScopeId) ||
        !isCapacityModel(scope.provider, scope.model))
      throw new HttpError(503, "invalid_response", "Recovery scope is unavailable.");
    return new D1EvidenceRecovery(env.COACH_DB, scope, principal.serviceId, RECOVERY_AUTHORITY);
  }

  async inspect(limit: number, after?: { createdAt: number; attemptId: string }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || (after && (!safeInteger(after.createdAt) || !requestIdPattern.test(after.attemptId)))) return invalid();
    const db = this.#db, p = this.#scope;
    if (!db) return unavailable();
    try {
      const result = await db.prepare(`SELECT a.id, a.reservation_id, a.created_at FROM inference_attempts a
        JOIN request_reservations r ON r.id = a.reservation_id
        WHERE a.provider_evidence_state = 'pending' AND r.service_id = ? AND r.quota_scope_id = ? AND r.provider = ? AND r.model = ?
          AND (? IS NULL OR (a.created_at, a.id) > (?, ?)) ORDER BY a.created_at, a.id LIMIT ?`)
        .bind(this.#serviceId, p.quotaScopeId, p.provider, p.model, after?.createdAt ?? null, after?.createdAt ?? null, after?.attemptId ?? null, limit + 1)
        .all<{ id: string; reservation_id: string; created_at: number }>();
      if (!result.success) return unavailable();
      const page = result.results.slice(0, limit), items = [];
      // Sequential bounded inspection also bounds concurrent D1 connections.
      for (const row of page) {
        const snapshot = await readRecoverySnapshot(db, this.#serviceId, row.reservation_id);
        const item = await classifyRecovery(snapshot);
        items.push({ attemptId: row.id, reservationId: row.reservation_id, createdAt: row.created_at,
          generation: item?.generation ?? null, classification: item?.classification ?? "inconsistent_record",
          ownerActive: item?.ownerActive ?? false, manualReview: true });
      }
      const last = page.at(-1);
      return { state: "page" as const, items, nextCursor: result.results.length > limit && last ? { createdAt: last.created_at, attemptId: last.id } : null };
    } catch { return unavailable(); }
  }

  async resolve(input: EvidenceResolution): Promise<Decision> {
    if (!input || Object.keys(input).some(k => !["operationId", "reservationId", "attemptId", "expectedGeneration", "method"].includes(k)) ||
        ![input.operationId, input.reservationId, input.attemptId].every(v => typeof v === "string" && requestIdPattern.test(v)) ||
        !safeInteger(input.expectedGeneration) || input.expectedGeneration < 1 || input.expectedGeneration >= Number.MAX_SAFE_INTEGER ||
        !["not_dispatched", "accounted_with_hold"].includes(input.method)) return invalid();
    const db = this.#db, p = this.#scope;
    if (!db) return unavailable();
    try {
      const requestHash = await sha256(canonicalJson([this.#serviceId, p, input]));
      const prior = await db.prepare(`SELECT e.request_hash, e.proof_hash, a.provider_evidence_state, a.provider_evidence_receipt
        FROM provider_evidence_resolutions e JOIN inference_attempts a ON a.id = e.attempt_id WHERE e.operation_id = ? AND e.service_id = ?`)
        .bind(input.operationId, this.#serviceId).all<Row>();
      if (!prior.success) return unavailable();
      if (prior.results[0]) {
        const e = prior.results[0];
        return { state: e.request_hash === requestHash && e.provider_evidence_state === "acknowledged" && e.provider_evidence_receipt === e.proof_hash
          ? "already_resolved" : "conflict" };
      }
      const snapshot = await readRecoverySnapshot(db, this.#serviceId, input.reservationId), { r, a, u, links } = snapshot;
      const item = await classifyRecovery(snapshot);
      if (!r || !a || a.id !== input.attemptId || r.quota_scope_id !== p.quotaScopeId || r.provider !== p.provider || r.model !== p.model ||
          r.claim_generation !== input.expectedGeneration || a.provider_evidence_state !== "pending" || a.provider_evidence_receipt !== null ||
          !hashPattern.test(a.provider_evidence_policy_hash ?? "")) return { state: "conflict" };
      if (!item || item.classification === "inconsistent_record" || r.claim_lease === null || r.claim_lease > r.now ||
          (r.recovery_operation_id !== null && (item.classification !== "already_recovered" || r.recovery_lease_expires_at === null || r.recovery_lease_expires_at > r.now)))
        return { state: "not_eligible" };
      let hold: Row | undefined;
      const holdQuery = { sql: `SELECT h.*, o.operation_hash, o.recorded_at AS operation_recorded_at, o.revision AS operation_revision
        FROM provider_hold_operations o JOIN provider_holds h ON h.quota_scope_id = o.quota_scope_id AND h.provider = o.provider
          AND h.model = o.model AND h.hold_key = o.hold_key
        WHERE o.operation_id = ?1 AND o.action = 'record' AND h.quota_scope_id = ?2 AND h.provider = ?3 AND h.model = ?4`,
        values: [a.id, p.quotaScopeId, p.provider, p.provider === "cloudflare_workers_ai" ? "" : p.model] };
      if (input.method === "not_dispatched") {
        const prepared = item.classification === "dispatch_uncertain" && r.status === "reserved" && r.claim_state === "reserved" &&
          a.status === "prepared" && a.finished_at === null && a.failure_receipt_hash === null;
        const accountedNotSent = ["settled_failure", "already_recovered"].includes(item.classification) && r.status === "not_sent" &&
          a.status === "not_sent" && a.failure_receipt_hash !== null;
        if ((!prepared && !accountedNotSent) || a.sent_at !== null || u || r.expires_at > r.now) return { state: "not_eligible" };
      } else {
        // A valid failure receipt may retain unknown dimensions. Never refund them.
        if (!(item.classification === "settled_successfully" || (a.failure_receipt_hash !== null &&
            ["settled_failure", "outcome_unknown"].includes(item.classification)))) return { state: "not_eligible" };
        const found = await db.prepare(holdQuery.sql).bind(...holdQuery.values).all<Row>();
        if (!found.success) return unavailable();
        hold = found.results[0];
        if (!hold || hold.status !== "active" || hold.hold_until !== null || hold.quota_metric !== null || hold.model !== holdQuery.values[3] ||
            hold.source_class !== "operational" || hold.confidence !== 3 || hold.plan !== "free" ||
            !["temporary_provider_unavailable", "model_unavailable"].includes(String(hold.reason_code)) ||
            hold.revision !== hold.operation_revision || hold.updated_at !== hold.operation_recorded_at ||
            !safeInteger(hold.evidence_at) || hold.evidence_at < a.created_at || hold.evidence_at > r.now) return { state: "not_eligible" };
        const observation = { quotaScopeId: p.quotaScopeId, provider: p.provider, model: hold.model, policyVersion: hold.policy_version,
          observedAt: hold.evidence_at, source: "operational", reason: hold.reason_code, until: null };
        if (await sha256(canonicalJson(observation)) !== hold.evidence_hash ||
            await sha256(canonicalJson(["record", { ...observation, operationId: a.id }])) !== hold.operation_hash ||
            `ph1.${await sha256(canonicalJson([p.quotaScopeId, p.provider, hold.model, null, hold.reason_code]))}` !== hold.hold_key)
          return { state: "not_eligible" };
      }
      const proofHash = await sha256(canonicalJson([r, a, u ?? null, links, hold ?? null, input.method]));
      const rows = [r ? [r] : [], a ? [a] : [], u ? [u] : [], links];
      const statements = recoverySnapshotQueries(this.#serviceId, input.reservationId).map((q, i) => snapshotGate(db, q, rows[i]!));
      if (hold) statements.push(snapshotGate(db, holdQuery, [hold]));
      const expected: ("check" | "write")[] = statements.map(() => "check");
      const write = (s: D1Statement) => { statements.push(s, db.prepare(assertion)); expected.push("write", "check"); };
      // Terminal receipt hashes bind the original generation; preserve them.
      const increment = input.method === "not_dispatched" && a.status === "prepared" ? 1 : 0;
      write(db.prepare(`UPDATE idempotency_records SET generation = generation + ?1 WHERE id = ?2 AND service_id = ?3
        AND generation = ?4 AND generation < 9007199254740991 AND lease_expires_at <= unixepoch()
        AND (?5 = 0 OR EXISTS (SELECT 1 FROM request_reservations WHERE id = ?6 AND expires_at <= unixepoch()))`)
        .bind(increment, r.claim_id!, this.#serviceId, input.expectedGeneration, input.method === "not_dispatched" ? 1 : 0, r.id));
      write(db.prepare(`INSERT INTO provider_evidence_resolutions (operation_id, attempt_id, service_id, request_hash, proof_hash,
        method, expected_generation, resulting_generation, hold_operation_id, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`)
        .bind(input.operationId, a.id, this.#serviceId, requestHash, proofHash, input.method, input.expectedGeneration,
          input.expectedGeneration + increment, hold ? a.id : null));
      write(db.prepare(`UPDATE inference_attempts SET provider_evidence_state = 'acknowledged', provider_evidence_receipt = ?
        WHERE id = ? AND reservation_id = ? AND provider_evidence_state = 'pending' AND provider_evidence_receipt IS NULL`)
        .bind(proofHash, a.id, r.id));
      const result = await db.batch<{ checked: number }>(statements);
      if (result.length !== statements.length || result.some((s, i) => !s.success ||
          (expected[i] === "write" ? s.meta.changes !== 1 : s.meta.changes !== 0 || s.results[0]?.checked !== 1))) return unavailable();
      return { state: "resolved" };
    } catch (error) {
      return error instanceof Error && /evidence_resolution_conflict|malformed JSON|UNIQUE constraint/.test(error.message)
        ? { state: "conflict" } : unavailable();
    }
  }
}
