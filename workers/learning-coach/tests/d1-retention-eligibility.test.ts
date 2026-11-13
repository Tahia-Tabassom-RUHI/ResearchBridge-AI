import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { D1IdempotencyStore } from "../src/storage/d1-idempotency";
import { D1RetentionEligibility, RETAINED_AUTHORITIES, type RetentionPolicy } from "../src/storage/d1-retention-eligibility";
import { D1ProviderHolds } from "../src/storage/d1-provider-holds";
import { D1EvidenceRecovery } from "../src/storage/d1-evidence-recovery";
import { localProviderServices } from "../src/local-services";
import { LocalPolicyMockProvider, type PolicyMockScenario } from "../src/providers/local-policy-mock";
import { MockSourceResolver } from "../src/providers/mock";
import { createGateway } from "../src/handlers/gateway";
import { environment, migrate, request, runtime, snapshot, type DB } from "./local-pipeline-fixture";
import { policyFixture, POLICY_TIME } from "./provider-policy-fixture";
import type { D1Binding } from "../src/storage/d1-quota-admission";

const principal = { serviceId: "streamlit" } as const;
const identity = { ...principal, keyHash: "1".repeat(64), payloadHash: "2".repeat(64), fingerprintKeyId: "3".repeat(64), responseVersion: "2" as const };
const ownership = { leaseSeconds: 30, ttlSeconds: 60, retentionSeconds: 120 };
const policy: RetentionPolicy = { decisionReference: "synthetic review only", auditSeconds: 100, providerCorrectionSeconds: 200, receiptSeconds: 300 };
function setup(db: DB) {
  let now = POLICY_TIME + 10;
  const binding: D1Binding = { prepare: sql => db.prepare(sql.replaceAll("unixepoch()", String(now))), batch: ss => db.batch(ss) };
  const store = new D1IdempotencyStore(binding, ownership), inspect = new D1RetentionEligibility(binding, principal, policy);
  const providerPolicy = policyFixture("groq", POLICY_TIME);
  const gateway = (scenario: PolicyMockScenario = "success") => {
    const provider = new LocalPolicyMockProvider(providerPolicy, scenario, undefined, () => now);
    const services = localProviderServices(environment(binding), { policy: providerPolicy, bounds: { inputTokens: 100, outputTokens: 200 },
      ownership: { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 172800 } }, provider, () => now)!;
    const handler = createGateway({ mode: "local", enabled: true, provider, sources: new MockSourceResolver(), ...services });
    return { ...services, send: () => handler.fetch(request(), environment(binding)) };
  };
  return { binding, store, inspect, gateway, providerPolicy, advance: (seconds: number) => { now += seconds; }, time: () => now };
}
async function isolated(run: (db: DB, s: ReturnType<typeof setup>) => Promise<void>) {
  const mf = runtime(); try { const db = await mf.getD1Database("COACH_DB"); await migrate(db); await run(db, setup(db));
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await mf.dispose(); }
}
async function claimId(db: DB) { return (await db.prepare("SELECT id FROM idempotency_records ORDER BY rowid DESC LIMIT 1").first<{ id: string }>())!.id; }

test("claims atomically register immutable replay barriers and retain normal duplicate ownership", () => isolated(async (db, s) => {
  const first = await s.store.claim(identity); assert.equal(first.state, "acquired");
  const duplicate = await s.store.claim(identity); assert.equal(duplicate.state, "pending");
  assert.equal((await s.store.claim({ ...identity, payloadHash: "4".repeat(64) })).state, "conflict");
  assert.equal((await db.prepare("SELECT count(*) AS n FROM request_replay_barriers").first<{ n: number }>())!.n, 1);
  await assert.rejects(db.prepare("UPDATE request_replay_barriers SET expires_at = expires_at + 1").run(), /immutable/);
}));

test("freshness uses D1 time, expires at the exact boundary and ignores claimed timestamps", () => isolated(async (db, s) => {
  const supplied = { ...identity, issuedAt: s.time() + 999999 }; assert.equal((await s.store.claim(supplied)).state, "acquired");
  const row = await db.prepare("SELECT created_at FROM idempotency_records").first<{ created_at: number }>(); assert.equal(row!.created_at, s.time());
  s.advance(59); assert.notEqual((await s.store.claim(identity)).state, "acquired");
  s.advance(1); assert.equal((await s.store.claim(identity)).state, "expired");
}));

