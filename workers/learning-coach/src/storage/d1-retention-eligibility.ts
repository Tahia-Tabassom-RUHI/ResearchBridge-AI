import type { ServicePrincipal } from "../auth";
import { safeInteger } from "../config/provider-policy";
import type { D1Binding } from "./d1-quota-admission";
import { classifyRecovery, readRecoverySnapshot } from "./recovery-inspection";
import { hashPattern, requestIdPattern, validIdentity } from "./request-identity";

export interface RetentionPolicy {
  decisionReference: string;
  auditSeconds: number;
  providerCorrectionSeconds: number;
  receiptSeconds: number;
}
export function validRetentionPolicy(p: RetentionPolicy | undefined): p is RetentionPolicy {
  return !!p && typeof p.decisionReference === "string" && !!p.decisionReference.trim() && p.decisionReference.length <= 1000 &&
    Object.keys(p).every(k => ["decisionReference", "auditSeconds", "providerCorrectionSeconds", "receiptSeconds"].includes(k)) &&
    [p.auditSeconds, p.providerCorrectionSeconds, p.receiptSeconds].every(safeInteger);
}
export const RETAINED_AUTHORITIES = Object.freeze([
  "request_replay_barriers", "provider_policy_revocations", "provider_capacity_policies",
  "provider_evidence_resolutions", "provider_hold_operations", "provider_holds", "provider_quota_windows",
]);
type Decision = { state: "storage_unavailable" | "invalid_request" | "configuration_missing" | "not_found" } |
  { state: "eligible" | "retain"; reasons: string[]; evaluatedAt: number; eligibleAfter: number | null; generation: number };
type Claim = { id: string; key_hash: string; service_id: string; reservation_id: string | null; processing_state: string;
  status: string; payload_hash: string; fingerprint_key_id: string; owner_token_hash: string; response_version: "1" | "2";
  created_at: number; updated_at: number; expires_at: number; lease_expires_at: number; retain_until: number; generation: number; now: number };

// Read-only assessment of one request-history graph, never a deletion permit.
// Trusted composition supplies the authenticated principal and reviewed policy.
export class D1RetentionEligibility {
  private readonly policy: RetentionPolicy | undefined;
  private readonly serviceId: string;
  constructor(private readonly db: D1Binding | undefined, principal: ServicePrincipal, policy?: RetentionPolicy) {
    this.serviceId = principal.serviceId; this.policy = policy ? structuredClone(policy) : undefined;
  }

