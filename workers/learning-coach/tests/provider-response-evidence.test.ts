import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { QWEN_REVIEW_BOUNDARY } from "../src/config/provider-policy";
import { ProviderResponseParser } from "../src/providers/response-parser";
import { normalizeFailure } from "../src/storage/failure-usage";
import { normalizeHoldObservation } from "../src/storage/provider-hold-evidence";
import { normalizeSettlementUsage } from "../src/storage/settlement-usage";
import { D1ProviderHolds } from "../src/storage/d1-provider-holds";
import { D1QuotaProvisioning } from "../src/storage/d1-quota-provisioning";
import { D1QuotaAdmission, type D1Binding } from "../src/storage/d1-quota-admission";
import { migrate, runtime, tables } from "./local-pipeline-fixture";
import { policyFixture } from "./provider-policy-fixture";
import { adapted, header, http, NOW, observed, operation, responseFixture } from "./provider-response-fixture";

test("copied and fabricated observation objects cannot become hold or usage evidence", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [header("remaining-tokens", "0")], { usage: { total_tokens: 30 } })));
  for (const forged of [structuredClone(o), JSON.parse(JSON.stringify(o)), { ...o, source: "browser" }, { ...o, provider: "cloudflare_workers_ai" }, null]) {
    assert.deepEqual(await f.parser.holdEvidence(forged, operation), { state: "rejected", reason: "untrusted_observation" });
    assert.equal(f.parser.usageEvidence(forged, f.attempt), undefined);
  }
});
test("mutating an authentic observation is rejected without corrupting its private snapshot", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(429, [["retry-after", "2"]])));
  o.model = "forged"; assert.equal((await f.parser.holdEvidence(o, operation)).state, "rejected");
  o.model = f.policy.model; assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence[0]!.until, NOW + 2);
});
test("observations cannot cross accounts, models, attempts or parser instances", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [header("remaining-tokens", "0")], { usage: { total_tokens: 30 } })));
  const otherPolicy = structuredClone(f.policy); otherPolicy.quotaScopeId = "other-account";
  const other = responseFixture("groq", "groq_http", otherPolicy);
  assert.equal((await other.parser.holdEvidence(o, operation)).state, "rejected");
  assert.equal(f.parser.usageEvidence(o, { ...f.attempt, attemptId: crypto.randomUUID() }), undefined);
  assert.equal(f.parser.usageEvidence(o, { ...f.attempt, reservationId: crypto.randomUUID() }), undefined);
  assert.equal(f.parser.usageEvidence(o, { ...f.attempt, provider: "cloudflare_workers_ai" }), undefined);
  assert.equal(f.parser.usageEvidence(o, { ...f.attempt, model: "wrong-model" }), undefined);
});
test("original trusted configuration and attempt are cloned", async () => {
  const f = responseFixture(), originalModel = f.policy.model;
  f.policy.quotaScopeId = "mutated-account"; f.attempt.model = "mutated-model";
  const o = observed(f.parser.observe(http(429, [["retry-after", "2"]])));
  const e = adapted(await f.parser.holdEvidence(o, operation)).evidence[0]!;
  assert.equal(e.quotaScopeId, "synthetic-account"); assert.equal(e.model, originalModel);
});
test("only one observation per provider attempt context prevents time-shifted duplicate parsing", () => {
  const f = responseFixture(), input = http(429, [["retry-after", "2"]]); observed(f.parser.observe(input));
  f.time(NOW + 1); assert.deepEqual(f.parser.observe(input), { state: "rejected", reason: "already_observed" });
});
test("stable caller operation yields stable independent child receipts", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(429, [["retry-after", "4"], header("remaining-requests", "0"), header("remaining-tokens", "0")])));
  const first = adapted(await f.parser.holdEvidence(o, operation)); assert.equal(first.evidence.length, 3);
  assert.equal(new Set(first.evidence.map(e => e.operationId)).size, 3);
  assert.deepEqual(await f.parser.holdEvidence(o, operation), first);
  for (const e of first.evidence) assert.deepEqual(normalizeHoldObservation(e, f.policy, NOW), e);
  assert.deepEqual(await f.parser.holdEvidence(o, "student-name"), { state: "rejected", reason: "invalid_operation_ids" });
});
for (const raw of [{ kind: "http_response", status: 429, source: "browser", headers: [["retry-after", "5"]] },
  { kind: "http_response", status: 429, quotaScopeId: "client-account" }, { kind: "http_response", status: 429, observedAt: NOW },
  { kind: "http_response", status: 429, provider: "groq" }, { kind: "http_response", status: 429, model: "client-model" },
  { kind: "http_response", status: 429, credentials: "PRIVATE KEY" }, new Request("https://example.invalid", { headers: { "retry-after": "5" } })]) {
  test("request-controlled context and request objects are rejected", () => assert.equal(responseFixture().parser.observe(raw).state, "rejected"));
}
for (const [label, alter] of [
  ["unknown provider", (p: any) => { p.provider = "unknown"; }], ["wrong model", (p: any) => { p.model = "other-model"; }],
  ["paid plan", (p: any) => { p.plan = "paid"; }], ["automatic billing", (p: any) => { p.billing = "auto_upgrade"; }],
  ["disabled policy", (p: any) => { p.enabled = false; }], ["expired policy", (p: any) => { p.reviewAfter = NOW; }],
] as const) test(`parser context rejects ${label}`, () => {
  const f = responseFixture(), p = structuredClone(f.policy); alter(p);
  assert.equal(ProviderResponseParser.create(p, f.attempt, "groq_http", () => NOW).state, "rejected");
});
test("mismatched transport or attempt identity cannot construct a trusted parser", () => {
  const f = responseFixture();
  for (const attempt of [{ ...f.attempt, model: "other" }, { ...f.attempt, provider: "cloudflare_workers_ai" }, { ...f.attempt, attemptId: "student" }])
    assert.equal(ProviderResponseParser.create(f.policy, attempt, "groq_http", () => NOW).state, "rejected");
  assert.equal(ProviderResponseParser.create(f.policy, f.attempt, "workers_ai_http", () => NOW).state, "rejected");
  assert.equal(ProviderResponseParser.create(f.policy, f.attempt, "browser" as any, () => NOW).state, "rejected");
});
test("redirects and invalid HTTP statuses are not treated as provider completions", () => {
  for (const status of [101, 302, 399, 600, 429.5, "429", null]) assert.equal(responseFixture().parser.observe({ kind: "http_response", status }).state, "rejected");
});
test("wrong model in provider body rejects all usage and hold signals", () => {
  for (const body of [{ model: "wrong", usage: { total_tokens: 100 } }, { result: { model: "wrong" } }])
    assert.deepEqual(responseFixture().parser.observe(http(200, [header("remaining-tokens", "0")], body)), { state: "rejected", reason: "identity_mismatch" });
});
test("clock failures, stale contexts and future timestamps cannot mint observations", () => {
  const f = responseFixture();
  for (const now of [NaN, Infinity, -1, NOW + 0.5]) assert.equal(ProviderResponseParser.create(f.policy, f.attempt, "groq_http", () => now).state, "rejected");
  f.time(NOW - 1); assert.deepEqual(f.parser.observe(http()), { state: "rejected", reason: "stale_context" });
  const stale = responseFixture(); stale.time(NOW + 301); assert.equal(stale.parser.observe(http()).state, "rejected");
  const unavailable = responseFixture(); unavailable.time(NaN); assert.equal(unavailable.parser.observe(http()).state, "rejected");
});
test("stale observations, expired deadlines and changed policies cannot create fresh restrictions", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(429, [["retry-after", "2"]], { usage: { total_tokens: 30 } })));
  f.time(NOW + 2); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
  f.time(NOW + 301); assert.deepEqual(await f.parser.holdEvidence(o, operation), { state: "rejected", reason: "stale_observation" });
  assert.equal(f.parser.usageEvidence(o, f.attempt)!.totalTokens!.amount, 30);
  f.time(NOW); const p = structuredClone(f.policy); p.version++;
  assert.deepEqual(await f.parser.holdEvidence(o, operation, p), { state: "rejected", reason: "policy_unavailable" });
  p.version--; p.enabled = false; assert.equal((await f.parser.holdEvidence(o, operation, p)).state, "rejected");
});
test("historical Qwen eligibility closes at its existing review/deprecation boundary", async () => {
  const p = policyFixture("cloudflare_workers_ai", QWEN_REVIEW_BOUNDARY - 10), f = responseFixture("cloudflare_workers_ai");
  const attempt = { ...f.attempt, model: p.model };
  assert.equal(ProviderResponseParser.create(p, attempt, "workers_ai_binding", () => QWEN_REVIEW_BOUNDARY - 1).state, "ready");
  assert.equal(ProviderResponseParser.create(p, attempt, "workers_ai_binding", () => QWEN_REVIEW_BOUNDARY).state, "rejected");
  assert.equal(p.model, "@cf/qwen/qwen3-30b-a3b-fp8");
});
test("in-flight observations remain classifiable after review expiry but cannot mint hold evidence", async () => {
  const f = responseFixture(), p = structuredClone(f.policy); p.reviewAfter = NOW + 1;
  const nearExpiry = responseFixture("groq", "groq_http", p); nearExpiry.time(NOW + 1);
  const o = observed(nearExpiry.parser.observe(http(429, [["retry-after", "10"]])));
  assert.equal(o.classification, "rate_limited"); assert.deepEqual(await nearExpiry.parser.holdEvidence(o, operation), { state: "rejected", reason: "policy_unavailable" });
});
for (const failure of ["timeout", "interrupted"] as const) test(`transport ${failure} preserves uncertain outcome without fabricated usage or holds`, async () => {
  const f = responseFixture(), o = observed(f.parser.observe({ kind: "transport_failure", failure }));
  assert.equal(o.classification, failure === "timeout" ? "provider_timeout" : "connection_interrupted");
  assert.equal(o.httpStatus, null); assert.equal(o.usage, null); assert.deepEqual(o.quotas, []);
  assert.equal(adapted(await f.parser.holdEvidence(o, operation)).state, "no_hold");
});
for (const raw of [{ total_tokens: -1 }, { prompt_tokens: 1.5 }, { completion_tokens: "3" }, { total_tokens: Number.MAX_SAFE_INTEGER + 1 },
  { prompt_tokens: 10, completion_tokens: 20, total_tokens: 29 }, { prompt_tokens: 31, total_tokens: 30 },
  { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 }, { total_tokens: NaN }, null]) {
  test(`invalid usage ${JSON.stringify(raw)} never becomes measured zero`, () => {
    const f = responseFixture(), o = observed(f.parser.observe(http(200, [], { usage: raw })));
    assert.equal(o.usage, null); assert.equal(f.parser.usageEvidence(o, f.attempt), undefined); assert.ok(o.issues.includes("invalid_usage"));
  });
}
for (const raw of [{ neurons: 0 }, { requests: 1 }, { input_tokens: 3 }, { total_tokens: 3, unit: "neurons" }, { kind: "estimated", total_tokens: 3 }]) {
  test("unsupported usage units or provenance cannot become token/compute settlements", () => {
    const f = responseFixture(), o = observed(f.parser.observe(http(200, [], { usage: raw })));
    assert.equal(o.usage, null); assert.ok(o.issues.includes("unsupported_usage"));
  });
}
test("partial measured usage keeps missing fields absent and overages intact", () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(500, [], { usage: { prompt_tokens: 20000 } })));
  const usage = f.parser.usageEvidence(o, f.attempt)!;
  assert.deepEqual(usage, { inputTokens: { kind: "measured", amount: 20000, evidence: "provider_report" } });
  assert.equal(normalizeSettlementUsage(usage as any), undefined);
  assert.notEqual(typeof normalizeFailure({ category: "CONFIRMED_PROVIDER_ERROR", reason: "provider_http_error", httpStatus: 500, usage }), "string");
});
test("explicit measured zero remains distinct from missing usage", () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [], { usage: { completion_tokens: 0 } })));
  assert.equal(o.usage!.measurements.outputTokens!.amount, 0); assert.equal(o.usage!.measurements.inputTokens, undefined);
  assert.equal(observed(responseFixture().parser.observe(http())).usage, null);
});
for (const headers of [Array(129).fill(["retry-after", "3"]), [["retry-after", "3\r\nAuthorization: PRIVATE"]], [["invalid name", "x"]],
  [["x-ignore", "x".repeat(4097)]], Array(5).fill(["x-ignore", "x".repeat(4000)]), { "retry-after": "3" }]) {
  test("malformed or excessive headers are bounded without echoing content", async () => {
    const f = responseFixture(), o = observed(f.parser.observe({ kind: "http_response", status: 429, headers }));
    assert.ok(o.issues.includes("invalid_headers")); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
    assert.ok(!JSON.stringify(o).includes("PRIVATE"));
  });
}
test("normalization modules contain no networking, logging, database, or gateway execution", async () => {
  const names = (await readdir(new URL("../src/providers/", import.meta.url))).filter(n => /^response-|^(groq|cloudflare)-response/.test(n));
  for (const name of names) {
    const source = await readFile(new URL(`../src/providers/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(|\bconsole\s*\.|\.prepare\s*\(|\.batch\s*\(|\.run\s*\(|from ["'][^"']*(?:d1-|gateway)/, name);
  }
});

test("normalized evidence integrates with real local D1 holds without parser-side mutation", { timeout: 60000 }, async t => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const binding: D1Binding = { prepare: sql => db.prepare(sql.replaceAll("unixepoch()", String(NOW))), batch: statements => db.batch(statements) };
    const tracked = ["provider_hold_operations", "provider_holds", ...tables, "provider_capacity_policies"];
    const snapshot = async () => Object.fromEntries(await Promise.all(tracked.map(async name => [name, (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results])));
    for (const provider of ["groq", "cloudflare_workers_ai"] as const) await t.test(`${provider} parser supplies validated hold evidence only on explicit storage invocation`, async () => {
      await db.batch(tracked.map(table => db.prepare(`DELETE FROM ${table}`)));
      const f = responseFixture(provider), provision = await new D1QuotaProvisioning(binding, () => NOW).provision(f.policy);
      assert.equal(provision.state, "provisioned"); if (provision.state !== "provisioned") return;
      const before = await snapshot(), o = observed(f.parser.observe(provider === "groq" ? http(200, [header("remaining-tokens", "0"), header("reset-tokens", "1m")]) :
        { kind: "binding_error", namespace: "workers_ai", code: 3036 }));
      const plan = adapted(await f.parser.holdEvidence(o, operation)); assert.deepEqual(await snapshot(), before);
      const holds = new D1ProviderHolds(binding, f.policy, () => NOW), e = plan.evidence[0]!;
      assert.equal((await holds.record(e)).state, "recorded");
      const after = await snapshot(); assert.equal((await holds.record(e)).state, "already_recorded"); assert.deepEqual(await snapshot(), after);
      const r = await new D1QuotaAdmission(binding, [provision.policy]).reserve({ serviceId: "service", requestId: crypto.randomUUID(), provider, model: f.policy.model,
        estimate: { kind: "estimated", requests: 1, inputTokens: 10, outputTokens: 20, computeUnits: { neurons: 1 } } });
      assert.equal(r.status, "quota_dimension_held"); assert.deepEqual(await snapshot(), after);
      for (const table of tables) assert.deepEqual(after[table], before[table]);
    });
    await t.test("parsed provider evidence cannot weaken a stronger operational hold", async () => {
      await db.batch(tracked.map(table => db.prepare(`DELETE FROM ${table}`)));
      const f = responseFixture(), store = new D1ProviderHolds(binding, f.policy, () => NOW);
      await new D1QuotaProvisioning(binding, () => NOW).provision(f.policy);
      const o = observed(f.parser.observe(http(200, [header("remaining-tokens", "0"), header("reset-tokens", "1m")])));
      const e = adapted(await f.parser.holdEvidence(o, operation)).evidence[0]!;
      const { remaining: _remaining, ...operational } = e;
      assert.equal((await store.record({ ...operational, operationId: crypto.randomUUID(), observedAt: NOW - 1, source: "operational", until: null })).state, "recorded");
      assert.equal((await store.record(e)).state, "recorded");
      const held = await store.inspectApplicable(); assert.equal(held.state, "inspected");
      if (held.state === "inspected") { assert.equal(held.holds[0]!.until, null); assert.equal(held.holds[0]!.source, "operational"); }
    });
  } finally { await mf.dispose(); }
});
