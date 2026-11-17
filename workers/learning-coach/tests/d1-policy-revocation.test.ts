import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir, mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createGateway } from "../src/handlers/gateway";
import { localProviderServices } from "../src/local-services";
import { LocalPolicyMockProvider } from "../src/providers/local-policy-mock";
import { MockSourceResolver } from "../src/providers/mock";
import { D1PolicyRevocation, type PolicyRevocation } from "../src/storage/d1-policy-revocation";
import { D1QuotaProvisioning } from "../src/storage/d1-quota-provisioning";
import { environment, fault, migrate, request, runtime, snapshot, seed, type DB } from "./local-pipeline-fixture";
import { policyFixture, POLICY_TIME } from "./provider-policy-fixture";
import type { D1Binding } from "../src/storage/d1-quota-admission";

const now = POLICY_TIME + 10;
function setup(db: DB) {
  const binding: D1Binding = { prepare: sql => db.prepare(sql.replaceAll("unixepoch()", String(now))), batch: ss => db.batch(ss) };
  const policy = policyFixture("groq", POLICY_TIME);
  const input: PolicyRevocation = { quotaScopeId: policy.quotaScopeId, provider: policy.provider, model: policy.model,
    expectedPolicyVersion: policy.version, expectedGeneration: 0 };
  const revoker = new D1PolicyRevocation(binding);
  const make = (connection = binding) => {
    const provider = new LocalPolicyMockProvider(policy, "success", undefined, () => now);
    let calls = 0; const generate = provider.generate.bind(provider);
    provider.generate = async (...args) => { calls++; return generate(...args); };
    const services = localProviderServices(environment(connection), { policy, bounds: { inputTokens: 100, outputTokens: 200 },
      ownership: { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 172800 } }, provider, () => now)!;
    const gateway = createGateway({ mode: "local", enabled: true, provider, sources: new MockSourceResolver(), ...services });
    return { ...services, get calls() { return calls; }, send: (r = request()) => gateway.fetch(r, environment(connection)) };
  };
  return { binding, policy, input, revoker, make };
}
async function isolated(run: (db: DB, s: ReturnType<typeof setup>) => Promise<void>) {
  const mf = runtime();
  try { const db = await mf.getD1Database("COACH_DB"); await migrate(db); await run(db, setup(db));
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await mf.dispose(); }
}

test("revocation blocks an older gateway and cannot be overwritten by newer provisioning", () => isolated(async (db, s) => {
  const older = s.make(); assert.equal((await new D1QuotaProvisioning(s.binding).provision(s.policy)).state, "provisioned");
  const before = await snapshot(db);
  assert.deepEqual(await s.revoker.revoke(s.input), { state: "revoked", generation: 1 });
  assert.notEqual((await older.send()).status, 200); assert.equal(older.calls, 0);
  const newer = structuredClone(s.policy); newer.version++;
  assert.equal((await new D1QuotaProvisioning(s.binding).provision(newer)).state, "disabled");
  assert.deepEqual((await snapshot(db)).provider_quota_windows, before.provider_quota_windows);
  await assert.rejects(db.prepare("UPDATE provider_capacity_policies SET version = version + 1").run(), /provider_policy_revoked/);
  await assert.rejects(db.prepare("DELETE FROM provider_policy_revocations").run(), /provider_revocation_permanent/);
}));

for (const point of ["admission", "arming"] as const) test(`revocation after ${point} prevents dispatch and rolls back ownership changes`, () => isolated(async (db, s) => {
  const g = s.make(); let before: Awaited<ReturnType<typeof snapshot>>;
  const revoke = async () => { before = await snapshot(db); assert.equal((await s.revoker.revoke(s.input)).state, "revoked"); };
  if (point === "admission") {
    const begin = g.durable.begin.bind(g.durable);
    g.durable.begin = async (...args) => { const r = await begin(...args); await revoke(); return r; };
  } else {
    const open = g.execution.open.bind(g.execution);
    g.execution.open = async (...args) => { const r = await open(...args); await revoke(); return r; };
  }
  assert.notEqual((await g.send()).status, 200); assert.equal(g.calls, 0);
  const after = await snapshot(db);
  assert.equal(after.request_reservations![0]!.status, "reserved");
  assert.deepEqual(after.provider_quota_windows, before!.provider_quota_windows);
  if (point === "arming") assert.deepEqual(after, before!);
}));

