import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createGateway } from "../src/handlers/gateway";
import { localServices, type LocalDurableConfig } from "../src/local-services";
import { LocalMockProvider, MockSourceResolver } from "../src/providers/mock";
import type { InferenceProvider } from "../src/providers/types";
import type { D1Binding, D1Statement, D1QueryResult } from "../src/storage/d1-quota-admission";
import { fixture } from "./fixtures";

export type DB = Awaited<ReturnType<Miniflare["getD1Database"]>>;
export const secret = "a".repeat(64), fingerprint = "b".repeat(64);
export const tables = ["usage_accounting", "idempotency_records", "inference_attempts", "reservation_quota_windows", "request_reservations", "provider_quota_windows"];
export const environment = (db?: D1Binding) => ({ COACH_SERVICE_SECRET: secret, COACH_FINGERPRINT_SECRET: fingerprint, ...(db ? { COACH_DB: db } : {}) });
export const runtime = (directory?: string) => new Miniflare(convertV4MiniflareOptions({ modules: true,
  script: "export default { fetch() { return new Response('local pipeline tests'); } };", compatibilityDate: "2026-11-03", cf: false,
  telemetry: { enabled: false }, d1Databases: { COACH_DB: "pipeline-tests" }, ...(directory ? { resourcePersistencePath: directory } : {}),
  outboundService: () => { throw new Error("External networking forbidden in pipeline tests"); },
}));
export async function migrate(db: DB) {
  const names = (await readdir(new URL("../migrations/", import.meta.url))).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort();
  for (const name of names) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    for (const statement of sql.replace(/--[^\n]*/g, "").split(/;(?!\s*END\b)/i).map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
}
export async function seed(db: DB, capacity = 100000): Promise<LocalDurableConfig> {
  const start = Math.floor(Date.now() / 1000) - 5;
  const metrics = ["requests", "requests", "tokens", "tokens", "input_tokens", "output_tokens", "compute_units"] as const;
  const durations = [3600, 86400, 3600, 86400, 3601, 3602, 300];
  const windows = metrics.map((metric, n) => ({ windowId: `w${n}`, model: "mock-model", metric,
    unit: metric === "requests" ? "requests" : metric === "compute_units" ? "milli_neurons" : "tokens",
    capacity, safetyMargin: 0, windowStart: start, windowSeconds: durations[n]! }));
  for (const w of windows) await db.prepare(`INSERT INTO provider_quota_windows (id, quota_scope_id, provider, model, dimension, unit,
    window_start, window_seconds, window_end, limit_amount, created_at, updated_at, retain_until)
    VALUES (?, 'local-mock', 'mock', 'mock-model', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(w.windowId, w.metric === "input_tokens" || w.metric === "output_tokens" ? "tokens" : w.metric, w.unit,
      start, w.windowSeconds, start + w.windowSeconds, capacity, start, start, start + w.windowSeconds + 7200).run();
  return { ownership: { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 7200 },
    quota: { provider: "mock", model: "mock-model", quotaScopeId: "local-mock", leaseSeconds: 120, retentionSeconds: 7200, windows },
    estimate: { kind: "estimated", requests: 1, inputTokens: 10, outputTokens: 20, computeUnits: { milli_neurons: 40 } } };
}
export function request(id = crypto.randomUUID(), body: unknown = fixture("term_clarification").request, extra: Record<string, string> = {}) {
  return new Request("http://127.0.0.1/api/coach/generate", { method: "POST", headers: {
    Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "X-ResearchBridge-Request-ID": id, ...extra,
  }, body: JSON.stringify(body) });
}
export function gateway(db: D1Binding | undefined, config: LocalDurableConfig, provider: InferenceProvider = new LocalMockProvider(), timeoutMs = 50) {
  const services = localServices(environment(db), config);
  return { services, handler: createGateway({ mode: "local", enabled: true, provider, sources: new MockSourceResolver(),
    timeoutMs, ...(services ? { durable: services.durable } : {}) }) };
}
export async function snapshot(db: DB): Promise<Record<string, Record<string, unknown>[]>> {
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
}
// Inject at SQL boundaries without changing the real local D1 transaction engine.
export function fault(db: DB, match: (sql: string[]) => boolean, effect: (statements: D1Statement[]) => Promise<void>, afterCommit = false): D1Binding {
  const sqlByStatement = new Map<D1Statement, string>();
  const wrap = (statement: D1Statement, sql: string): D1Statement => {
    const wrapped: D1Statement = { bind: (...args) => wrap(statement.bind(...args), sql), all: <T>() => statement.all<T>() };
    sqlByStatement.set(wrapped, sql); originals.set(wrapped, statement); return wrapped;
  };
  const originals = new Map<D1Statement, D1Statement>();
  return { prepare: sql => wrap(db.prepare(sql), sql), async batch<T>(statements: D1Statement[]): Promise<D1QueryResult<T>[]> {
    const matches = match(statements.map(s => sqlByStatement.get(s)!));
    const actual = statements.map(s => originals.get(s)!);
    if (matches && !afterCommit) await effect(actual);
    const results = await db.batch<T>(actual);
    if (matches && afterCommit) await effect(actual);
    return results;
  } };
}
