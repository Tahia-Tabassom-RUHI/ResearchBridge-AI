import type { QuotaMetric, SettlementDecision, SuccessfulSettlementInput, UsageReporter } from "../storage";
import type { D1Binding, D1Statement } from "./d1-quota-admission";
import { canonicalJson, sha256, validFence } from "./request-identity";
import { consumption, normalizeSettlementUsage, safeAmount, usageIdentifier, type NormalizedUsage } from "./settlement-usage";
import { successReceipt } from "./accounting-receipts";

const MAX = Number.MAX_SAFE_INTEGER;
type Denial = Extract<SettlementDecision, { retryable: false }>;
const deny = (state: Denial["state"]): Denial => ({ state, retryable: false });
type OwnedRow = {
  processing_state: string; request_status: string; reservation_status: string; attempt_status: string;
  sent_at: number | null; finished_at: number | null; reconciliation_state: string;
  reconciliation_requested_at: number | null; reconciliation_completed_at: number | null;
  retain_until: number; quota_scope_id: string; usage_id: string | null; settlement_hash: string | null;
  settlement_generation: number | null; usage_status: string | null;
};
type Link = { quota_window_id: string; reserved_amount: number; settled_amount: number | null;
  status: string; quota_metric: QuotaMetric | null; unit: string; dimension: string;
  quota_scope_id: string; provider: string; model: string };
type Allocation = { link: Link; amount: number };

const FROM = `FROM idempotency_records i JOIN request_reservations r ON r.id = i.reservation_id
  JOIN inference_attempts a ON a.reservation_id = r.id`;
const AUTH = `i.id = ? AND i.service_id = ? AND i.key_hash = ? AND i.payload_hash = ?
  AND i.fingerprint_key_id = ? AND i.response_version = ? AND i.owner_token_hash = ? AND i.generation = ?
  AND i.expires_at > unixepoch() AND i.lease_expires_at > unixepoch()
  AND i.updated_at <= unixepoch() AND r.updated_at <= unixepoch() AND a.updated_at <= unixepoch()
  AND r.service_id = i.service_id AND r.request_id = i.id
  AND r.id = ? AND a.id = ? AND r.provider = ? AND r.model = ?`;
const ELIGIBLE = `i.processing_state = 'completed' AND i.status = 'completed'
  AND r.status = 'completed' AND a.status = 'completed' AND a.sent_at IS NOT NULL AND a.finished_at IS NOT NULL
  AND r.reconciliation_state = 'awaiting' AND r.reconciliation_requested_at IS NOT NULL`;

// Internal service only. The owner capability comes from authenticated claim /
// admission / lifecycle operations. No public endpoint accepts these inputs.
export class D1UsageSettlement implements UsageReporter {
  constructor(private readonly db: D1Binding | undefined) {}

