import type { QuotaAdmission, QuotaAdmissionInput, QuotaAdmissionPolicy, QuotaAdmissionResult, QuotaWindowPolicy } from "../storage";
import { sha256, validFence } from "./request-identity";

// The subset of the Workers D1 binding used here. No runtime SDK dependency.
export interface D1QueryResult<T = Record<string, unknown>> {
  success: boolean;
  meta: { changes: number };
  results: T[];
}
export interface D1Statement {
  bind(...values: (string | number | null)[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<D1QueryResult<T>>;
}
export interface D1Binding {
  prepare(sql: string): D1Statement;
  batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1QueryResult<T>[]>;
}

const MAX = Number.MAX_SAFE_INTEGER;
// Bound SQL work per invocation, independently of any provider usage allowance.
const MAX_WINDOWS = 32;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,199}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positive = (value: unknown): value is number => integer(value) && value > 0;
const dimension = (metric: QuotaWindowPolicy["metric"]) => metric === "requests" || metric === "compute_units" ? metric : "tokens";

type WindowRow = {
  id: string; quota_scope_id: string; provider: string; model: string; dimension: string; unit: string;
  window_seconds: number; window_start: number; window_end: number; limit_amount: number;
  safety_margin: number; reserved_amount: number; consumed_amount: number; status: string;
  created_at: number; updated_at: number; retain_until: number; now: number;
};
type Denial = Extract<QuotaAdmissionResult, { admitted: false }>;
type Problem = Pick<Denial, "status" | "reason" | "resetAt">;
type Allocation = { policy: QuotaWindowPolicy; amount: number };

function validPolicy(policy: QuotaAdmissionPolicy): boolean {
  if (!identifier(policy.quotaScopeId) || !positive(policy.leaseSeconds) || !positive(policy.retentionSeconds) ||
      policy.retentionSeconds < policy.leaseSeconds || !Array.isArray(policy.windows) ||
      policy.windows.length === 0 || policy.windows.length > MAX_WINDOWS) return false;
  const seen = new Set<string>();
  for (const w of policy.windows) {
    if (!w || !identifier(w.windowId) || seen.has(w.windowId) || (w.model !== "" && w.model !== policy.model) ||
        !["requests", "tokens", "input_tokens", "output_tokens", "compute_units"].includes(w.metric) ||
        !identifier(w.unit) || !integer(w.capacity) || !integer(w.safetyMargin) || w.safetyMargin > w.capacity ||
        !integer(w.windowStart) || !positive(w.windowSeconds) || !integer(w.windowStart + w.windowSeconds) ||
        (w.metric === "requests" && w.unit !== "requests") ||
        (["tokens", "input_tokens", "output_tokens"].includes(w.metric) && w.unit !== "tokens")) return false;
    seen.add(w.windowId);
  }
  return true;
}

function allocations(input: QuotaAdmissionInput, policy: QuotaAdmissionPolicy): Allocation[] | undefined {
  const e = input.estimate;
  if (!e || !["estimated", "measured"].includes(e.kind)) return;
  for (const value of [e.requests, e.inputTokens, e.outputTokens, e.neurons]) {
    if (value !== undefined && !integer(value)) return;
  }
  if (e.computeUnits !== undefined && (e.computeUnits === null || typeof e.computeUnits !== "object" ||
      Array.isArray(e.computeUnits) || Object.entries(e.computeUnits).some(([unit, value]) => !identifier(unit) || !integer(value)))) return;
  if (e.neurons !== undefined && e.computeUnits?.neurons !== undefined && e.neurons !== e.computeUnits.neurons) return;
  const result: Allocation[] = [];
  for (const w of policy.windows) {
    let amount: number | undefined;
    switch (w.metric) {
      case "requests": amount = e.requests ?? 1; break;
      case "input_tokens": amount = e.inputTokens; break;
      case "output_tokens": amount = e.outputTokens; break;
      case "tokens": amount = e.inputTokens !== undefined && e.outputTokens !== undefined ? e.inputTokens + e.outputTokens : undefined; break;
      case "compute_units": amount = e.computeUnits?.[w.unit] ?? (w.unit === "neurons" ? e.neurons : undefined); break;
    }
    if (!positive(amount)) return;
    result.push({ policy: w, amount });
  }
  return result;
}

function inspect(rows: (WindowRow | undefined)[], policy: QuotaAdmissionPolicy, wanted: Allocation[]): Problem | undefined {
  const exhausted: number[] = [];
  for (const [index, { policy: w, amount }] of wanted.entries()) {
    const row = rows[index];
    if (!row) return { status: "configuration_missing", reason: "window_unavailable" };
    if (row.quota_scope_id !== policy.quotaScopeId || row.provider !== policy.provider || row.model !== w.model ||
        row.dimension !== dimension(w.metric) || row.unit !== w.unit || row.limit_amount !== w.capacity ||
        row.safety_margin !== w.safetyMargin || row.window_start !== w.windowStart || row.window_seconds !== w.windowSeconds ||
        row.window_end !== w.windowStart + w.windowSeconds ||
        ![row.limit_amount, row.consumed_amount, row.reserved_amount, row.safety_margin, row.window_start,
          row.window_end, row.created_at, row.updated_at, row.retain_until, row.now].every(integer) ||
        row.updated_at < row.created_at || row.updated_at > row.now || row.retain_until < row.window_end ||
        !integer(row.now + policy.retentionSeconds)) return { status: "configuration_missing", reason: "invalid_window" };
    if (row.status !== "open" || row.now < row.window_start || row.now >= row.window_end) {
      return { status: "configuration_missing", reason: "window_unavailable" };
    }
    const safe = row.limit_amount - row.safety_margin;
    // Ordered subtraction keeps every intermediate within the exact integer range.
    if (row.consumed_amount > safe || row.reserved_amount > safe - row.consumed_amount) {
      return { status: "configuration_missing", reason: "invalid_window" };
    }
    if (amount > safe - row.consumed_amount - row.reserved_amount) exhausted.push(row.window_end);
  }
  if (exhausted.length) return { status: "insufficient_capacity", reason: "quota_exhausted", resetAt: Math.max(...exhausted) };
}

// All predicates are rechecked in the write transaction. The earlier reads only
// classify configuration errors; they never authorize an unconditional write.
const RESERVE_WINDOW = `UPDATE provider_quota_windows
  SET reserved_amount = CAST(reserved_amount AS INTEGER) + CAST(?1 AS INTEGER), updated_at = unixepoch()
  WHERE id = ?2 AND quota_scope_id = ?3 AND provider = ?4 AND model = ?5
    AND dimension = ?6 AND unit = ?7 AND limit_amount = ?8 AND safety_margin = ?9
    AND window_start = ?10 AND window_seconds = ?11 AND window_end = ?12
    AND status = 'open' AND window_start <= unixepoch() AND unixepoch() < window_end
    AND created_at >= 0 AND created_at <= updated_at AND updated_at <= unixepoch()
    AND retain_until >= window_end AND retain_until <= 9007199254740991
    AND consumed_amount BETWEEN 0 AND 9007199254740991
    AND reserved_amount BETWEEN 0 AND 9007199254740991
    AND consumed_amount = CAST(consumed_amount AS INTEGER)
    AND reserved_amount = CAST(reserved_amount AS INTEGER)
    AND ?1 <= CAST(limit_amount AS INTEGER) - safety_margin
              - CAST(consumed_amount AS INTEGER) - CAST(reserved_amount AS INTEGER)`;

export class D1QuotaAdmission implements QuotaAdmission {
  private readonly policies: readonly QuotaAdmissionPolicy[];
  constructor(private readonly db: D1Binding | undefined, policies: readonly QuotaAdmissionPolicy[] = []) {
    this.policies = structuredClone(policies);
  }

