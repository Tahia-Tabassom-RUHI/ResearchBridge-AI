import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { D1EvidenceRecovery, type EvidenceResolution, type EvidenceRecoveryEnv } from "../src/storage/d1-evidence-recovery";
import { D1ProviderHolds } from "../src/storage/d1-provider-holds";
import { D1PolicyRevocation } from "../src/storage/d1-policy-revocation";
import { localProviderServices } from "../src/local-services";
import { LocalPolicyMockProvider } from "../src/providers/local-policy-mock";
import { environment, fault, migrate, runtime, snapshot, type DB } from "./local-pipeline-fixture";
import { policyFixture, POLICY_TIME } from "./provider-policy-fixture";
import { fixture } from "./fixtures";
import { validateRequest } from "../src/contracts/index";
import type { D1Binding } from "../src/storage/d1-quota-admission";
import type { FailureReport, TransitionDecision } from "../src/storage";
import { classifyRecovery, readRecoverySnapshot } from "../src/storage/recovery-inspection";

const recoverySecret = "c".repeat(64), start = POLICY_TIME + 10;
const recoveryRequest = (token = recoverySecret, headers: Record<string, string> = {}, url = "https://internal.test/recovery") =>
  new Request(url, { headers: { Authorization: `Bearer ${token}`, ...headers } });
function updated(r: TransitionDecision) { assert.equal(r.state, "updated"); if (r.state !== "updated") throw new Error(); return r.fence; }
function setup(db: DB) {
  let now = start;
  const binding: D1Binding = { prepare: sql => db.prepare(sql.replaceAll("unixepoch()", String(now))), batch: ss => db.batch(ss) };
  const policy = policyFixture("groq", POLICY_TIME);
  const env: EvidenceRecoveryEnv = { ...environment(binding), COACH_EVIDENCE_RECOVERY_SECRET: recoverySecret };
  const authority = (connection = binding) => D1EvidenceRecovery.authenticate(recoveryRequest(), { ...env, COACH_DB: connection }, policy);
  const provider = new LocalPolicyMockProvider(policy, "success", undefined, () => now);
  const services = localProviderServices(environment(binding), { policy, bounds: { inputTokens: 100, outputTokens: 200 },
    ownership: { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 172800 } }, provider, () => now)!;
  const prepare = async (arm = true) => {
    const begun = await services.durable.begin({ serviceId: "streamlit" }, crypto.randomUUID(), {
      request: validateRequest(fixture("term_clarification").request), source: null, responseVersion: "2" });
    assert.equal(begun.state, "ready"); if (begun.state !== "ready") throw new Error(JSON.stringify(begun));
    const fence = updated(await services.durable.authorizeDispatch(begun.fence));
    const owned = await services.durable.readAttempt(fence, begun.reservationId);
    assert.equal(owned.state, "owned"); if (owned.state !== "owned") throw new Error();
    if (arm) assert.ok(await services.execution.open(fence, owned.attempt));
    const input: EvidenceResolution = { operationId: crypto.randomUUID(), reservationId: begun.reservationId,
      attemptId: owned.attempt.attemptId, expectedGeneration: fence.generation, method: "not_dispatched" };
    return { fence, attempt: owned.attempt, input };
  };
  const failure = async (report: FailureReport = { category: "UNKNOWN_OUTCOME", reason: "crash_boundary" }) => {
    const item = await prepare(); const sent = updated(await services.durable.dispatch(item.fence));
    assert.equal((await services.durable.accountFailure(sent, item.attempt, report)).state, "accounted");
    item.input.expectedGeneration = sent.generation + 2; item.input.method = "accounted_with_hold"; return item;
  };
  const hold = (attemptId: string, model = policy.model, until: number | null = null) => new D1ProviderHolds(binding, policy, () => now).record({
    operationId: attemptId, provider: policy.provider, model, quotaScopeId: policy.quotaScopeId, policyVersion: policy.version,
    observedAt: now, source: "operational", reason: "temporary_provider_unavailable", until });
  return { binding, policy, env, authority, services, prepare, failure, hold, expire: () => { now += 301; } };
}
async function isolated(run: (db: DB, s: ReturnType<typeof setup>) => Promise<void>) {
  const mf = runtime(); try { const db = await mf.getD1Database("COACH_DB"); await migrate(db); await run(db, setup(db));
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await mf.dispose(); }
}
const marker = async (db: DB, id: string) => (await db.prepare("SELECT provider_evidence_state FROM inference_attempts WHERE id = ?").bind(id)
  .first<{ provider_evidence_state: string }>())!.provider_evidence_state;