test("revocation committed immediately before the sent batch blocks unchanged lifecycle SQL", () => isolated(async (db, s) => {
  let injected = false;
  const raced = fault(s.binding, sql => !injected && sql.some(q => q.startsWith("UPDATE inference_attempts SET status = 'sent'")), async () => {
    injected = true; assert.equal((await s.revoker.revoke(s.input)).state, "revoked");
  });
  const g = s.make(raced); assert.notEqual((await g.send()).status, 200); assert.ok(injected); assert.equal(g.calls, 0);
  assert.equal((await db.prepare("SELECT status FROM inference_attempts").first<{ status: string }>())!.status, "prepared");
}));

test("ordinary update after arming grandfathers existing dispatch", () => isolated(async (_db, s) => {
  const g = s.make(), open = g.execution.open.bind(g.execution);
  g.execution.open = async (...args) => { const result = await open(...args);
    const next = structuredClone(s.policy); next.version++; next.dimensions[0]!.safetyMargin = 1;
    assert.equal((await new D1QuotaProvisioning(s.binding).provision(next)).state, "provisioned"); return result;
  };
  assert.equal((await g.send()).status, 200); assert.equal(g.calls, 1);
}));

test("database triggers reject pre-fix admission and dispatch SQL atomically", () => isolated(async (db, s) => {
  const g = s.make(), open = g.execution.open.bind(g.execution);
  g.execution.open = async (...args) => {
    const session = await open(...args); assert.equal((await s.revoker.revoke(s.input)).state, "revoked");
    const before = await snapshot(db);
    // Deliberately omit the new application predicate to exercise old binaries.
    await assert.rejects(db.batch([
      db.prepare("UPDATE idempotency_records SET generation = generation + 1"),
      db.prepare("UPDATE request_reservations SET status = 'sent' WHERE status = 'reserved'"),
    ]), /provider_policy_revoked/);
    await assert.rejects(db.prepare(`INSERT INTO request_reservations
      (id, service_id, request_id, quota_scope_id, provider, model, reservation_number, status, created_at, updated_at, expires_at, retain_until)
      SELECT ?, service_id, request_id, quota_scope_id, provider, model, reservation_number + 1, status,
        created_at, updated_at, expires_at, retain_until FROM request_reservations`).bind(crypto.randomUUID()).run(), /provider_policy_revoked/);
    assert.deepEqual(await snapshot(db), before); return session;
  };
  await g.send(); assert.equal(g.calls, 0);
}));

test("revocation uses exact policy version and monotonic generation CAS", () => isolated(async (db, s) => {
  assert.equal((await new D1QuotaProvisioning(s.binding).provision(s.policy)).state, "provisioned");
  for (const expectedPolicyVersion of [0, 2]) assert.notEqual((await s.revoker.revoke({ ...s.input, expectedPolicyVersion })).state, "revoked");
  const results = await Promise.all([s.revoker.revoke(s.input), s.revoker.revoke(s.input)]);
  assert.equal(results.filter(r => r.state === "revoked").length, 1);
  assert.equal((await s.revoker.revoke(s.input)).state, "conflict");
  assert.deepEqual(await s.revoker.revoke({ ...s.input, expectedGeneration: 1 }), { state: "revoked", generation: 2 });
  await assert.rejects(db.prepare("UPDATE provider_policy_revocations SET generation = 1").run(), /not_monotonic/);
}));

test("stale revocation version conflicts and unrelated account stays available", () => isolated(async (_db, s) => {
  const newer = structuredClone(s.policy); newer.version++;
  assert.equal((await new D1QuotaProvisioning(s.binding).provision(newer)).state, "provisioned");
  assert.equal((await s.revoker.revoke(s.input)).state, "conflict");
  assert.equal((await s.revoker.revoke({ ...s.input, expectedPolicyVersion: newer.version })).state, "revoked");
  s.policy.quotaScopeId = "unrelated-account";
  const other = s.make(); assert.equal((await other.send()).status, 200); assert.equal(other.calls, 1);
}));

for (const afterCommit of [false, true]) test(`revocation D1 failure ${afterCommit ? 'after' : 'before'} commit fails closed`, () => isolated(async (_db, s) => {
  assert.equal((await new D1QuotaProvisioning(s.binding).provision(s.policy)).state, "provisioned");
  const broken = fault(s.binding, sql => sql.some(q => q.startsWith("INSERT INTO provider_policy_revocations")), async () => { throw new Error("lost acknowledgment"); }, afterCommit);
  assert.equal((await new D1PolicyRevocation(broken).revoke(s.input)).state, "storage_unavailable");
  if (afterCommit) { const g = s.make(); assert.notEqual((await g.send()).status, 200); assert.equal(g.calls, 0); }
  assert.equal((await new D1PolicyRevocation(undefined).revoke(s.input)).state, "storage_unavailable");
}));

