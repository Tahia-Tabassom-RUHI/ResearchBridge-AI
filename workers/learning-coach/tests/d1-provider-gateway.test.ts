import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { QWEN_REVIEW_BOUNDARY, type CapacityProvider, type ProviderCapacityPolicy } from "../src/config/provider-policy";
import { createGateway } from "../src/handlers/gateway";
import { localProviderServices, type LocalProviderConfig } from "../src/local-services";
import { LocalPolicyMockProvider, type LocalResponseFixture, type PolicyMockScenario } from "../src/providers/local-policy-mock";
import { MockSourceResolver } from "../src/providers/mock";
import { D1QuotaProvisioning } from "../src/storage/d1-quota-provisioning";
import { D1ProviderHolds } from "../src/storage/d1-provider-holds";
import { D1UsageSettlement } from "../src/storage/d1-usage-settlement";
import type { SuccessfulSettlementInput } from "../src/storage";
import type { D1Binding } from "../src/storage/d1-quota-admission";
import production from "../src/index";
import local from "../src/local";
import { environment, fault, migrate, request, runtime, tables, type DB } from "./local-pipeline-fixture";
import { fixture } from "./fixtures";
import { policyFixture, POLICY_TIME } from "./provider-policy-fixture";

const allTables = ["provider_hold_operations", "provider_holds", ...tables, "provider_capacity_policies"];
const NOW = POLICY_TIME + 10;
const clocked = (db: D1Binding, clock: () => number): D1Binding => ({
  prepare: sql => db.prepare(sql.replaceAll("unixepoch()", String(clock()))), batch: statements => db.batch(statements),
});
async function rows(db: DB, table: string) { return (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results as Record<string, unknown>[]; }
async function snapshot(db: DB): Promise<Record<string, Record<string, unknown>[]>> { return Object.fromEntries(await Promise.all(allTables.map(async table => [table, await rows(db, table)]))); }
async function noContent(response: Response) {
  const body = await response.json() as Record<string, unknown>;
  assert.ok(!("output" in body)); assert.ok(!("sections" in body)); return body;
}
function setup(db: D1Binding, clock: () => number, providerName: CapacityProvider = "groq", scenario: PolicyMockScenario = "success",
  configure?: (c: LocalProviderConfig) => void, responseFixture?: (p: ProviderCapacityPolicy, now: number) => LocalResponseFixture) {
  const config: LocalProviderConfig = { ownership: { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 172800 },
    policy: policyFixture(providerName, NOW - 10), bounds: { inputTokens: 100, outputTokens: 200 } };
  configure?.(config);
  const provider = new LocalPolicyMockProvider(config.policy, scenario, responseFixture, clock);
  let calls = 0;
  const generate = provider.generate.bind(provider);
  provider.generate = async (...args) => { calls++; return generate(...args); };
  const services = localProviderServices(environment(db), config, provider, clock);
  const handler = createGateway({ mode: "local", enabled: true, provider, sources: new MockSourceResolver(), timeoutMs: 5000, ...services });
  return { config, provider, services, handler, get calls() { return calls; },
    send: (id = crypto.randomUUID(), body?: unknown, headers?: Record<string, string>) => handler.fetch(request(id, body, headers), environment(db)) };
}

test("Part 4E-4 policy, execution evidence, holds and accounting on local D1", { timeout: 300_000 }, async t => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    let now = NOW;
    const binding = clocked(db, () => now);
    const make = (provider: CapacityProvider = "groq", scenario: PolicyMockScenario = "success", connection = binding,
      configure?: (c: LocalProviderConfig) => void, responseFixture?: (p: ProviderCapacityPolicy, time: number) => LocalResponseFixture) =>
      setup(connection, () => now, provider, scenario, configure, responseFixture);
    const scenario = (name: string, run: () => Promise<void>) => t.test(name, async () => {
      now = NOW; await db.batch(allTables.map(table => db.prepare(`DELETE FROM ${table}`)));
      await run(); assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });

    for (const provider of ["groq", "cloudflare_workers_ai"] as const) {
      for (const version of ["1", "2"]) await scenario(`${provider}: V${version} settles and replays status only`, async () => {
        const g = make(provider), id = crypto.randomUUID();
        const response = await g.send(id, fixture("retrieved_abstract").request, { "X-ResearchBridge-Response-Version": version });
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
        assert.equal(g.calls, 1); const before = await snapshot(db);
        assert.equal(before.usage_accounting!.length, 1);
        assert.equal(before.inference_attempts![0]!.provider_evidence_state, "acknowledged");
        assert.equal((await noContent(await g.send(id, fixture("retrieved_abstract").request,
          { "X-ResearchBridge-Response-Version": version }))).state, "completed");
        assert.deepEqual(await snapshot(db), before); assert.equal(g.calls, 1);
      });
      for (const mode of ["success", "overage"] as const) await scenario(`${provider}: measured ${mode} reconciles all dimensions`, async () => {
        const g = make(provider, mode); assert.equal((await g.send()).status, 200);
        const links = await rows(db, "reservation_quota_windows"); assert.ok(links.every(w => w.status === "settled"));
        assert.ok((await rows(db, "provider_quota_windows")).every(w => w.reserved_amount === 0));
        const usage = (await rows(db, "usage_accounting"))[0]!;
        assert.equal(usage.kind, "measured");
        assert.equal(usage.input_tokens, mode === "success" ? 8 : 200);
        assert.ok(links.some(w => mode === "success" ? Number(w.settled_amount) < Number(w.reserved_amount) : Number(w.settled_amount) > Number(w.reserved_amount)));
      });
      for (const mode of ["missing_usage", "partial_usage", "error", "error_partial_usage", "timeout", "malformed_content"] as const) {
        await scenario(`${provider}: ${mode} preserves unreported usage and never redispatches`, async () => {
          const g = make(provider, mode), id = crypto.randomUUID(); const response = await g.send(id);
          // Cloudflare's required request/compute dimensions are independently
          // measured by the local fixture even when token details are partial.
          const complete = provider === "cloudflare_workers_ai" && mode === "partial_usage";
          assert.equal(response.status, complete ? 200 : mode === "timeout" ? 504 : 502, JSON.stringify(await response.clone().json()));
          if (!complete) await noContent(response); const before = await snapshot(db);
          assert.equal(before.usage_accounting!.length, complete ? 1 : 0); assert.equal(g.calls, 1);
          if (["missing_usage", "error", "timeout"].includes(mode)) assert.ok(before.provider_quota_windows!.every(w => Number(w.reserved_amount) > 0 && w.consumed_amount === 0));
          await noContent(await g.send(id)); assert.equal(g.calls, 1); assert.deepEqual(await snapshot(db), before);
        });
      }
    }
    for (const [mode, reason, deadline] of [
      ["daily_exhausted", "compute_capacity_exhausted", POLICY_TIME + 86400],
      ["temporary_capacity", "temporary_provider_unavailable", null],
      ["paid_required", "model_unavailable", null], ["deprecated", "model_unavailable", null],
      ["access_denied", "model_unavailable", null], ["model_unavailable", "model_unavailable", null],
    ] as const) await scenario(`Cloudflare ${mode} creates scoped durable ${reason}`, async () => {
      const g = make("cloudflare_workers_ai", mode); await noContent(await g.send()); assert.equal(g.calls, 1);
      const holds = await rows(db, "provider_holds"); assert.equal(holds.length, 1);
      assert.equal(holds[0]!.reason_code, reason); assert.equal(holds[0]!.hold_until, deadline);
      assert.equal(holds[0]!.model, mode === "daily_exhausted" ? "" : g.config.policy.model);
      const next = make("cloudflare_workers_ai"); await noContent(await next.send()); assert.equal(next.calls, 0);
      const unrelated = make("groq"); assert.equal((await unrelated.send()).status, 200);
    });
    for (const [mode, reason, deadline, seconds] of [
      ["rpd_exhausted", "daily_requests_exhausted", POLICY_TIME + 86400, 86400],
      ["tpm_exhausted", "token_rate_exhausted", POLICY_TIME + 60, 60],
      ["retry_after", "provider_retry_after", NOW + 17, null],
      ["missing_reset", "daily_requests_exhausted", null, 86400],
      ["zero_remaining", "daily_requests_exhausted", POLICY_TIME + 86400, 86400],
    ] as const) await scenario(`Groq ${mode} keeps RPD/TPM and verified deadlines distinct`, async () => {
      const g = make("groq", mode); const response = await g.send();
      assert.equal(response.status, mode === "zero_remaining" ? 200 : 429, JSON.stringify(await response.clone().json()));
      const h = (await rows(db, "provider_holds"))[0]!; assert.equal(h.reason_code, reason);
      assert.equal(h.hold_until, deadline); assert.equal(h.window_seconds, seconds); assert.equal(h.model, g.config.policy.model);
      const next = make(); await noContent(await next.send()); assert.equal(next.calls, 0);
      assert.equal((await make("cloudflare_workers_ai").send()).status, 200);
    });
    for (const status of [200, 429]) for (const exhausted of [false, true]) await scenario(`independent Groq duration fixtures: HTTP ${status}, exhausted=${exhausted}`, async () => {
      const g = make("groq", "success", binding, undefined, p => ({ metadata: { kind: "http_response", status,
        headers: [["x-ratelimit-limit-requests", "1000"], ["x-ratelimit-remaining-requests", exhausted ? "0" : "900"],
          ["x-ratelimit-reset-requests", "2m59.56s"], ["x-ratelimit-limit-tokens", "8000"],
          ["x-ratelimit-remaining-tokens", exhausted ? "0" : "7900"], ["x-ratelimit-reset-tokens", "7.66s"],
          ...(status === 429 ? [["retry-after", "3"]] : [])],
        body: { model: p.model, usage: { prompt_tokens: 8, completion_tokens: 12 }, ...(status === 429 ? { error: { type: "rate_limit" } } : {}) } },
        counters: { requests: { kind: "measured", amount: 1, evidence: "provider_report" } } }));
      assert.equal((await g.send()).status, status); assert.equal(g.calls, 1);
      assert.equal((await rows(db, "inference_attempts"))[0]!.provider_evidence_state, "acknowledged");
      const holds = await rows(db, "provider_holds"), quotas = await rows(db, "provider_quota_windows");
      assert.ok(quotas.every(w => w.reserved_amount === 0 && Number(w.consumed_amount) > 0));
      assert.deepEqual(quotas.map(w => w.limit_amount).sort((a, b) => Number(a) - Number(b)), [30, 1000, 8000, 200000]);
      if (exhausted) {
        assert.equal(holds.find(h => h.reason_code === "daily_requests_exhausted")!.hold_until, NOW + 180);
        assert.equal(holds.find(h => h.reason_code === "token_rate_exhausted")!.hold_until, NOW + 8);
        assert.ok(holds.every(h => h.quota_window_id === null));
        now += 9; const next = make(); await noContent(await next.send()); assert.equal(next.calls, 0);
        assert.equal((await rows(db, "provider_quota_windows")).find(w => w.window_seconds === 86400 && w.quota_metric === "requests")!.consumed_amount, 1);
      } else assert.equal(holds.filter(h => h.quota_metric !== null).length, 0);
      if (status === 429) assert.equal(holds.find(h => h.reason_code === "provider_retry_after")!.hold_until, NOW + 3);
    });
    await scenario("nonaligned reset cannot shorten a stronger indefinite dimension hold", async () => {
      const g = make("groq", "success", binding, undefined, p => ({ metadata: { kind: "http_response", status: 200,
        headers: [["x-ratelimit-remaining-tokens", "0"], ["x-ratelimit-reset-tokens", "7.66s"]],
        body: { model: p.model, usage: { prompt_tokens: 8, completion_tokens: 12 } } },
        counters: { requests: { kind: "measured", amount: 1, evidence: "provider_report" } } }));
      const generate = g.provider.generate.bind(g.provider), p = g.config.policy;
      g.provider.generate = async (...args) => {
        assert.equal((await new D1ProviderHolds(binding, p, () => now).record({ operationId: crypto.randomUUID(),
          provider: p.provider, model: p.model, quotaScopeId: p.quotaScopeId, policyVersion: p.version,
          observedAt: now - 1, source: "operational", reason: "token_rate_exhausted", until: null,
          dimension: { metric: "tokens", unit: "tokens", windowSeconds: 60 } })).state, "recorded");
        return generate(...args);
      };
      assert.equal((await g.send()).status, 200);
      const h = (await rows(db, "provider_holds"))[0]!; assert.equal(h.hold_until, null); assert.equal(h.confidence, 3);
    });
    for (const provider of ["groq", "cloudflare_workers_ai"] as const) await scenario(`${provider}: unknown error is not quota exhaustion`, async () => {
      const g = make(provider, "unknown_error"); assert.equal((await g.send()).status, 502);
      assert.equal((await rows(db, "provider_holds")).length, 0);
      assert.equal((await rows(db, "inference_attempts"))[0]!.provider_evidence_state, "acknowledged");
      assert.equal((await make(provider).send()).status, 200);
    });
    for (const mode of ["malformed_metadata", "contradictory_headers"] as const) await scenario(`${mode} remains durably blocked without a fabricated cooldown`, async () => {
      const g = make("groq", mode); assert.equal((await noContent(await g.send())).state, "reconciliation_failed");
      assert.equal((await rows(db, "provider_holds")).length, 0);
      assert.equal((await rows(db, "inference_attempts"))[0]!.provider_evidence_state, "pending");
      now += 86400; const next = make(); await noContent(await next.send()); assert.equal(next.calls, 0);
    });

    const invalid: [string, (p: ProviderCapacityPolicy) => void][] = [
      ["expired", p => { p.reviewAfter = NOW; }], ["schema version", p => { (p as { schemaVersion: number }).schemaVersion = 2; }],
      ["paid model", p => { (p.eligibility as { paidOnly: boolean }).paidOnly = true; }],
      ["disabled", p => { p.enabled = false; }], ["unverified account", p => { (p.eligibility as { verified: boolean }).verified = false; }],
      ["missing dimension", p => { p.dimensions = []; }], ["wrong model", p => { p.model = "unreviewed-model"; }],
      ["unverified capacity", p => { delete p.dimensions[0]!.account; }],
      ["version zero", p => { p.version = 0; }], ["incomplete inventory", p => { (p.quotaInventory as { complete: boolean }).complete = false; }],
    ];
    for (const [name, change] of invalid) await scenario(`current ${name} cannot use an older persisted approval`, async () => {
      const p = make().config.policy; assert.equal((await new D1QuotaProvisioning(binding).provision(p)).state, "provisioned");
      const g = make("groq", "success", binding, c => change(c.policy)); await noContent(await g.send());
      assert.equal(g.calls, 0); assert.equal((await rows(db, "request_reservations")).length, 0);
    });
    await scenario("model deprecation boundary rejects admission exactly at cutoff", async () => {
      now = QWEN_REVIEW_BOUNDARY;
      const g = make("cloudflare_workers_ai", "success", binding, c => { c.policy.reviewAfter = QWEN_REVIEW_BOUNDARY; });
      await noContent(await g.send()); assert.equal(g.calls, 0);
    });
    await scenario("invalid conservative bounds fail before provisioning", async () => {
      const g = make("groq", "success", binding, c => { c.bounds.outputTokens = -1; }); await noContent(await g.send());
      assert.equal(g.calls, 0); assert.equal((await rows(db, "provider_quota_windows")).length, 0);
    });
    await scenario("quota exhaustion and hold expiry do not reset counters", async () => {
      const g = make("groq", "retry_after"); await g.send(); now += 18;
      await db.prepare("UPDATE provider_quota_windows SET consumed_amount = limit_amount - reserved_amount").run();
      const before = await rows(db, "provider_quota_windows"), next = make(); await noContent(await next.send());
      assert.equal(next.calls, 0); assert.deepEqual(await rows(db, "provider_quota_windows"), before);
    });
    await scenario("expired retry hold admits only after policy and available capacity checks", async () => {
      await make("groq", "retry_after").send(); now += 18; assert.equal((await make().send()).status, 200);
      assert.equal((await rows(db, "provider_holds"))[0]!.status, "active");
    });
    await scenario("unknown reset does not expire at a window rollover", async () => {
      await make("groq", "missing_reset").send(); now += 86400;
      const g = make(); await noContent(await g.send()); assert.equal(g.calls, 0);
    });
    await scenario("concurrent duplicate requests dispatch once; conflicting payload cannot reuse ownership", async () => {
      const g = make(), id = crypto.randomUUID(); const responses = await Promise.all(Array.from({ length: 12 }, () => g.send(id)));
      assert.equal(responses.filter(r => r.status === 200).length, 1); assert.equal(g.calls, 1);
      assert.equal((await rows(db, "usage_accounting")).length, 1);
      const conflict = await noContent(await g.send(id, { contract_version: "2", task_id: "term_clarification", input: { term: "changed" } }));
      assert.equal(conflict.state, "conflict");
    });
    await scenario("successful settlement is immutable and stale fencing cannot charge twice", async () => {
      const g = make(); let captured: SuccessfulSettlementInput | undefined;
      const original = g.services!.durable.settleSuccess.bind(g.services!.durable);
      g.services!.durable.settleSuccess = (fence, attempt, usage) => { captured = { ...attempt, fence: { ...fence, generation: fence.generation + 2 }, usage }; return original(fence, attempt, usage); };
      assert.equal((await g.send()).status, 200); assert.ok(captured); const before = await snapshot(db);
      const settlement = new D1UsageSettlement(binding);
      assert.equal((await settlement.settle(captured)).state, "already_settled");
      assert.equal((await settlement.settle({ ...captured, fence: { ...captured.fence, generation: captured.fence.generation - 1 } })).state, "stale_owner");
      assert.deepEqual(await snapshot(db), before);
    });
    for (const field of ["observation", "provider", "model", "quotaScopeId", "policy", "accounting", "capacity"]) await scenario(`public ${field} cannot inject evidence or configuration`, async () => {
      const g = make(); const response = await g.send(crypto.randomUUID(), { ...(fixture("term_clarification").request as object), [field]: "forged" });
      assert.equal(response.status, 400); assert.equal(g.calls, 0); assert.equal((await rows(db, "idempotency_records")).length, 0);
    });
    for (const field of ["model", "account_id", "quotaScopeId", "provider"]) await scenario(`conflicting response ${field} is rejected`, async () => {
      const g = make("groq", "success", binding, undefined, p => ({ metadata: { kind: "http_response", status: 200,
        body: { model: p.model, usage: { prompt_tokens: 1, completion_tokens: 1 }, [field]: "wrong-identity" } } }));
      assert.equal((await noContent(await g.send())).state, "reconciliation_failed");
      assert.equal((await rows(db, "inference_attempts"))[0]!.provider_evidence_state, "pending");
    });
    await scenario("a forged result object from a replaced generate method has no execution capability", async () => {
      const g = make(); const generate = g.provider.generate.bind(g.provider);
      g.provider.generate = async (...args) => ({ ...await generate(...args) });
      assert.equal((await noContent(await g.send())).state, "reconciliation_failed");
    });
    await scenario("stale generation during provider execution cannot write holds or acknowledge evidence", async () => {
      const g = make("groq", "rpd_exhausted"), generate = g.provider.generate.bind(g.provider);
      g.provider.generate = async (...args) => { const r = await generate(...args); await db.prepare("UPDATE idempotency_records SET generation = generation + 1").run(); return r; };
      assert.equal((await noContent(await g.send())).state, "stale_owner");
      assert.equal((await rows(db, "provider_holds")).length, 0);
      assert.equal((await rows(db, "inference_attempts"))[0]!.provider_evidence_state, "pending");
    });
    await scenario("stale provider observation remains blocked and never fabricates an expiry", async () => {
      const g = make(), generate = g.provider.generate.bind(g.provider);
      g.provider.generate = async (...args) => { const r = await generate(...args); now += 301; return r; };
      await noContent(await g.send()); assert.equal((await rows(db, "provider_holds")).length, 0);
      assert.equal((await rows(db, "inference_attempts"))[0]!.provider_evidence_state, "pending");
    });
    await scenario("missing response metadata keeps the durable barrier", async () => {
      const g = make("groq", "success", binding, undefined, () => ({ metadata: undefined }));
      assert.equal((await noContent(await g.send())).state, "reconciliation_failed");
      assert.equal((await rows(db, "provider_holds")).length, 0);
      const next = make(); await noContent(await next.send()); assert.equal(next.calls, 0);
    });
    await scenario("429 without quota or reset evidence creates an indefinite availability hold", async () => {
      const g = make("groq", "success", binding, undefined, p => ({ metadata: { kind: "http_response", status: 429,
        body: { model: p.model, error: { type: "synthetic_rate_limit" } } } }));
      const response = await g.send(); assert.equal(response.status, 429); assert.equal(response.headers.get("Retry-After"), null);
      const h = (await rows(db, "provider_holds"))[0]!;
      assert.equal(h.reason_code, "temporary_provider_unavailable"); assert.equal(h.hold_until, null);
      assert.equal(h.quota_metric, null); const next = make(); await noContent(await next.send()); assert.equal(next.calls, 0);
    });
    await scenario("estimated counters stay estimated and are not accepted as measured success", async () => {
      const g = make("groq", "success", binding, undefined, p => ({ metadata: { kind: "http_response", status: 200,
        body: { model: p.model, usage: { prompt_tokens: 8, completion_tokens: 12 } } },
        counters: { requests: { kind: "estimated", amount: 1, evidence: "explicit_upper_bound_v1" } } }));
      assert.equal((await g.send()).status, 502); assert.equal((await rows(db, "usage_accounting")).length, 0);
      const links = await rows(db, "reservation_quota_windows");
      assert.ok(links.some(l => l.failure_basis === "estimated")); assert.ok(links.some(l => l.failure_basis === "measured"));
    });
    await scenario("a header limit above account policy never increases persisted capacity", async () => {
      const g = make("groq", "success", binding, undefined, p => ({ metadata: { kind: "http_response", status: 200,
        headers: [["x-ratelimit-limit-tokens", "9999999"]], body: { model: p.model } } }));
      assert.equal((await noContent(await g.send())).state, "reconciliation_failed");
      assert.ok((await rows(db, "provider_quota_windows")).every(w => Number(w.limit_amount) <= 200000));
    });
    for (const later of [false, true]) await scenario(`an already admitted response ${later ? "extends" : "duplicates"} existing hold evidence safely`, async () => {
      const g = make("groq", "retry_after"), generate = g.provider.generate.bind(g.provider), p = g.config.policy;
      g.provider.generate = async (...args) => {
        const observedAt = later ? now - 1 : now;
        const result = await new D1ProviderHolds(binding, p, () => now).record({ operationId: crypto.randomUUID(),
          quotaScopeId: p.quotaScopeId, provider: p.provider, model: p.model, policyVersion: p.version, observedAt,
          reason: "provider_retry_after", source: "verified_retry_after", until: observedAt + 17 });
        assert.equal(result.state, "recorded"); return generate(...args);
      };
      assert.equal((await g.send()).status, 429); const hold = (await rows(db, "provider_holds"))[0]!;
      assert.equal(hold.hold_until, NOW + 17); assert.equal(hold.revision, later ? 2 : 1);
      assert.equal((await rows(db, "provider_hold_operations")).length, 2);
    });
    await scenario("stronger existing operational hold is never cleared by a successful observation", async () => {
      const g = make(), generate = g.provider.generate.bind(g.provider), p = g.config.policy;
      g.provider.generate = async (...args) => {
        assert.equal((await new D1ProviderHolds(binding, p, () => now).record({ operationId: crypto.randomUUID(),
          quotaScopeId: p.quotaScopeId, provider: p.provider, model: p.model, policyVersion: p.version, observedAt: now,
          reason: "temporary_provider_unavailable", source: "operational", until: null })).state, "recorded");
        return generate(...args);
      };
      assert.equal((await g.send()).status, 200); const next = make(); await noContent(await next.send()); assert.equal(next.calls, 0);
      assert.equal((await rows(db, "provider_holds"))[0]!.hold_until, null);
    });
    await scenario("concurrent admitted observations converge without extending a duplicate deadline", async () => {
      const g = make("groq", "retry_after");
      let reached = 0, release!: () => void;
      const both = new Promise<void>(resolve => { release = resolve; });
      // Both admissions commit before either arms a barrier. This is the
      // explicitly permitted earlier-admission case, not retroactive blocking.
      const open = g.services!.execution.open.bind(g.services!.execution);
      g.services!.execution.open = async (...args) => { if (++reached === 2) release(); await both; return open(...args); };
      const responses = await Promise.all([g.send(), g.send()]); responses.forEach(r => assert.ok([429, 503].includes(r.status)));
      assert.equal(g.calls, 2); const holds = await rows(db, "provider_holds"); assert.equal(holds.length, 1);
      assert.equal(holds[0]!.hold_until, NOW + 17); assert.equal(holds[0]!.revision, 1);
      const next = make(); await noContent(await next.send()); assert.equal(next.calls, 0);
    });
    await scenario("lost response delivery replays only completed status", async () => {
      const g = make(), id = crypto.randomUUID(); await g.send(id); // Simulated discarded network response.
      const before = await snapshot(db); assert.equal((await noContent(await g.send(id))).state, "completed");
      assert.equal(g.calls, 1); assert.deepEqual(await snapshot(db), before);
    });

    const boundaries: [string, (sql: string[]) => boolean, PolicyMockScenario, boolean][] = [
      ["provisioning", sql => sql.some(s => s.startsWith("INSERT INTO provider_capacity_policies")), "success", false],
      ["admission", sql => sql.some(s => s.startsWith("INSERT INTO request_reservations")), "success", false],
      ["authorization", sql => sql.some(s => s.startsWith("INSERT INTO inference_attempts")), "success", false],
      ["evidence barrier", sql => sql.some(s => s.includes("SET provider_evidence_state = 'pending'")), "success", false],
      ["dispatch", sql => sql.some(s => s.startsWith("UPDATE inference_attempts SET status = 'sent'")), "success", false],
      ["hold persistence", sql => sql.some(s => s.startsWith("INSERT INTO provider_holds")), "rpd_exhausted", true],
      ["evidence acknowledgement", sql => sql.some(s => s.includes("SET provider_evidence_state = 'acknowledged'")), "success", true],
      ["success settlement", sql => sql.some(s => s.startsWith("INSERT INTO usage_accounting")), "success", true],
      ["failure accounting", sql => sql.some(s => s.startsWith("UPDATE inference_attempts SET failure_category")), "error", true],
    ];
    for (const [name, match, mode, sent] of boundaries) for (const afterCommit of [false, true]) {
      await scenario(`${name}: ${afterCommit ? "lost acknowledgement" : "write failure"} remains conservative`, async () => {
        let injected = false;
        const broken = fault(binding, sql => !injected && match(sql), async () => { injected = true; throw new Error("SECRET SQL sentinel"); }, afterCommit);
        const g = make("groq", mode, broken), id = crypto.randomUUID();
        const response = await g.send(id); await noContent(response); assert.ok(injected, name); assert.equal(g.calls, sent ? 1 : 0);
        const before = await snapshot(db); await noContent(await make().send(id)); assert.deepEqual(await snapshot(db), before);
        if (name === "hold persistence") {
          const next = make(); await noContent(await next.send()); assert.equal(next.calls, 0);
          assert.equal(before.inference_attempts![0]!.provider_evidence_state, afterCommit ? "acknowledged" : "pending");
        }
      });
    }
    await scenario("durably newer policy racing admission rolls back the older reservation", async () => {
      const p = make().config.policy; let changed = false;
      const raced = fault(binding, sql => !changed && sql.some(s => s.startsWith("INSERT INTO request_reservations")), async () => {
        changed = true; const next = structuredClone(p); next.version++; next.dimensions[0]!.safetyMargin = 1;
        assert.equal((await new D1QuotaProvisioning(binding).provision(next)).state, "provisioned");
      });
      const g = make("groq", "success", raced); await noContent(await g.send()); assert.ok(changed); assert.equal(g.calls, 0);
      assert.equal((await rows(db, "request_reservations")).length, 0);
    });
    await scenario("hold committed after diagnostic reads blocks the atomic admission write", async () => {
      const p = make().config.policy; let changed = false;
      const raced = fault(binding, sql => !changed && sql.some(s => s.startsWith("INSERT INTO request_reservations")), async () => {
        changed = true; const result = await new D1ProviderHolds(binding, p, () => now).record({ operationId: crypto.randomUUID(),
          quotaScopeId: p.quotaScopeId, provider: p.provider, model: p.model, policyVersion: p.version, observedAt: now,
          reason: "temporary_provider_unavailable", source: "operational", until: null }); assert.equal(result.state, "recorded");
      });
      const g = make("groq", "success", raced); await noContent(await g.send()); assert.ok(changed); assert.equal(g.calls, 0);
      assert.equal((await rows(db, "request_reservations")).length, 0);
    });
    await scenario("fencing change immediately before hold transaction rolls it back", async () => {
      let changed = false;
      const raced = fault(binding, sql => !changed && sql.some(s => s.startsWith("INSERT INTO provider_holds")), async () => {
        changed = true; await db.prepare("UPDATE idempotency_records SET generation = generation + 1").run();
      });
      const g = make("groq", "rpd_exhausted", raced); assert.equal((await noContent(await g.send())).state, "stale_owner");
      assert.ok(changed); assert.equal((await rows(db, "provider_holds")).length, 0);
      assert.equal((await rows(db, "provider_hold_operations")).length, 0);
    });
    await scenario("required quota window lost before admission prevents every reservation", async () => {
      let removed = false;
      const raced = fault(binding, sql => !removed && sql.some(s => s.startsWith("INSERT INTO request_reservations")), async () => {
        removed = true; await db.prepare("DELETE FROM provider_quota_windows WHERE quota_metric = 'tokens'").run();
      });
      const g = make("groq", "success", raced); await noContent(await g.send()); assert.ok(removed); assert.equal(g.calls, 0);
      assert.equal((await rows(db, "request_reservations")).length, 0);
    });
    await scenario("a new pending barrier racing admission is checked inside the transaction", async () => {
      const first = make(); let pending = false, release!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const generate = first.provider.generate.bind(first.provider);
      first.provider.generate = async (...args) => { pending = true; await waiting; return generate(...args); };
      let firstResponse: Promise<Response> | undefined;
      const raced = fault(binding, sql => sql.some(s => s.startsWith("INSERT INTO request_reservations")), async () => {
        firstResponse = first.send();
        while (!pending) await new Promise(resolve => setTimeout(resolve, 1));
      });
      const second = make("groq", "success", raced);
      try { await noContent(await second.send()); assert.equal(second.calls, 0); }
      finally { release(); }
      assert.equal((await firstResponse!).status, 200);
      assert.equal((await rows(db, "request_reservations")).length, 1);
    });
    await scenario("a pending Groq barrier isolates other providers and account scopes", async () => {
      await make("groq", "malformed_metadata").send();
      assert.equal((await make("cloudflare_workers_ai").send()).status, 200);
      assert.equal((await make("groq", "success", binding, c => { c.policy.quotaScopeId = "other-trusted-account"; }).send()).status, 200);
    });
    await scenario("missing D1, policy and accounting never permit an unmetered fallback", async () => {
      const config = make().config;
      for (const env of [environment(), { ...environment(binding), COACH_FINGERPRINT_SECRET: "" },
        { ...environment(binding), LOCAL_DURABLE_CONFIG: JSON.stringify({ ...config, policy: null }) }]) {
        const r = await local.fetch(request(), { LOCAL_MOCK_ENABLED: "true", LOCAL_DURABLE_CONFIG: JSON.stringify(config), ...env });
        assert.equal(r.status, 503); await noContent(r);
      }
      assert.equal((await rows(db, "request_reservations")).length, 0);
    });
    await scenario("production and non-loopback local entry reject policy simulation flags", async () => {
      const config = make().config, env = { ...environment(binding), LOCAL_MOCK_ENABLED: "true", LOCAL_DURABLE_CONFIG: JSON.stringify(config) };
      const external = () => new Request("https://example.test/api/coach/generate", request());
      assert.equal((await production.fetch(external(), env)).status, 503);
      assert.equal((await local.fetch(external(), env)).status, 503);
      assert.equal((await rows(db, "idempotency_records")).length, 0);
    });
    await scenario("private text, raw responses, credentials and errors do not enter storage or logs", async () => {
      const logs: unknown[][] = [], old = console.error; console.error = (...args) => { logs.push(args); };
      try {
        const response = await make().send(crypto.randomUUID(), { contract_version: "2", task_id: "term_clarification", input: { term: "PRIVATE REFLECTION sentinel" } });
        assert.equal(response.status, 200); const data = JSON.stringify(await snapshot(db));
        for (const secret of ["PRIVATE REFLECTION sentinel", "Mock definition", "a".repeat(64), "b".repeat(64), "SECRET SQL sentinel"]) assert.ok(!data.includes(secret));
        assert.deepEqual(logs, []);
      } finally { console.error = old; }
    });
  } finally { await mf.dispose(); }
});

