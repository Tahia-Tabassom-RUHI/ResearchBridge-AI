import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { D1RetentionCleanup, type CleanupConfig, type CleanupEnv } from "../src/storage/d1-retention-cleanup";
import { localProviderServices } from "../src/local-services";
import { LocalPolicyMockProvider, type PolicyMockScenario } from "../src/providers/local-policy-mock";
import { MockSourceResolver } from "../src/providers/mock";
import { createGateway } from "../src/handlers/gateway";
import { D1IdempotencyStore } from "../src/storage/d1-idempotency";
import { D1ProviderHolds } from "../src/storage/d1-provider-holds";
import { D1PolicyRevocation } from "../src/storage/d1-policy-revocation";
import { D1EvidenceRecovery } from "../src/storage/d1-evidence-recovery";
import { environment, fault, migrate, request, runtime, type DB } from "./local-pipeline-fixture";
import { policyFixture, POLICY_TIME } from "./provider-policy-fixture";
import type { D1Binding } from "../src/storage/d1-quota-admission";

const key = "d".repeat(64), authRequest = (token = key, headers: Record<string, string> = {}, url = "https://internal.test/cleanup") =>
  new Request(url, { headers: { Authorization: `Bearer ${token}`, ...headers } });
const config: CleanupConfig = { enabled: true, approved: true, approvalReference: "synthetic test approval only", batchSize: 2,
  retention: { decisionReference: "synthetic test policy only", auditSeconds: 100, providerCorrectionSeconds: 200, receiptSeconds: 300 } };