for (const expired of [false, true]) test(`barrier-only state rejects UUID reuse ${expired ? 'after' : 'before'} original expiry without history deletion`, () => isolated(async (db, s) => {
  // Construct the state a future safe prune would leave. Execute no deletion.
  await db.prepare(`INSERT INTO request_replay_barriers (service_id, key_hash, claim_id, first_seen_at, expires_at, legacy)
    VALUES (?, ?, ?, ?, ?, 0)`).bind(principal.serviceId, identity.keyHash, crypto.randomUUID(), s.time(), s.time() + 60).run();
  if (expired) s.advance(60);
  assert.equal((await s.store.claim(identity)).state, expired ? "expired" : "outcome_unknown");
  assert.equal((await s.store.claim({ ...identity, payloadHash: "5".repeat(64) })).state, expired ? "expired" : "outcome_unknown");
  assert.equal((await db.prepare("SELECT count(*) AS n FROM idempotency_records").first<{ n: number }>())!.n, 0);
}));

test("concurrent duplicate requests acquire one owner and one barrier", () => isolated(async (db, s) => {
  const results = await Promise.all(Array.from({ length: 12 }, () => s.store.claim(identity)));
  assert.equal(results.filter(r => r.state === "acquired").length, 1);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM request_replay_barriers").first<{ n: number }>())!.n, 1);
}));

test("failed barrier registration rolls back the claim and grants no capability", () => isolated(async (db, s) => {
  await db.prepare(`CREATE TRIGGER synthetic_barrier_failure BEFORE INSERT ON request_replay_barriers
    BEGIN SELECT RAISE(ABORT, 'synthetic_barrier_failure'); END`).run();
  assert.equal((await s.store.claim(identity)).state, "storage_unavailable");
  for (const table of ["idempotency_records", "request_replay_barriers"])
    assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n, 0);
}));

test("backward clocks and malformed ownership cannot make history eligible", () => isolated(async (db, s) => {
  const claim = await s.store.claim(identity); if (claim.state !== "acquired") throw new Error();
  await s.store.failBeforeDispatch(claim.fence); const id = await claimId(db);
  s.advance(-1); const backwards = await s.inspect.inspect(id); assert.equal(backwards.state, "retain");
  if (backwards.state === "retain") assert.ok(backwards.reasons.includes("invalid_timestamps"));
  s.advance(1000); await db.prepare("UPDATE idempotency_records SET fingerprint_key_id = NULL WHERE id = ?").bind(id).run();
  const malformed = await s.inspect.inspect(id); assert.equal(malformed.state, "retain");
  if (malformed.state === "retain") assert.ok(malformed.reasons.includes("invalid_ownership"));
}));

test("explicit failed pre-admission claims become eligible only at the configured horizon", () => isolated(async (db, s) => {
  const claim = await s.store.claim(identity); assert.equal(claim.state, "acquired"); if (claim.state !== "acquired") throw new Error();
  assert.equal((await s.store.failBeforeDispatch(claim.fence)).state, "updated");
  const id = await claimId(db); assert.equal((await s.inspect.inspect(id)).state, "retain");
  s.advance(299); assert.equal((await s.inspect.inspect(id)).state, "retain");
  s.advance(1); const before = await snapshot(db); assert.equal((await s.inspect.inspect(id)).state, "eligible");
  assert.deepEqual(await snapshot(db), before);
  assert.equal((await new D1RetentionEligibility(s.binding, principal).inspect(id)).state, "configuration_missing");
  assert.equal((await new D1RetentionEligibility(s.binding, principal, { ...policy, auditSeconds: Number.MAX_SAFE_INTEGER }).inspect(id)).state, "retain");
}));

test("measured completed history is eligible after all stored dependency horizons", () => isolated(async (db, s) => {
  assert.equal((await s.gateway().send()).status, 200); const id = await claimId(db);
  assert.equal((await s.inspect.inspect(id)).state, "retain"); s.advance(4 * 86400);
  assert.equal((await s.inspect.inspect(id)).state, "eligible");
  assert.ok(RETAINED_AUTHORITIES.includes("provider_policy_revocations"));
  assert.ok(RETAINED_AUTHORITIES.includes("provider_evidence_resolutions"));
}));

for (const scenario of ["missing_usage", "partial_usage", "malformed_metadata", "timeout"] as const) test(`${scenario} is never age-only eligible`, () => isolated(async (db, s) => {
  await s.gateway(scenario).send(); const id = await claimId(db); s.advance(4 * 86400);
  const result = await s.inspect.inspect(id); assert.equal(result.state, "retain");
  if (result.state === "retain") assert.ok(result.reasons.includes("unresolved_accounting"));
}));

