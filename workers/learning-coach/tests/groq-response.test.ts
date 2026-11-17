import assert from "node:assert/strict";
import { normalizeHoldObservation } from "../src/storage/provider-hold-evidence";
import { test } from "node:test";
import { normalizeFailure } from "../src/storage/failure-usage";
import { adapted, header, http, NOW, observed, operation, responseFixture } from "./provider-response-fixture";

test("Groq documented headers map to RPD and TPM and preserve measured usage", () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [header("limit-requests", "1000"), header("remaining-requests", "999"), header("reset-requests", "24h"),
    header("limit-tokens", "8000"), header("remaining-tokens", "7970"), header("reset-tokens", "1m")],
  { model: f.policy.model, usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, queue_time: 0.1 }, choices: [{ text: "PRIVATE GENERATED TEXT" }] })));
  assert.equal(o.classification, "usage_observation"); assert.equal(o.quality, "verified");
  assert.deepEqual(o.quotas.map(q => q.dimension), [{ metric: "requests", unit: "requests", windowSeconds: 86400 }, { metric: "tokens", unit: "tokens", windowSeconds: 60 }]);
  assert.equal(o.quotas[0]!.limit, 1000); assert.deepEqual(o.quotas[1]!.reset, { state: "known", until: NOW + 60, basis: "duration" });
  const usage = f.parser.usageEvidence(o, f.attempt)!; assert.equal(usage.inputTokens!.amount, 10); assert.equal(usage.totalTokens!.amount, 30);
  assert.ok(!Object.hasOwn(usage, "requests")); assert.ok(!JSON.stringify(o).includes("PRIVATE"));
  assert.notEqual(typeof normalizeFailure({ category: "UNKNOWN_OUTCOME", reason: "response_missing", usage }), "string");
});
for (const [dimension, reset, reason] of [["requests", "24h", "daily_requests_exhausted"], ["tokens", "60s", "token_rate_exhausted"]] as const) {
  test(`successful Groq zero ${dimension} only holds that dimension`, async () => {
    const f = responseFixture(), o = observed(f.parser.observe(http(200, [header(`remaining-${dimension}`, "0"), header(`reset-${dimension}`, reset)])));
    assert.equal(o.classification, "quota_exhausted"); const r = adapted(await f.parser.holdEvidence(o, operation));
    assert.equal(r.state, "eligible"); assert.equal(r.evidence.length, 1); assert.equal(r.evidence[0]!.reason, reason);
    assert.equal(r.evidence[0]!.model, f.policy.model); assert.equal(r.evidence[0]!.source, "verified_quota");
  });
}
test("zero remaining without reset produces indefinite dimension evidence", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [header("remaining-tokens", "0")])));
  assert.equal(o.quotas[0]!.reset.state, "missing"); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence[0]!.until, null);
});
test("partial headers preserve unknown fields and never manufacture usage", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [header("limit-tokens", "8000")])));
  assert.equal(o.quotas[0]!.remaining, null); assert.equal(o.usage, null); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).state, "no_hold");
});
for (const raw of ["7.66s", "2m59.56s", "1h2m3s"]) test(`provider duration ${raw} creates an independent restrictive deadline`, async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [header("remaining-tokens", "0"), header("reset-tokens", raw)])));
  assert.equal(o.quotas[0]!.reset.state, "known"); assert.ok(!o.issues.includes("reset_policy_conflict"));
  assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence[0]!.until, NOW + ({ "7.66s": 8, "2m59.56s": 180, "1h2m3s": 3723 }[raw]!));
});
for (const raw of [undefined, "invalid", "-10", "1.5", "604801", "0"]) test(`429 with Retry-After ${String(raw)} invents no deadline`, async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(429, raw === undefined ? [] : [["retry-after", raw]])));
  assert.equal(o.classification, "rate_limited"); assert.equal(o.quotas.length, 0); assert.equal(o.usage, null);
  assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
});
test("429 with valid Retry-After creates only a model-specific retry instruction", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(429, [["Retry-After", "2"]])));
  const e = adapted(await f.parser.holdEvidence(o, operation)).evidence[0]!;
  assert.equal(e.until, NOW + 2); assert.equal(e.reason, "provider_retry_after"); assert.equal(e.model, f.policy.model); assert.equal(e.dimension, undefined);
});
test("HTTP-date Retry-After accounts for the trusted provider Date", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(429, [["retry-after", new Date((NOW - 10) * 1000).toUTCString()], ["date", new Date((NOW - 20) * 1000).toUTCString()]])));
  assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence[0]!.until, NOW + 10);
});
for (const [status, classification] of [[400, "invalid_request"], [401, "provider_authentication_failure"], [403, "provider_authentication_failure"], [500, "provider_error"], [502, "provider_error"], [503, "provider_error"]] as const) {
  test(`Groq HTTP ${status} is classified without a fabricated hold or usage`, async () => {
    const f = responseFixture(), o = observed(f.parser.observe(http(status, [], { error: { message: "PRIVATE ERROR", type: "provider_error" } })));
    assert.equal(o.classification, classification); assert.equal(o.usage, null); assert.equal(o.retry.state, "missing");
    assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0); assert.ok(!JSON.stringify(o).includes("PRIVATE"));
  });
}
for (const status of [200, 401, 403, 500, 503]) test(`Groq ignores undocumented Retry-After on ${status}`, async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(status, [["retry-after", "10"]])));
  assert.ok(o.issues.includes("unexpected_retry")); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
});
test("case-insensitive identical duplicate headers are accepted once", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [["X-RateLimit-Remaining-Tokens", " 0\t"], ["x-ratelimit-remaining-tokens", "0"]])));
  assert.equal(o.quotas.length, 1); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 1);
});
test("conflicting duplicate capacity headers cannot create holds", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [header("remaining-tokens", "0"), header("remaining-tokens", "3")])));
  assert.ok(o.issues.includes("conflicting_headers")); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
});
for (const raw of ["-1", "1.2", "1e3", "9007199254740992", "NaN", "", "0, 0", "0, 5", "12 tokens"]) test(`invalid numeric quota ${raw} is rejected`, async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [header("remaining-tokens", raw)])));
  assert.ok(o.issues.includes("invalid_quota")); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
});
test("remaining greater than reported limit is contradictory", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [header("limit-tokens", "1"), header("remaining-tokens", "2")])));
  assert.equal(o.quotas[0]!.quality, "invalid"); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
});
test("larger observed capacity is retained for review but cannot raise a policy or authorize evidence", async () => {
  const f = responseFixture(), before = structuredClone(f.policy), o = observed(f.parser.observe(http(200, [header("limit-tokens", "9000"), header("remaining-tokens", "0")])));
  assert.equal(o.quotas[0]!.limit, 9000); assert.ok(o.issues.includes("capacity_above_policy"));
  assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0); assert.deepEqual(f.policy, before);
});
test("invalid reset is not converted to an indefinite hold", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [header("remaining-tokens", "0"), header("reset-tokens", "NaN")])));
  assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
});
test("fractional reset duration can match a verified policy boundary after upward rounding", async () => {
  const f = responseFixture(); f.time(NOW + 52); const parser = f.create();
  const o = observed(parser.observe(http(200, [header("remaining-tokens", "0"), header("reset-tokens", "7.66s")])));
  const r = adapted(await parser.holdEvidence(o, operation)); assert.equal(r.state, "eligible"); assert.equal(r.evidence[0]!.until, NOW + 60);
});
test("TPM headers cannot be remapped onto separate input/output token policies", async () => {
  const f = responseFixture(), p = structuredClone(f.policy), combined = p.dimensions.find(d => d.metric === "tokens" && d.window.kind === "fixed")!;
  p.dimensions = p.dimensions.filter(d => d !== combined);
  p.dimensions.push({ ...structuredClone(combined), metric: "input_tokens" }, { ...structuredClone(combined), metric: "output_tokens" });
  const separate = responseFixture("groq", "groq_http", p), o = observed(separate.parser.observe(http(200, [header("remaining-tokens", "0")])));
  assert.ok(o.issues.includes("unsupported_dimension")); assert.equal(adapted(await separate.parser.holdEvidence(o, operation)).evidence.length, 0);
});
test("conflicting Retry-After duplicates cannot create a retry hold", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(429, [["Retry-After", "2"], ["retry-after", "3"]])));
  assert.equal(o.retry.state, "invalid"); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
});
test("conflicting Date duplicates cannot authenticate an HTTP-date retry duration", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(429, [["retry-after", new Date((NOW + 10) * 1000).toUTCString()],
    ["date", new Date(NOW * 1000).toUTCString()], ["Date", new Date((NOW + 1) * 1000).toUTCString()]])));
  assert.equal(o.retry.state, "clock_uncertain"); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
});
test("body/status contradiction suppresses otherwise eligible holds", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [header("remaining-tokens", "0")], { error: { code: "invalid_api_key", message: "PRIVATE" } })));
  assert.equal(o.quality, "invalid"); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
});
test("undocumented headers cannot invent RPM, TPD or neuron measurements", () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [["x-ratelimit-rpm", "0"], ["x-ratelimit-tpd", "0"], ["neurons", "0"]])));
  assert.deepEqual(o.quotas, []); assert.equal(o.usage, null);
});

test("nonaligned observed deadlines cannot be replayed after context freshness expires", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [header("remaining-requests", "0"), header("reset-requests", "2m59.56s")])));
  assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence[0]!.until, NOW + 180);
  f.time(NOW + 301); assert.deepEqual(await f.parser.holdEvidence(o, operation), { state: "rejected", reason: "stale_observation" });
});

test("observed deadlines retain scope, units, range and local-window binding checks", async () => {
  const f = responseFixture(), o = observed(f.parser.observe(http(200, [header("remaining-tokens", "0"), header("reset-tokens", "7.66s")])));
  const e = adapted(await f.parser.holdEvidence(o, operation)).evidence[0]!;
  assert.ok(normalizeHoldObservation(e, f.policy, NOW));
  for (const changed of [{ ...e, until: NOW + 604801 }, { ...e, model: "wrong-model" },
    { ...e, quotaScopeId: "wrong-account" }, { ...e, dimension: { ...e.dimension!, unit: "neurons" } },
    { ...e, dimension: { ...e.dimension!, windowId: "local-window" } }])
    assert.equal(normalizeHoldObservation(changed, f.policy, NOW), undefined);
});