  async inspect(claimId: string): Promise<Decision> {
    if (!requestIdPattern.test(claimId)) return { state: "invalid_request" };
    const p = this.policy, db = this.db;
    if (!validRetentionPolicy(p)) return { state: "configuration_missing" };
    if (!db) return { state: "storage_unavailable" };
    try {
      const read = await db.prepare("SELECT *, unixepoch() AS now FROM idempotency_records WHERE id = ? AND service_id = ?")
        .bind(claimId, this.serviceId).all<Claim>();
      if (!read.success) return { state: "storage_unavailable" };
      const i = read.results[0]; if (!i) return { state: "not_found" };
      const reasons: string[] = [];
      if (!validIdentity({ serviceId: i.service_id, keyHash: i.key_hash, payloadHash: i.payload_hash,
        fingerprintKeyId: i.fingerprint_key_id, responseVersion: i.response_version }) ||
          !hashPattern.test(i.owner_token_hash ?? "") || !safeInteger(i.generation) || i.generation < 1) reasons.push("invalid_ownership");
      const times = [i.retain_until, i.expires_at, i.lease_expires_at];
      let latest = i.updated_at;
      const barrier = await db.prepare("SELECT * FROM request_replay_barriers WHERE service_id = ? AND key_hash = ?")
        .bind(this.serviceId, i.key_hash).all<{ claim_id: string; first_seen_at: number; expires_at: number; legacy: number }>();
      if (!barrier.success) return { state: "storage_unavailable" };
      const b = barrier.results[0];
      if (!b || b.claim_id !== i.id || b.first_seen_at !== i.created_at || b.expires_at !== i.expires_at) reasons.push("replay_barrier_missing_or_mismatched");
      if (b?.legacy !== 0) reasons.push("legacy_history");
      if (i.lease_expires_at > i.now || i.expires_at > i.now) reasons.push("request_still_live");
      if (i.reservation_id === null) {
        if (i.processing_state !== "failed" || i.status !== "pending") reasons.push("unresolved_request");
        const dangling = await db.prepare("SELECT id FROM request_reservations WHERE service_id = ? AND request_id = ? LIMIT 1")
          .bind(this.serviceId, i.id).all();
        if (!dangling.success) return { state: "storage_unavailable" };
        if (dangling.results.length) reasons.push("inconsistent_history");
      } else {
        const s = await readRecoverySnapshot(db, this.serviceId, i.reservation_id), item = await classifyRecovery(s);
        const { r, a, u } = s;
        if (!r || !a || r.claim_generation !== i.generation || r.claim_id !== i.id) reasons.push("inconsistent_history");
        if (!item || !["settled_successfully", "settled_failure", "already_recovered"].includes(item.classification)) reasons.push("unresolved_accounting");
        if (a?.status !== "not_sent" && !(item?.classification === "settled_successfully" && u?.kind === "measured")) reasons.push("provider_outcome_not_final");
        if (a?.provider_evidence_state === "pending") reasons.push("pending_provider_evidence");
        if (a?.provider_evidence_state === "acknowledged" && !hashPattern.test(a.provider_evidence_receipt ?? "")) reasons.push("invalid_evidence_receipt");
        if (r?.recovery_operation_id) reasons.push("required_recovery_receipt");
        const dependencies = await db.batch([
          db.prepare(`SELECT l.created_at, l.updated_at, w.window_end, w.retain_until, w.reserved_amount
            FROM reservation_quota_windows l JOIN provider_quota_windows w ON w.id = l.quota_window_id
            WHERE l.reservation_id = ? LIMIT 33`).bind(i.reservation_id),
          db.prepare("SELECT retain_until, updated_at FROM inference_attempts WHERE reservation_id = ?").bind(i.reservation_id),
          db.prepare("SELECT retain_until, updated_at FROM usage_accounting WHERE attempt_id = ?").bind(a?.id ?? ""),
          db.prepare("SELECT operation_id FROM provider_evidence_resolutions WHERE attempt_id = ? LIMIT 1").bind(a?.id ?? ""),
          db.prepare("SELECT operation_id FROM provider_hold_operations WHERE operation_id = ? LIMIT 1").bind(a?.id ?? ""),
          db.prepare(`SELECT hold_key FROM provider_holds WHERE quota_scope_id = ? AND provider = ? AND model IN ('', ?)
            AND status = 'active' LIMIT 1`).bind(r?.quota_scope_id ?? "", r?.provider ?? "", r?.model ?? ""),
          db.prepare("SELECT id FROM request_reservations WHERE service_id = ? AND request_id = ? AND id != ? LIMIT 1")
            .bind(this.serviceId, i.id, i.reservation_id),
        ]);
        if (dependencies.length !== 7 || dependencies.some(d => !d.success)) return { state: "storage_unavailable" };
        if (dependencies[3]!.results.length || dependencies[4]!.results.length) reasons.push("required_evidence_or_hold_receipt");
        if (dependencies[5]!.results.length) reasons.push("active_provider_hold");
        if (dependencies[6]!.results.length) reasons.push("additional_reservation_dependency");
        if (r) { times.push(r.retain_until, r.expires_at); latest = Math.max(latest, r.updated_at); }
        for (const row of dependencies[0]!.results) {
          if (!safeInteger(row.reserved_amount) || row.reserved_amount !== 0) reasons.push("outstanding_window_capacity");
          if (!safeInteger(row.window_end) || row.window_end > i.now) reasons.push("quota_window_still_live");
          times.push(row.retain_until as number, row.window_end as number);
          latest = Math.max(latest, row.updated_at as number);
        }
        for (const rows of dependencies.slice(1, 3)) for (const row of rows.results) {
          times.push(row.retain_until as number); latest = Math.max(latest, row.updated_at as number);
        }
      }
      const horizon = Math.max(p.auditSeconds, p.providerCorrectionSeconds, p.receiptSeconds);
      times.push(latest + horizon);
      if (![i.now, i.created_at, latest, i.generation, ...times].every(safeInteger) || i.created_at > latest || latest > i.now) reasons.push("invalid_timestamps");
      const deadline = times.every(safeInteger) ? Math.max(...times) : null;
      if (deadline === null || i.now < deadline) reasons.push("retention_horizon_not_elapsed");
      return { state: reasons.length ? "retain" : "eligible", reasons: [...new Set(reasons)], evaluatedAt: i.now,
        eligibleAfter: deadline, generation: i.generation };
    } catch { return { state: "storage_unavailable" }; }
  }
}