test("active holds and altered accounting receipts prevent history eligibility", () => isolated(async (db, s) => {
  await s.gateway().send(); const id = await claimId(db), p = s.providerPolicy;
  assert.equal((await new D1ProviderHolds(s.binding, p, s.time).record({ operationId: crypto.randomUUID(), provider: p.provider, model: p.model,
    quotaScopeId: p.quotaScopeId, policyVersion: p.version, observedAt: s.time(), source: "operational", reason: "temporary_provider_unavailable", until: null })).state, "recorded");
  s.advance(4 * 86400); const held = await s.inspect.inspect(id); assert.equal(held.state, "retain");
  if (held.state === "retain") assert.ok(held.reasons.includes("active_provider_hold"));
  await db.prepare("UPDATE usage_accounting SET settlement_hash = ?").bind("6".repeat(64)).run();
  const altered = await s.inspect.inspect(id); assert.equal(altered.state, "retain");
  if (altered.state === "retain") assert.ok(altered.reasons.includes("unresolved_accounting"));
}));

test("completed F02 receipts remain protected", () => isolated(async (db, s) => {
  const g = s.gateway(); const dispatch = g.durable.dispatch.bind(g.durable);
  g.durable.dispatch = async () => ({ state: "storage_unavailable", retryable: false });
  await g.send(); g.durable.dispatch = dispatch;
  const id = await claimId(db), a = await db.prepare("SELECT id, reservation_id FROM inference_attempts").first<{ id: string; reservation_id: string }>();
  const generation = (await db.prepare("SELECT generation FROM idempotency_records").first<{ generation: number }>())!.generation;
  s.advance(301); const key = "c".repeat(64);
  const recovery = await D1EvidenceRecovery.authenticate(new Request("https://internal.test/recovery", { headers: { Authorization: `Bearer ${key}` } }),
    { ...environment(s.binding), COACH_EVIDENCE_RECOVERY_SECRET: key }, s.providerPolicy);
  assert.equal((await recovery.resolve({ operationId: crypto.randomUUID(), reservationId: a!.reservation_id, attemptId: a!.id,
    expectedGeneration: generation, method: "not_dispatched" })).state, "resolved");
  s.advance(4 * 86400); const result = await s.inspect.inspect(id); assert.equal(result.state, "retain");
  if (result.state === "retain") assert.ok(result.reasons.includes("required_evidence_or_hold_receipt"));
}));

test("migration preserves legacy valid requests and restart retains barrier-only replay protection", async () => {
  await mkdir(new URL("../.wrangler/retention-tests/", import.meta.url), { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL("../.wrangler/retention-tests/run-", import.meta.url)));
  let mf = runtime(directory);
  try {
    let db = await mf.getD1Database("COACH_DB");
    const names = (await readdir(new URL("../migrations/", import.meta.url))).filter(n => /^\d{4}_/.test(n)).sort();
    const apply = async (name: string) => { const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await db.batch(sql.replace(/--[^\n]*/g, "").split(/;(?!\s*END\b)/i).map(s => s.trim()).filter(Boolean).map(s => db.prepare(s))); };
    for (const name of names.filter(n => n < "0014")) await apply(name);
    const s = setup(db); const claimed = await s.store.claim(identity); assert.equal(claimed.state, "acquired");
    const before = await snapshot(db); await apply(names.find(n => n.startsWith("0014"))!); assert.deepEqual(await snapshot(db), before);
    assert.equal((await s.store.claim(identity)).state, "pending");
    s.advance(500); const legacy = await s.inspect.inspect(await claimId(db)); assert.equal(legacy.state, "retain");
    if (legacy.state === "retain") assert.ok(legacy.reasons.includes("legacy_history"));
    const extra = { ...identity, keyHash: "7".repeat(64) };
    await db.prepare(`INSERT INTO request_replay_barriers (service_id, key_hash, claim_id, first_seen_at, expires_at, legacy)
      VALUES (?, ?, ?, ?, ?, 0)`).bind(principal.serviceId, extra.keyHash, crypto.randomUUID(), POLICY_TIME, POLICY_TIME + 1).run();
    await mf.dispose(); mf = runtime(directory); db = await mf.getD1Database("COACH_DB");
    assert.equal((await setup(db).store.claim(extra)).state, "expired");
  } finally { await mf.dispose(); }
});
