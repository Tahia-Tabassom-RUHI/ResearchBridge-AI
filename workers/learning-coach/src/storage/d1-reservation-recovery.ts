import { authenticate, type ServicePrincipal } from "../auth";
import { isLoopback, type Env } from "../config/index";
import { HttpError } from "../errors/index";
import type { FailureAccountingDecision, RecoveryClaimDecision, RecoveryClaimInput, RecoveryDenial, RecoveryFence,
  RecoveryScan, ReservationRecovery } from "../storage";
import type { D1Binding, D1Statement } from "./d1-quota-admission";
import { D1FailureAccounting } from "./d1-failure-accounting";
import { canonicalJson, requestIdPattern, sha256 } from "./request-identity";
import { safeAmount, usageIdentifier } from "./settlement-usage";
import { classifyRecovery, originalRecoveryLinks, readRecoverySnapshot } from "./recovery-inspection";
import { validRecoveryFence } from "./recovery-authority";

const deny = (state: RecoveryDenial["state"]): RecoveryDenial => ({ state, retryable: false });
export interface RecoveryPolicy { leaseSeconds: number }

// No route or scheduler instantiates this service. Authentication is the only
// supported construction path; principal IDs never come from caller JSON.
export class D1ReservationRecovery implements ReservationRecovery {
  private constructor(private readonly db: D1Binding | undefined, private readonly principal: ServicePrincipal,
    private readonly leaseSeconds: number) {}

  static async authenticate(request: Request, env: Env, policy: RecoveryPolicy): Promise<D1ReservationRecovery> {
    const principal = await authenticate(request, env);
    if (request.headers.has("Origin") || request.headers.has("Sec-Fetch-Site")) throw new HttpError(403, "invalid_request", "Server authentication is required.");
    const url = new URL(request.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) throw new HttpError(400, "invalid_request", "HTTPS is required.");
    if (!Number.isSafeInteger(policy.leaseSeconds) || policy.leaseSeconds < 1 || policy.leaseSeconds > 3600)
      throw new HttpError(503, "invalid_response", "Recovery configuration is unavailable.");
    return new D1ReservationRecovery(env.COACH_DB, principal, policy.leaseSeconds);
  }

  async inspect(reservationId: string) {
    if (!usageIdentifier(reservationId)) return deny("invalid_request");
    if (!this.db) return deny("storage_unavailable");
    try {
      const item = await classifyRecovery(await readRecoverySnapshot(this.db, this.principal.serviceId, reservationId));
      return item ? { state: "inspected" as const, item } : deny("not_found");
    } catch { return deny("storage_unavailable"); }
  }

  async discover(input: RecoveryScan) {
    if (!input || !["reservation_expiry", "owner_lease"].includes(input.basis) || !safeAmount(input.from) || !safeAmount(input.through) ||
        input.from > input.through || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20 ||
        (input.cursor && (!safeAmount(input.cursor.time) || input.cursor.time < input.from || input.cursor.time > input.through || !usageIdentifier(input.cursor.id)))) return deny("invalid_request");
    const db = this.db;
    if (!db) return deny("storage_unavailable");
    try {
      const clock = await db.prepare("SELECT unixepoch() AS now").all<{ now: number }>();
      if (!clock.success || !safeAmount(clock.results[0]?.now)) return deny("storage_unavailable");
      if (input.through > clock.results[0]!.now) return deny("invalid_request");
      const lease = input.basis === "owner_lease";
      // Two indexed streams avoid an OR over lease and reservation expiry. Each
      // keyset cursor is tied to an explicit fixed basis and time interval.
      const source = lease ? `idempotency_records i INDEXED BY idempotency_recovery_scan
        JOIN request_reservations r ON r.id = i.reservation_id AND r.service_id = i.service_id` : "request_reservations r INDEXED BY reservations_recovery_scan";
      const owner = lease ? "i" : "r", expiry = lease ? "i.lease_expires_at" : "r.expires_at";
      const cursor = input.cursor;
      const result = await db.prepare(`SELECT r.id AS reservation_id, ${owner}.id AS id, ${expiry} AS time FROM ${source}
        WHERE ${owner}.service_id = ? AND ${expiry} BETWEEN ? AND min(?, unixepoch())
          ${cursor ? `AND (${expiry}, ${owner}.id) > (?, ?)` : ""}
        ORDER BY ${expiry}, ${owner}.id LIMIT ?`)
        .bind(this.principal.serviceId, input.from, input.through, ...(cursor ? [cursor.time, cursor.id] : []), input.limit + 1)
        .all<{ reservation_id: string; id: string; time: number }>();
      if (!result.success) return deny("storage_unavailable");
      const page = result.results.slice(0, input.limit);
      const items = await Promise.all(page.map(async row => classifyRecovery(await readRecoverySnapshot(db, this.principal.serviceId, row.reservation_id))));
      const last = page.at(-1);
      return { state: "page" as const, items: items.filter(x => x !== undefined),
        nextCursor: result.results.length > input.limit && last ? { time: last.time, id: last.id } : null };
    } catch { return deny("storage_unavailable"); }
  }

