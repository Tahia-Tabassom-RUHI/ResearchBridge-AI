import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPACITY_MODELS, LEGACY_QWEN_MODEL, QWEN_REVIEW_BOUNDARY, estimatePolicyReservation,
  isCapacityModel, validateProviderPolicy } from "../src/config/provider-policy";
import { messagesForTask, validateRequest } from "../src/contracts/index";
import { D1QuotaProvisioning, policyWindows } from "../src/storage/d1-quota-provisioning";
import { D1PolicyRevocation } from "../src/storage/d1-policy-revocation";
import { D1EvidenceRecovery } from "../src/storage/d1-evidence-recovery";
import { D1ProviderHolds } from "../src/storage/d1-provider-holds";
import type { D1Binding } from "../src/storage/d1-quota-admission";
import { localProviderServices } from "../src/local-services";
import { LocalPolicyMockProvider } from "../src/providers/local-policy-mock";
import { environment, migrate, runtime } from "./local-pipeline-fixture";
import { fixture } from "./fixtures";
import { gemmaPolicyFixture, policyFixture, POLICY_TIME as NOW } from "./provider-policy-fixture";
import { adapted, http, observed, operation, responseFixture } from "./provider-response-fixture";

test("Gemma is preferred; historical identity and Qwen-only expiry remain explicit", () => {
  assert.equal(CAPACITY_MODELS.cloudflare_workers_ai, "@cf/google/gemma-4-26b-a4b-it");
  const p = gemmaPolicyFixture(QWEN_REVIEW_BOUNDARY);
  assert.equal(validateProviderPolicy(p, QWEN_REVIEW_BOUNDARY).state, "valid");
  const qwen = policyFixture("cloudflare_workers_ai", QWEN_REVIEW_BOUNDARY - 1);
  assert.equal(validateProviderPolicy(qwen, QWEN_REVIEW_BOUNDARY).state, "review_required");
  qwen.reviewAfter++;
  assert.equal(validateProviderPolicy(qwen, QWEN_REVIEW_BOUNDARY).state, "invalid_policy");
  assert.ok(isCapacityModel("cloudflare_workers_ai", LEGACY_QWEN_MODEL));
  for (const provider of ["groq", ["cloudflare_workers_ai"], "toString", null])
    assert.equal(isCapacityModel(provider, p.model), false);
  p.eligibility.verified = false as true;
  assert.equal(validateProviderPolicy(p, QWEN_REVIEW_BOUNDARY).state, "invalid_policy");
});

test("candidate pricing uses upward-rounded neurons, retaining account-wide window identities", async () => {
  const gemma = gemmaPolicyFixture(), qwen = policyFixture();
  assert.deepEqual(estimatePolicyReservation(gemma, NOW, 1000, 1000)?.computeUnits, { neurons: 37 });
  assert.deepEqual(estimatePolicyReservation(qwen, NOW, 1000, 1000)?.computeUnits, { neurons: 36 });
  assert.deepEqual(await policyWindows(gemma, NOW), await policyWindows(qwen, NOW));
  assert.ok((await policyWindows(gemma, NOW)).every(w => w.model === ""));
});

test("contract messages do not inherit a Qwen reasoning instruction", () => {
  const request = validateRequest(fixture("term_clarification").request);
  const messages = messagesForTask({ request, source: null, responseVersion: "2" });
  assert.deepEqual(messages.map(m => m.role), ["system", "user"]);
  assert.ok(!JSON.stringify(messages).includes("/no_think"));
  assert.ok(messages[0]!.content.includes("untrusted data"));
});