const protectedTables = ["request_replay_barriers", "provider_policy_revocations", "provider_capacity_policies", "provider_holds", "provider_hold_operations", "provider_evidence_resolutions", "provider_quota_windows"];
const historyTables = ["idempotency_records", "request_reservations", "inference_attempts", "reservation_quota_windows", "usage_accounting"];
async function rows(db: DB, table: string) { return (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results; }
async function snapshot(db: DB) { return Object.fromEntries(await Promise.all([...protectedTables, ...historyTables].map(async t => [t, await rows(db, t)]))); }
function setup(db: DB) {
  let now = POLICY_TIME + 10;
  const binding: D1Binding = { prepare: sql => db.prepare(sql.replaceAll("unixepoch()", String(now))), batch: ss => db.batch(ss) };
  const env: CleanupEnv = { ...environment(binding), COACH_EVIDENCE_RECOVERY_SECRET: "c".repeat(64), COACH_CLEANUP_SECRET: key };
  const policy = policyFixture("groq", POLICY_TIME);
  const gateway = (scenario: PolicyMockScenario = "success") => {
    const provider = new LocalPolicyMockProvider(policy, scenario, undefined, () => now);
    const services = localProviderServices(environment(binding), { policy, bounds: { inputTokens: 100, outputTokens: 200 },
      ownership: { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 172800 } }, provider, () => now)!;
    const handler = createGateway({ mode: "local", enabled: true, provider, sources: new MockSourceResolver(), ...services });
    return { ...services, send: (id = crypto.randomUUID()) => handler.fetch(request(id), environment(binding)) };
  };
  const authority = (settings?: CleanupConfig, connection = binding) => D1RetentionCleanup.authenticate(authRequest(), { ...env, COACH_DB: connection }, settings);
  return { binding, env, policy, gateway, authority, time: () => now, age: () => { now += 4 * 86400; } };
}
async function isolated(run: (db: DB, s: ReturnType<typeof setup>) => Promise<void>) {
  const mf = runtime(); try { const db = await mf.getD1Database("COACH_DB"); await migrate(db); await run(db, setup(db));
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await mf.dispose(); }
}

test("cleanup is disabled by default and missing or unapproved horizons never write", () => isolated(async (db, s) => {
  await s.gateway().send(); s.age(); const before = await snapshot(db);
  assert.equal((await (await s.authority()).run()).state, "disabled");
  assert.equal((await (await s.authority({ ...config, enabled: false })).run()).state, "disabled");
  for (const changed of [{ ...config, approved: false }, { ...config, approvalReference: "" }, { ...config, batchSize: 6 },
    { ...config, retention: undefined }, { ...config, retention: { ...config.retention, receiptSeconds: undefined } }])
    assert.equal((await (await s.authority(changed as CleanupConfig)).run()).state, "configuration_missing");
  assert.deepEqual(await snapshot(db), before);
}));

test("dedicated runtime cleanup authority rejects service/recovery credentials and browser requests", () => isolated(async (_db, s) => {
  assert.throws(() => Reflect.construct(D1RetentionCleanup, [s.binding, config, "streamlit", Symbol("forged")]));
  for (const r of [authRequest("a".repeat(64)), authRequest("c".repeat(64)), authRequest(key, { Origin: "https://browser.test" }),
    authRequest(key, { "Sec-Fetch-Site": "same-origin" }), authRequest(key, {}, "http://public.test/cleanup")])
    await assert.rejects(D1RetentionCleanup.authenticate(r, s.env, config));
}));

test("eligible measured history is deleted in dependency order; replay and all protected tables survive", () => isolated(async (db, s) => {
  const id = crypto.randomUUID(), g = s.gateway(); assert.equal((await g.send(id)).status, 200); s.age(); const before = await snapshot(db);
  const result = await (await s.authority(config)).run(); assert.equal(result.state, "completed", JSON.stringify(result));
  assert.deepEqual(result.deleted, { usage_accounting: 1, reservation_quota_windows: 4, inference_attempts: 1, idempotency_records: 1, request_reservations: 1 });
  for (const table of historyTables) assert.deepEqual(await rows(db, table), []);
  for (const table of protectedTables) assert.deepEqual(await rows(db, table), before[table]);
  const replay = await g.send(id); assert.equal(replay.status, 410); assert.equal((await replay.json() as { state: string }).state, "expired");
  assert.deepEqual(await rows(db, "idempotency_records"), []);
  assert.equal((await (await s.authority(config)).run()).deleted.idempotency_records, 0);
}));

test("finalized pre-admission failures clean only their claim", () => isolated(async (db, s) => {
  const store = new D1IdempotencyStore(s.binding, { leaseSeconds: 30, ttlSeconds: 60, retentionSeconds: 120 });
  const claim = await store.claim({ serviceId: "streamlit", keyHash: "1".repeat(64), payloadHash: "2".repeat(64), fingerprintKeyId: "3".repeat(64), responseVersion: "2" });
  if (claim.state !== "acquired") throw new Error(); await store.failBeforeDispatch(claim.fence); s.age();
  const result = await (await s.authority(config)).run(); assert.equal(result.deleted.idempotency_records, 1);
  assert.equal(result.deleted.request_reservations, 0); assert.equal((await rows(db, "request_replay_barriers")).length, 1);
}));

test("keyset batches bound inspected graphs and repeated calls remain safe", () => isolated(async (db, s) => {
  for (let i = 0; i < 3; i++) assert.equal((await s.gateway().send()).status, 200); s.age();
  const service = await s.authority({ ...config, batchSize: 1 });
  const first = await service.run(); assert.equal(first.deleted.idempotency_records, 1); assert.ok(first.nextCursor);
  const second = await service.run(first.nextCursor!); assert.equal(second.deleted.idempotency_records, 1); assert.ok(second.nextCursor);
  const third = await service.run(second.nextCursor!); assert.equal(third.deleted.idempotency_records, 1); assert.equal(third.nextCursor, null);
  assert.equal((await service.run()).deleted.idempotency_records, 0); assert.equal((await rows(db, "request_replay_barriers")).length, 3);
}));

for (const scenario of ["missing_usage", "partial_usage", "malformed_metadata", "timeout"] as const) test(`${scenario} is skipped even after timestamps expire`, () => isolated(async (db, s) => {
  await s.gateway(scenario).send(); s.age(); const before = await snapshot(db);
  const result = await (await s.authority(config)).run(); assert.equal(result.deleted.idempotency_records, 0);
  assert.ok(result.skipped.unresolved_accounting); assert.deepEqual(await snapshot(db), before);
}));

test("active requests and configured horizons are protected", () => isolated(async (db, s) => {
  await s.gateway().send(); const before = await snapshot(db);
  assert.equal((await (await s.authority(config)).run()).deleted.idempotency_records, 0);
  s.age(); const result = await (await s.authority({ ...config, retention: { ...config.retention, auditSeconds: 10 * 86400 } })).run();
  assert.ok(result.skipped.retention_horizon_not_elapsed); assert.deepEqual(await snapshot(db), before);
}));

test("legacy history remains protected", () => isolated(async (db, s) => {
  await db.prepare(`INSERT INTO idempotency_records (id, service_id, key_hash, payload_hash, response_version, created_at, updated_at, expires_at, retain_until)
    VALUES (?, 'streamlit', ?, ?, '2', ?, ?, ?, ?)`).bind(crypto.randomUUID(), "4".repeat(64), "5".repeat(64), s.time(), s.time(), s.time(), s.time()).run();
  // This legacy-shaped row has no valid owner capability even though the new
  // insertion trigger has conservatively protected its UUID.
  s.age(); const before = await snapshot(db); const result = await (await s.authority(config)).run();
  assert.ok(result.skipped.invalid_ownership); assert.deepEqual(await snapshot(db), before);
}));

test("an additional reservation prevents removing shared ownership evidence", () => isolated(async (db, s) => {
  await s.gateway().send();
  await db.prepare(`INSERT INTO request_reservations (id, service_id, request_id, quota_scope_id, provider, model,
    reservation_number, status, created_at, updated_at, expires_at, retain_until)
    SELECT ?, service_id, request_id, quota_scope_id, provider, model, reservation_number + 1, 'reserved',
      created_at, updated_at, expires_at, retain_until FROM request_reservations`).bind(crypto.randomUUID()).run();
  s.age(); const before = await snapshot(db), result = await (await s.authority(config)).run();
  assert.ok(result.skipped.additional_reservation_dependency); assert.equal(result.deleted.idempotency_records, 0);
  assert.deepEqual(await snapshot(db), before);
}));

test("concurrent cleanup deletes a graph once", () => isolated(async (db, s) => {
  await s.gateway().send(); s.age(); const service = await s.authority(config);
  const results = await Promise.all([service.run(), service.run()]);
  assert.equal(results.reduce((n, r) => n + r.deleted.idempotency_records, 0), 1);
  assert.deepEqual(await rows(db, "idempotency_records"), []); assert.equal((await rows(db, "request_replay_barriers")).length, 1);
}));

for (const change of ["hold", "accounting", "fence"] as const) test(`${change} racing cleanup invalidates transactional proof`, () => isolated(async (db, s) => {
  await s.gateway().send(); s.age(); let injected = false;
  const connection = fault(s.binding, sql => !injected && sql.some(q => q.startsWith("DELETE FROM")), async () => {
    injected = true;
    if (change === "hold") assert.equal((await new D1ProviderHolds(s.binding, s.policy, s.time).record({ operationId: crypto.randomUUID(),
      provider: s.policy.provider, model: s.policy.model, quotaScopeId: s.policy.quotaScopeId, policyVersion: s.policy.version,
      observedAt: s.time(), source: "operational", reason: "temporary_provider_unavailable", until: null })).state, "recorded");
    else await db.prepare(change === "fence" ? "UPDATE idempotency_records SET generation = generation + 1" :
      "UPDATE usage_accounting SET settlement_hash = ?").bind(...(change === "accounting" ? ["6".repeat(64)] : [])).run();
  });
  const result = await (await s.authority(config, connection)).run(); assert.ok(injected); assert.equal(result.deleted.idempotency_records, 0);
  assert.ok(result.skipped.changed_since_inspection); for (const table of historyTables) assert.ok((await rows(db, table)).length > 0);
}));

test("a late conditional delete failure rolls back every earlier deletion", () => isolated(async (db, s) => {
  await s.gateway().send(); s.age(); const before = await snapshot(db);
  const broken = fault(s.binding, sql => sql.some(q => q.startsWith("DELETE FROM")), async statements => {
    // The final parent deletion follows successful child removals.
    statements[statements.length - 3] = db.prepare("DELETE FROM request_reservations WHERE id = 'missing'");
  });
  const result = await (await s.authority(config, broken)).run(); assert.equal(result.deleted.idempotency_records, 0);
  assert.ok(result.skipped.changed_since_inspection); assert.deepEqual(await snapshot(db), before);
}));

for (const afterCommit of [false, true]) test(`D1 failure ${afterCommit ? 'after' : 'before'} commit reports no unconfirmed deletion counts`, () => isolated(async (db, s) => {
  await s.gateway().send(); s.age(); const before = await snapshot(db);
  const broken = fault(s.binding, sql => sql.some(q => q.startsWith("DELETE FROM")), async () => { throw new Error("lost acknowledgment"); }, afterCommit);
  const result = await (await s.authority(config, broken)).run(); assert.equal(result.state, "storage_unavailable"); assert.equal(result.uncertain, true);
  assert.equal(result.deleted.idempotency_records, 0);
  if (!afterCommit) assert.deepEqual(await snapshot(db), before);
  else assert.deepEqual(await rows(db, "idempotency_records"), []);
  assert.equal((await (await s.authority(config)).run()).deleted.idempotency_records, afterCommit ? 0 : 1);
}));

test("F02 evidence receipts and F01 revocations remain protected", () => isolated(async (db, s) => {
  const g = s.gateway(); g.durable.dispatch = async () => ({ state: "storage_unavailable", retryable: false }); await g.send();
  const a = (await rows(db, "inference_attempts"))[0]!, i = (await rows(db, "idempotency_records"))[0]!;
  assert.equal((await new D1PolicyRevocation(s.binding).revoke({ ...s.policy, expectedPolicyVersion: 1, expectedGeneration: 0 })).state, "revoked");
  s.age(); const recoveryKey = "c".repeat(64);
  const recovery = await D1EvidenceRecovery.authenticate(authRequest(recoveryKey), { ...environment(s.binding), COACH_EVIDENCE_RECOVERY_SECRET: recoveryKey }, s.policy);
  assert.equal((await recovery.resolve({ operationId: crypto.randomUUID(), attemptId: a.id as string, reservationId: a.reservation_id as string,
    expectedGeneration: i.generation as number, method: "not_dispatched" })).state, "resolved");
  const before = await snapshot(db), result = await (await s.authority(config)).run();
  assert.equal(result.deleted.idempotency_records, 0); assert.ok(result.skipped.required_evidence_or_hold_receipt); assert.deepEqual(await snapshot(db), before);
}));

test("cleanup remains safe after restart and repeated manual invocation", async () => {
  await mkdir(new URL("../.wrangler/cleanup-tests/", import.meta.url), { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL("../.wrangler/cleanup-tests/run-", import.meta.url)));
  let mf = runtime(directory);
  try {
    let db = await mf.getD1Database("COACH_DB"); await migrate(db); const s = setup(db); const id = crypto.randomUUID();
    await s.gateway().send(id); await mf.dispose(); mf = runtime(directory); db = await mf.getD1Database("COACH_DB");
    const next = setup(db); next.age(); assert.equal((await (await next.authority(config)).run()).deleted.idempotency_records, 1);
    await mf.dispose(); mf = runtime(directory); db = await mf.getD1Database("COACH_DB"); const last = setup(db); last.age();
    assert.equal((await (await last.authority(config)).run()).deleted.idempotency_records, 0);
    assert.equal((await last.gateway().send(id)).status, 410);
  } finally { await mf.dispose(); }
});
