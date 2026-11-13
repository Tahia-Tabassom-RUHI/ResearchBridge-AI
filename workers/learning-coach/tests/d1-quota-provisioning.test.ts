import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import type { IdempotencyFence, QuotaAdmissionPolicy, QuotaProvisioningResult, TransitionDecision } from "../src/storage";
import { estimatePolicyReservation, type ProviderCapacityPolicy } from "../src/config/provider-policy";
import { D1QuotaProvisioning } from "../src/storage/d1-quota-provisioning";
import { D1QuotaAdmission, type D1Binding } from "../src/storage/d1-quota-admission";
import { D1IdempotencyStore } from "../src/storage/d1-idempotency";
import { D1UsageSettlement } from "../src/storage/d1-usage-settlement";
import { D1FailureAccounting } from "../src/storage/d1-failure-accounting";
import { sha256 } from "../src/storage/request-identity";
import { runtime, migrate, fault, seed, tables, type DB } from "./local-pipeline-fixture";
import { policyFixture, POLICY_TIME as NOW } from "./provider-policy-fixture";

const allTables = [...tables, "provider_holds", "provider_capacity_policies"];
async function snapshot(db: DB) {
  return Object.fromEntries(await Promise.all(allTables.map(async table => [table,
    (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
}
function provisioned(r: QuotaProvisioningResult): QuotaAdmissionPolicy {
  assert.equal(r.state, "provisioned", JSON.stringify(r));
  if (r.state !== "provisioned") throw new Error("Provision rejected");
  return r.policy;
}
function updated(r: TransitionDecision): IdempotencyFence {
  assert.equal(r.state, "updated"); if (r.state !== "updated") throw new Error("Transition rejected"); return r.fence;
}
const writes = (sql: string[]) => sql.some(s => s.startsWith("INSERT INTO provider_capacity_policies"));

test("safe policy provisioning on real local D1", { timeout: 180000 }, async t => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const scenario = (name: string, run: () => Promise<void>) => t.test(name, async () => {
      await db.batch(allTables.map(table => db.prepare(`DELETE FROM ${table}`)));
      await run(); assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });
    const service = (binding: D1Binding = db, now = NOW) => new D1QuotaProvisioning(binding, () => now);
    await scenario("provisions multiple dimensions with independent provider allocations", async () => {
      const cf = provisioned(await service().provision(policyFixture()));
      const groq = provisioned(await service().provision(policyFixture("groq")));
      assert.equal(cf.windows.length, 2); assert.equal(groq.windows.length, 4);
      const rows = (await db.prepare("SELECT * FROM provider_quota_windows").all()).results;
      assert.equal(rows.length, 6); assert.ok(rows.every((r: Record<string, unknown>) => r.reserved_amount === 0 && r.consumed_amount === 0));
      assert.equal((await db.prepare("SELECT * FROM provider_capacity_policies").all()).results.length, 2);
    });
    await scenario("repeated provisioning performs zero writes and preserves usage", async () => {
      const p = policyFixture(), first = provisioned(await service().provision(p));
      await db.prepare("UPDATE provider_quota_windows SET reserved_amount = 2, consumed_amount = 3").run();
      const before = await snapshot(db); let count = 0;
      const binding = fault(db, writes, async () => { count++; });
      assert.deepEqual(provisioned(await service(binding).provision(p)), first);
      assert.deepEqual(await snapshot(db), before); assert.equal(count, 0);
    });
    await scenario("concurrent provisioning has one deterministic row per dimension", async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => service().provision(policyFixture())));
      assert.ok(results.every(r => r.state === "provisioned"));
      assert.equal((await db.prepare("SELECT * FROM provider_quota_windows").all()).results.length, 2);
      assert.equal((await db.prepare("SELECT * FROM provider_capacity_policies").all()).results.length, 1);
    });
    await scenario("split token windows coexist without duplicate or combined counters", async () => {
      const p = policyFixture("groq"), output = structuredClone(p.dimensions[2]!);
      p.dimensions[2]!.metric = "input_tokens"; output.metric = "output_tokens"; p.dimensions.push(output);
      const policy = provisioned(await service().provision(p));
      const split = policy.windows.filter(w => ["input_tokens", "output_tokens"].includes(w.metric));
      assert.equal(split.length, 2); assert.notEqual(split[0]!.windowId, split[1]!.windowId);
      assert.equal(new Set(policy.windows.map(w => w.windowId)).size, 5);
      const before = await snapshot(db); await service().provision(p); assert.deepEqual(await snapshot(db), before);
      const r = split[0]!;
      await assert.rejects(db.prepare(`INSERT INTO provider_quota_windows
        (id, quota_scope_id, provider, model, dimension, unit, window_seconds, window_start, window_end,
         limit_amount, created_at, updated_at, retain_until, quota_metric)
        SELECT 'duplicate', quota_scope_id, provider, model, dimension, unit, window_seconds, window_start, window_end,
          limit_amount, created_at, updated_at, retain_until, quota_metric FROM provider_quota_windows WHERE id = ?`).bind(r.windowId).run(), /UNIQUE/);
    });
    await scenario("version-only changes preserve windows and all counters", async () => {
      const p = policyFixture(); const first = provisioned(await service().provision(p));
      await db.prepare("UPDATE provider_quota_windows SET reserved_amount = 3, consumed_amount = 4").run();
      p.version = 2; p.provenance = "reviewed version 2";
      const next = provisioned(await service().provision(p));
      assert.deepEqual(next.windows, first.windows);
      assert.equal(next.providerPolicy!.version, 2);
      assert.notEqual(next.providerPolicy!.hash, first.providerPolicy!.hash);
      const rows = (await db.prepare("SELECT * FROM provider_quota_windows").all()).results;
      assert.ok(rows.every((r: Record<string, unknown>) => r.reserved_amount === 3 && r.consumed_amount === 4));
      const before = await snapshot(db); assert.equal((await service().provision(policyFixture())).state, "unsafe_change");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("restrictive updates preserve counters and reject stale admissions", async () => {
      const p = policyFixture(); const first = provisioned(await service().provision(p));
      await db.prepare("UPDATE provider_quota_windows SET reserved_amount = 3, consumed_amount = 4").run();
      p.version = 2; p.dimensions[0]!.account!.amount = 20; p.dimensions[0]!.safetyMargin = 2;
      const second = provisioned(await service().provision(p));
      assert.equal(second.windows.find(w => w.metric === "requests")!.capacity, 20);
      assert.deepEqual(first.windows.map(w => w.windowId), second.windows.map(w => w.windowId));
      assert.ok((await db.prepare("SELECT * FROM provider_quota_windows").all()).results.every((r: Record<string, unknown>) => r.reserved_amount === 3 && r.consumed_amount === 4));
    });
    await scenario("capacity increases, reduced margins and overcommitted reductions fail closed", async () => {
      const original = policyFixture(); original.dimensions[0]!.safetyMargin = 10;
      provisioned(await service().provision(original)); const before = await snapshot(db);
      for (const change of [(p: ProviderCapacityPolicy) => { p.dimensions[0]!.account!.amount = 301; },
        (p: ProviderCapacityPolicy) => { p.dimensions[0]!.safetyMargin = 9; },
        (p: ProviderCapacityPolicy) => { p.dimensions[0]!.account!.amount = 0; p.dimensions[0]!.safetyMargin = 0; }]) {
        const p = structuredClone(original); p.version = 2; change(p);
        if (p.dimensions[0]!.account!.amount === 0) {
          await db.prepare("UPDATE provider_quota_windows SET reserved_amount = 1 WHERE dimension = 'requests'").run();
          const occupied = await snapshot(db); assert.equal((await service().provision(p)).state, "unsafe_change"); assert.deepEqual(await snapshot(db), occupied);
        } else { assert.equal((await service().provision(p)).state, "unsafe_change"); assert.deepEqual(await snapshot(db), before); }
      }
    });
    await scenario("same version edits and reset topology changes cannot mint a fresh allowance", async () => {
      const original = policyFixture(); provisioned(await service().provision(original)); const before = await snapshot(db);
      const p = structuredClone(original); p.provenance = "unversioned edit";
      assert.equal((await service().provision(p)).state, "unsafe_change");
      p.version = 2; p.dimensions[0]!.window = { kind: "fixed", seconds: 60, anchor: 1 };
      assert.equal((await service().provision(p)).state, "unsafe_change"); assert.deepEqual(await snapshot(db), before);
    });
    await scenario("concurrent conflicting versions cannot overwrite a stricter capacity", async () => {
      const p = policyFixture(); provisioned(await service().provision(p));
      const low = structuredClone(p), high = structuredClone(p); low.version = 2; high.version = 3;
      low.dimensions[0]!.account!.amount = 10; high.dimensions[0]!.account!.amount = 20;
      const binding = fault(db, writes, async () => { provisioned(await service().provision(low)); });
      assert.equal((await service(binding).provision(high)).state, "conflict");
      assert.equal((await db.prepare("SELECT limit_amount FROM provider_quota_windows WHERE dimension = 'requests'").first())!.limit_amount, 10);
      assert.equal((await db.prepare("SELECT version FROM provider_capacity_policies").first())!.version, 2);
    });
    await scenario("a late dimension conflict rolls back earlier window and receipt changes", async () => {
      const p = policyFixture(); provisioned(await service().provision(p));
      p.version = 2; p.dimensions.forEach(d => { d.account!.amount = 10; });
      let competing: Awaited<ReturnType<typeof snapshot>>;
      const binding = fault(db, writes, async () => {
        await db.prepare("UPDATE provider_quota_windows SET consumed_amount = 11 WHERE dimension = 'requests'").run();
        competing = await snapshot(db);
      });
      assert.equal((await service(binding).provision(p)).state, "conflict");
      assert.deepEqual(await snapshot(db), competing!);
    });
    await scenario("minute rollover creates only the current minute and preserves the daily row", async () => {
      const p = policyFixture(), first = provisioned(await service().provision(p));
      await db.prepare("UPDATE provider_quota_windows SET reserved_amount = 5, consumed_amount = 6").run();
      const before = await snapshot(db), second = provisioned(await service(db, NOW + 60).provision(p));
      assert.equal(second.windows.find(w => w.metric === "compute_units")!.windowId, first.windows.find(w => w.metric === "compute_units")!.windowId);
      assert.notEqual(second.windows.find(w => w.metric === "requests")!.windowId, first.windows.find(w => w.metric === "requests")!.windowId);
      const rows = (await snapshot(db)).provider_quota_windows!;
      assert.equal(rows.length, 3);
      for (const old of before.provider_quota_windows!) assert.deepEqual(rows.find((r: Record<string, unknown>) => r.id === old.id), old);
    });
    await scenario("UTC daily rollover never resets outstanding reservations or historical usage", async () => {
      const p = policyFixture(); provisioned(await service().provision(p));
      await db.prepare("UPDATE provider_quota_windows SET reserved_amount = 5, consumed_amount = 6").run();
      const before = await snapshot(db); provisioned(await service(db, NOW + 86400).provision(p));
      const rows = (await snapshot(db)).provider_quota_windows!; assert.equal(rows.length, 4);
      for (const old of before.provider_quota_windows!) assert.deepEqual(rows.find((r: Record<string, unknown>) => r.id === old.id), old);
    });
    await scenario("account daily resets use the configured anchor", async () => {
      const p = policyFixture("groq");
      for (const d of p.dimensions) if (d.window.kind === "utc_day") d.window = { kind: "fixed", seconds: 86400, anchor: 3600 };
      const first = provisioned(await service().provision(p));
      const next = provisioned(await service(db, NOW + 3600).provision(p));
      for (const w of first.windows.filter(w => w.windowSeconds === 86400)) {
        assert.equal(w.windowStart, NOW - 82800); assert.ok(next.windows.some(n => n.metric === w.metric && n.windowStart === NOW + 3600));
      }
    });
    await scenario("capacity can rise only in fresh windows with a newer verified policy", async () => {
      const p = policyFixture(); p.dimensions[0]!.account!.amount = 10; provisioned(await service().provision(p));
      p.version = 2; p.dimensions[0]!.account!.amount = 20;
      const next = provisioned(await service(db, NOW + 60).provision(p));
      assert.equal(next.windows.find(w => w.metric === "requests")!.capacity, 20);
      assert.equal((await db.prepare("SELECT limit_amount FROM provider_quota_windows WHERE dimension = 'requests' ORDER BY window_start").all()).results[0]!.limit_amount, 10);
    });
    await scenario("long idle periods do not backfill historical windows", async () => {
      const p = policyFixture("groq"); p.reviewAfter = NOW + 100 * 86400;
      provisioned(await service().provision(p)); provisioned(await service(db, NOW + 90 * 86400).provision(p));
      assert.equal((await db.prepare("SELECT * FROM provider_quota_windows").all()).results.length, 8);
    });
    await scenario("overlapping unmanaged legacy windows cannot be bypassed with fresh identities", async () => {
      const config = await seed(db);
      const p = policyFixture(); p.quotaScopeId = config.quota.quotaScopeId;
      await db.prepare(`UPDATE provider_quota_windows SET provider = ?, model = '', window_start = ?,
        window_end = ? + window_seconds, created_at = ?, updated_at = ?, retain_until = ? + window_seconds + 7200`)
        .bind(p.provider, NOW - 1, NOW - 1, NOW - 1, NOW - 1, NOW - 1).run();
      const before = await snapshot(db); assert.equal((await service().provision(p)).state, "unsafe_change");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("outstanding reservation links survive a daily boundary", async () => {
      const now = (await db.prepare("SELECT unixepoch() AS now").first<{ now: number }>())!.now;
      const p = policyFixture("groq", now), policy = provisioned(await new D1QuotaProvisioning(db).provision(p));
      const r = await new D1QuotaAdmission(db, [policy]).reserve({ serviceId: "service", requestId: "outstanding",
        provider: p.provider, model: p.model, estimate: estimatePolicyReservation(p, now, 10, 20)! }); assert.ok(r.admitted);
      const before = await snapshot(db);
      const next = Math.max(...policy.windows.map(w => w.windowStart + w.windowSeconds));
      provisioned(await new D1QuotaProvisioning(db, () => next).provision(p));
      const after = await snapshot(db);
      assert.deepEqual(after.request_reservations, before.request_reservations);
      assert.deepEqual(after.reservation_quota_windows, before.reservation_quota_windows);
      for (const old of before.provider_quota_windows!) assert.deepEqual(after.provider_quota_windows!.find((w: Record<string, unknown>) => w.id === old.id), old);
    });
    await scenario("admission winning a race prevents an overcommitting policy reduction", async () => {
      const now = (await db.prepare("SELECT unixepoch() AS now").first<{ now: number }>())!.now;
      const p = policyFixture("groq", now), policy = provisioned(await new D1QuotaProvisioning(db).provision(p));
      const lower = structuredClone(p); lower.version = 2; lower.dimensions[0]!.account!.amount = 0;
      const binding = fault(db, writes, async () => {
        const r = await new D1QuotaAdmission(db, [policy]).reserve({ serviceId: "service", requestId: "race",
          provider: p.provider, model: p.model, estimate: estimatePolicyReservation(p, now, 10, 20)! }); assert.ok(r.admitted);
      });
      assert.equal((await new D1QuotaProvisioning(binding).provision(lower)).state, "conflict");
      assert.equal((await db.prepare("SELECT version FROM provider_capacity_policies").first())!.version, 1);
      assert.ok((await db.prepare("SELECT reserved_amount FROM provider_quota_windows WHERE dimension = 'requests'").all()).results.every((w: Record<string, unknown>) => w.reserved_amount === 1));
    });
    await scenario("provisioning winning a race rejects stale admission without partial reservations", async () => {
      const now = (await db.prepare("SELECT unixepoch() AS now").first<{ now: number }>())!.now;
      const p = policyFixture("groq", now), policy = provisioned(await new D1QuotaProvisioning(db).provision(p));
      const lower = structuredClone(p); lower.version = 2; lower.dimensions[0]!.account!.amount = 0;
      const binding = fault(db, sql => sql.some(s => s.startsWith("INSERT INTO request_reservations")), async () => {
        provisioned(await new D1QuotaProvisioning(db).provision(lower));
      });
      const r = await new D1QuotaAdmission(binding, [policy]).reserve({ serviceId: "service", requestId: "race",
        provider: p.provider, model: p.model, estimate: estimatePolicyReservation(p, now, 10, 20)! }); assert.equal(r.admitted, false);
      assert.equal((await db.prepare("SELECT * FROM request_reservations").all()).results.length, 0);
      assert.equal((await db.prepare("SELECT * FROM reservation_quota_windows").all()).results.length, 0);
      assert.ok((await db.prepare("SELECT reserved_amount FROM provider_quota_windows").all()).results.every((w: Record<string, unknown>) => w.reserved_amount === 0));
    });
    await scenario("invalid, disabled and expired configuration cannot write or enable unmetered fallback", async () => {
      for (const p of [undefined, {}, { ...policyFixture(), enabled: false }, { ...policyFixture(), reviewAfter: NOW }]) {
        const before = await snapshot(db); assert.notEqual((await service().provision(p)).state, "provisioned");
        assert.deepEqual(await snapshot(db), before);
      }
      assert.equal((await new D1QuotaAdmission(db).reserve({ serviceId: "service", requestId: "request", provider: "groq",
        model: "openai/gpt-oss-20b", estimate: { kind: "estimated" } })).status, "configuration_missing");
    });
    await scenario("missing binding, database read/write failures and uncertain acknowledgements fail closed", async () => {
      assert.equal((await new D1QuotaProvisioning(undefined).provision(policyFixture())).state, "storage_unavailable");
      const failing: D1Binding = { prepare() { throw new Error("database failure"); }, async batch() { throw new Error("database failure"); } };
      assert.equal((await service(failing).provision(policyFixture())).state, "storage_unavailable");
      const before = await snapshot(db);
      const failedWrite = fault(db, writes, async () => { throw new Error("database write failure"); });
      assert.equal((await service(failedWrite).provision(policyFixture())).state, "storage_unavailable");
      assert.deepEqual(await snapshot(db), before);
      const lost = fault(db, writes, async () => { throw new Error("acknowledgement lost"); }, true);
      assert.equal((await service(lost).provision(policyFixture())).state, "storage_unavailable");
      assert.equal((await db.prepare("SELECT * FROM provider_quota_windows").all()).results.length, 2);
      provisioned(await service().provision(policyFixture()));
    });
    await scenario("default clock, admission, ownership, settlement and failure accounting remain compatible", async () => {
      const now = (await db.prepare("SELECT unixepoch() AS now").first<{ now: number }>())!.now;
      const p = policyFixture("groq", now), policy = provisioned(await new D1QuotaProvisioning(db).provision(p));
      const store = new D1IdempotencyStore(db, { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 7200 });
      const estimate = estimatePolicyReservation(p, now, 10, 20)!;
      const make = async () => {
        const identity = { serviceId: "service", keyHash: await sha256(crypto.randomUUID()), payloadHash: await sha256("payload"),
          fingerprintKeyId: await sha256("key"), responseVersion: "2" as const };
        const claim = await store.claim(identity); assert.equal(claim.state, "acquired");
        if (claim.state !== "acquired") throw new Error("claim rejected");
        const r = await new D1QuotaAdmission(db, [policy]).reserve({ serviceId: "service", requestId: claim.fence.claimId,
          provider: p.provider, model: p.model, claim: claim.fence, estimate }); assert.ok(r.admitted);
        return { identity, r, fence: { ...claim.fence, generation: claim.fence.generation + 1 } };
      };
      const success = await make(), links = (await db.prepare("SELECT * FROM reservation_quota_windows").all()).results;
      provisioned(await new D1QuotaProvisioning(db).provision(p));
      assert.deepEqual((await db.prepare("SELECT * FROM reservation_quota_windows").all()).results, links);
      let fence = updated(await store.authorizeDispatch(success.fence)); fence = updated(await store.dispatch(fence));
      fence = updated(await store.complete(fence)); fence = updated(await store.awaitReconciliation(fence));
      const attempt = (await db.prepare("SELECT id FROM inference_attempts WHERE reservation_id = ?").bind(success.r.reservationId).first())!.id as string;
      assert.equal((await new D1UsageSettlement(db).settle({ fence, reservationId: success.r.reservationId,
        attemptId: attempt, provider: p.provider, model: p.model, usage: { kind: "measured", requests: 1, inputTokens: 8, outputTokens: 12 } })).state, "settled");
      assert.equal((await store.lookup(success.identity)).state, "completed");
      const failure = await make(); fence = updated(await store.failBeforeDispatch(failure.fence));
      fence = updated(await store.awaitReconciliation(fence));
      const failed = (await db.prepare("SELECT id FROM inference_attempts WHERE reservation_id = ?").bind(failure.r.reservationId).first())!.id as string;
      assert.equal((await new D1FailureAccounting(db).record({ fence, reservationId: failure.r.reservationId,
        attemptId: failed, provider: p.provider, model: p.model,
        failure: { category: "PROVEN_PRE_DISPATCH_FAILURE", reason: "dispatch_cancelled" } })).state, "recorded");
      assert.ok((await db.prepare("SELECT * FROM provider_quota_windows").all()).results.every((w: Record<string, unknown>) => w.reserved_amount === 0));
      const stricter = structuredClone(p); stricter.version = 2; stricter.dimensions[0]!.account!.amount = 5;
      const current = provisioned(await new D1QuotaProvisioning(db).provision(stricter));
      const stale = await new D1QuotaAdmission(db, [policy]).reserve({ serviceId: "service", requestId: "stale-policy", provider: p.provider, model: p.model, estimate });
      assert.equal(stale.status, "provider_policy_unavailable");
      // A token window cannot be reinterpreted as a split metric.
      const wrong = structuredClone(current); const tokens = wrong.windows.find(w => w.metric === "tokens")!; tokens.metric = "input_tokens";
      assert.equal((await new D1QuotaAdmission(db, [wrong]).reserve({ serviceId: "service", requestId: "wrong-metric", provider: p.provider, model: p.model, estimate })).status, "provider_policy_unavailable");
    });
  } finally { await mf.dispose(); }
});

test("migration 0009 preserves occupied windows and every dependent table", { timeout: 60000 }, async () => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB");
    const names = (await readdir(new URL("../migrations/", import.meta.url))).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort();
    const statements = async (name: string) => (await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
      .replace(/--[^\n]*/g, "").split(/;(?!\s*END\b)/i).map(s => s.trim()).filter(Boolean).map(s => db.prepare(s));
    for (const name of names.filter(n => n < "0009")) await db.batch(await statements(name));
    await seed(db);
    await db.prepare(`INSERT INTO request_reservations (id, service_id, request_id, quota_scope_id, provider, model,
      reservation_number, created_at, updated_at, expires_at, retain_until)
      VALUES ('r', 's', 'q', 'local-mock', 'mock', 'mock-model', 1, 100, 100, 200, 100000)`).run();
    await db.prepare(`INSERT INTO reservation_quota_windows (reservation_id, quota_window_id, reserved_amount, created_at, updated_at, quota_metric)
      VALUES ('r', 'w0', 2, 100, 100, 'requests')`).run();
    await db.prepare("UPDATE provider_quota_windows SET reserved_amount = 2, consumed_amount = 3 WHERE id = 'w0'").run();
    await db.prepare("INSERT INTO inference_attempts (id, reservation_id, created_at, updated_at, retain_until) VALUES ('a', 'r', 100, 100, 100000)").run();
    await db.prepare("INSERT INTO usage_accounting (id, attempt_id, kind, request_count, created_at, updated_at, retain_until) VALUES ('u', 'a', 'measured', 1, 100, 100, 100000)").run();
    await db.prepare(`INSERT INTO idempotency_records (id, service_id, key_hash, payload_hash, response_version, created_at,
      updated_at, expires_at, retain_until, reservation_id) VALUES ('i', 's', ?, ?, '2', 100, 100, 200, 100000, 'r')`)
      .bind("a".repeat(64), "b".repeat(64)).run();
    await db.prepare(`INSERT INTO provider_holds VALUES ('local-mock', 'mock', 'mock-model', 'active', 'manual', 200, 100, 100, 100000)`).run();
    const preserved = [...tables, "provider_holds"];
    const before = Object.fromEntries(await Promise.all(preserved.map(async name => [name, (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results])));
    await db.batch(await statements(names.find(n => n.startsWith("0009"))!));
    for (const name of preserved) {
      const rows = (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results;
      if (name === "provider_quota_windows") for (const r of rows) { assert.equal(r.quota_metric, null); delete r.quota_metric; }
      assert.deepEqual(rows, before[name], name);
    }
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    await assert.rejects(db.prepare("DELETE FROM provider_quota_windows WHERE id = 'w0'").run(), /FOREIGN KEY/);
  } finally { await mf.dispose(); }
});
