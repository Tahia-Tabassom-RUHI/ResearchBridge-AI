import assert from "node:assert/strict";
import { test } from "node:test";
import { capacityLimit, estimatePolicyReservation, QWEN_REVIEW_BOUNDARY, resetBounds, validateProviderPolicy } from "../src/config/provider-policy";
import { policyWindows } from "../src/storage/d1-quota-provisioning";
import { policyFixture, POLICY_TIME as NOW } from "./provider-policy-fixture";

test("trusted provider policy validation", async t => {
  for (const provider of ["cloudflare_workers_ai", "groq"] as const) await t.test(`valid ${provider} policy`, () => {
    const p = policyFixture(provider); assert.equal(validateProviderPolicy(p, NOW).state, "valid");
  });
  const rejects: [string, (p: any) => void][] = [
    ["missing capacity", p => { delete p.dimensions[0].account; }],
    ["missing protections", p => { p.dimensions = []; }],
    ["incomplete account constraint inventory", p => { p.quotaInventory.complete = false; }],
    ["missing account constraint inventory", p => { delete p.quotaInventory; }],
    ["no request rate protection", p => { p.dimensions.shift(); }],
    ["missing daily compute", p => { p.dimensions.pop(); }],
    ["unverified eligibility", p => { p.eligibility.verified = false; }],
    ["paid-only model", p => { p.eligibility.paidOnly = true; }],
    ["public example is not account eligibility", p => { p.eligibility.source = p.dimensions[1].documented.source; }],
    ["paid plan", p => { p.plan = "paid"; }],
    ["automatic billing", p => { p.billing = "auto_upgrade"; }],
    ["unknown provider", p => { p.provider = "unmetered"; }],
    ["provider identity cannot be coerced", p => { p.provider = [p.provider]; }],
    ["unknown model", p => { p.model = "@cf/unknown/model"; }],
    ["negative limit", p => { p.dimensions[0].account.amount = -1; }],
    ["fractional limit", p => { p.dimensions[0].account.amount = 1.5; }],
    ["unsafe integer", p => { p.dimensions[0].account.amount = Number.MAX_SAFE_INTEGER + 1; }],
    ["negative margin", p => { p.dimensions[0].safetyMargin = -1; }],
    ["excess margin", p => { p.dimensions[0].safetyMargin = 301; }],
    ["infinite margin", p => { p.dimensions[0].safetyMargin = Infinity; }],
    ["duplicate dimensions", p => { p.dimensions.push(structuredClone(p.dimensions[0])); }],
    ["unbounded dimensions", p => { p.dimensions = Array(100).fill(p.dimensions[0]); }],
    ["invented units", p => { p.dimensions[0].unit = "tokens"; }],
    ["unknown reset", p => { p.dimensions[0].window.kind = "rolling_unknown"; }],
    ["out of range anchor", p => { p.dimensions[0].window.anchor = 60; }],
    ["missing reset provenance", p => { delete p.dimensions[0].resetSource; }],
    ["missing estimation", p => { delete p.estimation; }],
    ["missing neuron costs", p => { delete p.estimation.compute; }],
    ["invalid conversion denominator", p => { p.estimation.compute.denominator = 0; }],
    ["token/neuron equivalence", p => { p.estimation.compute.unit = "tokens"; }],
    ["untrusted public source", p => { p.estimation.compute.source.reference = "https://example.com/rates"; }],
    ["runtime observations cannot set capacity", p => { p.runtimeObservations = { limit: 99999999 }; }],
    ["future verification", p => { p.verifiedAt = NOW + 1; }],
    ["future evidence", p => { p.dimensions[0].account.source.verifiedAt = NOW + 1; }],
    ["expired model assumptions cannot be extended", p => { p.reviewAfter = QWEN_REVIEW_BOUNDARY + 1; }],
    ["timestamp overflow", p => { p.retentionSeconds = Number.MAX_SAFE_INTEGER; }],
    ["version overflow", p => { p.version = Number.MAX_SAFE_INTEGER + 1; }],
  ];
  for (const [name, change] of rejects) await t.test(name, () => {
    const p = policyFixture(); change(p); assert.equal(validateProviderPolicy(p, NOW).state, "invalid_policy");
  });
  await t.test("malformed configurations fail closed without throwing", () => {
    for (const p of [null, undefined, {}, [], "", { ...policyFixture(), dimensions: [null] }]) {
      assert.equal(validateProviderPolicy(p, NOW).state, "invalid_policy");
    }
  });
  await t.test("disabled and review boundaries", () => {
    const p = policyFixture(); p.enabled = false; assert.equal(validateProviderPolicy(p, NOW).state, "disabled");
    p.enabled = true; p.reviewAfter = NOW; assert.equal(validateProviderPolicy(p, NOW).state, "review_required");
  });
  await t.test("Groq requires account capacities and reset verification", () => {
    const p = policyFixture("groq"); p.dimensions[0]!.documented = { amount: 1000,
      source: { kind: "provider_documentation", reference: "https://console.groq.com/docs/models", verifiedAt: NOW - 1 } };
    delete p.dimensions[0]!.account; assert.equal(validateProviderPolicy(p, NOW).state, "invalid_policy");
  });
  await t.test("verified accounts need only their applicable dimensions", () => {
    const p = policyFixture("groq");
    p.dimensions = p.dimensions.filter(d => d.window.kind !== "utc_day");
    p.dimensions[1]!.metric = "input_tokens";
    assert.equal(validateProviderPolicy(p, NOW).state, "valid");
    // Omissions require a trusted complete inventory, never an inference from missing data.
    (p.quotaInventory as { complete: boolean }).complete = false;
    assert.equal(validateProviderPolicy(p, NOW).state, "invalid_policy");
  });
  await t.test("strict public and account limits intersect; observations never raise them", () => {
    const p = policyFixture(); p.dimensions[1]!.account!.amount = 5000;
    assert.equal(capacityLimit(p.dimensions[1]!), 5000);
    p.dimensions[1]!.account!.amount = 12000; assert.equal(capacityLimit(p.dimensions[1]!), 10000);
    assert.equal(validateProviderPolicy(p, NOW).state, "valid");
  });
  await t.test("split token caps are alternatives to combined caps", () => {
    const p = policyFixture("groq"), input = structuredClone(p.dimensions[2]!), output = structuredClone(input);
    input.metric = "input_tokens"; output.metric = "output_tokens";
    p.dimensions.push(input, output); assert.equal(validateProviderPolicy(p, NOW).state, "invalid_policy");
    p.dimensions = p.dimensions.filter(d => d.metric !== "tokens" || d.window.kind === "utc_day");
    assert.equal(validateProviderPolicy(p, NOW).state, "valid");
    output.window = { kind: "fixed", seconds: 60, anchor: 1 };
    assert.equal(validateProviderPolicy(p, NOW).state, "invalid_policy");
  });
  await t.test("exact rational compute estimates round upward without unsafe arithmetic", () => {
    const p = policyFixture();
    assert.deepEqual(estimatePolicyReservation(p, NOW, 1000, 1000), { kind: "estimated", requests: 1,
      inputTokens: 1000, outputTokens: 1000, computeUnits: { neurons: 36 } });
    assert.equal(estimatePolicyReservation(p, NOW, Number.MAX_SAFE_INTEGER, 1), undefined);
    p.estimation.compute!.inputNumerator = Number.MAX_SAFE_INTEGER;
    p.estimation.compute!.denominator = 1;
    assert.equal(estimatePolicyReservation(p, NOW, 2, 1), undefined);
  });
  await t.test("deterministic identities exclude policy versions and include provider/model/metric", async () => {
    const p = policyFixture(), first = await policyWindows(p, NOW); p.version = 2;
    assert.deepEqual(await policyWindows(p, NOW), first);
    const groq = await policyWindows(policyFixture("groq"), NOW);
    assert.equal(new Set([...first, ...groq].map(w => w.windowId)).size, first.length + groq.length);
    assert.ok(first.every(w => w.model === "")); assert.ok(groq.every(w => w.model === "openai/gpt-oss-20b"));
  });
});

