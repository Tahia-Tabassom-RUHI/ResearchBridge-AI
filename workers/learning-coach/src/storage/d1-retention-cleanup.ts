import { authenticate } from "../auth";
import { isLoopback, type Env } from "../config/index";
import { safeInteger } from "../config/provider-policy";
import { HttpError } from "../errors/index";
import { D1RetentionEligibility, validRetentionPolicy, type RetentionPolicy } from "./d1-retention-eligibility";
import type { D1Binding, D1Statement } from "./d1-quota-admission";
import { requestIdPattern } from "./request-identity";
import { snapshotGate } from "./snapshot-gate";

export interface CleanupEnv extends Env { COACH_CLEANUP_SECRET?: string; COACH_EVIDENCE_RECOVERY_SECRET?: string }
export interface CleanupConfig {
  enabled: boolean; approved: boolean; approvalReference: string; retention: RetentionPolicy; batchSize: number;
}
export interface CleanupCursor { retainUntil: number; claimId: string }
const AUTHORITY = Symbol("retention cleanup authority");
const MAX_BATCH = 5; // At most 31 D1 calls per run, below the Free per-invocation query limit.
const emptyCounts = () => ({ usage_accounting: 0, reservation_quota_windows: 0, inference_attempts: 0, idempotency_records: 0, request_reservations: 0 });
type Counts = ReturnType<typeof emptyCounts>;
type Query = { sql: string; values: (string | number | null)[]; rows: object[] };

// Capture only internal SELECTs used by eligibility and graph discovery. Every
// result and absence is compared again inside the authoritative D1 batch.
function capture(db: D1Binding) {
  const queries: Query[] = [], originals = new Map<D1Statement, D1Statement>();
  const metadata = new Map<D1Statement, Omit<Query, "rows">>();
  const wrap = (sql: string, values: (string | number | null)[] = []): D1Statement => {
    if (!/^SELECT\b/i.test(sql.trim())) throw new Error("Cleanup assessment must be read-only");
    let next = 0;
    const numbered = sql.replace(/\?(\d*)/g, (_match, index: string) => index ? `?${index}` : `?${++next}`);
    const original = values.length ? db.prepare(numbered).bind(...values) : db.prepare(numbered);
    const q = { sql: numbered, values: [...values] };
    const result: D1Statement = { bind: (...args) => wrap(sql, args), all: async <T>() => {
      const r = await original.all<T>();
      if (!r.success) throw new Error("Assessment unavailable");
      queries.push({ ...q, rows: structuredClone(r.results) as object[] }); return r;
    } };
    originals.set(result, original); metadata.set(result, q); return result;
  };
  const binding: D1Binding = { prepare: sql => wrap(sql), batch: async <T>(statements: D1Statement[]) => {
    const results = await db.batch<T>(statements.map(s => originals.get(s)!));
    if (results.length !== statements.length) throw new Error("Assessment unavailable");
    for (const [i, s] of statements.entries()) {
      const q = metadata.get(s); if (!q || !results[i]!.success) throw new Error("Assessment unavailable");
      queries.push({ ...q, rows: structuredClone(results[i]!.results) as object[] });
    }
    return results;
  } };
  return { binding, queries };
}