  async settle(input: SuccessfulSettlementInput): Promise<SettlementDecision> {
    if (!input?.fence || !validFence(input.fence)) return deny("stale_owner");
    if (![input.reservationId, input.attemptId, input.provider, input.model].every(usageIdentifier)) return deny("stale_owner");
    const usage = normalizeSettlementUsage(input.usage);
    if (!usage) return deny("invalid_usage");
    const db = this.db;
    if (!db) return deny("storage_unavailable");
    const f = input.fence;
    try {
      const auth = [f.claimId, f.serviceId, f.keyHash, f.payloadHash, f.fingerprintKeyId, f.responseVersion,
        await sha256(f.token), f.generation, input.reservationId, input.attemptId, input.provider, input.model];
      const read = async () => {
        const results = await db.batch([
          db.prepare(`SELECT i.processing_state, i.status AS request_status, r.status AS reservation_status,
            a.status AS attempt_status, a.sent_at, a.finished_at, r.reconciliation_state,
            r.reconciliation_requested_at, r.reconciliation_completed_at, r.quota_scope_id,
            max(i.retain_until, r.retain_until, a.retain_until) AS retain_until,
            u.id AS usage_id, u.settlement_hash, u.settlement_generation, u.status AS usage_status
            ${FROM} LEFT JOIN usage_accounting u ON u.attempt_id = a.id WHERE ${AUTH}`).bind(...auth),
          db.prepare(`SELECT l.quota_window_id, l.reserved_amount, l.settled_amount, l.status, l.quota_metric,
            w.unit, w.dimension, w.quota_scope_id, w.provider, w.model
            FROM reservation_quota_windows l JOIN provider_quota_windows w ON w.id = l.quota_window_id
            WHERE l.reservation_id = ? ORDER BY l.quota_window_id LIMIT 33`).bind(input.reservationId),
        ]);
        if (results.length !== 2 || results.some(r => !r.success)) throw new Error("Settlement read unavailable");
        return { row: results[0]!.results[0] as OwnedRow | undefined, links: results[1]!.results as Link[] };
      };
      const prepare = async ({ row, links }: Awaited<ReturnType<typeof read>>): Promise<
        { row: OwnedRow; allocations: Allocation[]; hash: string } | SettlementDecision> => {
        if (!row) return deny("stale_owner");
        if (row.processing_state !== "completed" || row.request_status !== "completed" || row.reservation_status !== "completed" ||
            row.attempt_status !== "completed" || row.sent_at === null || row.finished_at === null ||
            row.reconciliation_state !== "awaiting" || row.reconciliation_requested_at === null) return deny("invalid_state");
        if (!safeAmount(row.retain_until) || links.length === 0 || links.length > 32) return deny("invalid_accounting");
        const allocations: Allocation[] = [];
        for (const link of links) {
          const metric = link.quota_metric;
          if (!metric || !["requests", "input_tokens", "output_tokens", "tokens", "compute_units"].includes(metric) ||
              link.quota_scope_id !== row.quota_scope_id || link.provider !== input.provider || !["", input.model].includes(link.model) ||
              link.dimension !== (metric === "requests" || metric === "compute_units" ? metric : "tokens") ||
              (metric === "requests" && link.unit !== "requests") ||
              (["input_tokens", "output_tokens", "tokens"].includes(metric) && link.unit !== "tokens") ||
              !usageIdentifier(link.unit) || !safeAmount(link.reserved_amount) || link.reserved_amount === 0) return deny("invalid_accounting");
          const amount = consumption(usage, metric, link.unit);
          if (!safeAmount(amount) || (usage.kind === "estimated" && amount < link.reserved_amount)) return deny("invalid_usage");
          allocations.push({ link, amount });
        }
        const hash = await successReceipt({ claimId: f.claimId, generation: f.generation,
          reservationId: input.reservationId, attemptId: input.attemptId, provider: input.provider, model: input.model }, usage,
          allocations.map(({ link, amount }) => ({ window: link.quota_window_id, metric: link.quota_metric,
            unit: link.unit, reserved: link.reserved_amount, consumed: amount })));
        if (row.usage_id !== null) {
          if (row.settlement_hash !== hash || row.settlement_generation !== f.generation) return deny("conflict");
          if (row.usage_status !== "reconciled" || row.reconciliation_completed_at === null ||
              allocations.some(({ link, amount }) => link.status !== "settled" || link.settled_amount !== amount)) return deny("invalid_accounting");
          return { state: "already_settled" };
        }
        if (row.reconciliation_completed_at !== null || links.some(l => l.status !== "reserved" || l.settled_amount !== null)) return deny("invalid_accounting");
        return { row, allocations, hash };
      };
      const plan = await prepare(await read());
      if ("state" in plan) return plan;
      const { row, allocations, hash } = plan;
      const statements: D1Statement[] = [db.prepare(`UPDATE idempotency_records SET updated_at = unixepoch()
        WHERE id = ? AND EXISTS (SELECT 1 ${FROM} WHERE ${AUTH} AND ${ELIGIBLE}
          AND r.reconciliation_completed_at IS NULL
          AND (SELECT count(*) FROM reservation_quota_windows WHERE reservation_id = r.id) = ?
          AND NOT EXISTS (SELECT 1 FROM usage_accounting WHERE attempt_id = a.id))`)
        .bind(f.claimId, ...auth, allocations.length)];
      // This INSERT always executes. Even a nonexistent owner cannot evade the
      // changes() assertion by making a guard UPDATE match no row.
      statements.push(this.usageInsert(db, input, usage, hash, row.retain_until));
      const guard = () => db.prepare("UPDATE usage_accounting SET settlement_check = changes() WHERE attempt_id = ?").bind(input.attemptId);
      const write = (statement: D1Statement) => statements.push(statement, guard());
      for (const { link: l, amount } of allocations) {
        write(db.prepare(`UPDATE provider_quota_windows SET
          reserved_amount = CAST(reserved_amount AS INTEGER) - CAST(? AS INTEGER),
          consumed_amount = CAST(consumed_amount AS INTEGER) + CAST(? AS INTEGER),
          updated_at = unixepoch(), retain_until = max(retain_until, unixepoch())
          WHERE id = ? AND quota_scope_id = ? AND provider = ? AND model = ? AND dimension = ? AND unit = ?
            AND reserved_amount BETWEEN ? AND ${MAX} AND consumed_amount BETWEEN 0 AND ${MAX} - ?
            AND reserved_amount = CAST(reserved_amount AS INTEGER) AND consumed_amount = CAST(consumed_amount AS INTEGER)
            AND created_at >= 0 AND updated_at <= unixepoch() AND retain_until <= ${MAX}
            AND EXISTS (SELECT 1 FROM reservation_quota_windows l WHERE l.quota_window_id = provider_quota_windows.id
              AND l.reservation_id = ? AND l.status = 'reserved' AND l.settled_amount IS NULL
              AND l.reserved_amount = ? AND l.quota_metric = ?)`)
          .bind(l.reserved_amount, amount, l.quota_window_id, row.quota_scope_id, input.provider, l.model, l.dimension, l.unit,
            l.reserved_amount, amount, input.reservationId, l.reserved_amount, l.quota_metric));
        write(db.prepare(`UPDATE reservation_quota_windows SET status = 'settled', settled_amount = ?, updated_at = unixepoch()
          WHERE reservation_id = ? AND quota_window_id = ? AND status = 'reserved' AND settled_amount IS NULL
            AND reserved_amount = ? AND quota_metric = ? AND updated_at <= unixepoch()`)
          .bind(amount, input.reservationId, l.quota_window_id, l.reserved_amount, l.quota_metric));
      }
      write(db.prepare(`UPDATE request_reservations SET reconciliation_completed_at = unixepoch(),
        updated_at = unixepoch(), retain_until = max(retain_until, unixepoch())
        WHERE id = ? AND status = 'completed' AND reconciliation_state = 'awaiting' AND reconciliation_completed_at IS NULL
          AND (SELECT count(*) FROM reservation_quota_windows WHERE reservation_id = ?) = ?
          AND NOT EXISTS (SELECT 1 FROM reservation_quota_windows WHERE reservation_id = ?
            AND (status != 'settled' OR settled_amount IS NULL))`)
        .bind(input.reservationId, input.reservationId, allocations.length, input.reservationId));
      try {
        const results = await db.batch(statements);
        if (results.length !== statements.length || results.some(r => !r.success || r.meta.changes !== 1)) return deny("storage_unavailable");
        return { state: "settled" };
      } catch (error) {
        // Only diagnose deterministic transaction rejection. An ambiguous write
        // returns unavailable; an explicit identical retry can read the receipt.
        if (error instanceof Error && /usage_settlement_succeeded|UNIQUE constraint failed: usage_accounting.attempt_id/.test(error.message)) {
          const current = await prepare(await read());
          return "state" in current ? current : deny("invalid_accounting");
        }
        return deny("storage_unavailable");
      }
    } catch { return deny("storage_unavailable"); }
  }

  private usageInsert(db: D1Binding, input: SuccessfulSettlementInput, usage: NormalizedUsage, hash: string, retain: number): D1Statement {
    const units = Object.entries(usage.computeUnits);
    const single = units.length === 1 ? units[0]! : undefined;
    return db.prepare(`INSERT INTO usage_accounting (id, attempt_id, kind, status, request_count, input_tokens, output_tokens,
      total_tokens, compute_units, compute_unit, compute_usage, estimate_policy, settlement_hash, settlement_generation,
      created_at, updated_at, retain_until, settlement_check)
      VALUES (?, ?, ?, 'reconciled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(), max(?, unixepoch()), changes())`)
      .bind(crypto.randomUUID(), input.attemptId, usage.kind, usage.requests, usage.inputTokens, usage.outputTokens, usage.totalTokens,
        single?.[1] ?? null, single?.[0] ?? null, canonicalJson(usage.computeUnits), usage.estimatePolicy, hash, input.fence.generation, retain);
  }
}
