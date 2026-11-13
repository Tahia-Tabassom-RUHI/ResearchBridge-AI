import type { FailureReport, QuotaMetric, RecoveryClassification, RecoveryInspection, SettlementUsage } from "../storage";
import type { D1Binding } from "./d1-quota-admission";
import { failureAllocation, normalizeFailure } from "./failure-usage";
import { failureReceipt, successReceipt } from "./accounting-receipts";
import { canonicalJson, hashPattern, requestIdPattern, validIdentity } from "./request-identity";
import { consumption, normalizeSettlementUsage, safeAmount, usageIdentifier } from "./settlement-usage";

export interface RecoveryReservation {
  id: string; service_id: string; request_id: string; quota_scope_id: string; provider: string; model: string; status: string;
  created_at: number; updated_at: number; expires_at: number; retain_until: number; now: number;
  reconciliation_state: string; reconciliation_requested_at: number | null; reconciliation_completed_at: number | null;
  claim_id: string | null; claim_service: string | null; claim_generation: number | null; claim_lease: number | null;
  claim_state: string | null; claim_status: string | null; claim_expires: number | null; claim_updated: number | null;
  key_hash: string | null; payload_hash: string | null; fingerprint_key_id: string | null; owner_token_hash: string | null; response_version: string;
  recovery_operation_id: string | null; recovery_token_hash: string | null; recovery_generation: number | null;
  recovery_started_at: number | null; recovery_lease_expires_at: number | null; recovery_receipt_hash: string | null; recovery_completed_at: number | null;
}
export interface RecoveryAttempt {
  provider_evidence_state: string; provider_evidence_policy_hash: string | null; provider_evidence_receipt: string | null;
  id: string; reservation_id: string; status: string; created_at: number; updated_at: number; sent_at: number | null; finished_at: number | null;
  failure_category: FailureReport["category"] | null; failure_reason: FailureReport["reason"] | null; failure_http_status: number | null;
  failure_usage: string | null; failure_receipt_hash: string | null; failure_generation: number | null;
  failure_accounting_state: string | null; failure_recorded_at: number | null;
}
export interface RecoveryLink {
  quota_window_id: string; quota_metric: QuotaMetric | null; reserved_amount: number; settled_amount: number | null; status: string;
  failure_basis: string | null; failure_held_amount: number | null; quota_scope_id: string; provider: string; model: string; dimension: string; unit: string;
  window_reserved: number; window_consumed: number; window_updated: number;
}
interface RecoveryUsage {
  id: string; attempt_id: string; kind: string; status: string; request_count: number; input_tokens: number | null; output_tokens: number | null;
  total_tokens: number | null; compute_units: number | null; compute_unit: string | null; compute_usage: string | null; estimate_policy: string | null;
  settlement_hash: string | null; settlement_generation: number | null;
}
export interface RecoverySnapshot { r: RecoveryReservation | undefined; a: RecoveryAttempt | undefined; u: RecoveryUsage | undefined; links: RecoveryLink[] }
export function recoverySnapshotQueries(serviceId: string, reservationId: string) {
  return [
    `SELECT r.*, unixepoch() AS now, i.id AS claim_id, i.service_id AS claim_service, i.generation AS claim_generation,
      i.lease_expires_at AS claim_lease, i.processing_state AS claim_state, i.status AS claim_status, i.expires_at AS claim_expires,
      i.updated_at AS claim_updated, i.key_hash, i.payload_hash, i.fingerprint_key_id, i.owner_token_hash, i.response_version
      FROM request_reservations r LEFT JOIN idempotency_records i ON i.reservation_id = r.id WHERE r.service_id = ?1 AND r.id = ?2`,
    `SELECT a.* FROM inference_attempts a JOIN request_reservations r ON r.id = a.reservation_id WHERE r.service_id = ?1 AND r.id = ?2`,
    `SELECT u.* FROM usage_accounting u JOIN inference_attempts a ON a.id = u.attempt_id
      JOIN request_reservations r ON r.id = a.reservation_id WHERE r.service_id = ?1 AND r.id = ?2`,
    `SELECT l.quota_window_id, l.quota_metric, l.reserved_amount, l.settled_amount, l.status, l.failure_basis, l.failure_held_amount,
      w.quota_scope_id, w.provider, w.model, w.dimension, w.unit, w.reserved_amount AS window_reserved,
      w.consumed_amount AS window_consumed, w.updated_at AS window_updated FROM reservation_quota_windows l
      JOIN request_reservations r ON r.id = l.reservation_id LEFT JOIN provider_quota_windows w ON w.id = l.quota_window_id
      WHERE r.service_id = ?1 AND r.id = ?2 ORDER BY l.quota_window_id LIMIT 33`,
  ].map(sql => ({ sql, values: [serviceId, reservationId] }));
}
export async function readRecoverySnapshot(db: D1Binding, serviceId: string, reservationId: string): Promise<RecoverySnapshot> {
  const results = await db.batch<unknown>(recoverySnapshotQueries(serviceId, reservationId).map(q => db.prepare(q.sql).bind(...q.values)));
  if (results.length !== 4 || results.some(x => !x.success)) throw new Error("Recovery inspection unavailable");
  return { r: results[0]!.results[0] as RecoveryReservation | undefined, a: results[1]!.results[0] as RecoveryAttempt | undefined,
    u: results[2]!.results[0] as RecoveryUsage | undefined, links: results[3]!.results as RecoveryLink[] };
}
export function originalRecoveryLinks(links: RecoveryLink[]) {
  return links.map(l => ({ id: l.quota_window_id, metric: l.quota_metric, reserved: l.reserved_amount,
    scope: l.quota_scope_id, provider: l.provider, model: l.model, dimension: l.dimension, unit: l.unit }));
}
const failureFields = ["failure_category", "failure_reason", "failure_http_status", "failure_usage", "failure_receipt_hash",
  "failure_generation", "failure_accounting_state", "failure_recorded_at"] as const;