export class D1RetentionCleanup {
  readonly #db: D1Binding | undefined;
  readonly #config: CleanupConfig | undefined;
  readonly #serviceId: "streamlit";
  private constructor(db: D1Binding | undefined, config: CleanupConfig | undefined, serviceId: "streamlit", token: symbol) {
    if (token !== AUTHORITY) throw new HttpError(403, "invalid_request", "Cleanup authentication is required.");
    this.#db = db; this.#config = config ? structuredClone(config) : undefined; this.#serviceId = serviceId;
  }
  static async authenticate(request: Request, env: CleanupEnv, config?: CleanupConfig): Promise<D1RetentionCleanup> {
    const key = env.COACH_CLEANUP_SECRET;
    if (!key || key === env.COACH_SERVICE_SECRET || key === env.COACH_EVIDENCE_RECOVERY_SECRET)
      throw new HttpError(503, "invalid_response", "Cleanup authority is unavailable.");
    const principal = await authenticate(request, { COACH_SERVICE_SECRET: key });
    const url = new URL(request.url);
    if (request.headers.has("Origin") || request.headers.has("Sec-Fetch-Site")) throw new HttpError(403, "invalid_request", "Cleanup authentication is required.");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) throw new HttpError(400, "invalid_request", "HTTPS is required.");
    return new D1RetentionCleanup(env.COACH_DB, config, principal.serviceId, AUTHORITY);
  }

  async run(after?: CleanupCursor) {
    const deleted = emptyCounts(), skipped: Record<string, number> = {};
    const summary = (state: "completed" | "disabled" | "configuration_missing" | "invalid_request" | "storage_unavailable", nextCursor: CleanupCursor | null = null, uncertain = false) =>
      ({ state, deleted, skipped, nextCursor, uncertain });
    const config = this.#config, db = this.#db;
    if (!config?.enabled) return summary("disabled");
    if (config.enabled !== true || config.approved !== true || typeof config.approvalReference !== "string" ||
        !config.approvalReference.trim() || config.approvalReference.length > 1000 || !validRetentionPolicy(config.retention) ||
        !Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > MAX_BATCH ||
        Object.keys(config).some(k => !["enabled", "approved", "approvalReference", "retention", "batchSize"].includes(k))) return summary("configuration_missing");
    if (after && (!safeInteger(after.retainUntil) || !requestIdPattern.test(after.claimId))) return summary("invalid_request");
    if (!db) return summary("storage_unavailable");
    const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
    try {
      const candidates = await db.prepare(`SELECT id, retain_until FROM idempotency_records INDEXED BY idempotency_cleanup_scan
        WHERE service_id = ? AND retain_until <= unixepoch() ${after ? "AND (retain_until, id) > (?, ?)" : ""}
        ORDER BY retain_until, id LIMIT ?`).bind(this.#serviceId, ...(after ? [after.retainUntil, after.claimId] : []),
          config.batchSize + 1).all<{ id: string; retain_until: number }>();
      if (!candidates.success) return summary("storage_unavailable");
      const page = candidates.results.slice(0, config.batchSize);
      for (const candidate of page) {
        const recorded = capture(db), read = recorded.binding;
        const eligibility = await new D1RetentionEligibility(read, { serviceId: this.#serviceId }, config.retention).inspect(candidate.id);
        if (eligibility.state !== "eligible") {
          if (eligibility.state === "storage_unavailable") return summary("storage_unavailable");
          if (eligibility.state === "retain") for (const reason of eligibility.reasons) skip(reason);
          else skip(eligibility.state);
          continue;
        }
        const plan = await read.batch([
          read.prepare("SELECT reservation_id FROM idempotency_records WHERE id = ? AND service_id = ?").bind(candidate.id, this.#serviceId),
          read.prepare(`SELECT a.id FROM inference_attempts a JOIN idempotency_records i ON i.reservation_id = a.reservation_id
            WHERE i.id = ? AND i.service_id = ?`).bind(candidate.id, this.#serviceId),
          read.prepare(`SELECT l.quota_window_id FROM reservation_quota_windows l JOIN idempotency_records i ON i.reservation_id = l.reservation_id
            WHERE i.id = ? AND i.service_id = ? LIMIT 33`).bind(candidate.id, this.#serviceId),
          read.prepare(`SELECT u.id FROM usage_accounting u JOIN inference_attempts a ON a.id = u.attempt_id
            JOIN idempotency_records i ON i.reservation_id = a.reservation_id WHERE i.id = ? AND i.service_id = ?`).bind(candidate.id, this.#serviceId),
        ]);
        const reservation = plan[0]!.results[0]?.reservation_id as string | null | undefined;
        if (reservation === undefined) { skip("changed_since_inspection"); continue; }
        if (plan[1]!.results.length > 1 || plan[2]!.results.length > 32 || plan[3]!.results.length > 1) { skip("inconsistent_history"); continue; }
        const attempt = plan[1]!.results[0]?.id as string | undefined;
        const clockGate = () => db.prepare(`SELECT CASE WHEN unixepoch() >= ? AND unixepoch() >= ?
          THEN 1 ELSE json('cleanup_precondition_failed') END AS checked`).bind(eligibility.eligibleAfter!, eligibility.evaluatedAt);
        const statements: D1Statement[] = [clockGate(), ...recorded.queries.map(q => snapshotGate(db, q, q.rows))];
        const expected: (number | null)[] = statements.map(() => null), counts = emptyCounts();
        const remove = (table: keyof Counts, sql: string, values: (string | number | null)[], count: number) => {
          statements.push(db.prepare(sql).bind(...values), db.prepare(`SELECT CASE WHEN changes() = ? THEN 1 ELSE json('cleanup_precondition_failed') END AS checked`).bind(count));
          expected.push(count, null); counts[table] = count;
        };
        if (reservation !== null) {
          remove("usage_accounting", "DELETE FROM usage_accounting WHERE attempt_id = ?", [attempt ?? ""], plan[3]!.results.length);
          remove("reservation_quota_windows", "DELETE FROM reservation_quota_windows WHERE reservation_id = ?", [reservation], plan[2]!.results.length);
          remove("inference_attempts", "DELETE FROM inference_attempts WHERE id = ? AND reservation_id = ?", [attempt ?? "", reservation], plan[1]!.results.length);
        }
        remove("idempotency_records", "DELETE FROM idempotency_records WHERE id = ? AND service_id = ? AND generation = ?", [candidate.id, this.#serviceId, eligibility.generation], 1);
        if (reservation !== null) remove("request_reservations", "DELETE FROM request_reservations WHERE id = ? AND service_id = ?", [reservation, this.#serviceId], 1);
        statements.push(clockGate()); expected.push(null);
        try {
          const result = await db.batch<{ checked: number }>(statements);
          if (result.length !== statements.length || result.some((r, i) => !r.success ||
              (expected[i] === null ? r.meta.changes !== 0 || r.results[0]?.checked !== 1 : r.meta.changes !== expected[i]))) return summary("storage_unavailable", null, true);
          for (const table of Object.keys(counts) as (keyof Counts)[]) deleted[table] += counts[table];
        } catch (error) {
          if (error instanceof Error && /malformed JSON|cleanup_precondition_failed/.test(error.message)) { skip("changed_since_inspection"); continue; }
          return summary("storage_unavailable", null, true);
        }
      }
      const last = page.at(-1);
      return summary("completed", candidates.results.length > config.batchSize && last ? { retainUntil: last.retain_until, claimId: last.id } : null);
    } catch { return summary("storage_unavailable"); }
  }
}
