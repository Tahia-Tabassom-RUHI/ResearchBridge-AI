import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { FailureAccountingInput, FailureMeasurement, FailureReport, FailureUsage, IdempotencyFence, QuotaMetric, TransitionDecision } from "../src/storage";
import { D1FailureAccounting } from "../src/storage/d1-failure-accounting";
import { D1IdempotencyStore } from "../src/storage/d1-idempotency";
import { D1QuotaAdmission, type D1Binding, type D1QueryResult, type D1Statement } from "../src/storage/d1-quota-admission";
import { D1UsageSettlement } from "../src/storage/d1-usage-settlement";
import { sha256 } from "../src/storage/request-identity";

type DB = Awaited<ReturnType<Miniflare["getD1Database"]>>;
const policy = { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 7200 };
const files = (await readdir(new URL("../migrations/", import.meta.url))).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort();
const tables = ["usage_accounting", "idempotency_records", "inference_attempts", "reservation_quota_windows", "request_reservations", "provider_quota_windows"];
const runtime = (directory?: string) => new Miniflare(convertV4MiniflareOptions({
  modules: true, script: "export default { fetch() { return new Response('local failure accounting tests'); } };",
  compatibilityDate: "2026-11-03", cf: false, telemetry: { enabled: false }, d1Databases: { COACH_DB: "failure-accounting-tests" },
  ...(directory ? { resourcePersistencePath: directory } : {}),
  outboundService: () => { throw new Error("External networking is forbidden in failure accounting tests"); },
}));
async function migrate(db: DB, names = files) {
  for (const name of names) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    for (const statement of sql.replace(/--[^\n]*/g, "").split(/;(?!\s*END\b)/i).map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
}
function updated(r: TransitionDecision): IdempotencyFence {
  assert.equal(r.state, "updated", JSON.stringify(r));
  if (r.state !== "updated") throw new Error("Lifecycle rejected");
  return r.fence;
}
const measured = (amount: number): FailureMeasurement => ({ kind: "measured", amount, evidence: "provider_report" });
const estimated = (amount: number): FailureMeasurement => ({ kind: "estimated", amount, evidence: "explicit_upper_bound_v1" });
const unknown: FailureReport = { category: "UNKNOWN_OUTCOME", reason: "response_missing" };
const proven: FailureReport = { category: "PROVEN_PRE_DISPATCH_FAILURE", reason: "preparation_failed" };
const providerError = (usage?: FailureUsage, httpStatus = 500): FailureReport => ({ category: "CONFIRMED_PROVIDER_ERROR", reason: "provider_http_error", httpStatus,
  ...(usage !== undefined ? { usage } : {}) });
type Options = { provider?: string; model?: string; metrics?: QuotaMetric[];
  stage?: "reserved" | "prepared" | "sent" | "completed" | "unknown_unmarked" | "not_sent" | "prepared_then_failed" };
async function fixture(db: DB, options: Options = {}) {
  const provider = options.provider ?? "groq", model = options.model ?? "test-model", prefix = crypto.randomUUID();
  const start = Math.floor(Date.now() / 1000) - 10;
  const windows = (options.metrics ?? ["requests", "tokens", "compute_units"]).map((metric, index) => ({ windowId: `${prefix}-${index}`, model,
    metric, unit: metric === "requests" ? "requests" : metric === "compute_units" ? "milli_neurons" : "tokens",
    capacity: 1000, safetyMargin: 0, windowStart: start, windowSeconds: 600 + index }));
  for (const w of windows) await db.prepare(`INSERT INTO provider_quota_windows (id, quota_scope_id, provider, model, dimension,
    unit, window_start, window_seconds, window_end, limit_amount, consumed_amount, created_at, updated_at, retain_until)
    VALUES (?, 'test-account', ?, ?, ?, ?, ?, ?, ?, 1000, 2, ?, ?, ?)`)
    .bind(w.windowId, provider, model, ["requests", "compute_units"].includes(w.metric) ? w.metric : "tokens", w.unit,
      start, w.windowSeconds, start + w.windowSeconds, start, start, start + 10000).run();
  const store = new D1IdempotencyStore(db, policy);
  const claim = await store.claim({ serviceId: "streamlit", keyHash: await sha256(crypto.randomUUID()), payloadHash: await sha256("failure fixture"),
    fingerprintKeyId: await sha256("local fixture key id"), responseVersion: "2" });
  assert.equal(claim.state, "acquired"); if (claim.state !== "acquired") throw new Error("Claim rejected");
  let fence = claim.fence;
  const admission = new D1QuotaAdmission(db, [{ provider, model, quotaScopeId: "test-account", leaseSeconds: 120, retentionSeconds: 7200, windows }]);
  const estimate = { kind: "estimated" as const, requests: 1, inputTokens: 10, outputTokens: 20, computeUnits: { milli_neurons: 40 } };
  const admitted = await admission.reserve({ serviceId: fence.serviceId, requestId: fence.claimId, provider, model, claim: fence, estimate });
  assert.ok(admitted.admitted, JSON.stringify(admitted));
  fence = { ...fence, generation: fence.generation + 1 };
  const stage = options.stage;
  if (stage === "not_sent") fence = updated(await store.failBeforeDispatch(fence));
  else if (stage !== "reserved") {
    fence = updated(await store.authorizeDispatch(fence));
    if (stage === "prepared_then_failed") fence = updated(await store.failBeforeDispatch(fence));
    else if (stage !== "prepared") {
      fence = updated(await store.dispatch(fence));
      if (stage !== "sent") fence = updated(await store[stage === "completed" ? "complete" : "markUnknown"](fence));
    }
  }
  if (!stage || ["not_sent", "prepared_then_failed", "completed"].includes(stage)) fence = updated(await store.awaitReconciliation(fence));
  const attempt = await db.prepare("SELECT id FROM inference_attempts WHERE reservation_id = ?").bind(admitted.reservationId).first<{ id: string }>();
  const input: FailureAccountingInput = { fence, reservationId: admitted.reservationId, attemptId: attempt?.id ?? crypto.randomUUID(), provider, model,
    failure: stage === "not_sent" || stage === "prepared_then_failed" ? proven : unknown };
  return { input, store, admission, estimate, windows, accounting: new D1FailureAccounting(db) };
}
async function snapshot(db: DB): Promise<Record<string, Record<string, unknown>[]>> {
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
}
async function counters(db: DB): Promise<{ reserved_amount: number; consumed_amount: number }[]> {
  return (await db.prepare("SELECT reserved_amount, consumed_amount FROM provider_quota_windows ORDER BY rowid").all()).results;
}
const recorded = (accounting: "held" | "partial" | "accounted" | "released", state = "recorded") => ({ state, accounting, retryable: false });

test("failure accounting on real local D1", { timeout: 240_000 }, async t => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const scenario = (name: string, fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, options: Options = {}) => t.test(name, async () => {
      await db.batch(tables.map(table => db.prepare(`DELETE FROM ${table}`)));
      await fn(await fixture(db, options));
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });
    await scenario("proven failure before authorization releases all windows and records no measured zero", async ({ input, accounting, store }) => {
      assert.deepEqual(await accounting.record(input), recorded("released"));
      assert.deepEqual(await counters(db), [1, 2, 3].map(() => ({ reserved_amount: 0, consumed_amount: 2 })));
      const s = await snapshot(db);
      assert.ok(s.reservation_quota_windows!.every(l => l.status === "released" && l.settled_amount === 0 && l.failure_basis === "proven_not_sent"));
      assert.equal(s.usage_accounting!.length, 0);
      assert.equal((await store.lookup(input.fence)).state, "failed");
      assert.equal(s.inference_attempts![0]!.status, "not_sent");
    }, { stage: "not_sent" });
    await scenario("authorized preparation can release only after fenced non-dispatch closure", async ({ input, accounting, store }) => {
      assert.deepEqual(await accounting.record(input), recorded("released"));
      assert.equal((await store.dispatch(input.fence)).state, "stale_owner");
    }, { stage: "prepared_then_failed" });
    await scenario("duplicate pre-dispatch failure never refunds twice", async ({ input, accounting }) => {
      assert.deepEqual(await accounting.record(input), recorded("released"));
      const before = await snapshot(db);
      assert.deepEqual(await accounting.record(input), recorded("released", "already_recorded"));
      assert.deepEqual(await accounting.inspect(input), recorded("released", "already_recorded"));
      assert.deepEqual(await snapshot(db), before);
    }, { stage: "not_sent" });
    await scenario("20 concurrent pre-dispatch releases have one writer", async ({ input, accounting }) => {
      const results = await Promise.all(Array.from({ length: 20 }, () => accounting.record(input)));
      assert.equal(results.filter(r => r.state === "recorded").length, 1, JSON.stringify(results));
      assert.equal(results.filter(r => r.state === "already_recorded").length, 19);
      assert.ok((await counters(db)).every(w => w.reserved_amount === 0 && w.consumed_amount === 2));
    }, { stage: "not_sent" });
    for (const stage of ["reserved", "prepared", "sent", "unknown_unmarked", "completed"] as const) {
      await scenario(`${stage} state alone cannot authorize a release`, async ({ input, accounting }) => {
        const before = await snapshot(db);
        const result = await accounting.record({ ...input, failure: proven });
        assert.ok(["stale_owner", "invalid_state"].includes(result.state));
        assert.deepEqual(await snapshot(db), before);
      }, { stage });
    }
    await scenario("dispatch and non-dispatch closure race: only the durable winner determines accounting", async ({ input, store, accounting }) => {
      const results = await Promise.all([store.dispatch(input.fence), store.failBeforeDispatch(input.fence)]);
      assert.equal(results.filter(r => r.state === "updated").length, 1);
      if (results[0]!.state === "updated") {
        input.fence = updated(await store.awaitReconciliation(updated(await store.markUnknown(results[0]!.fence))));
        input.failure = unknown;
        assert.deepEqual(await accounting.record(input), recorded("held"));
      } else {
        input.fence = updated(await store.awaitReconciliation(updated(results[1]!))); input.failure = proven;
        assert.deepEqual(await accounting.record(input), recorded("released"));
      }
      assert.equal((await store.dispatch(input.fence)).state, "stale_owner");
    }, { stage: "prepared" });
    await scenario("lost dispatch acknowledgement cannot turn a prepared owner's fence into release authority", async ({ input, accounting, store }) => {
      let providerCalls = 0;
      const uncertain: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        await db.batch(statements); throw new Error("Lost dispatch acknowledgement");
      } };
      const dispatched = await new D1IdempotencyStore(uncertain, policy).dispatch(input.fence);
      if (dispatched.state === "updated") providerCalls++;
      assert.equal(dispatched.state, "storage_unavailable");
      const before = await snapshot(db);
      assert.equal((await accounting.record({ ...input, failure: proven })).state, "stale_owner");
      assert.equal((await store.failBeforeDispatch(input.fence)).state, "stale_owner");
      assert.deepEqual(await store.claim(input.fence), { state: "dispatched", retryable: false });
      assert.equal(providerCalls, 0); assert.deepEqual(await snapshot(db), before);
    }, { stage: "prepared" });
    for (const failure of [
      { category: "POSSIBLY_DISPATCHED_FAILURE", reason: "request_timeout" },
      { category: "POSSIBLY_DISPATCHED_FAILURE", reason: "connection_failure" },
      { category: "POSSIBLY_DISPATCHED_FAILURE", reason: "interrupted_send" },
      { category: "UNKNOWN_OUTCOME", reason: "crash_boundary" }, unknown,
      { category: "UNKNOWN_OUTCOME", reason: "ambiguous_response" },
      { category: "INVALID_OR_UNTRUSTED_USAGE", reason: "malformed_response" },
      { category: "INVALID_OR_UNTRUSTED_USAGE", reason: "missing_usage" },
    ] as FailureReport[]) {
      await scenario(`${failure.reason} keeps unknown capacity and cannot authorize redispatch`, async ({ input, accounting, store }) => {
        const before = await counters(db); input.failure = failure;
        assert.deepEqual(await accounting.record(input), recorded("held"));
        assert.deepEqual(await counters(db), before);
        const s = await snapshot(db);
        assert.ok(s.reservation_quota_windows!.every(l => l.status === "unknown" && l.settled_amount === null && l.failure_held_amount === l.reserved_amount));
        assert.equal(s.usage_accounting!.length, 0); assert.equal(s.inference_attempts![0]!.status, "unknown");
        assert.deepEqual(await store.claim(input.fence), { state: "outcome_unknown", retryable: false });
        assert.equal((await store.dispatch(input.fence)).state, "stale_owner");
        assert.deepEqual(await accounting.record(input), recorded("held", "already_recorded"));
      });
    }
    for (const httpStatus of [400, 401, 403, 429, 500, 503]) {
      await scenario(`HTTP ${httpStatus} alone never implies zero consumption or a reset time`, async ({ input, accounting }) => {
        const before = await counters(db); input.failure = providerError(undefined, httpStatus);
        assert.deepEqual(await accounting.record(input), recorded("held"));
        assert.deepEqual(await counters(db), before);
        assert.equal((await db.prepare("SELECT count(*) AS n FROM provider_holds").first()).n, 0);
      });
    }
    await scenario("trusted request count with missing tokens/compute settles only that dimension", async ({ input, accounting }) => {
      input.failure = providerError({ requests: measured(1) });
      assert.deepEqual(await accounting.record(input), recorded("partial"));
      assert.deepEqual(await counters(db), [{ reserved_amount: 0, consumed_amount: 3 }, { reserved_amount: 30, consumed_amount: 2 }, { reserved_amount: 40, consumed_amount: 2 }]);
    });
    await scenario("provider-specific evidence of no token charge releases tokens but not other dimensions", async ({ input, accounting }) => {
      input.failure = providerError({ totalTokens: measured(0) }, 429);
      assert.deepEqual(await accounting.record(input), recorded("partial"));
      assert.deepEqual(await counters(db), [{ reserved_amount: 1, consumed_amount: 2 }, { reserved_amount: 0, consumed_amount: 2 }, { reserved_amount: 40, consumed_amount: 2 }]);
    });
    await scenario("independent input/output/combined tokens and compute report exact overages", async ({ input, accounting }) => {
      input.failure = providerError({ requests: measured(1), inputTokens: measured(8), outputTokens: measured(25), computeUnits: { milli_neurons: measured(1500) } });
      assert.deepEqual(await accounting.record(input), recorded("accounted"));
      assert.deepEqual(await counters(db), [3, 10, 27, 35, 1502].map(consumed_amount => ({ reserved_amount: 0, consumed_amount })));
      assert.equal((await db.prepare("SELECT status FROM inference_attempts").first()).status, "unknown");
      assert.equal((await db.prepare("SELECT count(*) AS n FROM usage_accounting").first()).n, 0);
    }, { metrics: ["requests", "input_tokens", "output_tokens", "tokens", "compute_units"] });
    await scenario("partial input tokens cannot become a measured combined total", async ({ input, accounting }) => {
      input.failure = providerError({ inputTokens: measured(50) });
      assert.deepEqual(await accounting.record(input), recorded("partial"));
      assert.deepEqual(await counters(db), [{ reserved_amount: 0, consumed_amount: 52 }, { reserved_amount: 20, consumed_amount: 2 }, { reserved_amount: 50, consumed_amount: 2 }]);
      const combined = await db.prepare("SELECT settled_amount, failure_held_amount FROM reservation_quota_windows WHERE quota_metric = 'tokens'").first();
      assert.deepEqual(combined, { settled_amount: null, failure_held_amount: 50 });
    }, { metrics: ["input_tokens", "output_tokens", "tokens"] });
    await scenario("mixed measured and conservative estimates retain distinct provenance", async ({ input, accounting }) => {
      input.failure = providerError({ requests: measured(1), inputTokens: measured(10), outputTokens: estimated(25), computeUnits: { milli_neurons: estimated(45) } });
      assert.deepEqual(await accounting.record(input), recorded("accounted"));
      assert.deepEqual(await counters(db), [3, 37, 47].map(consumed_amount => ({ reserved_amount: 0, consumed_amount })));
      const report = JSON.parse((await db.prepare("SELECT failure_usage FROM inference_attempts").first()).failure_usage);
      assert.equal(report.requests.kind, "measured"); assert.equal(report.totalTokens.kind, "estimated");
    });
    await scenario("conservative estimates cannot lower a reservation", async ({ input, accounting }) => {
      const before = await snapshot(db); input.failure = providerError({ totalTokens: estimated(29) });
      assert.equal((await accounting.record(input)).state, "invalid_usage"); assert.deepEqual(await snapshot(db), before);
    });
    await scenario("missing request usage is persisted as NULL, never measured zero", async ({ input, accounting }) => {
      input.failure = providerError({ totalTokens: measured(12) });
      assert.deepEqual(await accounting.record(input), recorded("partial"));
      const report = JSON.parse((await db.prepare("SELECT failure_usage FROM inference_attempts").first()).failure_usage);
      assert.equal(report.requests, null); assert.equal(report.inputTokens, null);
      assert.equal((await db.prepare("SELECT count(*) AS n FROM usage_accounting").first()).n, 0);
    });
    await scenario("malformed/untrusted usage is rejected without refund; sanitized failure can record a hold", async ({ input, accounting }) => {
      const before = await snapshot(db);
      const bad: unknown[] = [null, [], { requests: null }, { requests: 1 }, { requests: { ...measured(0), evidence: "untrusted" } },
        { computeUnits: null }, { computeUnits: [] }, { computeUnits: { milli_neurons: measured(-1) } }, { response: "PRIVATE RESPONSE" }];
      for (const amount of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
        bad.push({ requests: { ...measured(0), amount } });
      }
      for (const usage of bad) assert.equal((await accounting.record({ ...input, failure: providerError(usage as FailureUsage) })).state, "invalid_usage");
      assert.deepEqual(await snapshot(db), before);
      input.failure = { category: "INVALID_OR_UNTRUSTED_USAGE", reason: "malformed_usage" };
      assert.deepEqual(await accounting.record(input), recorded("held"));
    });
    await scenario("contradictory token reports and unsafe sums are rejected", async ({ input, accounting }) => {
      const before = await snapshot(db);
      for (const usage of [
        { inputTokens: measured(10), outputTokens: measured(20), totalTokens: measured(31) },
        { inputTokens: measured(10), totalTokens: measured(9) },
        { inputTokens: measured(10), outputTokens: estimated(20), totalTokens: measured(31) },
        { inputTokens: measured(10), totalTokens: estimated(9) },
        { inputTokens: measured(Number.MAX_SAFE_INTEGER), outputTokens: measured(1) },
      ]) assert.equal((await accounting.record({ ...input, failure: providerError(usage) })).state, "invalid_usage");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("an upper bound can exceed a measured total without being mislabeled contradictory", async ({ input, accounting }) => {
      input.failure = providerError({ inputTokens: estimated(50), outputTokens: measured(2), totalTokens: measured(12) });
      assert.deepEqual(await accounting.record(input), recorded("partial"));
      assert.equal((await counters(db))[1]!.consumed_amount, 14);
    });
    await scenario("structured category/reason/HTTP status fields reject arbitrary data", async ({ input, accounting }) => {
      const before = await snapshot(db);
      for (const failure of [null, {}, { category: "UNKNOWN_OUTCOME", reason: "private prompt" }, { ...unknown, httpStatus: 500 },
        { ...unknown, response: "PRIVATE RESPONSE" }, providerError(undefined, 200), providerError(undefined, 600), providerError(undefined, 401.5)]) {
        assert.equal((await accounting.record({ ...input, failure: failure as FailureReport })).state, "invalid_failure");
      }
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("a proven non-dispatch report cannot also carry provider usage", async ({ input, accounting }) => {
      const before = await snapshot(db);
      assert.equal((await accounting.record({ ...input, failure: { ...proven, usage: { requests: measured(1) } } as FailureReport })).state, "invalid_usage");
      assert.deepEqual(await snapshot(db), before);
    }, { stage: "not_sent" });
    await scenario("Cloudflare and Groq with the same error status retain independent evidence and budgets", async first => {
      const second = await fixture(db, { provider: "cloudflare" });
      first.input.failure = providerError({ requests: measured(1) }, 429);
      second.input.failure = providerError({ requests: measured(0) }, 429);
      assert.equal((await first.accounting.record({ ...first.input, provider: "cloudflare" })).state, "stale_owner");
      assert.deepEqual(await first.accounting.record(first.input), recorded("partial"));
      assert.equal((await counters(db))[3]!.reserved_amount, 1);
      assert.deepEqual(await second.accounting.record(second.input), recorded("partial"));
      assert.deepEqual((await counters(db))[3], { reserved_amount: 0, consumed_amount: 2 });
      assert.deepEqual((await counters(db))[0], { reserved_amount: 0, consumed_amount: 3 });
    });
    await scenario("wrong model, attempt, reservation or owner cannot release or inspect", async ({ input, accounting }) => {
      const before = await snapshot(db);
      const inputs = [{ ...input, attemptId: crypto.randomUUID() }, { ...input, reservationId: crypto.randomUUID() }, { ...input, model: "other" }];
      for (const variant of [{ serviceId: "other" }, { claimId: crypto.randomUUID() }, { token: "0".repeat(64) }, { keyHash: "0".repeat(64) },
        { payloadHash: "0".repeat(64) }, { fingerprintKeyId: "0".repeat(64) }, { responseVersion: "1" as const }]) inputs.push({ ...input, fence: { ...input.fence, ...variant } });
      for (const wrong of inputs) {
        assert.equal((await accounting.record(wrong)).state, "stale_owner"); assert.equal((await accounting.inspect(wrong)).state, "stale_owner");
      }
      assert.deepEqual(await snapshot(db), before);
    }, { stage: "not_sent" });
    await scenario("stale generations and expired leases never grant accounting or receipt access", async ({ input, accounting }) => {
      assert.deepEqual(await accounting.record(input), recorded("held"));
      for (const generation of [input.fence.generation - 1, 0, 1.5, Number.MAX_SAFE_INTEGER, Infinity]) {
        const stale = { ...input, fence: { ...input.fence, generation } };
        assert.equal((await accounting.record(stale)).state, "stale_owner"); assert.equal((await accounting.inspect(stale)).state, "stale_owner");
      }
      await db.prepare("UPDATE idempotency_records SET lease_expires_at = created_at").run();
      const before = await snapshot(db);
      assert.equal((await accounting.record(input)).state, "stale_owner"); assert.deepEqual(await snapshot(db), before);
    });
    await scenario("expired reservation or missing response alone cannot refund prepared capacity", async ({ input, accounting }) => {
      await db.prepare("UPDATE request_reservations SET expires_at = created_at").run();
      const before = await snapshot(db); input.failure = proven;
      assert.equal((await accounting.record(input)).state, "invalid_state"); assert.deepEqual(await snapshot(db), before);
    }, { stage: "prepared" });
    await scenario("conflicting duplicate evidence is immutable", async ({ input, accounting }) => {
      input.failure = providerError({ requests: measured(1) });
      assert.deepEqual(await accounting.record(input), recorded("partial"));
      const before = await snapshot(db);
      assert.equal((await accounting.record({ ...input, failure: providerError({ requests: measured(2) }) })).state, "conflict");
      assert.equal((await accounting.record({ ...input, failure: proven })).state, "invalid_state");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("concurrent partial usage reports account once", async ({ input, accounting }) => {
      input.failure = providerError({ requests: measured(1) });
      const results = await Promise.all(Array.from({ length: 10 }, () => accounting.record(input)));
      assert.equal(results.filter(r => r.state === "recorded").length, 1);
      assert.equal(results.filter(r => r.state === "already_recorded").length, 9);
      assert.deepEqual((await counters(db))[0], { reserved_amount: 0, consumed_amount: 3 });
    });
    await scenario("concurrent conflicting evidence has one winner", async ({ input, accounting }) => {
      const results = await Promise.all([accounting.record({ ...input, failure: providerError({ requests: measured(1) }) }),
        accounting.record({ ...input, failure: providerError({ requests: measured(2) }) })]);
      assert.deepEqual(results.map(r => r.state).sort(), ["conflict", "recorded"]);
    });
    await scenario("failure cannot mutate a successful settlement receipt", async ({ input, accounting }) => {
      const success = await new D1UsageSettlement(db).settle({ ...input, usage: { kind: "measured", requests: 1, totalTokens: 20, computeUnits: { milli_neurons: 25 } } });
      assert.equal(success.state, "settled"); const before = await snapshot(db);
      for (const failure of [unknown, proven, providerError({ requests: measured(0) })]) {
        assert.equal((await accounting.record({ ...input, failure })).state, "conflict");
      }
      assert.deepEqual(await snapshot(db), before);
    }, { stage: "completed" });
    await scenario("unknown failure receipt cannot be converted into successful settlement", async ({ input, accounting, store }) => {
      assert.deepEqual(await accounting.record(input), recorded("held")); const before = await snapshot(db);
      assert.equal((await new D1UsageSettlement(db).settle({ ...input, usage: { kind: "measured", requests: 1, totalTokens: 0 } })).state, "invalid_state");
      assert.equal((await store.complete(input.fence)).state, "stale_owner"); assert.deepEqual(await snapshot(db), before);
    });
    for (const index of [0, 2, 4, 6, 8, 10, 12, 14]) {
      await scenario(`zero-row write ${index} rolls back receipt and every window`, async ({ input }) => {
        input.failure = providerError({ requests: measured(1), totalTokens: measured(0) });
        const before = await snapshot(db);
        const broken: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
          const actual = [...statements]; if (actual.length > 2) actual[index] = db.prepare("UPDATE inference_attempts SET status = 'unknown' WHERE 0");
          return db.batch(actual) as Promise<D1QueryResult<T>[]>;
        } };
        assert.equal((await new D1FailureAccounting(broken).record(input)).state, "invalid_accounting");
        assert.deepEqual(await snapshot(db), before);
      });
    }
    for (const [name, sql] of [
      ["underflow", "UPDATE provider_quota_windows SET reserved_amount = 0 WHERE dimension = 'tokens'"],
      ["consumed overflow", `UPDATE provider_quota_windows SET consumed_amount = ${Number.MAX_SAFE_INTEGER} WHERE dimension = 'requests'`],
      ["fractional counter", "UPDATE provider_quota_windows SET reserved_amount = 40.5 WHERE dimension = 'compute_units'"],
      ["ambiguous legacy metric", "UPDATE reservation_quota_windows SET quota_metric = NULL WHERE quota_metric = 'tokens'"],
    ]) await scenario(`${name} fails without partial accounting`, async ({ input, accounting }) => {
      input.failure = providerError({ requests: measured(1) }); await db.prepare(sql!).run(); const before = await snapshot(db);
      assert.equal((await accounting.record(input)).state, "invalid_accounting"); assert.deepEqual(await snapshot(db), before);
    });
    await scenario("increased unknown hold cannot overflow reserved counters", async ({ input, accounting }) => {
      await db.prepare("UPDATE provider_quota_windows SET reserved_amount = ? WHERE dimension = 'tokens'").bind(Number.MAX_SAFE_INTEGER).run();
      const before = await snapshot(db); input.failure = providerError({ inputTokens: measured(50) });
      assert.equal((await accounting.record(input)).state, "invalid_accounting"); assert.deepEqual(await snapshot(db), before);
    });
    await scenario("safe integer boundary accounting remains exact", async ({ input, accounting }) => {
      await db.prepare("UPDATE provider_quota_windows SET consumed_amount = ? WHERE dimension = 'requests'").bind(Number.MAX_SAFE_INTEGER - 1).run();
      input.failure = providerError({ requests: measured(1) });
      assert.deepEqual(await accounting.record(input), recorded("partial"));
      assert.equal((await counters(db))[0]!.consumed_amount, Number.MAX_SAFE_INTEGER);
    });
    await scenario("ownership lost between read and write is rejected transactionally", async ({ input }) => {
      let before: Awaited<ReturnType<typeof snapshot>>;
      const raced: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        if (statements.length > 2) { await db.prepare("UPDATE idempotency_records SET generation = generation + 1").run(); before = await snapshot(db); }
        return db.batch(statements) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await new D1FailureAccounting(raced).record(input)).state, "stale_owner"); assert.deepEqual(await snapshot(db), before!);
    });
    await scenario("late SQL constraint failure rolls back the release receipt and counters", async ({ input }) => {
      const before = await snapshot(db);
      const broken: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        return db.batch(statements.length > 2 ? [...statements, db.prepare("UPDATE inference_attempts SET status = 'invalid'")] : statements) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await new D1FailureAccounting(broken).record(input)).state, "storage_unavailable");
      assert.deepEqual(await snapshot(db), before);
    }, { stage: "not_sent" });
    await scenario("missing owner guard cannot silently allow a refund", async ({ input }) => {
      let before: Awaited<ReturnType<typeof snapshot>>;
      const raced: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        if (statements.length > 2) { await db.prepare("DELETE FROM idempotency_records").run(); before = await snapshot(db); }
        return db.batch(statements) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await new D1FailureAccounting(raced).record(input)).state, "stale_owner"); assert.deepEqual(await snapshot(db), before!);
    }, { stage: "not_sent" });
    await scenario("database unavailable reports neither accounting nor release success", async ({ input }) => {
      const broken: D1Binding = { prepare() { throw new Error("private DB detail"); }, async batch() { throw new Error("private DB detail"); } };
      for (const binding of [undefined, broken]) for (const method of ["record", "inspect"] as const) {
        assert.deepEqual(await new D1FailureAccounting(binding)[method](input), { state: "storage_unavailable", retryable: false });
      }
    });
    await scenario("read-only inspection before an operation cannot release capacity", async ({ input, accounting }) => {
      const before = await snapshot(db); assert.equal((await accounting.inspect(input)).state, "not_recorded");
      assert.deepEqual(await snapshot(db), before);
    }, { stage: "not_sent" });
    await scenario("lost write acknowledgement is confirmed by inspection, never a blind refund", async ({ input, accounting }) => {
      const uncertain: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        const results = await db.batch(statements); if (statements.length > 2) throw new Error("Lost acknowledgement");
        return results as D1QueryResult<T>[];
      } };
      assert.equal((await new D1FailureAccounting(uncertain).record(input)).state, "storage_unavailable"); const before = await snapshot(db);
      assert.deepEqual(await accounting.inspect(input), recorded("released", "already_recorded"));
      assert.deepEqual(await accounting.record(input), recorded("released", "already_recorded")); assert.deepEqual(await snapshot(db), before);
    }, { stage: "not_sent" });
    await scenario("pre-write failure leaves all capacity reserved and no receipt", async ({ input, accounting }) => {
      const before = await snapshot(db);
      const broken: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        if (statements.length > 2) throw new Error("Unavailable before write"); return db.batch(statements) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await new D1FailureAccounting(broken).record(input)).state, "storage_unavailable");
      assert.equal((await accounting.inspect(input)).state, "not_recorded"); assert.deepEqual(await snapshot(db), before);
    }, { stage: "not_sent" });
    await scenario("unexpected row acknowledgement is unavailable even if the receipt committed", async ({ input, accounting }) => {
      const broken: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        const results = await db.batch(statements); if (statements.length > 2) results[0].meta.changes = 0; return results as D1QueryResult<T>[];
      } };
      assert.equal((await new D1FailureAccounting(broken).record(input)).state, "storage_unavailable");
      assert.deepEqual(await accounting.inspect(input), recorded("held", "already_recorded"));
    });
    await scenario("release preserves another reservation and cannot reopen the original request", async ({ input, accounting, admission, store, estimate }) => {
      const other = await admission.reserve({ serviceId: input.fence.serviceId, requestId: crypto.randomUUID(), provider: input.provider, model: input.model, estimate });
      assert.ok(other.admitted); assert.deepEqual(await accounting.record(input), recorded("released"));
      assert.deepEqual((await counters(db)).map(w => w.reserved_amount), [1, 30, 40]);
      assert.deepEqual(await store.claim(input.fence), { state: "failed", retryable: false });
      assert.equal((await admission.reserve({ serviceId: input.fence.serviceId, requestId: input.fence.claimId, claim: input.fence,
        provider: input.provider, model: input.model, estimate })).admitted, false);
    }, { stage: "not_sent" });
    await scenario("receipt stores only enumerated reasons and numeric evidence, never raw content or capabilities", async ({ input, accounting }) => {
      input.failure = providerError({ requests: measured(1) }); await accounting.record(input);
      const stored = JSON.stringify(await snapshot(db));
      for (const secret of [input.fence.token, "PRIVATE RESPONSE", "private DB detail"]) assert.ok(!stored.includes(secret));
      assert.equal((await db.prepare("SELECT count(*) AS n FROM inference_attempts").first()).n, 1);
      assert.equal((await db.prepare("SELECT count(*) AS n FROM usage_accounting").first()).n, 0);
    });
  } finally { await mf.dispose(); }
});