test("lost dispatch acknowledgment never invokes or refunds after revocation", () => isolated(async (db, s) => {
  let injected = false;
  const broken = fault(s.binding, sql => !injected && sql.some(q => q.startsWith("UPDATE inference_attempts SET status = 'sent'")), async () => {
    injected = true; assert.equal((await s.revoker.revoke(s.input)).state, "revoked"); throw new Error("lost dispatch acknowledgment");
  }, true);
  const g = s.make(broken); await g.send(); assert.ok(injected); assert.equal(g.calls, 0);
  assert.equal((await snapshot(db)).request_reservations![0]!.status, "sent");
  assert.ok((await snapshot(db)).provider_quota_windows!.every(w => Number(w.reserved_amount) > 0));
}));

test("dispatch committed before revocation may finish accounting", () => isolated(async (db, s) => {
  const g = s.make(), dispatch = g.durable.dispatch.bind(g.durable);
  g.durable.dispatch = async fence => { const result = await dispatch(fence);
    assert.equal(result.state, "updated"); assert.equal((await s.revoker.revoke(s.input)).state, "revoked"); return result; };
  assert.equal((await g.send()).status, 200); assert.equal(g.calls, 1);
  assert.ok((await snapshot(db)).provider_quota_windows!.every(w => w.reserved_amount === 0));
}));

test("concurrent dispatch and revocation obey D1 commit ordering", () => isolated(async (db, s) => {
  const g = s.make(), dispatch = g.durable.dispatch.bind(g.durable);
  g.durable.dispatch = async fence => {
    const [result, revoked] = await Promise.all([dispatch(fence), s.revoker.revoke(s.input)]);
    assert.equal(revoked.state, "revoked"); return result;
  };
  await g.send(); const rows = (await snapshot(db)).request_reservations!;
  assert.equal(g.calls, rows[0]!.status === "reserved" ? 0 : 1);
  const next = s.make(); await next.send(); assert.equal(next.calls, 0);
}));

test("completed accounting and status-only replay survive revocation; bad credentials cannot dispatch", () => isolated(async (db, s) => {
  const g = s.make(), id = crypto.randomUUID(); assert.equal((await g.send(request(id))).status, 200);
  const before = await snapshot(db); assert.equal((await s.revoker.revoke(s.input)).state, "revoked");
  assert.equal((await g.send(request(id))).status, 200); assert.equal(g.calls, 1); assert.deepEqual(await snapshot(db), before);
  assert.equal((await g.send(request(crypto.randomUUID(), undefined, { Authorization: 'Bearer wrong' }))).status, 401);
  assert.equal(g.calls, 1);
}));

test("migration 0012 preserves occupied tables and revocation survives restart", async () => {
  await mkdir(new URL("../.wrangler/revocation-tests/", import.meta.url), { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL("../.wrangler/revocation-tests/run-", import.meta.url)));
  let mf = runtime(directory);
  try {
    let db = await mf.getD1Database("COACH_DB");
    const names = (await readdir(new URL("../migrations/", import.meta.url))).filter(n => /^\d{4}_/.test(n)).sort();
    const apply = async (name: string) => { const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await db.batch(sql.replace(/--[^\n]*/g, "").split(/;(?!\s*END\b)/i).map(s => s.trim()).filter(Boolean).map(s => db.prepare(s))); };
    for (const name of names.filter(n => n < "0012")) await apply(name);
    await seed(db); const before = await snapshot(db);
    await apply(names.find(n => n.startsWith("0012"))!); assert.deepEqual(await snapshot(db), before);
    const s = setup(db); assert.equal((await s.make().send()).status, 200); const completed = await snapshot(db);
    assert.equal((await s.revoker.revoke(s.input)).state, "revoked");
    await mf.dispose(); mf = runtime(directory); db = await mf.getD1Database("COACH_DB");
    const next = setup(db).make(); await next.send(); assert.equal(next.calls, 0);
    assert.deepEqual((await snapshot(db)).provider_quota_windows, completed.provider_quota_windows);
  } finally { await mf.dispose(); }
});
