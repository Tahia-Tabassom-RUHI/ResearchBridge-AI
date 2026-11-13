import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { IdempotencyFence, QuotaMetric, SettlementUsage, SuccessfulSettlementInput, TransitionDecision } from "../src/storage";
import { D1IdempotencyStore } from "../src/storage/d1-idempotency";
import { D1QuotaAdmission, type D1Binding, type D1QueryResult, type D1Statement } from "../src/storage/d1-quota-admission";
import { D1UsageSettlement } from "../src/storage/d1-usage-settlement";
import { sha256 } from "../src/storage/request-identity";

type DB = Awaited<ReturnType<Miniflare["getD1Database"]>>;
const policy = { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 7200 };
const files = (await readdir(new URL("../migrations/", import.meta.url))).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort();
const tables = ["usage_accounting", "idempotency_records", "inference_attempts", "reservation_quota_windows", "request_reservations", "provider_quota_windows"];
const runtime = (directory?: string) => new Miniflare(convertV4MiniflareOptions({
  modules: true, script: "export default { fetch() { return new Response('local settlement tests'); } };",
  compatibilityDate: "2026-11-03", cf: false, telemetry: { enabled: false }, d1Databases: { COACH_DB: "settlement-tests" },
  ...(directory ? { resourcePersistencePath: directory } : {}),
  outboundService: () => { throw new Error("External networking is forbidden in settlement tests"); },
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
type Options = { metrics?: QuotaMetric[]; provider?: string; stage?: "reserved" | "prepared" | "sent" | "completed" | "unknown" | "not_sent";
  capacity?: number; computeUnits?: string[] };
async function fixture(db: DB, options: Options = {}) {
  const provider = options.provider ?? "groq", model = "test-model", prefix = crypto.randomUUID();
  const metrics = options.metrics ?? ["requests", "tokens"];
  const start = Math.floor(Date.now() / 1000) - 10;
  const capacity = options.capacity ?? 1000;
  const windows = metrics.map((metric, index) => ({ windowId: `${prefix}-${index}`, model, metric,
    unit: metric === "requests" ? "requests" : metric === "compute_units" ? options.computeUnits?.[index] ?? "milli_neurons" : "tokens",
    capacity, safetyMargin: 0, windowStart: start, windowSeconds: index === 0 ? 60 : 86400 + index }));
  for (const w of windows) await db.prepare(`INSERT INTO provider_quota_windows (id, quota_scope_id, provider, model, dimension,
    unit, window_start, window_seconds, window_end, limit_amount, consumed_amount, created_at, updated_at, retain_until)
    VALUES (?, 'test-account', ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?)`)
    .bind(w.windowId, provider, model, ["requests", "compute_units"].includes(w.metric) ? w.metric : "tokens", w.unit,
      start, w.windowSeconds, start + w.windowSeconds, capacity, start, start, start + w.windowSeconds + 10000).run();
  const store = new D1IdempotencyStore(db, policy);
  const claimed = await store.claim({ serviceId: "streamlit", keyHash: await sha256(crypto.randomUUID()),
    payloadHash: await sha256("test usage request fingerprint"), fingerprintKeyId: await sha256("test fingerprint key id"), responseVersion: "2" });
  assert.equal(claimed.state, "acquired");
  if (claimed.state !== "acquired") throw new Error("Claim rejected");
  let fence = claimed.fence;
  const admissionPolicy = { provider, model, quotaScopeId: "test-account", leaseSeconds: 120, retentionSeconds: 7200, windows };
  const admission = new D1QuotaAdmission(db, [admissionPolicy]);
  const estimate = { kind: "estimated" as const, requests: 1, inputTokens: 10, outputTokens: 20,
    computeUnits: Object.fromEntries(windows.filter(w => w.metric === "compute_units").map(w => [w.unit, 40])) };
  const admitted = await admission.reserve({ serviceId: fence.serviceId, requestId: fence.claimId, provider, model, claim: fence, estimate });
  assert.ok(admitted.admitted, JSON.stringify(admitted));
  fence = { ...fence, generation: fence.generation + 1 };
  const stage = options.stage;
  if (stage === "not_sent") fence = updated(await store.failBeforeDispatch(fence));
  else if (stage !== "reserved") {
    fence = updated(await store.authorizeDispatch(fence));
    if (stage !== "prepared") {
      fence = updated(await store.dispatch(fence));
      if (stage !== "sent") fence = updated(await store[stage === "unknown" ? "markUnknown" : "complete"](fence));
    }
  }
  if (!stage || stage === "not_sent" || stage === "unknown") fence = updated(await store.awaitReconciliation(fence));
  const a = await db.prepare("SELECT id FROM inference_attempts WHERE reservation_id = ?").bind(admitted.reservationId).first<{ id: string }>();
  const input: SuccessfulSettlementInput = { fence, reservationId: admitted.reservationId, attemptId: a?.id ?? crypto.randomUUID(), provider, model,
    usage: { kind: "measured", requests: 1, inputTokens: 8, outputTokens: 12,
      computeUnits: Object.fromEntries(windows.filter(w => w.metric === "compute_units").map(w => [w.unit, 25])) } };
  return { input, store, admission, windows, admissionPolicy, estimate, settlement: new D1UsageSettlement(db) };
}
async function snapshot(db: DB): Promise<Record<string, Record<string, unknown>[]>> {
  return Object.fromEntries(await Promise.all(tables.map(async table => [table,
    (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
}
async function counters(db: DB) {
  return (await db.prepare("SELECT reserved_amount, consumed_amount FROM provider_quota_windows ORDER BY rowid").all()).results;
}

test("successful usage settlement on real local D1", { timeout: 180_000 }, async t => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const scenario = (name: string, fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, options: Options = {}) => t.test(name, async () => {
      await db.batch(tables.map(table => db.prepare(`DELETE FROM ${table}`)));
      await fn(await fixture(db, options));
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });
    await scenario("single request window transfers reservation exactly once", async ({ input, settlement }) => {
      assert.equal((await settlement.settle(input)).state, "settled");
      assert.deepEqual(await counters(db), [{ reserved_amount: 0, consumed_amount: 3 }]);
      const usage = await db.prepare("SELECT * FROM usage_accounting").first();
      assert.equal(usage.request_count, 1); assert.equal(usage.status, "reconciled");
      const r = await db.prepare("SELECT * FROM request_reservations").first();
      assert.equal(r.status, "completed"); assert.equal(r.reconciliation_state, "awaiting");
      assert.ok(r.reconciliation_completed_at >= r.reconciliation_requested_at);
    }, { metrics: ["requests"] });

    await scenario("all request, input, output, combined and compute windows settle together", async ({ input, settlement }) => {
      assert.equal((await settlement.settle(input)).state, "settled");
      assert.deepEqual(await counters(db), [3, 10, 14, 22, 27].map(consumed_amount => ({ reserved_amount: 0, consumed_amount })));
      const links: { reserved_amount: number; settled_amount: number; status: string }[] = (await db.prepare("SELECT reserved_amount, settled_amount, status FROM reservation_quota_windows ORDER BY rowid")
        .all<{ reserved_amount: number; settled_amount: number; status: string }>()).results;
      assert.deepEqual(links.map(l => l.reserved_amount), [1, 10, 20, 30, 40]);
      assert.deepEqual(links.map(l => l.settled_amount), [1, 8, 12, 20, 25]);
      assert.ok(links.every(l => l.status === "settled"));
      const u = await db.prepare("SELECT * FROM usage_accounting").first();
      assert.equal(u.total_tokens, 20); assert.equal(u.compute_units, 25); assert.equal(u.compute_unit, "milli_neurons");
    }, { metrics: ["requests", "input_tokens", "output_tokens", "tokens", "compute_units"] });

    for (const [label, total] of [["below", 5], ["equal to", 30], ["above", 150]] as const) {
      await scenario(`actual usage ${label} reservation is recorded without truncation`, async ({ input, settlement, admission, estimate }) => {
        input.usage = { kind: "measured", requests: 1, totalTokens: total };
        assert.equal((await settlement.settle(input)).state, "settled");
        assert.deepEqual(await counters(db), [{ reserved_amount: 0, consumed_amount: total + 2 }]);
        if (total > 100) {
          const next = await admission.reserve({ serviceId: "streamlit", requestId: crypto.randomUUID(), provider: input.provider, model: input.model, estimate });
          assert.equal(next.admitted, false, "Overage must prevent further admission");
        }
      }, { metrics: ["tokens"], capacity: 100 });
    }
    await scenario("explicit measured zero token usage releases unused tokens", async ({ input, settlement }) => {
      input.usage = { kind: "measured", requests: 1, totalTokens: 0 };
      assert.equal((await settlement.settle(input)).state, "settled");
      assert.deepEqual(await counters(db), [{ reserved_amount: 0, consumed_amount: 2 }]);
    }, { metrics: ["tokens"] });
    await scenario("missing required measured usage never becomes zero", async ({ input, settlement }) => {
      const before = await snapshot(db);
      input.usage = { kind: "measured", requests: 1 };
      assert.equal((await settlement.settle(input)).state, "invalid_usage");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("explicit conservative upper bound retains or increases every reserved dimension", async ({ input, settlement }) => {
      input.usage = { kind: "estimated", estimatePolicy: "explicit_upper_bound_v1", requests: 1, totalTokens: 40 };
      assert.equal((await settlement.settle(input)).state, "settled");
      assert.deepEqual(await counters(db), [{ reserved_amount: 0, consumed_amount: 3 }, { reserved_amount: 0, consumed_amount: 42 }]);
      const u = await db.prepare("SELECT kind, estimate_policy FROM usage_accounting").first();
      assert.deepEqual(u, { kind: "estimated", estimate_policy: "explicit_upper_bound_v1" });
    });
    await scenario("estimates cannot release capacity or omit their policy", async ({ input, settlement }) => {
      const before = await snapshot(db);
      for (const usage of [{ kind: "estimated", requests: 1, totalTokens: 40 },
        { kind: "estimated", estimatePolicy: "explicit_upper_bound_v1", requests: 1, totalTokens: 29 }]) {
        assert.equal((await settlement.settle({ ...input, usage: usage as SettlementUsage })).state, "invalid_usage");
      }
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("reject malformed, negative, fractional, unsafe, contradictory and private usage data", async ({ input, settlement }) => {
      const before = await snapshot(db);
      const variants: unknown[] = [null, {}, [], { ...input.usage, kind: "simulated" }, { ...input.usage, requests: 0 },
        { ...input.usage, totalTokens: 50 }, { ...input.usage, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
        { ...input.usage, computeUnits: null }, { ...input.usage, computeUnits: [] }, { ...input.usage, computeUnits: { neurons: -1 } },
        { ...input.usage, computeUnits: { neurons: 0.1 } }, { ...input.usage, response: "PRIVATE RESPONSE SENTINEL" }];
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "10", null, undefined]) {
        for (const key of ["requests", "inputTokens", "outputTokens", "totalTokens"]) variants.push({ ...input.usage, [key]: value });
      }
      for (const usage of variants) assert.equal((await settlement.settle({ ...input, usage: usage as SettlementUsage })).state, "invalid_usage");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("input/output windows require both specific metrics, even with a total", async ({ input, settlement }) => {
      input.usage = { kind: "measured", requests: 1, totalTokens: 20 };
      assert.equal((await settlement.settle(input)).state, "invalid_usage");
    }, { metrics: ["input_tokens", "output_tokens"] });
    await scenario("multiple named integer compute units remain independent", async ({ input, settlement }) => {
      input.usage.computeUnits = { milli_neurons: 30, gpu_milliseconds: 60 };
      assert.equal((await settlement.settle(input)).state, "settled");
      assert.deepEqual(await counters(db), [32, 62].map(consumed_amount => ({ reserved_amount: 0, consumed_amount })));
      const u = await db.prepare("SELECT compute_units, compute_unit, compute_usage FROM usage_accounting").first();
      assert.equal(u.compute_units, null); assert.equal(u.compute_unit, null);
      assert.deepEqual(JSON.parse(u.compute_usage), input.usage.computeUnits);
    }, { metrics: ["compute_units", "compute_units"], computeUnits: ["milli_neurons", "gpu_milliseconds"], provider: "cloudflare" });
    await scenario("missing or wrong named compute units cannot settle", async ({ input, settlement }) => {
      input.usage.computeUnits = { neurons: 25 };
      assert.equal((await settlement.settle(input)).state, "invalid_usage");
    }, { metrics: ["compute_units"], provider: "cloudflare" });
    await scenario("Cloudflare and Groq accounting does not cross provider boundaries", async first => {
      const second = await fixture(db, { provider: "cloudflare", metrics: ["requests", "compute_units"] });
      const before = await counters(db);
      assert.equal((await first.settlement.settle({ ...first.input, provider: "cloudflare" })).state, "stale_owner");
      assert.equal((await first.settlement.settle(first.input)).state, "settled");
      assert.deepEqual((await counters(db)).slice(2), before.slice(2));
      assert.equal((await second.settlement.settle(second.input)).state, "settled");
    });
    await scenario("identical duplicate is a durable read with no counter or metadata writes", async ({ input, settlement }) => {
      assert.equal((await settlement.settle(input)).state, "settled");
      const before = await snapshot(db);
      input.usage.totalTokens = 20; // Explicit total normalizes to the same receipt.
      assert.equal((await settlement.settle(input)).state, "already_settled");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("conflicting duplicate cannot overwrite existing accounting", async ({ input, settlement }) => {
      assert.equal((await settlement.settle(input)).state, "settled");
      const before = await snapshot(db);
      input.usage.outputTokens = 13;
      assert.equal((await settlement.settle(input)).state, "conflict");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("20 concurrent identical settlements have exactly one writer", async ({ input, settlement }) => {
      const results = await Promise.all(Array.from({ length: 20 }, () => settlement.settle(input)));
      assert.equal(results.filter(r => r.state === "settled").length, 1);
      assert.equal(results.filter(r => r.state === "already_settled").length, 19, JSON.stringify(results));
      assert.equal((await db.prepare("SELECT count(*) AS n FROM usage_accounting").first()).n, 1);
      assert.deepEqual(await counters(db), [3, 22].map(consumed_amount => ({ reserved_amount: 0, consumed_amount })));
    });
    await scenario("competing different settlements produce one winner and one conflict", async ({ input, settlement }) => {
      const results = await Promise.all([settlement.settle(input), settlement.settle({ ...input, usage: { ...input.usage, outputTokens: 13 } })]);
      assert.deepEqual(results.map(r => r.state).sort(), ["conflict", "settled"]);
      const u = await db.prepare("SELECT total_tokens FROM usage_accounting").first();
      assert.equal((await counters(db))[1]!.consumed_amount, u.total_tokens + 2);
    });
    await scenario("stale fencing rejected before and after settlement", async ({ input, settlement }) => {
      const stale = { ...input, fence: { ...input.fence, generation: input.fence.generation - 1 } };
      assert.equal((await settlement.settle(stale)).state, "stale_owner");
      assert.equal((await settlement.settle(input)).state, "settled");
      const before = await snapshot(db);
      assert.equal((await settlement.settle(stale)).state, "stale_owner");
      await db.prepare("UPDATE idempotency_records SET generation = generation + 1").run();
      assert.equal((await settlement.settle(input)).state, "stale_owner");
      assert.deepEqual(await counters(db), before.provider_quota_windows!.map(w => ({ reserved_amount: w.reserved_amount, consumed_amount: w.consumed_amount })));
    });
    await scenario("unauthorized identity, capability, reservation or attempt is rejected", async ({ input, settlement }) => {
      const before = await snapshot(db);
      for (const variant of [{ serviceId: "other" }, { token: "0".repeat(64) }, { payloadHash: "0".repeat(64) },
        { keyHash: "0".repeat(64) }, { fingerprintKeyId: "0".repeat(64) }, { responseVersion: "1" as const }, { claimId: crypto.randomUUID() }]) {
        assert.equal((await settlement.settle({ ...input, fence: { ...input.fence, ...variant } })).state, "stale_owner");
      }
      for (const variant of [{ attemptId: crypto.randomUUID() }, { reservationId: crypto.randomUUID() }, { model: "other" }]) {
        assert.equal((await settlement.settle({ ...input, ...variant })).state, "stale_owner");
      }
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("expired ownership lease fails closed", async ({ input, settlement }) => {
      await db.prepare("UPDATE idempotency_records SET lease_expires_at = created_at").run();
      const before = await snapshot(db);
      assert.equal((await settlement.settle(input)).state, "stale_owner");
      assert.deepEqual(await snapshot(db), before);
    });
    for (const stage of ["reserved", "prepared", "sent", "completed", "unknown", "not_sent"] as const) {
      await scenario(`${stage} cannot bypass successful awaiting-reconciliation eligibility`, async ({ input, settlement }) => {
        const before = await snapshot(db);
        assert.ok(["invalid_state", "stale_owner"].includes((await settlement.settle(input)).state));
        assert.deepEqual(await snapshot(db), before);
      }, { stage });
    }
    await scenario("closed quota windows still record completed usage", async ({ input, settlement }) => {
      await db.prepare("UPDATE provider_quota_windows SET status = 'closed'").run();
      assert.equal((await settlement.settle(input)).state, "settled");
    });
    await scenario("settling one reservation preserves another reservation in the same window", async ({ input, settlement, admission, estimate }) => {
      const other = await admission.reserve({ serviceId: "streamlit", requestId: crypto.randomUUID(), provider: input.provider, model: input.model, estimate });
      assert.ok(other.admitted);
      assert.equal((await settlement.settle(input)).state, "settled");
      assert.deepEqual(await counters(db), [{ reserved_amount: 1, consumed_amount: 3 }, { reserved_amount: 30, consumed_amount: 22 }]);
    });
    for (const [name, sql] of [
      ["counter underflow", "UPDATE provider_quota_windows SET reserved_amount = 0 WHERE dimension = 'tokens'"],
      ["counter overflow", `UPDATE provider_quota_windows SET consumed_amount = ${Number.MAX_SAFE_INTEGER} WHERE dimension = 'tokens'`],
      ["fractional legacy counter", "UPDATE provider_quota_windows SET consumed_amount = 1.5 WHERE dimension = 'tokens'"],
      ["ambiguous legacy token metric", "UPDATE reservation_quota_windows SET quota_metric = NULL"],
      ["inconsistent reservation link", "UPDATE reservation_quota_windows SET status = 'released'"],
    ]) {
      await scenario(`${name} rejects settlement without partial updates`, async ({ input, settlement }) => {
        await db.prepare(sql!).run(); const before = await snapshot(db);
        assert.equal((await settlement.settle(input)).state, "invalid_accounting");
        assert.deepEqual(await snapshot(db), before);
      });
    }
    await scenario("maximum safe consumed value is accepted without overflow", async ({ input, settlement }) => {
      await db.prepare("UPDATE provider_quota_windows SET consumed_amount = ?").bind(Number.MAX_SAFE_INTEGER - 20).run();
      input.usage = { kind: "measured", requests: 1, totalTokens: 20 };
      assert.equal((await settlement.settle(input)).state, "settled");
      assert.deepEqual(await counters(db), [{ reserved_amount: 0, consumed_amount: Number.MAX_SAFE_INTEGER }]);
    }, { metrics: ["tokens"] });
    for (const index of [0, 2, 4, 6, 8, 10]) {
      await scenario(`zero-row write at statement ${index} rolls back the entire batch`, async ({ input }) => {
        const before = await snapshot(db);
        const broken: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
          const actual = [...statements];
          if (actual.length > 2) actual[index] = db.prepare("UPDATE usage_accounting SET status = 'reconciled' WHERE 0");
          return db.batch(actual) as Promise<D1QueryResult<T>[]>;
        } };
        assert.equal((await new D1UsageSettlement(broken).settle(input)).state, "invalid_accounting");
        assert.deepEqual(await snapshot(db), before);
      });
    }
    await scenario("changed links between planning and writing cannot use stale reservation amounts", async ({ input }) => {
      let before: Awaited<ReturnType<typeof snapshot>>;
      const raced: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        if (statements.length > 2) {
          await db.prepare("UPDATE reservation_quota_windows SET reserved_amount = reserved_amount + 1 WHERE quota_metric = 'tokens'").run();
          before = await snapshot(db);
        }
        return db.batch(statements) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await new D1UsageSettlement(raced).settle(input)).state, "invalid_accounting");
      assert.deepEqual(await snapshot(db), before!);
    });
    await scenario("an extra applicable window introduced after the read rolls back all settlement writes", async ({ input }) => {
      let before: Awaited<ReturnType<typeof snapshot>>;
      const raced: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        if (statements.length > 2) {
          await db.prepare(`INSERT INTO provider_quota_windows (id, quota_scope_id, provider, model, dimension, unit,
            window_start, window_seconds, window_end, limit_amount, reserved_amount, created_at, updated_at, retain_until)
            SELECT 'extra-window', quota_scope_id, provider, model, dimension, unit, window_start, window_seconds + 100,
              window_end + 100, limit_amount, 1, created_at, updated_at, retain_until + 100
            FROM provider_quota_windows WHERE dimension = 'requests'`).run();
          await db.prepare(`INSERT INTO reservation_quota_windows (reservation_id, quota_window_id, reserved_amount,
            created_at, updated_at, quota_metric) VALUES (?, 'extra-window', 1, unixepoch(), unixepoch(), 'requests')`)
            .bind(input.reservationId).run();
          before = await snapshot(db);
        }
        return db.batch(statements) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await new D1UsageSettlement(raced).settle(input)).state, "invalid_accounting");
      assert.deepEqual(await snapshot(db), before!);
    });
    await scenario("a fencing change after the read is rejected inside the write transaction", async ({ input }) => {
      let before: Awaited<ReturnType<typeof snapshot>>;
      const raced: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        if (statements.length > 2) {
          await db.prepare("UPDATE idempotency_records SET generation = generation + 1").run();
          before = await snapshot(db);
        }
        return db.batch(statements) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await new D1UsageSettlement(raced).settle(input)).state, "stale_owner");
      assert.deepEqual(await snapshot(db), before!);
    });
    await scenario("existing usage records are never overwritten", async ({ input, settlement }) => {
      await db.prepare(`INSERT INTO usage_accounting (id, attempt_id, kind, request_count, created_at, updated_at, retain_until)
        VALUES ('legacy-usage', ?, 'measured', 1, unixepoch(), unixepoch(), unixepoch() + 1000)`).bind(input.attemptId).run();
      const before = await snapshot(db);
      assert.equal((await settlement.settle(input)).state, "conflict");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("database unavailable returns a closed result", async ({ input }) => {
      const broken: D1Binding = { prepare() { throw new Error("private failure"); }, async batch() { throw new Error("private failure"); } };
      for (const binding of [undefined, broken]) assert.deepEqual(await new D1UsageSettlement(binding).settle(input), { state: "storage_unavailable", retryable: false });
    });
    await scenario("lost acknowledgement is resolved by an explicit identical retry without another charge", async ({ input, settlement }) => {
      const uncertain: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        const results = await db.batch(statements);
        if (statements.length > 2) throw new Error("Acknowledgement lost");
        return results as D1QueryResult<T>[];
      } };
      assert.equal((await new D1UsageSettlement(uncertain).settle(input)).state, "storage_unavailable");
      const before = await snapshot(db);
      assert.equal((await settlement.settle(input)).state, "already_settled");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("unexpected affected-row acknowledgement returns unavailable", async ({ input, settlement }) => {
      const uncertain: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        const results = await db.batch(statements);
        if (statements.length > 2) results[2].meta.changes = 0;
        return results as D1QueryResult<T>[];
      } };
      assert.equal((await new D1UsageSettlement(uncertain).settle(input)).state, "storage_unavailable");
      assert.equal((await settlement.settle(input)).state, "already_settled");
    });
    await scenario("settlement preserves status-only idempotency and immutable lifecycle outcomes", async ({ input, settlement, store, admission, estimate }) => {
      assert.equal((await settlement.settle(input)).state, "settled");
      assert.deepEqual(await store.claim(input.fence), { state: "completed", retryable: false });
      for (const method of ["complete", "dispatch", "authorizeDispatch", "failBeforeDispatch", "markUnknown", "awaitReconciliation"] as const) {
        assert.equal((await store[method](input.fence)).state, "stale_owner");
      }
      assert.equal((await admission.reserve({ serviceId: input.fence.serviceId, requestId: input.fence.claimId,
        provider: input.provider, model: input.model, claim: input.fence, estimate })).admitted, false);
      const stored = JSON.stringify(await snapshot(db));
      assert.ok(!stored.includes(input.fence.token));
      assert.ok(!stored.includes("PRIVATE RESPONSE SENTINEL"));
      const columns: string[] = (await db.prepare("PRAGMA table_info(usage_accounting)").all()).results.map((r: { name: string }) => r.name);
      assert.ok(!columns.some(n => /prompt|response|credential|secret/.test(String(n))));
    });
  } finally { await mf.dispose(); }
});

test("successful settlement receipt and counters survive a Worker restart", { timeout: 45_000 }, async () => {
  await mkdir(new URL("../.wrangler/settlement-tests/", import.meta.url), { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL("../.wrangler/settlement-tests/restart-", import.meta.url)));
  let mf = runtime(directory);
  try {
    let db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const { input, settlement } = await fixture(db);
    assert.equal((await settlement.settle(input)).state, "settled");
    const before = await snapshot(db);
    await mf.dispose(); mf = runtime(directory); db = await mf.getD1Database("COACH_DB");
    assert.equal((await new D1UsageSettlement(db).settle(input)).state, "already_settled");
    assert.deepEqual(await snapshot(db), before);
    assert.equal((await new D1IdempotencyStore(db, policy).lookup(input.fence)).state, "completed");
  } finally { await mf.dispose(); }
});

test("migration 0006 preserves old data and leaves ambiguous token metrics unset", { timeout: 30_000 }, async () => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db, files.filter(n => n < "0006"));
    await db.prepare(`INSERT INTO request_reservations (id, service_id, request_id, quota_scope_id, provider, model,
      reservation_number, created_at, updated_at, expires_at, retain_until) VALUES ('r', 's', 'q', 'scope', 'groq', 'm', 1, 1, 1, 2, 1000)`).run();
    for (const [dimension, unit] of [["requests", "requests"], ["tokens", "tokens"], ["compute_units", "milli_neurons"]]) {
      await db.prepare(`INSERT INTO provider_quota_windows (id, quota_scope_id, provider, model, dimension, unit, window_seconds,
        window_start, window_end, limit_amount, reserved_amount, consumed_amount, created_at, updated_at, retain_until)
        VALUES (?, 'scope', 'groq', 'm', ?, ?, 60, 1, 61, 100, 5, 3, 1, 1, 1000)`).bind(dimension!, dimension!, unit!).run();
      await db.prepare(`INSERT INTO reservation_quota_windows (reservation_id, quota_window_id, reserved_amount, created_at, updated_at)
        VALUES ('r', ?, 5, 1, 1)`).bind(dimension!).run();
    }
    await db.prepare("INSERT INTO inference_attempts (id, reservation_id, created_at, updated_at, retain_until) VALUES ('a', 'r', 1, 1, 1000)").run();
    await db.prepare(`INSERT INTO usage_accounting (id, attempt_id, kind, request_count, compute_units, compute_unit, created_at, updated_at, retain_until)
      VALUES ('u', 'a', 'measured', 1, 0.5, 'neurons', 1, 1, 1000)`).run();
    const before = await snapshot(db);
    await migrate(db, files.filter(n => n.startsWith("0006")));
    const after = await snapshot(db);
    for (const table of tables) for (const [index, old] of before[table]!.entries()) {
      for (const key of Object.keys(old)) assert.deepEqual(after[table]![index]![key], old[key], `${table}.${key}`);
    }
    assert.deepEqual(after.reservation_quota_windows!.map(r => r.quota_metric), ["requests", null, "compute_units"]);
    assert.equal(after.request_reservations![0]!.reconciliation_completed_at, null);
    assert.equal(after.usage_accounting![0]!.settlement_hash, null);
    for (const sql of ["UPDATE reservation_quota_windows SET quota_metric = 'invalid'", "UPDATE usage_accounting SET settlement_check = 0",
      "UPDATE usage_accounting SET total_tokens = -1", "UPDATE usage_accounting SET compute_usage = '[]'",
      "UPDATE request_reservations SET reconciliation_completed_at = 1"]) await assert.rejects(db.prepare(sql).run(), /constraint/i);
  } finally { await mf.dispose(); }
});