  async reserve(input: QuotaAdmissionInput): Promise<QuotaAdmissionResult> {
    const context = { requestId: input.requestId, provider: input.provider, model: input.model };
    const deny = (problem: Problem): Denial => ({ ...context, admitted: false, ...problem });
    if (![input.serviceId, input.requestId, input.provider, input.model].every(identifier)) {
      return deny({ status: "invalid_request", reason: "invalid_identifiers" });
    }
    if (input.claim && (!validFence(input.claim) || input.claim.serviceId !== input.serviceId || input.claim.claimId !== input.requestId)) {
      return deny({ status: "invalid_request", reason: "stale_claim" });
    }
    const matches = this.policies.filter(p => p.provider === input.provider && p.model === input.model);
    const policy = matches[0];
    if (!policy) return deny({ status: "configuration_missing", reason: "policy_missing" });
    if (matches.length !== 1 || !validPolicy(policy)) return deny({ status: "configuration_missing", reason: "invalid_policy" });
    const wanted = allocations(input, policy);
    if (!wanted) return deny({ status: "invalid_request", reason: "invalid_estimate" });
    const db = this.db;
    if (!db) return deny({ status: "storage_unavailable", reason: "database_binding_missing" });

    const readWindows = async (): Promise<(WindowRow | undefined)[]> => {
      const results = await db.batch<WindowRow>(wanted.map(({ policy: w }) =>
        db.prepare("SELECT *, unixepoch() AS now FROM provider_quota_windows WHERE id = ?").bind(w.windowId)));
      if (results.length !== wanted.length || results.some(r => !r.success)) throw new Error("Quota read failed");
      return results.map(r => r.results[0]);
    };
    try {
      const problem = inspect(await readWindows(), policy, wanted);
      if (problem) return deny(problem);
      const reservationId = crypto.randomUUID();
      const end = Math.min(...wanted.map(({ policy: w }) => w.windowStart + w.windowSeconds));
      const statements: D1Statement[] = [db.prepare(`INSERT INTO request_reservations
        (id, service_id, request_id, quota_scope_id, provider, model, reservation_number, status,
         created_at, updated_at, expires_at, retain_until)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'reserved', unixepoch(), unixepoch(),
                min(unixepoch() + ?, ?),
                CASE WHEN ? <= 9007199254740991 - unixepoch() THEN unixepoch() + ? ELSE -1 END) RETURNING expires_at`)
        .bind(reservationId, input.serviceId, input.requestId, policy.quotaScopeId, input.provider, input.model,
          policy.leaseSeconds, end, policy.retentionSeconds, policy.retentionSeconds)];
      if (input.claim) {
        const c = input.claim;
        statements.push(db.prepare(`UPDATE idempotency_records SET processing_state = 'reserved',
          generation = generation + 1, reservation_id = ?, updated_at = unixepoch()
          WHERE id = ? AND service_id = ? AND key_hash = ? AND payload_hash = ? AND fingerprint_key_id = ? AND response_version = ?
            AND owner_token_hash = ? AND generation = ? AND generation < 9007199254740991
            AND processing_state = 'pending' AND status = 'pending' AND reservation_id IS NULL
            AND expires_at > unixepoch() AND lease_expires_at > unixepoch()`)
          .bind(reservationId, c.claimId, c.serviceId, c.keyHash, c.payloadHash, c.fingerprintKeyId, c.responseVersion, await sha256(c.token), c.generation));
        // The reservation row always exists here. Missing/stale claims therefore
        // raise a constraint error rather than silently admitting unowned work.
        statements.push(db.prepare("UPDATE request_reservations SET ownership_check = changes() WHERE id = ?").bind(reservationId));
      }
      for (const { policy: w, amount } of wanted) {
        statements.push(db.prepare(RESERVE_WINDOW).bind(amount, w.windowId, policy.quotaScopeId, policy.provider, w.model,
          dimension(w.metric), w.unit, w.capacity, w.safetyMargin, w.windowStart, w.windowSeconds, w.windowStart + w.windowSeconds));
        // Keep this immediately after its UPDATE. SELECT or JS checks after batch
        // completion cannot provide the required rollback on zero affected rows.
        statements.push(db.prepare(`INSERT INTO reservation_quota_windows
          (reservation_id, quota_window_id, reserved_amount, status, created_at, updated_at, admission_check)
          VALUES (?, ?, ?, 'reserved', unixepoch(), unixepoch(), changes())`).bind(reservationId, w.windowId, amount));
      }
      const results = await db.batch<{ expires_at: number }>(statements);
      const expiry = results[0]?.results[0]?.expires_at;
      if (results.length !== statements.length || results.some(r => !r.success || r.meta.changes !== 1) || !integer(expiry)) {
        // An uncertain acknowledgement must never authorize dispatch or trigger a refund.
        return deny({ status: "storage_unavailable", reason: "admission_not_confirmed" });
      }
      return { ...context, admitted: true, status: "admitted", reason: "capacity_reserved", reservationId, leaseExpiresAt: expiry };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("idempotency_admission_succeeded")) return deny({ status: "invalid_request", reason: "stale_claim" });
      if (message.includes("quota_admission_succeeded")) {
        try {
          const problem = inspect(await readWindows(), policy, wanted);
          if (problem) return deny(problem);
        } catch { /* Return a closed decision below when diagnostic reads fail. */ }
        return deny({ status: "storage_unavailable", reason: "admission_not_confirmed" });
      }
      if (message.includes("UNIQUE constraint failed: request_reservations.service_id, request_reservations.request_id, request_reservations.reservation_number")) {
        return deny({ status: "invalid_request", reason: "duplicate_request" });
      }
      return deny({ status: "storage_unavailable", reason: "database_error" });
    }
  }
}