  async claim(input: RecoveryClaimInput): Promise<RecoveryClaimDecision> {
    if (!input || ![input.reservationId, input.requestId, input.attemptId, input.operationId].every(v => typeof v === "string" && requestIdPattern.test(v)) ||
        !safeAmount(input.expectedGeneration) || input.expectedGeneration < 1 || input.expectedGeneration >= Number.MAX_SAFE_INTEGER) return deny("invalid_request");
    const db = this.db;
    if (!db) return deny("storage_unavailable");
    try {
      const snapshot = await readRecoverySnapshot(db, this.principal.serviceId, input.reservationId);
      const item = await classifyRecovery(snapshot), r = snapshot.r;
      if (!item || !r) return deny("not_found");
      if (item.requestId !== input.requestId || item.attemptId !== input.attemptId) return deny("stale_owner");
      if (r.recovery_operation_id !== null && r.recovery_operation_id !== input.operationId) return deny("conflict");
      if (item.classification === "already_recovered") return { state: "already_recovered", retryable: false };
      if (item.classification === "recovery_in_progress") return { state: "already_claimed", retryable: false };
      if (item.generation !== input.expectedGeneration) return deny("stale_owner");
      if (!item.recoverable || item.classification !== "provably_not_dispatched") return deny("not_eligible");
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
      const tokenHash = await sha256(token);
      const linksJson = canonicalJson(originalRecoveryLinks(snapshot.links));
      const statements: D1Statement[] = [];
      const write = (statement: D1Statement) => statements.push(statement,
        db.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('recovery_precondition_failed') END AS checked"));
      write(db.prepare(`UPDATE idempotency_records AS i SET generation = generation + 1, updated_at = unixepoch(),
        retain_until = max(retain_until, unixepoch() + ?) WHERE id = ? AND service_id = ? AND reservation_id = ?
          AND generation = ? AND generation < 9007199254740991 AND lease_expires_at <= unixepoch()
          AND processing_state = 'failed' AND status = 'pending' AND updated_at <= unixepoch()
          AND EXISTS (SELECT 1 FROM request_reservations r JOIN inference_attempts a ON a.reservation_id = r.id
            WHERE r.id = i.reservation_id AND r.request_id = i.id AND r.service_id = i.service_id AND r.expires_at <= unixepoch()
              AND r.status = 'not_sent' AND a.id = ? AND a.status = 'not_sent' AND a.sent_at IS NULL AND a.finished_at IS NOT NULL
              AND r.reconciliation_completed_at IS NULL AND r.recovery_completed_at IS NULL AND r.recovery_receipt_hash IS NULL
              AND (r.recovery_operation_id IS NULL OR (r.recovery_operation_id = ? AND r.recovery_lease_expires_at <= unixepoch()))
              AND a.failure_category IS NULL AND a.failure_reason IS NULL AND a.failure_http_status IS NULL AND a.failure_usage IS NULL
              AND a.failure_receipt_hash IS NULL AND a.failure_generation IS NULL AND a.failure_accounting_state IS NULL AND a.failure_recorded_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM usage_accounting WHERE attempt_id = a.id))`)
        .bind(this.leaseSeconds, input.requestId, this.principal.serviceId, input.reservationId, input.expectedGeneration, input.attemptId, input.operationId));
      write(db.prepare(`UPDATE request_reservations AS r SET recovery_operation_id = ?, recovery_token_hash = ?, recovery_generation = ?,
        recovery_started_at = coalesce(recovery_started_at, unixepoch()), recovery_lease_expires_at = unixepoch() + ?,
        reconciliation_state = 'awaiting', reconciliation_requested_at = coalesce(reconciliation_requested_at, unixepoch()),
        updated_at = unixepoch(), retain_until = max(retain_until, unixepoch() + ?)
        WHERE id = ? AND service_id = ? AND request_id = ? AND status = 'not_sent' AND updated_at <= unixepoch()
          AND quota_scope_id = ? AND provider = ? AND model = ?
          AND recovery_operation_id IS ? AND recovery_token_hash IS ? AND recovery_generation IS ?
          AND (SELECT count(*) FROM reservation_quota_windows WHERE reservation_id = r.id) = ?
          AND NOT EXISTS (SELECT 1 FROM reservation_quota_windows l JOIN provider_quota_windows w ON w.id = l.quota_window_id
            LEFT JOIN json_each(?) e ON json_extract(e.value, '$.id') = l.quota_window_id
            WHERE l.reservation_id = r.id AND (e.value IS NULL OR l.status != 'reserved' OR l.settled_amount IS NOT NULL
              OR l.failure_basis IS NOT NULL OR l.failure_held_amount IS NOT NULL OR l.quota_metric IS NOT json_extract(e.value, '$.metric')
              OR l.reserved_amount != json_extract(e.value, '$.reserved') OR w.quota_scope_id != json_extract(e.value, '$.scope')
              OR w.provider != json_extract(e.value, '$.provider') OR w.model != json_extract(e.value, '$.model')
              OR w.dimension != json_extract(e.value, '$.dimension') OR w.unit != json_extract(e.value, '$.unit')
              OR w.reserved_amount < l.reserved_amount OR w.reserved_amount > 9007199254740991
              OR w.reserved_amount != CAST(w.reserved_amount AS INTEGER) OR w.consumed_amount > 9007199254740991
              OR w.consumed_amount != CAST(w.consumed_amount AS INTEGER)))`)
        .bind(input.operationId, tokenHash, input.expectedGeneration + 1, this.leaseSeconds, this.leaseSeconds,
          input.reservationId, this.principal.serviceId, input.requestId, r.quota_scope_id, r.provider, r.model,
          r.recovery_operation_id, r.recovery_token_hash, r.recovery_generation,
          snapshot.links.length, linksJson));
      const results = await db.batch<{ checked: number }>(statements);
      if (results.length !== statements.length || results.some((x, n) => !x.success ||
          (n % 2 === 0 ? x.meta.changes !== 1 : x.meta.changes !== 0 || x.results[0]?.checked !== 1))) return deny("storage_unavailable");
      return { state: "acquired", fence: { serviceId: this.principal.serviceId, claimId: input.requestId, reservationId: input.reservationId,
        attemptId: input.attemptId, operationId: input.operationId, generation: input.expectedGeneration + 1, token } };
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: request_reservations.recovery_operation_id")) return deny("conflict");
      if (error instanceof Error && error.message.includes("malformed JSON")) {
        const inspected = await this.inspect(input.reservationId);
        if (inspected.state === "inspected" && inspected.item.operationId === input.operationId && inspected.item.requestId === input.requestId &&
            inspected.item.attemptId === input.attemptId && ["recovery_in_progress", "already_recovered"].includes(inspected.item.classification))
          return { state: inspected.item.classification === "already_recovered" ? "already_recovered" : "already_claimed", retryable: false };
        return deny("stale_owner");
      }
      // Do not return/recover a capability from a read after an ambiguous claim.
      return deny("storage_unavailable");
    }
  }

  async release(fence: RecoveryFence): Promise<FailureAccountingDecision | RecoveryDenial> {
    if (!validRecoveryFence(fence) || fence.serviceId !== this.principal.serviceId) return deny("stale_owner");
    const db = this.db;
    if (!db) return deny("storage_unavailable");
    try {
      const snapshot = await readRecoverySnapshot(db, this.principal.serviceId, fence.reservationId);
      const r = snapshot.r, item = await classifyRecovery(snapshot);
      if (!r || !item || r.claim_id !== fence.claimId || snapshot.a?.id !== fence.attemptId || r.claim_generation !== fence.generation ||
          r.recovery_generation !== fence.generation || r.recovery_operation_id !== fence.operationId || r.recovery_token_hash !== await sha256(fence.token)) return deny("stale_owner");
      if (item.classification === "already_recovered") return { state: "already_recorded", accounting: "released", retryable: false };
      if (!safeAmount(r.recovery_lease_expires_at) || r.recovery_lease_expires_at <= r.now) return deny("stale_owner");
      if (item.classification !== "recovery_in_progress") return deny("not_eligible");
      const result = await new D1FailureAccounting(db).releaseRecovered(fence, r.provider, r.model);
      if (result.state === "stale_owner") {
        // A competing identical release may have completed. Inspect once; never
        // blindly repeat a write or report success without a verified receipt.
        const current = await readRecoverySnapshot(db, this.principal.serviceId, fence.reservationId);
        if (current.r?.claim_generation === fence.generation && current.r.recovery_token_hash === await sha256(fence.token) &&
            current.r.recovery_operation_id === fence.operationId && (await classifyRecovery(current))?.classification === "already_recovered")
          return { state: "already_recorded", accounting: "released", retryable: false };
      }
      return result;
    } catch { return deny("storage_unavailable"); }
  }
}
