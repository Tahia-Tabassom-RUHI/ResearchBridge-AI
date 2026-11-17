import assert from "node:assert/strict";
import { test } from "node:test";
import { adapted, http, NOW, observed, operation, responseFixture } from "./provider-response-fixture";

const cases = [[3036, 429, "quota_exhausted"], [3040, 429, "temporary_capacity_unavailable"], [5035, 403, "paid_plan_required"],
  [5028, 410, "model_deprecated"], [5018, 403, "model_access_denied"], [3041, 403, "model_access_denied"], [5007, 400, "model_unavailable"],
  [3042, 404, "model_unavailable"], [3007, 408, "provider_timeout"], [3008, 408, "connection_interrupted"], [5004, 400, "invalid_request"],
  [3003, 400, "invalid_request"], [3006, 413, "invalid_request"], [5005, 405, "invalid_request"]] as const;
for (const [code, status, classification] of cases) for (const transport of ["workers_ai_binding", "workers_ai_http"] as const) {
  test(`Workers AI ${transport} code ${code} is ${classification}`, async () => {
    const f = responseFixture("cloudflare_workers_ai", transport), o = observed(f.parser.observe(transport === "workers_ai_binding" ?
      { kind: "binding_error", namespace: "workers_ai", code } : http(status, [], { success: false, errors: [{ code, message: "PRIVATE PROVIDER ERROR" }] })));
    assert.equal(o.classification, classification); assert.equal(o.providerErrorCode, code); assert.equal(o.httpStatus, transport === "workers_ai_binding" ? null : status);
    assert.equal(o.retry.state, "missing"); assert.equal(o.usage, null); assert.ok(!JSON.stringify(o).includes("PRIVATE"));
    const r = adapted(await f.parser.holdEvidence(o, operation));
    if (code === 3036) {
      assert.equal(r.state, "eligible"); assert.equal(r.evidence.length, 1);
      assert.equal(r.evidence[0]!.reason, "compute_capacity_exhausted"); assert.equal(r.evidence[0]!.source, "confirmed_exhaustion");
      assert.equal(r.evidence[0]!.model, ""); assert.equal(r.evidence[0]!.until, NOW + 86400);
      assert.deepEqual(r.evidence[0]!.dimension, { metric: "compute_units", unit: "neurons", windowSeconds: 86400 });
    } else {
      assert.equal(r.evidence.length, 0);
      if ([3040, 5035, 5028, 5018, 3041, 5007, 3042].includes(code)) assert.ok(r.reasons.includes("operational_evidence_required"));
    }
  });
}
test("3036 near midnight uses the verified next UTC boundary", async () => {
  const f = responseFixture("cloudflare_workers_ai"); f.time(NOW + 86399);
  const parser = f.create(), o = observed(parser.observe({ kind: "binding_error", namespace: "workers_ai", code: 3036 }));
  assert.equal(adapted(await parser.holdEvidence(o, operation)).evidence[0]!.until, NOW + 86400);
});
test("3040 HTTP with a genuine retry instruction keeps model scope and exact deadline", async () => {
  const f = responseFixture("cloudflare_workers_ai", "workers_ai_http"), o = observed(f.parser.observe(http(429, [["retry-after", "23"]], { success: false, errors: [{ code: 3040 }] })));
  const r = adapted(await f.parser.holdEvidence(o, operation)); assert.equal(r.state, "review_required");
  assert.equal(r.evidence[0]!.until, NOW + 23); assert.equal(r.evidence[0]!.model, f.policy.model);
  assert.equal(r.evidence[0]!.reason, "provider_retry_after"); assert.deepEqual(o.quotas, []);
});
test("generic 429 never becomes daily neuron exhaustion", async () => {
  const f = responseFixture("cloudflare_workers_ai", "workers_ai_http"), o = observed(f.parser.observe(http(429)));
  assert.equal(o.classification, "rate_limited"); assert.deepEqual(o.quotas, []); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
});
test("503 Retry-After can report a genuine temporary instruction without quota claims", async () => {
  const f = responseFixture("cloudflare_workers_ai", "workers_ai_http"), o = observed(f.parser.observe(http(503, [["retry-after", "23"]])));
  assert.equal(o.classification, "provider_error"); assert.deepEqual(o.quotas, []);
  assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence[0]!.until, NOW + 23);
});
for (const [code, status] of [[5028, 410], [5035, 403], [5018, 403], [5007, 400]] as const) test(`availability code ${code} never suggests a cooldown or paid fallback`, async () => {
  const f = responseFixture("cloudflare_workers_ai", "workers_ai_http"), model = f.policy.model;
  const o = observed(f.parser.observe(http(status, [["retry-after", "10"]], { success: false, errors: [{ code }] })));
  assert.ok(o.issues.includes("unexpected_retry")); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
  assert.notEqual(o.retry.state, "known");
  assert.equal(f.policy.model, model); assert.equal(f.policy.billing, "free_only");
});
test("future deprecation announcement is not a present response failure", () => {
  const f = responseFixture("cloudflare_workers_ai"), o = observed(f.parser.observe({ kind: "binding_result", body: { model: f.policy.model, usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } } }));
  assert.equal(o.classification, "usage_observation"); assert.equal(o.providerErrorCode, null); assert.equal(o.retry.state, "missing");
  assert.equal(o.usage!.measurements.inputTokens!.amount, 3); assert.equal(o.usage!.measurements.computeUnits, undefined);
});
test("native HTTP result token usage is preserved without inferred neurons", () => {
  const f = responseFixture("cloudflare_workers_ai", "workers_ai_http"), o = observed(f.parser.observe(http(200, [], { success: true, errors: [], result: { model: f.policy.model, usage: { total_tokens: 50 } } })));
  assert.equal(o.usage!.measurements.totalTokens!.amount, 50); assert.equal(o.usage!.measurements.inputTokens, undefined); assert.equal(o.usage!.measurements.computeUnits, undefined);
});
for (const body of ["PRIVATE ERROR", null, { success: false, errors: "3036" }, { success: false, errors: [{ code: "3036" }] },
  { success: false, errors: [{ code: -1 }] }, { success: false, errors: Array(9).fill({ code: 3036 }) }, { error: { code: 3036 } }]) {
  test(`malformed Workers AI HTTP payload ${JSON.stringify(body).slice(0, 65)} cannot create holds`, async () => {
    const f = responseFixture("cloudflare_workers_ai", "workers_ai_http"), o = observed(f.parser.observe(http(429, [], body)));
    assert.ok(o.issues.includes("invalid_body")); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
  });
}
for (const body of [{ success: true, errors: [{ code: 3036 }] }, { success: false, errors: [{ code: 3036 }, { code: 3040 }] }]) {
  test("conflicting Workers AI body evidence is rejected for holds", async () => {
    const f = responseFixture("cloudflare_workers_ai", "workers_ai_http"), o = observed(f.parser.observe(http(429, [], body)));
    assert.ok(o.issues.includes("contradictory_response")); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
  });
}
test("HTTP status inconsistent with a known Workers AI code is not silently accepted", async () => {
  const f = responseFixture("cloudflare_workers_ai", "workers_ai_http"), o = observed(f.parser.observe(http(500, [], { success: false, errors: [{ code: 3036 }] })));
  assert.ok(o.issues.includes("contradictory_response")); assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
});
test("unknown Workers AI codes stay provider errors without quota or retry invention", async () => {
  const f = responseFixture("cloudflare_workers_ai"), o = observed(f.parser.observe({ kind: "binding_error", namespace: "workers_ai", code: 9999 }));
  assert.equal(o.classification, "provider_error"); assert.ok(o.issues.includes("unknown_error_code"));
  assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
});
for (const namespace of ["ai_gateway", "cloudflare_api", "browser", undefined]) test(`binding namespace ${namespace} cannot impersonate Workers AI`, () => {
  const f = responseFixture("cloudflare_workers_ai"); assert.equal(f.parser.observe({ kind: "binding_error", namespace, code: 3036 }).state, "rejected");
});
test("binding cannot invent HTTP status, headers, or extract a code from error text", () => {
  for (const raw of [{ kind: "binding_error", namespace: "workers_ai", code: 3040, headers: [["retry-after", "10"]] },
    { kind: "binding_error", namespace: "workers_ai", code: "3036" }, new Error("AiGatewayError: 3036: PRIVATE"),
    { kind: "http_response", status: 429, headers: [["retry-after", "10"]] }]) {
    assert.equal(responseFixture("cloudflare_workers_ai").parser.observe(raw).state, "rejected");
  }
});