for (const transport of ["workers_ai_binding", "workers_ai_http"] as const)
  test(`synthetic Gemma chat completion usage is compatible with ${transport}`, async () => {
    const p = gemmaPolicyFixture(NOW - 10), f = responseFixture("cloudflare_workers_ai", transport, p);
    const completion = { id: "synthetic", model: p.model, object: "chat.completion", created: NOW,
      choices: [{ index: 0, message: { role: "assistant", content: '{"output":"PRIVATE"}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 } };
    const o = observed(f.parser.observe(transport === "workers_ai_binding" ?
      { kind: "binding_result", body: completion } : http(200, [], { success: true, errors: [], result: completion })));
    assert.equal(o.classification, "usage_observation"); assert.deepEqual(o.issues, []);
    assert.equal(f.parser.usageEvidence(o, f.attempt)!.totalTokens!.amount, 2000);
    assert.ok(!JSON.stringify(o).includes("PRIVATE"));
    assert.equal(adapted(await f.parser.holdEvidence(o, operation)).evidence.length, 0);
    // Token counts do not prove measured neurons or increase capacity.
    assert.equal(f.parser.usageEvidence(o, f.attempt)!.computeUnits, undefined);
    assert.equal(estimatePolicyReservation(p, NOW, 1000, 1000)!.computeUnits!.neurons, 37);
  });

test("Gemma candidate preserves historical D1 policies, restrictions and recovery", { timeout: 60000 }, async t => {
  const mf = runtime(); let now = NOW;
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const binding: D1Binding = { prepare: sql => db.prepare(sql.replaceAll("unixepoch()", String(now))), batch: ss => db.batch(ss) };
    const provisioning = new D1QuotaProvisioning(binding, () => now);
    const qwen = policyFixture();
    const gemma = gemmaPolicyFixture(); gemma.version++;
    const allRows = async () => {
      const names = ["provider_capacity_policies", "provider_quota_windows", "provider_holds", "provider_hold_operations",
        "request_reservations", "inference_attempts", "usage_accounting", "request_replay_barriers", "provider_policy_revocations"];
      return Promise.all(names.map(async name => (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results));
    };
    await t.test("an occupied Qwen allocation cannot be replaced, replenished or stripped of holds", async () => {
      assert.equal((await provisioning.provision(qwen)).state, "provisioned");
      await db.prepare("UPDATE provider_quota_windows SET consumed_amount = 4, reserved_amount = 3").run();
      const held = await new D1ProviderHolds(binding, qwen, () => now).record({ operationId: crypto.randomUUID(),
        provider: qwen.provider, model: "", quotaScopeId: qwen.quotaScopeId, policyVersion: qwen.version,
        observedAt: now, source: "operational", reason: "temporary_provider_unavailable", until: null });
      assert.equal(held.state, "recorded");
      const before = await allRows();
      assert.equal((await provisioning.provision(gemma)).state, "unsafe_change");
      assert.deepEqual(await allRows(), before);
      assert.deepEqual(await new D1PolicyRevocation(binding).revoke({ quotaScopeId: qwen.quotaScopeId,
        provider: qwen.provider, model: qwen.model, expectedPolicyVersion: qwen.version, expectedGeneration: 0 }),
      { state: "revoked", generation: 1 });
      const revoked = await allRows();
      assert.equal((await provisioning.provision(gemma)).state, "disabled");
      assert.deepEqual(await allRows(), revoked);
    });
    await t.test("historical pending Qwen evidence remains inspectable after its cutoff", async () => {
      const p = policyFixture(); p.quotaScopeId = "historical-pending";
      const provider = new LocalPolicyMockProvider(p, "success", undefined, () => now);
      const services = localProviderServices(environment(binding), { policy: p, bounds: { inputTokens: 100, outputTokens: 200 },
        ownership: { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 172800 } }, provider, () => now)!;
      const begun = await services.durable.begin({ serviceId: "streamlit" }, crypto.randomUUID(), {
        request: validateRequest(fixture("term_clarification").request), source: null, responseVersion: "2" });
      assert.equal(begun.state, "ready"); if (begun.state !== "ready") throw new Error();
      const armed = await services.durable.authorizeDispatch(begun.fence);
      assert.equal(armed.state, "updated"); if (armed.state !== "updated") throw new Error();
      const owned = await services.durable.readAttempt(armed.fence, begun.reservationId);
      assert.equal(owned.state, "owned"); if (owned.state !== "owned") throw new Error();
      assert.ok(await services.execution.open(armed.fence, owned.attempt));
      now = QWEN_REVIEW_BOUNDARY + 1;
      const recoverySecret = "c".repeat(64);
      const recovery = await D1EvidenceRecovery.authenticate(new Request("https://internal.test/recovery", {
        headers: { Authorization: `Bearer ${recoverySecret}` } }),
      { ...environment(binding), COACH_EVIDENCE_RECOVERY_SECRET: recoverySecret }, p);
      const before = await allRows(), page = await recovery.inspect(5);
      assert.equal(page.state, "page"); if (page.state !== "page") throw new Error();
      assert.equal(page.items.length, 1); assert.equal(page.items[0]!.attemptId, owned.attempt.attemptId);
      assert.deepEqual(await allRows(), before);
    });
    await t.test("Gemma admission survives the Qwen-only cutoff but revocation still blocks dispatch", async () => {
      const p = gemmaPolicyFixture(now); p.quotaScopeId = "synthetic-gemma-account";
      const provider = new LocalPolicyMockProvider(p, "success", undefined, () => now);
      const services = localProviderServices(environment(binding), { policy: p, bounds: { inputTokens: 100, outputTokens: 200 },
        ownership: { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 172800 } }, provider, () => now)!;
      const begun = await services.durable.begin({ serviceId: "streamlit" }, crypto.randomUUID(), {
        request: validateRequest(fixture("term_clarification").request), source: null, responseVersion: "2" });
      assert.equal(begun.state, "ready"); if (begun.state !== "ready") throw new Error();
      const armed = await services.durable.authorizeDispatch(begun.fence);
      assert.equal(armed.state, "updated"); if (armed.state !== "updated") throw new Error();
      assert.equal((await new D1PolicyRevocation(binding).revoke({ quotaScopeId: p.quotaScopeId, provider: p.provider,
        model: p.model, expectedPolicyVersion: p.version, expectedGeneration: 0 })).state, "revoked");
      const before = await allRows();
      assert.notEqual((await services.durable.dispatch(armed.fence)).state, "updated");
      assert.deepEqual(await allRows(), before);
    });
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await mf.dispose(); }
});