const recoveryFields = ["recovery_operation_id", "recovery_token_hash", "recovery_generation", "recovery_started_at",
  "recovery_lease_expires_at", "recovery_receipt_hash", "recovery_completed_at"] as const;

export async function classifyRecovery({ r, a, u, links }: RecoverySnapshot): Promise<RecoveryInspection | undefined> {
  if (!r) return;
  const ownerActive = safeAmount(r.claim_lease) && r.claim_lease > r.now && safeAmount(r.claim_expires) && r.claim_expires > r.now;
  const item = (classification: RecoveryClassification, manualReview = true, recoverable = false): RecoveryInspection => ({
    reservationId: r.id, requestId: r.claim_id, attemptId: a?.id ?? null, generation: r.claim_generation,
    classification, ownerActive, recoverable, manualReview, operationId: r.recovery_operation_id });
  const bad = () => item("inconsistent_record");
  try {
    if (!r.claim_id || r.claim_id !== r.request_id || r.claim_service !== r.service_id || !requestIdPattern.test(r.claim_id) ||
        !safeAmount(r.claim_generation) || r.claim_generation < 1 || !safeAmount(r.claim_lease) || !safeAmount(r.claim_expires) ||
        !safeAmount(r.claim_updated) || r.claim_updated > r.now || !hashPattern.test(r.owner_token_hash ?? "") ||
        !validIdentity({ serviceId: r.service_id, keyHash: r.key_hash ?? "", payloadHash: r.payload_hash ?? "",
          fingerprintKeyId: r.fingerprint_key_id ?? "", responseVersion: r.response_version as "1" | "2" }) ||
        ![r.created_at, r.updated_at, r.expires_at, r.retain_until, r.now].every(safeAmount) || r.updated_at > r.now ||
        links.length === 0 || links.length > 32) return bad();
    for (const l of links) {
      const metric = l.quota_metric;
      if (!metric || !["requests", "tokens", "input_tokens", "output_tokens", "compute_units"].includes(metric) ||
          l.quota_scope_id !== r.quota_scope_id || l.provider !== r.provider || !["", r.model].includes(l.model) ||
          !usageIdentifier(l.unit) || l.dimension !== (["requests", "compute_units"].includes(metric) ? metric : "tokens") ||
          (metric === "requests" && l.unit !== "requests") || (["tokens", "input_tokens", "output_tokens"].includes(metric) && l.unit !== "tokens") ||
          ![l.reserved_amount, l.window_reserved, l.window_consumed, l.window_updated].every(safeAmount) ||
          l.reserved_amount === 0 || l.window_updated > r.now) return bad();
      const held = l.status === "reserved" ? l.reserved_amount : l.status === "unknown" ? l.failure_held_amount : 0;
      if (!safeAmount(held) || l.window_reserved < held || (l.settled_amount !== null &&
          (!safeAmount(l.settled_amount) || l.window_consumed < l.settled_amount))) return bad();
    }
    const pendingLinks = links.every(l => l.status === "reserved" && l.settled_amount === null && l.failure_basis === null && l.failure_held_amount === null);
    const hasRecovery = recoveryFields.some(k => r[k] !== null);
    if (hasRecovery && (!requestIdPattern.test(r.recovery_operation_id ?? "") || !hashPattern.test(r.recovery_token_hash ?? "") ||
        r.recovery_generation !== r.claim_generation || !safeAmount(r.recovery_started_at) || !safeAmount(r.recovery_lease_expires_at) ||
        r.recovery_started_at > r.now || r.recovery_lease_expires_at < r.recovery_started_at || r.status !== "not_sent" ||
        a?.status !== "not_sent" || a.sent_at !== null || r.claim_state !== "failed" || r.claim_status !== "pending")) return bad();
    if (!a) return !u && !hasRecovery && pendingLinks && r.status === "reserved" && r.claim_state === "reserved" && r.claim_status === "pending"
      ? item("dispatch_uncertain") : bad();
    if (!requestIdPattern.test(a.id) || ![a.created_at, a.updated_at].every(safeAmount) || a.updated_at > r.now || a.reservation_id !== r.id) return bad();
    const finished = a.finished_at !== null && safeAmount(a.finished_at) && a.finished_at >= a.created_at && a.finished_at <= a.updated_at;
    const sent = a.sent_at !== null && safeAmount(a.sent_at) && a.sent_at >= a.created_at && a.sent_at <= a.updated_at;
    const notSent = r.claim_state === "failed" && r.claim_status === "pending" && r.status === "not_sent" && a.status === "not_sent" && a.sent_at === null && finished;
    const unknown = r.claim_state === "outcome_unknown" && r.claim_status === "unknown" && r.status === "unknown" && a.status === "unknown" && sent && finished;
    const completed = r.claim_state === "completed" && r.claim_status === "completed" && r.status === "completed" && a.status === "completed" && sent && finished;
    const awaiting = r.reconciliation_state === "awaiting" && safeAmount(r.reconciliation_requested_at);
    const context = { claimId: r.claim_id, generation: r.claim_generation, reservationId: r.id, attemptId: a.id, provider: r.provider, model: r.model };
    const window = (l: RecoveryLink) => ({ window: l.quota_window_id, metric: l.quota_metric, unit: l.unit, reserved: l.reserved_amount });
    const hasFailure = failureFields.some(k => a[k] !== null);
    if (u) {
      if (!completed || !awaiting || hasFailure || hasRecovery || !safeAmount(r.reconciliation_completed_at) ||
          u.status !== "reconciled" || u.settlement_generation !== r.claim_generation || !u.compute_usage) return bad();
      const usage = normalizeSettlementUsage({ kind: u.kind, requests: u.request_count,
        ...(u.input_tokens === null ? {} : { inputTokens: u.input_tokens }), ...(u.output_tokens === null ? {} : { outputTokens: u.output_tokens }),
        ...(u.total_tokens === null ? {} : { totalTokens: u.total_tokens }), computeUnits: JSON.parse(u.compute_usage),
        ...(u.estimate_policy === null ? {} : { estimatePolicy: u.estimate_policy }) } as SettlementUsage);
      if (!usage) return bad();
      const units = Object.entries(usage.computeUnits);
      if (u.compute_units !== (units.length === 1 ? units[0]![1] : null) || u.compute_unit !== (units.length === 1 ? units[0]![0] : null)) return bad();
      const allocations = [];
      for (const l of links) {
        const amount = consumption(usage, l.quota_metric!, l.unit);
        if (!safeAmount(amount) || l.status !== "settled" || l.settled_amount !== amount || l.failure_basis !== null || l.failure_held_amount !== null ||
            (usage.kind === "estimated" && amount < l.reserved_amount)) return bad();
        allocations.push({ ...window(l), consumed: amount });
      }
      return await successReceipt(context, usage, allocations) === u.settlement_hash ? item("settled_successfully", false) : bad();
    }
    if (hasFailure) {
      if (!(notSent || unknown) || !awaiting || r.reconciliation_completed_at !== null || a.failure_generation !== r.claim_generation ||
          !safeAmount(a.failure_recorded_at) || !a.failure_usage || !hashPattern.test(a.failure_receipt_hash ?? "")) return bad();
      const persisted = JSON.parse(a.failure_usage);
      const report = { category: a.failure_category, reason: a.failure_reason,
        ...(a.failure_http_status === null ? {} : { httpStatus: a.failure_http_status }),
        ...(notSent ? {} : { usage: Object.fromEntries(Object.entries(persisted).filter(([, v]) => v !== null)) }) } as FailureReport;
      const failure = normalizeFailure(report);
      if (typeof failure === "string" || canonicalJson(failure.usage) !== a.failure_usage ||
          (notSent !== (failure.category === "PROVEN_PRE_DISPATCH_FAILURE"))) return bad();
      const allocations = [];
      for (const l of links) {
        const allocation = failureAllocation(failure, l.quota_metric!, l.unit, l.reserved_amount);
        if (!allocation || l.status !== allocation.status || l.settled_amount !== allocation.consumed ||
            l.failure_basis !== allocation.basis || l.failure_held_amount !== allocation.held) return bad();
        allocations.push({ ...window(l), ...allocation });
      }
      const known = allocations.filter(l => l.consumed !== null).length;
      const accounting = notSent ? "released" : known === 0 ? "held" : known === links.length ? "accounted" : "partial";
      if (accounting !== a.failure_accounting_state || await failureReceipt(context, failure, allocations) !== a.failure_receipt_hash) return bad();
      if (hasRecovery) return notSent && safeAmount(r.recovery_completed_at) && r.recovery_receipt_hash === a.failure_receipt_hash
        ? item("already_recovered", false) : bad();
      return item(accounting === "held" || accounting === "partial" ? "outcome_unknown" : "settled_failure", unknown);
    }
    if (!pendingLinks || r.reconciliation_completed_at !== null) return bad();
    if (hasRecovery && (r.recovery_completed_at !== null || r.recovery_receipt_hash !== null)) return bad();
    if (notSent) {
      if (hasRecovery && r.recovery_lease_expires_at! > r.now) return item("recovery_in_progress", false);
      const eligible = r.expires_at <= r.now && r.claim_lease <= r.now && r.claim_generation < Number.MAX_SAFE_INTEGER;
      return item("provably_not_dispatched", !eligible, eligible);
    }
    if (hasRecovery) return bad();
    if (completed || unknown) return item("outcome_unknown");
    if (r.status === "sent" && r.claim_state === "dispatched" && r.claim_status === "pending" && a.status === "sent" && sent && a.finished_at === null)
      return item("dispatched");
    if (r.status === "reserved" && r.claim_state === "reserved" && r.claim_status === "pending" && a.status === "prepared" && a.sent_at === null && a.finished_at === null)
      return item("dispatch_uncertain");
    return bad();
  } catch { return bad(); }
}
