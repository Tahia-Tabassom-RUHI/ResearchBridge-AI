import type { FailureAccounting, FailureAccountingDecision, FailureAccountingInput, FailureAccountingState, IdempotencyFence, QuotaMetric, RecoveryFence } from "../storage";
import type { D1Binding, D1Statement } from "./d1-quota-admission";
import { failureAllocation, normalizeFailure, type FailureAllocation } from "./failure-usage";
import { canonicalJson, sha256, validFence } from "./request-identity";
import { safeAmount, usageIdentifier } from "./settlement-usage";
import { failureReceipt } from "./accounting-receipts";
import { RECOVERY_AUTH, validRecoveryFence } from "./recovery-authority";

const MAX = Number.MAX_SAFE_INTEGER;
type Denial = Exclude<FailureAccountingDecision, { accounting: FailureAccountingState }>;
const deny = (state: Denial["state"]): Denial => ({ state, retryable: false });
type Row = { processing_state: string; request_status: string; reservation_status: string; attempt_status: string;
  sent_at: number | null; finished_at: number | null; reconciliation_state: string; reconciliation_requested_at: number | null;
  reconciliation_completed_at: number | null; quota_scope_id: string; usage_id: string | null;
  failure_receipt_hash: string | null; failure_generation: number | null; failure_recorded_at: number | null;
  failure_accounting_state: FailureAccountingState | null; failure_usage: string | null;
  failure_category: string | null; failure_reason: string | null; failure_http_status: number | null };
type Link = { quota_window_id: string; quota_metric: QuotaMetric | null; reserved_amount: number; status: string;
  settled_amount: number | null; failure_basis: string | null; failure_held_amount: number | null;
  quota_scope_id: string; provider: string; model: string; dimension: string; unit: string };
const FROM = `FROM idempotency_records i JOIN request_reservations r ON r.id = i.reservation_id
  JOIN inference_attempts a ON a.reservation_id = r.id`;
const AUTH = `i.id = ? AND i.service_id = ? AND i.key_hash = ? AND i.payload_hash = ? AND i.fingerprint_key_id = ?
  AND i.response_version = ? AND i.owner_token_hash = ? AND i.generation = ?
  AND i.expires_at > unixepoch() AND i.lease_expires_at > unixepoch()
  AND i.updated_at <= unixepoch() AND r.updated_at <= unixepoch() AND a.updated_at <= unixepoch()
  AND r.service_id = i.service_id AND r.request_id = i.id AND r.id = ? AND a.id = ? AND r.provider = ? AND r.model = ?`;

export class D1FailureAccounting implements FailureAccounting {
  constructor(private readonly db: D1Binding | undefined) {}
  record(input: FailureAccountingInput) { return this.execute(input, false, { kind: "owner", fence: input?.fence }); }
  inspect(input: FailureAccountingInput) { return this.execute(input, true, { kind: "owner", fence: input?.fence }); }
  // Internal capability entry used by authenticated recovery. Reuses the exact
  // failure release transaction; it never reopens a normal dispatch-owner lease.
  releaseRecovered(fence: RecoveryFence, provider: string, model: string) {
    return this.execute({ reservationId: fence.reservationId, attemptId: fence.attemptId, provider, model,
      failure: { category: "PROVEN_PRE_DISPATCH_FAILURE", reason: "dispatch_cancelled" } }, false, { kind: "recovery", fence });
  }

