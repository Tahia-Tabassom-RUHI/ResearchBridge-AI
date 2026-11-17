import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import localEntry from "../src/local";
import production from "../src/index";
import { LocalMockProvider, type MockScenario } from "../src/providers/mock";
import type { InferenceProvider, ProviderAttempt, ProviderResult } from "../src/providers/types";
import { D1UsageSettlement } from "../src/storage/d1-usage-settlement";
import { D1FailureAccounting } from "../src/storage/d1-failure-accounting";
import type { D1Binding } from "../src/storage/d1-quota-admission";
import type { SuccessfulSettlementInput } from "../src/storage";
import { fixture } from "./fixtures";
import { runtime, migrate, seed, gateway, environment, request, snapshot, tables, fault, secret, fingerprint } from "./local-pipeline-fixture";

test("complete durable local gateway pipeline", { timeout: 300_000 }, async t => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    async function scenario(name: string, run: (h: ReturnType<typeof harness>) => Promise<void>) {
      await t.test(name, async () => {
        await db.batch(tables.map(table => db.prepare(`DELETE FROM ${table}`)));
        const config = await seed(db);
        await run(harness(config));
        assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
      });
    }
    function harness(config: Awaited<ReturnType<typeof seed>>) {
      let calls = 0;
      const observed: ProviderAttempt[] = [];
      const make = (mode: MockScenario = "success", binding: D1Binding | undefined = db,
        transform?: (result: ProviderResult, attempt: ProviderAttempt) => Promise<ProviderResult>) => {
        const mock = new LocalMockProvider(mode);
        const provider: InferenceProvider = { identity: mock.identity, prepare: () => mock.prepare(),
          async generate(task, signal, attempt) {
            calls++; assert.ok(attempt); observed.push(structuredClone(attempt));
            assert.deepEqual(Object.keys(attempt).sort(), ["attemptId", "model", "provider", "reservationId"]);
            const result = await mock.generate(task, signal, attempt);
            return transform ? transform(result, attempt) : result;
          } };
        const composed = gateway(binding, config, provider, 50);
        return { ...composed, send: (id = crypto.randomUUID(), body?: unknown, headers?: Record<string, string>) =>
          composed.handler.fetch(request(id, body, headers), environment(binding)) };
      };
      return { config, make, get calls() { return calls; }, observed };
    }
    async function allHeld() {
      const s = await snapshot(db);
      assert.equal(s.request_reservations!.length, 1);
      for (const w of s.provider_quota_windows!) {
        const link = s.reservation_quota_windows!.find(l => l.quota_window_id === w.id)!;
        assert.equal(w.reserved_amount, link.reserved_amount); assert.equal(w.consumed_amount, 0);
      }
    }
    async function assertNoContent(response: Response) {
      const body = await response.clone().json() as Record<string, unknown>;
      assert.ok(!("output" in body) && !("research_problem" in body));
      assert.ok(!JSON.stringify(body).includes(secret)); return body;
    }
    for (const version of ["1", "2"]) for (const mode of ["success", "equal", "overage", "estimated"] as const) {
      await scenario(`${version}: ${mode} validates content and reconciles all seven windows`, async h => {
        const g = h.make(mode), id = crypto.randomUUID();
        const response = await g.send(id, fixture("abstract_one_section").request, { "X-ResearchBridge-Response-Version": version });
        assert.equal(response.status, 200, await response.clone().text());
        const body = await response.json() as Record<string, unknown>;
        if (version === "1") assert.deepEqual(Object.keys(body), ["research_problem", "method", "findings", "limitations"]);
        else assert.equal((body.output as { sections: unknown[] }).sections.length, 2);
        assert.equal("usage" in body, false); assert.equal(h.calls, 1);
        const s = await snapshot(db); assert.equal(s.usage_accounting!.length, 1); assert.equal(s.reservation_quota_windows!.length, 7);
        const u = s.usage_accounting![0]!;
        assert.equal(u.kind, mode === "estimated" ? "estimated" : "measured");
        assert.equal(u.request_count, ["overage", "estimated"].includes(mode) ? 2 : 1);
        assert.equal(u.total_tokens, mode === "success" ? 20 : mode === "equal" ? 30 : 50);
        assert.equal(u.compute_units, mode === "success" ? 25 : mode === "equal" ? 40 : 60);
        for (const w of s.provider_quota_windows!) {
          assert.equal(w.reserved_amount, 0);
          assert.equal(w.consumed_amount, s.reservation_quota_windows!.find(l => l.quota_window_id === w.id)!.settled_amount);
        }
        const replay = await g.send(id, fixture("abstract_one_section").request, { "X-ResearchBridge-Response-Version": version, "X-Student-ID": "another-student" });
        assert.equal((await assertNoContent(replay)).state, "completed"); assert.equal(h.calls, 1);
        assert.deepEqual(await snapshot(db), s);
      });
    }
    for (const name of ["learning_hints", "term_clarification", "retrieved_abstract"]) await scenario(`V2 ${name} preserves its contract`, async h => {
      const response = await h.make().send(crypto.randomUUID(), fixture(name).request);
      assert.equal(response.status, 200); const body = await response.json() as { task_id: string; output: object };
      assert.equal(body.task_id, (fixture(name).request as { task_id: string }).task_id); assert.ok(!("research_problem" in body.output));
    });
    for (const mode of ["missing_usage", "malformed_usage", "malformed", "timeout", "error", "rate_limit"] as const) {
      await scenario(`${mode} preserves unknown capacity and an immutable failure receipt`, async h => {
        const g = h.make(mode), id = crypto.randomUUID(); const response = await g.send(id);
        assert.equal(response.status, mode === "timeout" ? 504 : mode === "rate_limit" ? 429 : 502);
        await assertNoContent(response); await allHeld();
        const s = await snapshot(db), a = s.inference_attempts![0]!;
        assert.equal(a.status, "unknown"); assert.equal(a.failure_accounting_state, "held"); assert.ok(a.failure_receipt_hash);
        assert.equal((await assertNoContent(await g.send(id))).state, "outcome_unknown");
        assert.equal(h.calls, 1); assert.deepEqual(await snapshot(db), s);
      });
    }
    for (const mode of ["unavailable", "pre_dispatch_failure"] as const) await scenario(`${mode} closes before send and releases atomically`, async h => {
      const g = h.make(mode), id = crypto.randomUUID(); assert.equal((await g.send(id)).status, 503); assert.equal(h.calls, 0);
      const s = await snapshot(db); assert.equal(s.inference_attempts![0]!.status, "not_sent");
      assert.equal(s.inference_attempts![0]!.sent_at, null); assert.equal(s.inference_attempts![0]!.failure_accounting_state, "released");
      assert.ok(s.provider_quota_windows!.every(w => w.reserved_amount === 0 && w.consumed_amount === 0));
      assert.equal((await assertNoContent(await g.send(id))).state, "failed"); assert.deepEqual(await snapshot(db), s);
    });
    for (const mode of ["error_with_usage", "error_partial_usage"] as const) await scenario(`${mode} accounts only trusted supported evidence`, async h => {
      const g = h.make(mode); assert.equal((await g.send()).status, 502); const s = await snapshot(db);
      assert.equal(s.inference_attempts![0]!.failure_accounting_state, mode === "error_with_usage" ? "accounted" : "partial");
      for (const w of s.provider_quota_windows!) {
        if (w.dimension === "requests") { assert.equal(w.consumed_amount, 1); assert.equal(w.reserved_amount, 0); }
        else if (mode === "error_partial_usage") { assert.ok(Number(w.reserved_amount) > 0); assert.equal(w.consumed_amount, 0); }
      }
    });
    for (const [name, patch] of [
      ["wrong provider", { provider: "live-provider" }], ["wrong model", { model: "other-model" }],
      ["wrong attempt", { attemptId: crypto.randomUUID() }], ["wrong reservation", { reservationId: crypto.randomUUID() }],
      ["untrusted source", { source: "browser" }], ["unsafe integer", { usage: { kind: "measured", requests: Number.MAX_SAFE_INTEGER + 1 } }],
      ["fractional units", { usage: { kind: "measured", requests: 1.5 } }],
      ["invented field", { privateResponse: "must-not-persist" }],
    ] as const) await scenario(`${name} cannot be accepted as successful usage`, async h => {
      const g = h.make("success", db, async result => ({ ...result, accounting: { ...(result.accounting as object), ...patch } }));
      assert.equal((await g.send()).status, 502); await allHeld();
      assert.ok(!JSON.stringify(await snapshot(db)).includes("must-not-persist"));
    });
    await scenario("incomplete successful usage retains known requests and holds missing dimensions", async h => {
      const g = h.make("success", db, async result => ({ ...result,
        accounting: { ...(result.accounting as object), usage: { kind: "measured", requests: 1 } } }));
      assert.equal((await g.send()).status, 502); const s = await snapshot(db);
      assert.equal(s.inference_attempts![0]!.failure_accounting_state, "partial");
      assert.equal(s.usage_accounting!.length, 0);
      for (const w of s.provider_quota_windows!) {
        if (w.dimension === "requests") { assert.equal(w.consumed_amount, 1); assert.equal(w.reserved_amount, 0); }
        else { assert.ok(Number(w.reserved_amount) > 0); assert.equal(w.consumed_amount, 0); }
      }
    });
    await scenario("invalid content does not discard trustworthy overage evidence", async h => {
      const g = h.make("overage", db, async result => ({ ...result, output: { invalid: "private invalid response" } }));
      assert.equal((await g.send()).status, 502); const s = await snapshot(db);
      assert.equal(s.inference_attempts![0]!.failure_accounting_state, "accounted");
      assert.ok(s.provider_quota_windows!.every(w => w.reserved_amount === 0));
      assert.equal(s.provider_quota_windows!.find(w => w.id === "w2")!.consumed_amount, 50);
      assert.ok(!JSON.stringify(s).includes("private invalid response"));
    });
    await scenario("request usage and browser owner fields are rejected before D1", async h => {
      const g = h.make(), before = await snapshot(db);
      for (const extra of [{ usage: { requests: 0 } }, { owner_id: "student" }, { provider: "mock" }]) {
        assert.equal((await g.send(crypto.randomUUID(), { ...(fixture("term_clarification").request as object), ...extra })).status, 400);
      }
      assert.equal(h.calls, 0); assert.deepEqual(await snapshot(db), before);
    });
    await scenario("authentication, source validation and contract validation precede admission", async h => {
      const g = h.make(), before = await snapshot(db);
      assert.equal((await g.send(crypto.randomUUID(), undefined, { Authorization: "Bearer invalid" })).status, 401);
      assert.equal((await g.send(crypto.randomUUID(), fixture("unknown_paper_reference").request)).status, 400);
      assert.equal((await g.send(crypto.randomUUID(), {})).status, 400);
      assert.deepEqual(await snapshot(db), before); assert.equal(h.calls, 0);
    });
    await scenario("missing D1 and configuration never fall back to unmetered local generation", async h => {
      for (const env of [{}, environment(), { ...environment(db), COACH_FINGERPRINT_SECRET: "" },
        { ...environment(db), LOCAL_DURABLE_CONFIG: "invalid-json" },
        { ...environment(db), LOCAL_DURABLE_CONFIG: JSON.stringify({ ...h.config, quota: undefined }) }]) {
        const response = await localEntry.fetch(request(), { ...env, COACH_SERVICE_SECRET: secret, LOCAL_MOCK_ENABLED: "true" });
        assert.equal(response.status, 503); await assertNoContent(response);
      }
      assert.equal((await snapshot(db)).idempotency_records!.length, 0);
    });
    for (const change of ["provider", "model", "units", "margin", "windows", "estimate"] as const) await scenario(`invalid trusted ${change} fails closed`, async h => {
      if (change === "provider") h.config.quota.provider = "live";
      if (change === "model") h.config.quota.model = "other";
      if (change === "units") h.config.quota.windows[0]!.unit = "tokens";
      if (change === "margin") h.config.quota.windows[0]!.safetyMargin = -1;
      if (change === "windows") h.config.quota.windows = [];
      if (change === "estimate") h.config.estimate.inputTokens = -1;
      await assertNoContent(await h.make().send()); assert.equal(h.calls, 0);
      assert.equal((await snapshot(db)).request_reservations!.length, 0);
    });
    await scenario("quota exhaustion cannot reach provider preparation or execution", async h => {
      await db.prepare("UPDATE provider_quota_windows SET consumed_amount = limit_amount").run();
      const before = await snapshot(db); await assertNoContent(await h.make().send()); assert.equal(h.calls, 0);
      const after = await snapshot(db); assert.deepEqual(after.provider_quota_windows, before.provider_quota_windows);
      assert.equal(after.request_reservations!.length, 0);
    });
    await scenario("concurrent duplicates dispatch and settle once; changed payload conflicts", async h => {
      const g = h.make(), id = crypto.randomUUID();
      const responses = await Promise.all(Array.from({ length: 12 }, () => g.send(id)));
      const bodies = await Promise.all(responses.map(r => r.json())) as Record<string, unknown>[];
      assert.equal(bodies.filter(b => "output" in b).length, 1); assert.equal(h.calls, 1);
      const s = await snapshot(db); assert.equal(s.request_reservations!.length, 1); assert.equal(s.usage_accounting!.length, 1);
      const conflicting = { contract_version: "2", task_id: "term_clarification", input: { term: "different-term" } };
      assert.equal((await assertNoContent(await g.send(id, conflicting))).state, "conflict"); assert.deepEqual(await snapshot(db), s);
    });
    const boundaries: [string, (sql: string[]) => boolean, boolean][] = [
      ["claim", sql => sql[0]!.startsWith("INSERT INTO idempotency_records"), false],
      ["admission", sql => sql[0]!.startsWith("INSERT INTO request_reservations"), false],
      ["authorization", sql => sql.some(s => s.startsWith("INSERT INTO inference_attempts") && s.includes("'prepared'")), false],
      ["attempt inspection", sql => sql[0]!.startsWith("SELECT r.*, unixepoch() AS now"), false],
      ["dispatch", sql => sql.some(s => s.startsWith("UPDATE inference_attempts SET status = 'sent'")), false],
      ["completion", sql => sql[0]!.startsWith("UPDATE idempotency_records AS i SET") && sql[0]!.includes("i.processing_state = 'dispatched'"), true],
      ["awaiting", sql => sql.some(s => s.startsWith("UPDATE request_reservations SET reconciliation_state")), true],
      ["settlement", sql => sql.some(s => s.startsWith("INSERT INTO usage_accounting")), true],
      ["failure receipt", sql => sql[0]!.startsWith("UPDATE inference_attempts SET failure_category"), true],
    ];
    for (const [boundary, match, dispatched] of boundaries) for (const afterCommit of [false, true]) {
      await scenario(`${boundary}: ${afterCommit ? "lost acknowledgement" : "database unavailable"} cannot redispatch`, async h => {
        let injected = false;
        const broken = fault(db, sql => !injected && match(sql), async () => { injected = true; throw new Error("private SQL error must not escape"); }, afterCommit);
        const g = h.make(boundary === "failure receipt" ? "error" : "success", broken), id = crypto.randomUUID();
        const response = await g.send(id); await assertNoContent(response); assert.ok(injected);
        assert.equal(h.calls, dispatched ? 1 : 0);
        const s = await snapshot(db);
        if (s.idempotency_records!.length > 0) {
          await assertNoContent(await h.make().send(id)); assert.equal(h.calls, dispatched ? 1 : 0);
          assert.deepEqual(await snapshot(db), s);
        }
        if (s.request_reservations!.length && !(boundary === "settlement" && afterCommit)) await allHeld();
        if (boundary === "settlement" && afterCommit) assert.equal(s.usage_accounting!.length, 1);
      });
    }
    for (const mode of ["success", "pre_dispatch_failure"] as const) await scenario(`${mode}: a late zero-row accounting write rolls back every window`, async h => {
      const broken = fault(db, sql => sql.some(s => s.startsWith("INSERT INTO usage_accounting")) || sql[0]!.startsWith("UPDATE inference_attempts SET failure_category"),
        async statements => { statements[6] = db.prepare("UPDATE provider_quota_windows SET reserved_amount = 0 WHERE 0"); });
      const response = await h.make(mode, broken).send(); await assertNoContent(response); await allHeld();
      const s = await snapshot(db); assert.equal(s.usage_accounting!.length, 0); assert.equal(s.inference_attempts![0]!.failure_receipt_hash, null);
    });
    for (const mutation of ["generation", "lease"] as const) await scenario(`${mutation} changes during inference reject owner settlement`, async h => {
      const g = h.make("success", db, async result => {
        await db.prepare(mutation === "generation" ? "UPDATE idempotency_records SET generation = generation + 1" :
          "UPDATE idempotency_records SET lease_expires_at = created_at").run(); return result;
      });
      assert.equal((await assertNoContent(await g.send())).state, "stale_owner"); await allHeld(); assert.equal(h.calls, 1);
    });
    await scenario("lease expiry immediately before the conditional send prevents invocation", async h => {
      const expired = fault(db, sql => sql.some(s => s.startsWith("UPDATE inference_attempts SET status = 'sent'")), async () => {
        await db.prepare("UPDATE idempotency_records SET lease_expires_at = created_at").run();
      });
      assert.equal((await assertNoContent(await h.make("success", expired).send())).state, "stale_owner");
      assert.equal(h.calls, 0); await allHeld();
      assert.equal((await snapshot(db)).inference_attempts![0]!.status, "prepared");
    });
    await scenario("duplicate settlement is read-only and stale settlement is rejected", async h => {
      const g = h.make(); let input: SuccessfulSettlementInput | undefined;
      const durable = g.services!.durable, original = durable.settleSuccess.bind(durable);
      durable.settleSuccess = async (fence, attempt, usage) => {
        input = { ...attempt, fence: { ...fence, generation: fence.generation + 2 }, usage };
        return original(fence, attempt, usage);
      };
      assert.equal((await g.send()).status, 200); assert.ok(input); const before = await snapshot(db), settlement = new D1UsageSettlement(db);
      assert.equal((await settlement.settle(input)).state, "already_settled");
      assert.equal((await settlement.settle({ ...input, fence: { ...input.fence, generation: input.fence.generation - 1 } })).state, "stale_owner");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("explicit recovery releases only a closed non-dispatch failure, fences owners and prevents duplicate refunds", async h => {
      const broken = fault(db, sql => sql[0]!.startsWith("UPDATE inference_attempts SET failure_category"), async () => { throw new Error("unavailable"); });
      const g = h.make("pre_dispatch_failure", broken); let old: SuccessfulSettlementInput | undefined;
      const durable = g.services!.durable, original = durable.accountFailure.bind(durable);
      durable.accountFailure = async (fence, attempt, failure) => {
        old = { ...attempt, fence: { ...fence, generation: fence.generation + 2 }, usage: { kind: "measured", requests: 1 } };
        return original(fence, attempt, failure);
      };
      const id = crypto.randomUUID(); await assertNoContent(await g.send(id)); assert.equal(h.calls, 0); await allHeld(); assert.ok(old);
      await db.prepare("UPDATE request_reservations SET expires_at = created_at").run();
      await db.prepare("UPDATE idempotency_records SET lease_expires_at = created_at").run();
      const healthy = h.make(), recovery = await healthy.services!.recovery(request(), { leaseSeconds: 60 });
      const page = await recovery.discover({ basis: "reservation_expiry", from: 0, through: Math.floor(Date.now() / 1000), limit: 2 });
      assert.equal(page.state, "page"); if (page.state !== "page") throw new Error("No page");
      assert.equal(page.items.length, 1); const item = page.items[0]!; assert.equal(item.classification, "provably_not_dispatched");
      const claim = { reservationId: item.reservationId, requestId: item.requestId!, attemptId: item.attemptId!,
        expectedGeneration: item.generation!, operationId: crypto.randomUUID() };
      const claims = await Promise.all([recovery.claim(claim), recovery.claim(claim)]);
      assert.equal(claims.filter(c => c.state === "acquired").length, 1);
      const owner = claims.find(c => c.state === "acquired")!; assert.equal(owner.state, "acquired"); if (owner.state !== "acquired") throw new Error("No authority");
      assert.equal((await new D1FailureAccounting(db).record({ ...old, failure: { category: "PROVEN_PRE_DISPATCH_FAILURE", reason: "preparation_failed" } })).state, "stale_owner");
      assert.equal((await recovery.release(owner.fence)).state, "recorded"); const before = await snapshot(db);
      assert.equal((await recovery.release(owner.fence)).state, "already_recorded"); await assertNoContent(await healthy.send(id));
      assert.deepEqual(await snapshot(db), before); assert.equal(h.calls, 0);
    });
    await scenario("unknown timeout recovery and ordinary requests never refund or redispatch old work", async h => {
      const g = h.make("timeout"); await g.send(); const s = await snapshot(db), r = s.request_reservations![0]!, i = s.idempotency_records![0]!, a = s.inference_attempts![0]!;
      await db.prepare("UPDATE request_reservations SET expires_at = created_at").run(); await db.prepare("UPDATE idempotency_records SET lease_expires_at = created_at").run();
      const recovery = await g.services!.recovery(request(), { leaseSeconds: 60 }), before = await snapshot(db);
      const result = await recovery.claim({ reservationId: String(r.id), requestId: String(i.id), attemptId: String(a.id), expectedGeneration: Number(i.generation), operationId: crypto.randomUUID() });
      assert.equal(result.state, "not_eligible"); assert.deepEqual(await snapshot(db), before); assert.equal(h.calls, 1);
    });
    await scenario("local entry composes configured D1 while production ignores all enabling flags", async h => {
      const env = { ...environment(db), LOCAL_MOCK_ENABLED: "true", LOCAL_DURABLE_CONFIG: JSON.stringify(h.config) };
      assert.equal((await localEntry.fetch(request(), env)).status, 200);
      const before = await snapshot(db);
      assert.equal((await production.fetch(new Request("https://example.test/api/coach/generate", request()), env)).status, 503);
      assert.equal((await localEntry.fetch(new Request("https://example.test/api/coach/generate", request()), env)).status, 503);
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("private content, responses, capabilities and secrets are absent from storage and logs", async h => {
      const messages: unknown[][] = [], saved = console.error; console.error = (...args) => { messages.push(args); };
      try {
        const text = "private-reflection-sentinel";
        const response = await h.make().send(crypto.randomUUID(), { contract_version: "2", task_id: "term_clarification", input: { term: text } });
        assert.equal(response.status, 200); const persisted = JSON.stringify(await snapshot(db));
        for (const value of [text, "Mock definition", secret, fingerprint, "owner_token\""]) assert.ok(!persisted.includes(value));
        assert.deepEqual(messages, []);
      } finally { console.error = saved; }
    });
  } finally { await mf.dispose(); }
});

test("completed pipeline replay survives a Worker restart without another provider dispatch", { timeout: 60_000 }, async () => {
  await mkdir(new URL("../.wrangler/pipeline-tests/", import.meta.url), { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL("../.wrangler/pipeline-tests/restart-", import.meta.url)));
  let mf = runtime(directory);
  try {
    let db = await mf.getD1Database("COACH_DB"); await migrate(db); const config = await seed(db), id = crypto.randomUUID();
    assert.equal((await gateway(db, config).handler.fetch(request(id), environment(db))).status, 200);
    const before = await snapshot(db);
    await mf.dispose(); mf = runtime(directory); db = await mf.getD1Database("COACH_DB");
    const provider: InferenceProvider = { identity: new LocalMockProvider().identity, generate() { throw new Error("Duplicate dispatch"); } };
    const response = await gateway(db, config, provider).handler.fetch(request(id), environment(db));
    assert.deepEqual(await response.json(), { request_id: id, state: "completed", retryable: false, replay: "status_only" });
    assert.deepEqual(await snapshot(db), before);
  } finally { await mf.dispose(); }
});