test("recovery requires its dedicated credential and rejects browser or public HTTP authority", () => isolated(async (_db, s) => {
  assert.throws(() => Reflect.construct(D1EvidenceRecovery, [s.binding, s.policy, "streamlit", Symbol("forged")]));
  for (const req of [recoveryRequest("a".repeat(64)), recoveryRequest("wrong"), recoveryRequest(recoverySecret, { Origin: "https://student.test" }),
    recoveryRequest(recoverySecret, { "Sec-Fetch-Site": "same-origin" }), recoveryRequest(recoverySecret, {}, "http://public.test/recovery")])
    await assert.rejects(D1EvidenceRecovery.authenticate(req, s.env, s.policy));
  await assert.rejects(D1EvidenceRecovery.authenticate(recoveryRequest(), { ...s.env, COACH_EVIDENCE_RECOVERY_SECRET: "a".repeat(64) }, s.policy));
  await assert.rejects(D1EvidenceRecovery.authenticate(recoveryRequest(), environment(s.binding), s.policy));
}));

test("inspection is bounded, paginated, sanitized and read-only across tied timestamps", () => isolated(async (db, s) => {
  const items = await Promise.all([s.prepare(false), s.prepare(false), s.prepare(false)]);
  for (const item of items) assert.ok(await s.services.execution.open(item.fence, item.attempt));
  const service = await s.authority(), before = await snapshot(db), ids: string[] = [];
  let cursor: { createdAt: number; attemptId: string } | undefined;
  do { const page = await service.inspect(1, cursor); assert.equal(page.state, "page"); if (page.state !== "page") throw new Error();
    ids.push(...page.items.map(i => i.attemptId)); const data = JSON.stringify(page);
    for (const privateField of ["payload_hash", "owner_token", "fingerprint", recoverySecret, "private prompt"]) assert.ok(!data.includes(privateField));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(new Set(ids).size, 3); assert.deepEqual(await snapshot(db), before);
  for (const limit of [0, 21, 1.5]) assert.equal((await service.inspect(limit)).state, "invalid_request");
}));

test("expired proven non-dispatch resolves once without refund, erasing holds, or permitting redispatch", () => isolated(async (db, s) => {
  const item = await s.prepare(), service = await s.authority();
  assert.equal((await service.resolve(item.input)).state, "not_eligible"); s.expire();
  const before = await snapshot(db); assert.equal((await service.resolve(item.input)).state, "resolved");
  assert.equal(await marker(db, item.attempt.attemptId), "acknowledged");
  const after = await snapshot(db); assert.deepEqual(after.provider_quota_windows, before.provider_quota_windows);
  assert.deepEqual(after.reservation_quota_windows, before.reservation_quota_windows);
  assert.equal(after.idempotency_records![0]!.generation, item.input.expectedGeneration + 1);
  assert.equal((await service.resolve(item.input)).state, "already_resolved");
  assert.equal((await service.resolve({ ...item.input, operationId: crypto.randomUUID() })).state, "conflict");
  assert.equal((await service.resolve({ ...item.input, method: "accounted_with_hold" })).state, "conflict");
  await assert.rejects(db.prepare("UPDATE provider_evidence_resolutions SET method = 'accounted_with_hold'").run(), /immutable/);
  await assert.rejects(db.prepare("DELETE FROM provider_evidence_resolutions").run(), /immutable/);
  await assert.rejects(db.prepare("UPDATE request_reservations SET status = 'sent'").run(), /not_dispatched/);
  const next = await s.services.durable.begin({ serviceId: "streamlit" }, crypto.randomUUID(), {
    request: validateRequest(fixture("term_clarification").request), source: null, responseVersion: "2" });
  assert.equal(next.state, "ready");
}));

test("a sent attempt with no accounting or availability evidence stays protected", () => isolated(async (db, s) => {
  const item = await s.prepare(); updated(await s.services.durable.dispatch(item.fence)); s.expire();
  item.input.expectedGeneration++; const service = await s.authority(); const before = await snapshot(db);
  assert.equal((await service.resolve(item.input)).state, "not_eligible");
  assert.equal((await service.resolve({ ...item.input, method: "accounted_with_hold" })).state, "not_eligible");
  assert.deepEqual(await snapshot(db), before); assert.equal(await marker(db, item.attempt.attemptId), "pending");
}));

for (const partial of [false, true]) test(`${partial ? 'partial' : 'unknown'} usage requires a separate durable hold and remains conservatively accounted`, () => isolated(async (db, s) => {
  const report: FailureReport = { category: "UNKNOWN_OUTCOME", reason: "crash_boundary",
    ...(partial ? { usage: { requests: { amount: 1, kind: "measured", evidence: "provider_report" },
      inputTokens: { amount: 8, kind: "measured", evidence: "provider_report" } } } : {}) };
  const item = await s.failure(report), service = await s.authority();
  assert.equal((await s.hold(item.attempt.attemptId)).state, "recorded"); s.expire(); const before = await snapshot(db);
  assert.equal((await service.resolve(item.input)).state, "resolved");
  const after = await snapshot(db);
  for (const table of ["provider_quota_windows", "reservation_quota_windows", "usage_accounting", "idempotency_records"])
    assert.deepEqual(after[table], before[table]);
  const held = (await db.prepare("SELECT * FROM provider_holds").all()).results[0]!;
  assert.equal(held.status, "active"); assert.equal(held.hold_until, null);
  assert.ok(after.reservation_quota_windows!.some(l => l.status === "unknown" && Number(l.failure_held_amount) > 0));
  const next = await s.services.durable.begin({ serviceId: "streamlit" }, crypto.randomUUID(), {
    request: validateRequest(fixture("term_clarification").request), source: null, responseVersion: "2" });
  assert.notEqual(next.state, "ready");
}));

test("verified measured settlement alone cannot discharge provider availability", () => isolated(async (db, s) => {
  const item = await s.prepare(), sent = updated(await s.services.durable.dispatch(item.fence));
  assert.equal((await s.services.durable.settleSuccess(sent, item.attempt, { kind: "measured", requests: 1, inputTokens: 8, outputTokens: 12 })).state, "accounted");
  item.input.expectedGeneration = sent.generation + 2; item.input.method = "accounted_with_hold"; s.expire();
  const before = await snapshot(db); assert.equal((await (await s.authority()).resolve(item.input)).state, "not_eligible");
  assert.deepEqual(await snapshot(db), before); assert.equal(await marker(db, item.attempt.attemptId), "pending");
}));

test("verified success plus a restriction resolves without changing accounting or F01 revocation", () => isolated(async (db, s) => {
  const item = await s.prepare(), sent = updated(await s.services.durable.dispatch(item.fence));
  assert.equal((await s.services.durable.settleSuccess(sent, item.attempt, { kind: "measured", requests: 1, inputTokens: 8, outputTokens: 12 })).state, "accounted");
  item.input.expectedGeneration = sent.generation + 2; item.input.method = "accounted_with_hold";
  assert.equal((await s.hold(item.attempt.attemptId)).state, "recorded");
  assert.equal((await new D1PolicyRevocation(s.binding).revoke({ ...s.policy, expectedPolicyVersion: 1, expectedGeneration: 0 })).state, "revoked");
  s.expire(); const before = await snapshot(db);
  assert.equal((await (await s.authority()).resolve(item.input)).state, "resolved");
  const after = await snapshot(db);
  for (const table of ["provider_quota_windows", "reservation_quota_windows", "usage_accounting", "idempotency_records"])
    assert.deepEqual(after[table], before[table]);
  assert.equal((await classifyRecovery(await readRecoverySnapshot(s.binding, "streamlit", item.input.reservationId)))!.classification, "settled_successfully");
  await assert.rejects(db.prepare("UPDATE provider_capacity_policies SET version = version + 1").run(), /revoked/);
}));

test("receipt-verified non-dispatch preserves completed failure accounting and generation", () => isolated(async (db, s) => {
  const item = await s.prepare();
  assert.equal((await s.services.durable.accountFailure(item.fence, item.attempt,
    { category: "PROVEN_PRE_DISPATCH_FAILURE", reason: "preparation_failed" })).state, "accounted");
  item.input.expectedGeneration += 2; s.expire(); const before = await snapshot(db);
  assert.equal((await (await s.authority()).resolve(item.input)).state, "resolved");
  const after = await snapshot(db);
  for (const table of ["provider_quota_windows", "reservation_quota_windows", "idempotency_records"])
    assert.deepEqual(after[table], before[table]);
  assert.equal((await classifyRecovery(await readRecoverySnapshot(s.binding, "streamlit", item.input.reservationId)))!.classification, "settled_failure");
}));

test("unlinked and finite holds cannot replace a pending availability barrier", () => isolated(async (db, s) => {
  const item = await s.failure(); assert.equal((await s.hold(crypto.randomUUID())).state, "recorded");
  s.expire(); const service = await s.authority();
  assert.equal((await service.resolve(item.input)).state, "not_eligible");
  assert.equal(await marker(db, item.attempt.attemptId), "pending");
}));

test("finite restriction requires manual review", () => isolated(async (db, s) => {
  const item = await s.failure(); assert.equal((await s.hold(item.attempt.attemptId, s.policy.model, start + 60)).state, "recorded");
  s.expire(); assert.equal((await (await s.authority()).resolve(item.input)).state, "not_eligible");
  assert.equal(await marker(db, item.attempt.attemptId), "pending");
}));

test("malformed operations, stale generations, wrong scopes and absent D1 fail closed", () => isolated(async (_db, s) => {
  const item = await s.prepare(); s.expire(); const service = await s.authority();
  assert.equal((await service.resolve({ ...item.input, operationId: "browser-assertion" })).state, "invalid_request");
  assert.equal((await service.resolve({ ...item.input, expectedGeneration: item.input.expectedGeneration - 1 })).state, "conflict");
  const other = await D1EvidenceRecovery.authenticate(recoveryRequest(), s.env, { ...s.policy, quotaScopeId: "other-account" });
  assert.equal((await other.resolve(item.input)).state, "conflict");
  const page = await other.inspect(20); assert.equal(page.state, "page"); if (page.state === "page") assert.equal(page.items.length, 0);
  const { COACH_DB: _binding, ...withoutDB } = s.env;
  const absent = await D1EvidenceRecovery.authenticate(recoveryRequest(), withoutDB, s.policy);
  assert.equal((await absent.inspect(1)).state, "storage_unavailable");
  assert.equal((await absent.resolve(item.input)).state, "storage_unavailable");
}));

test("concurrent identical and conflicting operations produce one immutable resolution", () => isolated(async (db, s) => {
  const item = await s.prepare(); s.expire(); const service = await s.authority();
  const results = await Promise.all([service.resolve(item.input), service.resolve(item.input), service.resolve({ ...item.input, operationId: crypto.randomUUID() })]);
  assert.equal(results.filter(r => r.state === "resolved").length, 1);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM provider_evidence_resolutions").first<{ n: number }>())!.n, 1);
  assert.equal((await service.resolve(item.input)).state, results[2]!.state === "resolved" ? "conflict" : "already_resolved");
}));

for (const field of ["fence", "hold", "usage"] as const) test(`${field} changed between proof inspection and write rejects the whole transaction`, () => isolated(async (db, s) => {
  const item = await s.failure(); assert.equal((await s.hold(item.attempt.attemptId)).state, "recorded"); s.expire();
  let injected = false;
  const broken = fault(s.binding, sql => !injected && sql.some(q => q.startsWith("INSERT INTO provider_evidence_resolutions")), async () => {
    injected = true;
    await db.prepare(field === "fence" ? "UPDATE idempotency_records SET generation = generation + 1" : field === "hold"
      ? "UPDATE provider_holds SET status = 'released'" : "UPDATE inference_attempts SET failure_receipt_hash = ?")
      .bind(...(field === "usage" ? ["d".repeat(64)] : [])).run();
  });
  assert.equal((await (await s.authority(broken)).resolve(item.input)).state, "conflict"); assert.ok(injected);
  assert.equal(await marker(db, item.attempt.attemptId), "pending");
  assert.equal((await db.prepare("SELECT count(*) AS n FROM provider_evidence_resolutions").first<{ n: number }>())!.n, 0);
}));

for (const afterCommit of [false, true]) test(`database failure ${afterCommit ? 'after' : 'before'} commit never reports ambiguous resolution success`, () => isolated(async (db, s) => {
  const item = await s.prepare(); s.expire();
  const broken = fault(s.binding, sql => sql.some(q => q.startsWith("INSERT INTO provider_evidence_resolutions")), async () => { throw new Error("lost acknowledgment"); }, afterCommit);
  assert.equal((await (await s.authority(broken)).resolve(item.input)).state, "storage_unavailable");
  assert.equal(await marker(db, item.attempt.attemptId), afterCommit ? "acknowledged" : "pending");
  assert.equal((await (await s.authority()).resolve(item.input)).state, afterCommit ? "already_resolved" : "resolved");
}));

test("late marker-update failure rolls back the resolution receipt and fencing", () => isolated(async (db, s) => {
  const item = await s.prepare(); s.expire(); const before = await snapshot(db);
  const broken = fault(s.binding, sql => sql.some(q => q.startsWith("INSERT INTO provider_evidence_resolutions")), async statements => {
    statements[statements.length - 2] = db.prepare("UPDATE inference_attempts SET updated_at = updated_at WHERE id = 'missing'");
  });
  assert.equal((await (await s.authority(broken)).resolve(item.input)).state, "conflict");
  assert.deepEqual(await snapshot(db), before);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM provider_evidence_resolutions").first<{ n: number }>())!.n, 0);
}));

test("resolving one attempt preserves another pending barrier and F01 revocation", () => isolated(async (db, s) => {
  const first = await s.prepare(false), second = await s.prepare(false);
  for (const item of [first, second]) assert.ok(await s.services.execution.open(item.fence, item.attempt));
  assert.equal((await new D1PolicyRevocation(s.binding).revoke({ ...s.policy, expectedPolicyVersion: 1, expectedGeneration: 0 })).state, "revoked");
  s.expire(); assert.equal((await (await s.authority()).resolve(first.input)).state, "resolved");
  assert.equal(await marker(db, second.attempt.attemptId), "pending");
  assert.equal((await db.prepare("SELECT generation FROM provider_policy_revocations").first<{ generation: number }>())!.generation, 1);
  await assert.rejects(db.prepare("UPDATE request_reservations SET status = 'sent' WHERE id = ?").bind(second.input.reservationId).run(), /revoked/);
}));

test("migration 0013 preserves occupied F01 data and pending inspection works after restart", async () => {
  await mkdir(new URL("../.wrangler/evidence-recovery-tests/", import.meta.url), { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL("../.wrangler/evidence-recovery-tests/run-", import.meta.url)));
  let mf = runtime(directory);
  try {
    let db = await mf.getD1Database("COACH_DB");
    const names = (await readdir(new URL("../migrations/", import.meta.url))).filter(n => /^\d{4}_/.test(n)).sort();
    const apply = async (name: string) => { const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await db.batch(sql.replace(/--[^\n]*/g, "").split(/;(?!\s*END\b)/i).map(s => s.trim()).filter(Boolean).map(s => db.prepare(s))); };
    for (const name of names.filter(n => n < "0013")) await apply(name);
    const s = setup(db), item = await s.prepare(), before = await snapshot(db);
    await apply(names.find(n => n.startsWith("0013"))!); assert.deepEqual(await snapshot(db), before);
    await mf.dispose(); mf = runtime(directory); db = await mf.getD1Database("COACH_DB"); const next = setup(db); next.expire();
    const service = await next.authority(); const page = await service.inspect(20); assert.equal(page.state, "page");
    if (page.state === "page") assert.equal(page.items[0]!.attemptId, item.input.attemptId);
    assert.equal((await service.resolve(item.input)).state, "resolved");
    await mf.dispose(); mf = runtime(directory); db = await mf.getD1Database("COACH_DB");
    assert.equal((await (await setup(db).authority()).resolve(item.input)).state, "already_resolved");
  } finally { await mf.dispose(); }
});