  private async execute(input: Omit<FailureAccountingInput, "fence">, readOnly: boolean,
    authority: { kind: "owner"; fence: IdempotencyFence } | { kind: "recovery"; fence: RecoveryFence }): Promise<FailureAccountingDecision> {
    if (!authority.fence || !(authority.kind === "owner" ? validFence(authority.fence) : validRecoveryFence(authority.fence)) ||
        ![input.reservationId, input.attemptId, input.provider, input.model].every(usageIdentifier)) return deny("stale_owner");
    const failure = normalizeFailure(input.failure);
    if (typeof failure === "string") return deny(failure);
    const db = this.db;
    if (!db) return deny("storage_unavailable");
    const f = authority.fence, recovery = authority.kind === "recovery" ? authority.fence : undefined;
    const preDispatch = failure.category === "PROVEN_PRE_DISPATCH_FAILURE";
    const eligible = `r.reconciliation_state = 'awaiting' AND r.reconciliation_requested_at IS NOT NULL
      AND r.reconciliation_completed_at IS NULL AND a.finished_at IS NOT NULL AND ${preDispatch
        ? "i.processing_state = 'failed' AND i.status = 'pending' AND r.status = 'not_sent' AND a.status = 'not_sent' AND a.sent_at IS NULL"
        : "i.processing_state = 'outcome_unknown' AND i.status = 'unknown' AND r.status = 'unknown' AND a.status = 'unknown' AND a.sent_at IS NOT NULL"}`;
    try {
      const owner = authority.kind === "owner" ? authority.fence : undefined;
      const authPredicate = recovery ? RECOVERY_AUTH : AUTH;
      const auth = recovery ? [f.claimId, f.serviceId, f.generation, input.reservationId, input.attemptId, input.provider, input.model,
        recovery.operationId, await sha256(f.token)] : [f.claimId, f.serviceId, owner!.keyHash, owner!.payloadHash, owner!.fingerprintKeyId,
        owner!.responseVersion, await sha256(f.token), f.generation, input.reservationId, input.attemptId, input.provider, input.model];
      const usageJson = canonicalJson(failure.usage);
      const read = async () => {
        const results = await db.batch([
          db.prepare(`SELECT i.processing_state, i.status AS request_status, r.status AS reservation_status, a.status AS attempt_status,
            a.sent_at, a.finished_at, r.reconciliation_state, r.reconciliation_requested_at, r.reconciliation_completed_at, r.quota_scope_id,
            u.id AS usage_id, a.failure_receipt_hash, a.failure_generation, a.failure_recorded_at, a.failure_accounting_state,
            a.failure_usage, a.failure_category, a.failure_reason, a.failure_http_status
            ${FROM} LEFT JOIN usage_accounting u ON u.attempt_id = a.id WHERE ${authPredicate}`).bind(...auth),
          db.prepare(`SELECT l.quota_window_id, l.quota_metric, l.reserved_amount, l.status, l.settled_amount, l.failure_basis,
            l.failure_held_amount, w.quota_scope_id, w.provider, w.model, w.dimension, w.unit
            FROM reservation_quota_windows l JOIN provider_quota_windows w ON w.id = l.quota_window_id
            WHERE l.reservation_id = ? ORDER BY l.quota_window_id LIMIT 33`).bind(input.reservationId),
        ]);
        if (results.length !== 2 || results.some(r => !r.success)) throw new Error("Failure accounting read unavailable");
        return { row: results[0]!.results[0] as Row | undefined, links: results[1]!.results as Link[] };
      };
      const plan = async ({ row, links }: Awaited<ReturnType<typeof read>>): Promise<FailureAccountingDecision |
        { row: Row; allocations: { link: Link; allocation: FailureAllocation }[]; hash: string; accounting: FailureAccountingState }> => {
        if (!row) return deny("stale_owner");
        if (row.usage_id !== null) return deny("conflict");
        if (row.reconciliation_state !== "awaiting" || row.reconciliation_requested_at === null || row.reconciliation_completed_at !== null ||
            row.finished_at === null || (preDispatch
              ? row.processing_state !== "failed" || row.request_status !== "pending" || row.reservation_status !== "not_sent" || row.attempt_status !== "not_sent" || row.sent_at !== null
              : row.processing_state !== "outcome_unknown" || row.request_status !== "unknown" || row.reservation_status !== "unknown" || row.attempt_status !== "unknown" || row.sent_at === null)) return deny("invalid_state");
        if (links.length === 0 || links.length > 32) return deny("invalid_accounting");
        const allocations: { link: Link; allocation: FailureAllocation }[] = [];
        for (const link of links) {
          const metric = link.quota_metric;
          if (!metric || !["requests", "input_tokens", "output_tokens", "tokens", "compute_units"].includes(metric) ||
              !safeAmount(link.reserved_amount) || link.reserved_amount === 0 || link.quota_scope_id !== row.quota_scope_id ||
              link.provider !== input.provider || !["", input.model].includes(link.model) || !usageIdentifier(link.unit) ||
              link.dimension !== (["requests", "compute_units"].includes(metric) ? metric : "tokens") ||
              (metric === "requests" && link.unit !== "requests") ||
              (["tokens", "input_tokens", "output_tokens"].includes(metric) && link.unit !== "tokens")) return deny("invalid_accounting");
          const allocation = failureAllocation(failure, metric, link.unit, link.reserved_amount);
          if (!allocation || !safeAmount(allocation.held)) return deny("invalid_usage");
          allocations.push({ link, allocation });
        }
        const known = allocations.filter(a => a.allocation.consumed !== null).length;
        const accounting: FailureAccountingState = preDispatch ? "released" : known === 0 ? "held" : known === allocations.length ? "accounted" : "partial";
        const hash = await failureReceipt({ claimId: f.claimId, generation: f.generation,
          attemptId: input.attemptId, reservationId: input.reservationId, provider: input.provider, model: input.model }, failure,
          allocations.map(({ link, allocation }) => ({ window: link.quota_window_id, metric: link.quota_metric,
            unit: link.unit, reserved: link.reserved_amount, ...allocation })));
        if (row.failure_receipt_hash !== null) {
          if (row.failure_receipt_hash !== hash || row.failure_generation !== f.generation) return deny("conflict");
          if (row.failure_recorded_at === null || row.failure_accounting_state !== accounting || row.failure_usage !== usageJson ||
              row.failure_category !== failure.category || row.failure_reason !== failure.reason || row.failure_http_status !== failure.httpStatus ||
              allocations.some(({ link, allocation: a }) => link.status !== a.status || link.settled_amount !== a.consumed ||
                link.failure_held_amount !== a.held || link.failure_basis !== a.basis)) return deny("invalid_accounting");
          return { state: "already_recorded", accounting, retryable: false };
        }
        if (row.failure_recorded_at !== null || row.failure_category !== null || row.failure_reason !== null || row.failure_usage !== null ||
            row.failure_generation !== null || row.failure_accounting_state !== null || row.failure_http_status !== null ||
            links.some(l => l.status !== "reserved" || l.settled_amount !== null || l.failure_basis !== null || l.failure_held_amount !== null)) return deny("invalid_accounting");
        return { row, allocations, hash, accounting };
      };
      const prepared = await plan(await read());
      if ("state" in prepared) return prepared;
      if (readOnly) return deny("not_recorded");
      const { row, allocations, hash, accounting } = prepared;
      const statements: D1Statement[] = [];
      // Like admission, a zero-row write must become a SQL error, not merely a
      // post-commit JS denial. This unconditional assertion also fails when an
      // owner/attempt row disappears. It cannot itself miss a guard row.
      const write = (statement: D1Statement) => statements.push(statement,
        db.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('failure_accounting_precondition_failed') END AS checked"));
      write(db.prepare(`UPDATE inference_attempts SET failure_category = ?, failure_reason = ?, failure_http_status = ?,
        failure_usage = ?, failure_receipt_hash = ?, failure_generation = ?, failure_accounting_state = ?, updated_at = unixepoch(),
        retain_until = max(retain_until, unixepoch()) WHERE id = ? AND failure_receipt_hash IS NULL AND failure_recorded_at IS NULL
          AND failure_category IS NULL AND failure_reason IS NULL AND failure_usage IS NULL AND failure_generation IS NULL
          AND failure_accounting_state IS NULL AND failure_http_status IS NULL
          AND EXISTS (SELECT 1 ${FROM} WHERE ${authPredicate} AND ${eligible}
            AND (SELECT count(*) FROM reservation_quota_windows WHERE reservation_id = r.id) = ?
            AND NOT EXISTS (SELECT 1 FROM usage_accounting WHERE attempt_id = a.id))`)
        .bind(failure.category, failure.reason, failure.httpStatus, usageJson, hash, f.generation, accounting, input.attemptId, ...auth, allocations.length));
      for (const { link: l, allocation: a } of allocations) {
        // All inputs have already been range checked; every persisted counter and
        // original link amount is checked again in this transaction.
        write(db.prepare(`UPDATE provider_quota_windows SET
          reserved_amount = CAST(reserved_amount AS INTEGER) - CAST(?1 AS INTEGER) + CAST(?2 AS INTEGER),
          consumed_amount = CAST(consumed_amount AS INTEGER) + CAST(?3 AS INTEGER),
          updated_at = unixepoch(), retain_until = max(retain_until, unixepoch())
          WHERE id = ?4 AND quota_scope_id = ?5 AND provider = ?6 AND model = ?7 AND dimension = ?8 AND unit = ?9
            AND reserved_amount BETWEEN ?1 AND ${MAX} AND reserved_amount = CAST(reserved_amount AS INTEGER)
            AND CAST(reserved_amount AS INTEGER) - CAST(?1 AS INTEGER) <= ${MAX} - CAST(?2 AS INTEGER)
            AND consumed_amount BETWEEN 0 AND ${MAX} - CAST(?3 AS INTEGER) AND consumed_amount = CAST(consumed_amount AS INTEGER)
            AND updated_at <= unixepoch() AND created_at >= 0 AND retain_until <= ${MAX}
            AND EXISTS (SELECT 1 FROM reservation_quota_windows l WHERE l.quota_window_id = provider_quota_windows.id
              AND l.reservation_id = ?10 AND l.reserved_amount = ?1 AND l.quota_metric = ?11 AND l.status = 'reserved'
              AND l.settled_amount IS NULL AND l.failure_basis IS NULL AND l.failure_held_amount IS NULL)`)
          .bind(l.reserved_amount, a.held, a.consumed ?? 0, l.quota_window_id, row.quota_scope_id, input.provider,
            l.model, l.dimension, l.unit, input.reservationId, l.quota_metric));
        write(db.prepare(`UPDATE reservation_quota_windows SET status = ?, settled_amount = ?, failure_basis = ?, failure_held_amount = ?,
          updated_at = unixepoch() WHERE reservation_id = ? AND quota_window_id = ? AND reserved_amount = ? AND quota_metric = ?
            AND status = 'reserved' AND settled_amount IS NULL AND failure_basis IS NULL AND failure_held_amount IS NULL
            AND updated_at <= unixepoch()`)
          .bind(a.status, a.consumed, a.basis, a.held, input.reservationId, l.quota_window_id, l.reserved_amount, l.quota_metric));
      }
      write(db.prepare(`UPDATE inference_attempts SET failure_recorded_at = unixepoch(), updated_at = unixepoch()
        WHERE id = ? AND failure_receipt_hash = ? AND failure_recorded_at IS NULL
          AND (SELECT count(*) FROM reservation_quota_windows WHERE reservation_id = ?) = ?
          AND NOT EXISTS (SELECT 1 FROM reservation_quota_windows WHERE reservation_id = ?
            AND (failure_basis IS NULL OR failure_held_amount IS NULL OR status = 'reserved'))`)
        .bind(input.attemptId, hash, input.reservationId, allocations.length, input.reservationId));
      if (recovery) write(db.prepare(`UPDATE request_reservations SET recovery_completed_at = unixepoch(), recovery_receipt_hash = ?,
        updated_at = unixepoch(), retain_until = max(retain_until, unixepoch())
        WHERE id = ? AND recovery_operation_id = ? AND recovery_generation = ? AND recovery_token_hash = ?
          AND recovery_lease_expires_at > unixepoch() AND recovery_completed_at IS NULL AND recovery_receipt_hash IS NULL
          AND status = 'not_sent' AND EXISTS (SELECT 1 FROM inference_attempts WHERE id = ? AND reservation_id = request_reservations.id
            AND failure_receipt_hash = ? AND failure_recorded_at IS NOT NULL AND failure_accounting_state = 'released')`)
        .bind(hash, input.reservationId, recovery.operationId, f.generation, await sha256(f.token), input.attemptId, hash));
      try {
        const results = await db.batch<{ checked: number }>(statements);
        if (results.length !== statements.length || results.some((r, index) => !r.success ||
            (index % 2 === 0 ? r.meta.changes !== 1 : r.meta.changes !== 0 || r.results[0]?.checked !== 1))) return deny("storage_unavailable");
        return { state: "recorded", accounting, retryable: false };
      } catch (error) {
        if (error instanceof Error && error.message.includes("malformed JSON")) {
          const current = await plan(await read());
          return "state" in current ? current : deny("invalid_accounting");
        }
        // A timeout may follow a committed transaction. Only an explicit inspect
        // or identical retry can confirm its durable receipt; never refund again.
        return deny("storage_unavailable");
      }
    } catch { return deny("storage_unavailable"); }
  }
}