for (const mode of ["success", "rpd_exhausted", "malformed_metadata"] as const) test(`Part 4E-4 ${mode} survives a local Worker restart`, { timeout: 60_000 }, async () => {
  await mkdir(new URL("../.wrangler/provider-gateway-tests/", import.meta.url), { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL("../.wrangler/provider-gateway-tests/restart-", import.meta.url)));
  let mf = runtime(directory);
  try {
    let db = await mf.getD1Database("COACH_DB"); await migrate(db); const id = crypto.randomUUID();
    await setup(clocked(db, () => NOW), () => NOW, "groq", mode).send(id);
    const before = await snapshot(db); await mf.dispose(); mf = runtime(directory); db = await mf.getD1Database("COACH_DB");
    const next = setup(clocked(db, () => NOW), () => NOW);
    await noContent(await next.send(id)); assert.equal(next.calls, 0); assert.deepEqual(await snapshot(db), before);
    if (mode !== "success") { await noContent(await next.send()); assert.equal(next.calls, 0); }
  } finally { await mf.dispose(); }
});

test("Part 4E-4 compiled local Worker executes the policy pipeline inside workerd", { timeout: 60_000 }, async () => {
  const now = Math.floor(Date.now() / 1000), policy = policyFixture("groq", now);
  policy.reviewAfter = now + 86400;
  const config: LocalProviderConfig = { policy, bounds: { inputTokens: 100, outputTokens: 200 },
    ownership: { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 172800 } };
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: await readFile(new URL("../dist/local/index.js", import.meta.url), "utf8"),
    compatibilityDate: "2026-11-03", cf: false, telemetry: { enabled: false },
    d1Databases: { COACH_DB: "provider-gateway-runtime" }, bindings: { ...environment(),
      LOCAL_MOCK_ENABLED: "true", MOCK_SCENARIO: "zero_remaining", LOCAL_DURABLE_CONFIG: JSON.stringify(config) },
    outboundService: () => { throw new Error("External networking forbidden"); },
  }));
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const id = crypto.randomUUID(), input = request(id);
    const send = (r: Request) => mf.dispatchFetch(r.url, { method: r.method, headers: Object.fromEntries(r.headers), body: r.body!, duplex: "half" });
    const first = await send(input); assert.equal(first.status, 200, await first.clone().text());
    const before = await snapshot(db); assert.equal(before.provider_holds!.length, 1);
    assert.equal(before.usage_accounting!.length, 1);
    const replay = await send(request(id)); assert.equal((await replay.json() as { state: string }).state, "completed");
    assert.deepEqual(await snapshot(db), before);
    assert.notEqual((await send(request())).status, 200);
    assert.equal((await rows(db, "inference_attempts")).length, 1);
  } finally { await mf.dispose(); }
});