test("reset boundaries use UTC epoch seconds and configured anchors", () => {
  assert.deepEqual(resetBounds({ kind: "utc_day" }, NOW), { start: NOW, end: NOW + 86400 });
  assert.deepEqual(resetBounds({ kind: "utc_day" }, NOW + 86399), { start: NOW, end: NOW + 86400 });
  assert.deepEqual(resetBounds({ kind: "utc_day" }, NOW + 86400), { start: NOW + 86400, end: NOW + 172800 });
  assert.deepEqual(resetBounds({ kind: "fixed", seconds: 60, anchor: 0 }, NOW + 59), { start: NOW, end: NOW + 60 });
  assert.deepEqual(resetBounds({ kind: "fixed", seconds: 60, anchor: 0 }, NOW + 60), { start: NOW + 60, end: NOW + 120 });
  assert.deepEqual(resetBounds({ kind: "fixed", seconds: 86400, anchor: 3600 }, NOW), { start: NOW - 82800, end: NOW + 3600 });
  assert.deepEqual(resetBounds({ kind: "fixed", seconds: 86400, anchor: 3600 }, NOW + 3600), { start: NOW + 3600, end: NOW + 90000 });
  assert.throws(() => resetBounds({ kind: "utc_day" }, Number.MAX_SAFE_INTEGER));
});