test("released and partially accounted failure receipts persist across Worker restarts", { timeout: 45_000 }, async () => {
  await mkdir(new URL("../.wrangler/failure-tests/", import.meta.url), { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL("../.wrangler/failure-tests/restart-", import.meta.url)));
  let mf = runtime(directory);
  try {
    let db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const release = await fixture(db, { stage: "not_sent" }); const partial = await fixture(db, { model: "second-model" });
    partial.input.failure = providerError({ requests: measured(1) });
    assert.deepEqual(await release.accounting.record(release.input), recorded("released"));
    assert.deepEqual(await partial.accounting.record(partial.input), recorded("partial"));
    const before = await snapshot(db);
    await mf.dispose(); mf = runtime(directory); db = await mf.getD1Database("COACH_DB");
    const restarted = new D1FailureAccounting(db);
    assert.deepEqual(await restarted.inspect(release.input), recorded("released", "already_recorded"));
    assert.deepEqual(await restarted.record(partial.input), recorded("partial", "already_recorded"));
    assert.deepEqual(await snapshot(db), before);
  } finally { await mf.dispose(); }
});

test("migration 0007 preserves prior success receipts, amounts and lifecycle data", { timeout: 30_000 }, async () => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db, files.filter(n => n < "0007"));
    const { input } = await fixture(db, { stage: "prepared" });
    // Construct the schema-0006 terminal state directly; current dispatch requires 0012.
    await db.batch([
      db.prepare(`UPDATE idempotency_records SET processing_state = 'completed', status = 'completed',
        response_status = 200, generation = generation + 3, updated_at = unixepoch() WHERE id = ?`).bind(input.fence.claimId),
      db.prepare(`UPDATE request_reservations SET status = 'completed', reconciliation_state = 'awaiting',
        reconciliation_requested_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`).bind(input.reservationId),
      db.prepare(`UPDATE inference_attempts SET status = 'completed', sent_at = unixepoch(),
        finished_at = unixepoch(), updated_at = unixepoch() WHERE id = ?`).bind(input.attemptId),
    ]);
    input.fence = { ...input.fence, generation: input.fence.generation + 3 };
    assert.equal((await new D1UsageSettlement(db).settle({ ...input, usage: { kind: "measured", requests: 1, totalTokens: 20, computeUnits: { milli_neurons: 25 } } })).state, "settled");
    const before = await snapshot(db); await migrate(db, files.filter(n => n.startsWith("0007"))); const after = await snapshot(db);
    for (const table of tables) for (const [index, old] of before[table]!.entries()) {
      for (const key of Object.keys(old)) assert.deepEqual(after[table]![index]![key], old[key], `${table}.${key}`);
    }
    for (const sql of ["UPDATE inference_attempts SET failure_category = 'bad'", "UPDATE inference_attempts SET failure_reason = 'private text'",
      "UPDATE inference_attempts SET failure_http_status = 200", "UPDATE inference_attempts SET failure_recorded_at = updated_at",
      "UPDATE reservation_quota_windows SET failure_held_amount = -1", "UPDATE reservation_quota_windows SET failure_basis = 'bad'"]) {
      await assert.rejects(db.prepare(sql).run(), /constraint/i);
    }
    assert.equal(after.inference_attempts![0]!.failure_receipt_hash, null);
    assert.equal((await new D1UsageSettlement(db).settle({ ...input, usage: { kind: "measured", requests: 1, totalTokens: 20, computeUnits: { milli_neurons: 25 } } })).state, "already_settled");
  } finally { await mf.dispose(); }
});
