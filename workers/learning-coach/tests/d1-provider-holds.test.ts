import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LEGACY_QWEN_MODEL, estimatePolicyReservation, QWEN_REVIEW_BOUNDARY, resetBounds, type ProviderCapacityPolicy } from "../src/config/provider-policy";
import type { IdempotencyFence, ProviderHoldDecision, ProviderHoldObservation, ProviderHoldResolution, QuotaAdmissionPolicy, TransitionDecision } from "../src/storage";
import { D1ProviderHolds } from "../src/storage/d1-provider-holds";
import { D1QuotaProvisioning } from "../src/storage/d1-quota-provisioning";
import { D1QuotaAdmission, type D1Binding, type D1Statement } from "../src/storage/d1-quota-admission";
import { D1IdempotencyStore } from "../src/storage/d1-idempotency";
import { D1UsageSettlement } from "../src/storage/d1-usage-settlement";
import { D1FailureAccounting } from "../src/storage/d1-failure-accounting";
import { sha256 } from "../src/storage/request-identity";
import { fault, migrate, runtime, seed, tables, type DB } from "./local-pipeline-fixture";
import { policyFixture, POLICY_TIME as NOW } from "./provider-policy-fixture";

const allTables = ["provider_hold_operations", "provider_holds", ...tables, "provider_capacity_policies"];
const holdWrites = (sql: string[]) => sql.some(s => /^(INSERT INTO|UPDATE) provider_holds/.test(s));
const admissionWrites = (sql: string[]) => sql.some(s => s.startsWith("INSERT INTO request_reservations"));
function clocked(db: DB, clock: () => number): D1Binding {
  return { prepare: sql => {
    const now = clock(); assert.ok(Number.isSafeInteger(now) && now >= 0);
    return db.prepare(sql.replaceAll("unixepoch()", String(now)));
  }, batch: statements => db.batch(statements) };
}
async function rows(db: DB, table: string): Promise<Record<string, unknown>[]> { return (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results; }
async function snapshot(db: DB) { return Object.fromEntries(await Promise.all(allTables.map(async table => [table, await rows(db, table)]))); }
function success(r: ProviderHoldDecision) {
  assert.ok("holdId" in r, JSON.stringify(r)); return r;
}
function updated(r: TransitionDecision): IdempotencyFence { assert.equal(r.state, "updated"); if (r.state !== "updated") throw new Error("Transition rejected"); return r.fence; }
async function provision(db: D1Binding, p: ProviderCapacityPolicy, now: number): Promise<QuotaAdmissionPolicy> {
  const r = await new D1QuotaProvisioning(db, () => now).provision(p); assert.equal(r.state, "provisioned", JSON.stringify(r));
  if (r.state !== "provisioned") throw new Error("Provision rejected"); return r.policy;
}
function observation(p: ProviderCapacityPolicy, now: number, overrides: Partial<ProviderHoldObservation> = {}): ProviderHoldObservation {
  return { operationId: crypto.randomUUID(), provider: p.provider, quotaScopeId: p.quotaScopeId, model: p.model,
    reason: "provider_retry_after", source: "verified_retry_after", observedAt: now, until: now + 37, policyVersion: p.version, ...overrides };
}
function resolution(p: ProviderCapacityPolicy, h: ReturnType<typeof success>, now: number, overrides: Partial<ProviderHoldResolution> = {}): ProviderHoldResolution {
  return { operationId: crypto.randomUUID(), provider: p.provider, quotaScopeId: p.quotaScopeId, model: p.model,
    holdId: h.holdId, expectedRevision: h.revision, policyVersion: p.version, observedAt: now,
    source: "operational", reason: "availability_restored", ...overrides };
}

test("durable provider holds and authoritative admission on local D1", { timeout: 240000 }, async t => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    let now = NOW;
    const binding = clocked(db, () => now);
    async function harness(p = policyFixture("groq", NOW - 100)) {
      const quota = await provision(binding, p, now), holds = new D1ProviderHolds(binding, p, () => now);
      const estimate = estimatePolicyReservation(p, now, 10, 20)!;
      const send = (connection: D1Binding = binding, config = quota, id: string = crypto.randomUUID(), claim?: IdempotencyFence) =>
        new D1QuotaAdmission(connection, [config]).reserve({ serviceId: "service", requestId: id, provider: config.provider,
          model: config.model, estimate, ...(claim ? { claim } : {}) });
      return { p, quota, holds, estimate, send, observe: (change: Partial<ProviderHoldObservation> = {}) => observation(p, now, change) };
    }
    type H = Awaited<ReturnType<typeof harness>>;
    const scenario = (name: string, fn: (h: H) => Promise<void>, provider: "groq" | "cloudflare_workers_ai" = "groq") => t.test(name, async () => {
      now = NOW; await db.batch(allTables.map(table => db.prepare(`DELETE FROM ${table}`)));
      await fn(await harness(policyFixture(provider, NOW - 100)));
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });
    await scenario("model-specific Retry-After blocks despite available quota", async h => {
      success(await h.holds.record(h.observe())); const before = await snapshot(db);
      const r = await h.send(); assert.equal(r.status, "model_held"); assert.equal(r.admitted, false);
      if (!r.admitted) assert.equal(r.resetAt, NOW + 37);
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("provider-wide operational outage has explicit scope and deadline", async h => {
      success(await h.holds.record(h.observe({ model: "", source: "operational", reason: "temporary_provider_unavailable", until: NOW + 83 })));
      const r = await h.send(); assert.equal(r.status, "provider_held");
      if (!r.admitted) assert.equal(r.resetAt, NOW + 83);
    });
    await scenario("Groq token dimension hold uses its verified minute boundary", async h => {
      success(await h.holds.record(h.observe({ reason: "token_rate_exhausted", source: "verified_quota", remaining: 0,
        dimension: { metric: "tokens", unit: "tokens", windowSeconds: 60 }, until: NOW + 60 })));
      assert.equal((await h.send()).status, "quota_dimension_held");
      const inspected = await h.holds.inspectApplicable(); assert.equal(inspected.state, "inspected");
      if (inspected.state === "inspected") { assert.equal(inspected.holds[0]!.metric, "tokens"); assert.equal(inspected.holds[0]!.until, NOW + 60); }
    });
    await scenario("Cloudflare compute exhaustion is account/provider-wide and keeps Groq independent", async h => {
      const compute = h.quota.windows.find(w => w.metric === "compute_units")!;
      success(await h.holds.record(h.observe({ model: "", reason: "compute_capacity_exhausted", source: "confirmed_exhaustion",
        dimension: { metric: "compute_units", unit: "neurons", windowSeconds: 86400, windowId: compute.windowId }, until: NOW + 86400 })));
      assert.equal((await h.send()).status, "quota_dimension_held");
      const other = await harness(); assert.equal((await other.send()).admitted, true);
    }, "cloudflare_workers_ai");
    await scenario("accounts are isolated even for the same provider and model", async h => {
      success(await h.holds.record(h.observe({ model: "" })));
      const p = structuredClone(h.p); p.quotaScopeId = "other-verified-account";
      const other = await harness(p); assert.equal((await other.send()).admitted, true); assert.equal((await h.send()).admitted, false);
    });
    await scenario("independent reasons coexist and report the latest known applicable deadline", async h => {
      success(await h.holds.record(h.observe()));
      success(await h.holds.record(h.observe({ source: "operational", reason: "temporary_provider_unavailable", until: NOW + 43 })));
      success(await h.holds.record(h.observe({ reason: "daily_tokens_exhausted", source: "confirmed_exhaustion",
        dimension: { metric: "tokens", unit: "tokens", windowSeconds: 86400 }, until: NOW + 86400 })));
      assert.equal((await rows(db, "provider_holds")).length, 3);
      const r = await h.send(); assert.equal(r.status, "model_held"); if (!r.admitted) assert.equal(r.resetAt, NOW + 86400);
    });
    await scenario("unknown exhaustion has no fabricated expiration and survives rollover", async h => {
      success(await h.holds.record(h.observe({ reason: "token_rate_exhausted", source: "confirmed_exhaustion",
        dimension: { metric: "tokens", unit: "tokens", windowSeconds: 60 }, until: null })));
      let r = await h.send(); assert.equal(r.status, "provider_capacity_unknown"); assert.ok(!Object.hasOwn(r, "resetAt"));
      now += 86400; const quota = await provision(binding, h.p, now);
      r = await h.send(binding, quota); assert.equal(r.status, "provider_capacity_unknown");
      const expired = await h.holds.expired(20); assert.equal(expired.state, "page"); if (expired.state === "page") assert.equal(expired.holds.length, 0);
    });
    await scenario("model unavailability never suggests a rate-limit retry", async h => {
      success(await h.holds.record(h.observe({ reason: "model_unavailable", source: "operational", until: null })));
      const r = await h.send(); assert.equal(r.status, "model_held"); assert.equal(r.reason, "model_unavailable"); assert.ok(!Object.hasOwn(r, "resetAt"));
    });
    await scenario("exact operation replays write nothing, including after expiry", async h => {
      const e = h.observe(), first = success(await h.holds.record(e)), before = await snapshot(db);
      let writes = 0;
      const counted = fault(binding, sql => sql.some(s => /^(INSERT|UPDATE)/.test(s)), async () => { writes++; });
      const store = new D1ProviderHolds(counted, h.p, () => now);
      assert.deepEqual(await store.record(e), { ...first, state: "already_recorded" });
      now += 40; assert.equal((await store.record(e)).state, "already_recorded");
      assert.equal(writes, 0); assert.deepEqual(await snapshot(db), before);
    });
    await scenario("duplicate observation with another operation ID does not extend or revise a hold", async h => {
      const e = h.observe(); success(await h.holds.record(e)); const before = await rows(db, "provider_holds");
      now++; const second = { ...e, operationId: crypto.randomUUID() }; success(await h.holds.record(second));
      assert.deepEqual(await rows(db, "provider_holds"), before); assert.equal((await rows(db, "provider_hold_operations")).length, 2);
      assert.equal((await h.holds.record(second)).state, "already_recorded");
    });
    await scenario("newer evidence extends an absolute deadline without losing the original creation time", async h => {
      const first = success(await h.holds.record(h.observe())); now += 2;
      const next = success(await h.holds.record(h.observe({ until: NOW + 95 })));
      assert.equal(next.holdId, first.holdId); assert.equal(next.revision, first.revision + 1);
      const row = (await rows(db, "provider_holds"))[0]!; assert.equal(row.created_at, NOW); assert.equal(row.hold_until, NOW + 95);
    });
    await scenario("newer shorter evidence cannot shorten an active hold", async h => {
      success(await h.holds.record(h.observe({ until: NOW + 100 }))); now++;
      success(await h.holds.record(h.observe({ until: NOW + 10 })));
      assert.equal((await rows(db, "provider_holds"))[0]!.hold_until, NOW + 100);
    });
    await scenario("stale and contradictory simultaneous evidence is rejected without writes", async h => {
      const e = h.observe(); success(await h.holds.record(e)); const before = await snapshot(db);
      assert.equal((await h.holds.record({ ...e, operationId: crypto.randomUUID(), observedAt: NOW - 1 })).state, "stale_evidence");
      assert.equal((await h.holds.record({ ...e, operationId: crypto.randomUUID(), until: NOW + 38 })).state, "conflict");
      assert.equal((await h.holds.record({ ...e, until: NOW + 38 })).state, "conflict");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("known expiry restores admission without modifying any hold or quota counter", async h => {
      success(await h.holds.record(h.observe())); const before = await snapshot(db);
      now = NOW + 37;
      const inspection = await h.holds.inspectApplicable(); assert.equal(inspection.state, "inspected");
      if (inspection.state === "inspected") assert.equal(inspection.holds.length, 0);
      assert.deepEqual(await snapshot(db), before);
      assert.equal((await h.send()).admitted, true);
      assert.deepEqual(await rows(db, "provider_holds"), before.provider_holds);
    });
    await scenario("expiry does not erase consumed quota or promise capacity", async h => {
      success(await h.holds.record(h.observe()));
      await db.prepare("UPDATE provider_quota_windows SET consumed_amount = limit_amount WHERE dimension = 'requests'").run();
      now += 37; const before = await rows(db, "provider_quota_windows");
      assert.equal((await h.send()).status, "insufficient_capacity"); assert.deepEqual(await rows(db, "provider_quota_windows"), before);
    });
    await scenario("quota exhaustion without a provider hold still uses ordinary admission denial", async h => {
      await db.prepare("UPDATE provider_quota_windows SET consumed_amount = limit_amount WHERE dimension = 'requests'").run();
      assert.equal((await h.send()).status, "insufficient_capacity"); assert.equal((await rows(db, "provider_holds")).length, 0);
    });
    await scenario("concurrent identical operations commit once", async h => {
      const e = h.observe(); const results = await Promise.all(Array.from({ length: 20 }, () => h.holds.record(e)));
      assert.ok(results.every(r => ["recorded", "already_recorded"].includes(r.state)), JSON.stringify(results));
      assert.equal((await rows(db, "provider_holds")).length, 1); assert.equal((await rows(db, "provider_hold_operations")).length, 1);
    });
    await scenario("concurrent distinct creators cannot duplicate a restriction or claim lost writes", async h => {
      const evidence = Array.from({ length: 12 }, () => h.observe());
      const r = await Promise.all(evidence.map(e => h.holds.record(e)));
      assert.ok(r.some(v => v.state === "recorded")); assert.ok(r.every(v => ["recorded", "already_recorded", "conflict"].includes(v.state)));
      for (const e of evidence) success(await h.holds.record(e));
      assert.equal((await rows(db, "provider_holds")).length, 1);
      assert.equal((await rows(db, "provider_holds"))[0]!.revision, 1);
      assert.equal((await rows(db, "provider_hold_operations")).length, evidence.length);
    });
    await scenario("competing extensions use revision checks and preserve the committed restriction", async h => {
      success(await h.holds.record(h.observe())); now += 2;
      const longer = h.observe({ until: NOW + 100 }), shorter = h.observe({ observedAt: NOW + 1, until: NOW + 70 });
      const blocked = fault(binding, holdWrites, async () => { success(await h.holds.record(longer)); });
      assert.equal((await new D1ProviderHolds(blocked, h.p, () => now).record(shorter)).state, "conflict");
      assert.equal((await rows(db, "provider_holds"))[0]!.hold_until, NOW + 100);
      assert.equal((await h.holds.record(shorter)).state, "stale_evidence");
    });
    await scenario("hold committed after diagnostic reads blocks the whole reservation transaction", async h => {
      const e = h.observe(); let created = false;
      const raced = fault(binding, admissionWrites, async () => { if (!created) { created = true; success(await h.holds.record(e)); } });
      const r = await h.send(raced); assert.equal(r.status, "model_held");
      assert.equal((await rows(db, "request_reservations")).length, 0); assert.equal((await rows(db, "reservation_quota_windows")).length, 0);
      assert.ok((await rows(db, "provider_quota_windows")).every(w => w.reserved_amount === 0));
    });
    await scenario("an earlier committed admission remains intact when a hold commits afterward", async h => {
      const beforeHold = await h.send(); assert.ok(beforeHold.admitted); const reservations = await rows(db, "request_reservations");
      const quotas = await rows(db, "provider_quota_windows"); success(await h.holds.record(h.observe()));
      assert.deepEqual(await rows(db, "request_reservations"), reservations); assert.deepEqual(await rows(db, "provider_quota_windows"), quotas);
      const results = await Promise.all(Array.from({ length: 20 }, () => h.send()));
      assert.ok(results.every(r => r.status === "model_held")); assert.deepEqual(await rows(db, "request_reservations"), reservations);
    });
    await scenario("concurrent admission at exact expiry still obeys atomic capacity", async h => {
      h.p.version++; h.p.dimensions.find(d => d.metric === "requests" && d.window.kind === "fixed")!.account!.amount = 3;
      const quota = await provision(binding, h.p, now), holds = new D1ProviderHolds(binding, h.p, () => now);
      success(await holds.record(h.observe({ policyVersion: h.p.version })));
      now += 37; const results = await Promise.all(Array.from({ length: 10 }, () => h.send(binding, quota)));
      assert.equal(results.filter(r => r.admitted).length, 3); assert.equal((await rows(db, "request_reservations")).length, 3);
    });
    await scenario("a late hold predicate failure rolls back earlier windows and ownership changes", async h => {
      const store = new D1IdempotencyStore(binding, { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 7200 });
      const claim = await store.claim({ serviceId: "service", keyHash: await sha256("late"), payloadHash: await sha256("payload"), fingerprintKeyId: await sha256("fingerprint"), responseVersion: "2" });
      assert.equal(claim.state, "acquired"); if (claim.state !== "acquired") return;
      const created = success(await h.holds.record(h.observe()));
      await db.prepare("UPDATE provider_holds SET status = 'released'").run(); const before = await snapshot(db);
      const altered = fault(binding, admissionWrites, async statements => {
        // Insert a later failed precondition inside the real batch to prove
        // rollback of already-written counters, links and the claim generation.
        statements.splice(statements.length - 2, 0, binding.prepare("UPDATE provider_holds SET status = 'active' WHERE hold_key = ?").bind(created.holdId));
      });
      const r = await h.send(altered, h.quota, claim.fence.claimId, claim.fence); assert.equal(r.admitted, false);
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("policy version and review failures close admission even without holds", async h => {
      const old = h.quota; h.p.version++; h.p.provenance = "verified policy review";
      const next = await provision(binding, h.p, now);
      assert.equal((await h.send(binding, old)).status, "provider_policy_unavailable");
      assert.equal((await h.send(binding, next)).admitted, true);
      const stripped = structuredClone(next); delete stripped.providerPolicy;
      assert.equal((await h.send(binding, stripped)).status, "provider_policy_unavailable");
      now = h.p.reviewAfter; assert.equal((await h.send(binding, next)).status, "provider_policy_unavailable");
    });
    await scenario("required dimensions cannot be removed to bypass a dimension hold", async h => {
      success(await h.holds.record(h.observe({ reason: "token_rate_exhausted", source: "confirmed_exhaustion", until: NOW + 60,
        dimension: { metric: "tokens", unit: "tokens", windowSeconds: 60 } })));
      const changed = { ...h.quota, windows: h.quota.windows.filter(w => w.metric !== "tokens") };
      assert.equal((await h.send(binding, changed)).status, "provider_policy_unavailable");
    });
    await scenario("policy review racing admission is checked inside its transaction", async h => {
      const p = structuredClone(h.p); p.version++; p.provenance = "reviewed next policy";
      const raced = fault(binding, admissionWrites, async () => { await provision(binding, p, now); });
      assert.equal((await h.send(raced)).status, "provider_policy_unavailable"); assert.equal((await rows(db, "request_reservations")).length, 0);
    });
    await scenario("expired or stale policy cannot create or resolve holds", async h => {
      const e = h.observe(), p = structuredClone(h.p); p.version++; p.provenance = "reviewed";
      await provision(binding, p, now); assert.equal((await h.holds.record(e)).state, "policy_unavailable");
      assert.equal((await h.holds.inspectApplicable()).state, "policy_unavailable");
      now = h.p.reviewAfter; assert.equal((await h.holds.record(e)).state, "policy_unavailable");
    });
    await scenario("trusted operational resolution is conditional, idempotent, and does not touch quotas", async h => {
      const held = success(await h.holds.record(h.observe())); const before = await rows(db, "provider_quota_windows"); now++;
      const e = resolution(h.p, held, now); const released = success(await h.holds.resolve(e));
      assert.equal(released.state, "resolved"); assert.equal(released.revision, held.revision + 1);
      const after = await snapshot(db); assert.equal((await h.holds.resolve(e)).state, "already_resolved");
      assert.deepEqual(await snapshot(db), after); assert.deepEqual(await rows(db, "provider_quota_windows"), before);
      assert.equal((await h.send()).admitted, true);
    });
    await scenario("weaker evidence cannot clear or shorten an indefinite operational restriction", async h => {
      const e = h.observe({ model: h.p.model, source: "operational", reason: "token_rate_exhausted", until: null,
        dimension: { metric: "tokens", unit: "tokens", windowSeconds: 60 } });
      success(await h.holds.record(e)); now++;
      const latest = success(await h.holds.record({ ...e, operationId: crypto.randomUUID(), source: "verified_quota", remaining: 0, until: NOW + 60, observedAt: now }));
      assert.equal((await rows(db, "provider_holds"))[0]!.hold_until, null); now++;
      assert.equal((await h.holds.resolve(resolution(h.p, latest, now, { source: "verified_quota", reason: "capacity_available", remaining: 10 }))).state, "stale_evidence");
      assert.equal((await h.send()).status, "provider_capacity_unknown");
    });
    await scenario("unknown exhaustion can be resolved by fresh verified capacity", async h => {
      const held = success(await h.holds.record(h.observe({ source: "confirmed_exhaustion", reason: "token_rate_exhausted", until: null,
        dimension: { metric: "tokens", unit: "tokens", windowSeconds: 60 } }))); now++;
      success(await h.holds.resolve(resolution(h.p, held, now, { source: "verified_quota", reason: "capacity_available", remaining: 10 })));
      assert.equal((await h.send()).admitted, true);
    });
    await scenario("policy review needs an explicit fresh resolution and cannot clear a hold automatically", async h => {
      const held = success(await h.holds.record(h.observe({ source: "confirmed_exhaustion", reason: "daily_tokens_exhausted", until: null,
        dimension: { metric: "tokens", unit: "tokens", windowSeconds: 86400 } }))); now++;
      assert.equal((await h.holds.resolve(resolution(h.p, held, now, { reason: "policy_reviewed" }))).state, "invalid_evidence");
      const p = structuredClone(h.p); p.version++; p.provenance = "capacity reviewed"; const quota = await provision(binding, p, now);
      assert.equal((await h.send(binding, quota)).status, "provider_capacity_unknown");
      success(await new D1ProviderHolds(binding, p, () => now).resolve(resolution(p, held, now, { reason: "policy_reviewed" })));
      assert.equal((await h.send(binding, quota)).admitted, true);
    });
    await scenario("resolution loses safely to a concurrent extension", async h => {
      const held = success(await h.holds.record(h.observe())); now += 2;
      const extension = h.observe({ until: NOW + 100 });
      const raced = fault(binding, holdWrites, async () => { success(await h.holds.record(extension)); });
      assert.equal((await new D1ProviderHolds(raced, h.p, () => now).resolve(resolution(h.p, held, now - 1))).state, "conflict");
      assert.equal((await rows(db, "provider_holds"))[0]!.hold_until, NOW + 100); assert.equal((await h.send()).status, "model_held");
    });
    await scenario("replaying an old resolution cannot clear a newly reopened hold", async h => {
      const first = success(await h.holds.record(h.observe())); now++;
      const e = resolution(h.p, first, now); success(await h.holds.resolve(e)); now++;
      const reopened = success(await h.holds.record(h.observe({ until: NOW + 100 })));
      const before = await snapshot(db); assert.equal((await h.holds.resolve(e)).state, "already_resolved");
      assert.deepEqual(await snapshot(db), before); assert.ok(reopened.revision > first.revision); assert.equal((await h.send()).status, "model_held");
    });
    await scenario("expired hold inspection uses bounded pagination without clearing records", async h => {
      success(await h.holds.record(h.observe()));
      success(await h.holds.record(h.observe({ model: "" })));
      success(await h.holds.record(h.observe({ source: "operational", reason: "temporary_provider_unavailable" })));
      now += 40; const before = await snapshot(db), first = await h.holds.expired(2);
      assert.equal(first.state, "page"); if (first.state !== "page") return;
      assert.equal(first.holds.length, 2); assert.ok(first.nextCursor);
      const next = await h.holds.expired(2, first.nextCursor); assert.equal(next.state, "page");
      if (next.state === "page") { assert.equal(next.holds.length, 1); assert.equal(next.nextCursor, null); }
      assert.deepEqual(await snapshot(db), before); assert.equal((await h.holds.expired(21)).state, "invalid_evidence");
    });
    await scenario("missing binding and unavailable D1 fail closed", async h => {
      assert.equal((await new D1ProviderHolds(undefined, h.p).record(h.observe())).state, "storage_unavailable");
      const broken: D1Binding = { prepare() { throw new Error("private database detail"); }, async batch() { throw new Error("private database detail"); } };
      const store = new D1ProviderHolds(broken, h.p);
      assert.equal((await store.record(h.observe())).state, "storage_unavailable");
      assert.equal((await store.inspectApplicable()).state, "storage_unavailable");
      assert.equal((await store.expired(1)).state, "storage_unavailable");
      assert.equal((await store.inspectOperation(crypto.randomUUID())).state, "storage_unavailable");
      assert.equal((await h.send(broken)).status, "storage_unavailable");
    });
    await scenario("uncertain hold writes are confirmed from receipts without blind retry", async h => {
      const e = h.observe(); let writes = 0;
      const lost = fault(binding, holdWrites, async () => { writes++; throw new Error("acknowledgment lost"); }, true);
      const store = new D1ProviderHolds(lost, h.p, () => now);
      const r = success(await store.record(e)); assert.equal(r.state, "already_recorded"); assert.equal(writes, 1);
      assert.equal((await store.inspectOperation(e.operationId)).state, "already_recorded");
      assert.equal((await store.record(e)).state, "already_recorded"); assert.equal(writes, 1);
      assert.equal((await h.send()).status, "model_held");
    });
    await scenario("pre-commit failure creates no partial hold or receipt", async h => {
      const before = await snapshot(db), broken = fault(binding, holdWrites, async () => { throw new Error("database failure"); });
      assert.equal((await new D1ProviderHolds(broken, h.p, () => now).record(h.observe())).state, "storage_unavailable");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("late receipt failure rolls back the hold mutation", async h => {
      const before = await snapshot(db);
      const broken = fault(binding, holdWrites, async statements => { statements.push(binding.prepare("SELECT json('invalid')")); });
      assert.equal((await new D1ProviderHolds(broken, h.p, () => now).record(h.observe())).state, "conflict");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("expired policies still permit read-only receipt inspection", async h => {
      const e = h.observe(); success(await h.holds.record(e)); now = h.p.reviewAfter;
      assert.equal((await h.holds.inspectOperation(e.operationId)).state, "already_recorded");
      assert.equal((await h.holds.record(h.observe())).state, "policy_unavailable");
    });
    await scenario("hold creation racing a policy update cannot use stale authorization", async h => {
      const next = structuredClone(h.p); next.version++; next.provenance = "reviewed before hold commit";
      const raced = fault(binding, holdWrites, async () => { await provision(binding, next, now); });
      assert.equal((await new D1ProviderHolds(raced, h.p, () => now).record(h.observe())).state, "conflict");
      assert.equal((await rows(db, "provider_holds")).length, 0);
      assert.equal((await rows(db, "provider_hold_operations")).length, 0);
    });
    await scenario("window-scoped evidence cannot refer to another account's window", async h => {
      const other = policyFixture("groq", NOW - 100); other.quotaScopeId = "another-account";
      const otherQuota = await provision(binding, other, now), w = otherQuota.windows.find(w => w.metric === "tokens" && w.windowSeconds === 60)!;
      const before = await snapshot(db);
      assert.equal((await h.holds.record(h.observe({ source: "confirmed_exhaustion", reason: "token_rate_exhausted", until: NOW + 60,
        dimension: { metric: "tokens", unit: "tokens", windowSeconds: 60, windowId: w.windowId } }))).state, "conflict");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("ambiguous resolution acknowledgment is recovered without a second mutation", async h => {
      const held = success(await h.holds.record(h.observe())); now++;
      let writes = 0;
      const lost = fault(binding, holdWrites, async () => { writes++; throw new Error("lost acknowledgment"); }, true);
      const store = new D1ProviderHolds(lost, h.p, () => now), e = resolution(h.p, held, now);
      assert.equal((await store.resolve(e)).state, "already_resolved");
      assert.equal((await store.resolve(e)).state, "already_resolved"); assert.equal(writes, 1);
      assert.equal((await h.send()).admitted, true);
    });
    for (const outcome of ["unknown", "success", "failure"] as const) {
      await scenario(`provider holds preserve ${outcome} accounting and stale-owner fencing`, async h => {
        const store = new D1IdempotencyStore(binding, { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 7200 });
        const claim = await store.claim({ serviceId: "service", keyHash: await sha256(crypto.randomUUID()),
          payloadHash: await sha256("private payload digest"), fingerprintKeyId: await sha256("local fingerprint"), responseVersion: "2" });
        assert.equal(claim.state, "acquired"); if (claim.state !== "acquired") return;
        const admitted = await h.send(binding, h.quota, claim.fence.claimId, claim.fence); assert.ok(admitted.admitted);
        let fence = { ...claim.fence, generation: claim.fence.generation + 1 };
        fence = updated(await store.authorizeDispatch(fence)); fence = updated(await store.dispatch(fence));
        fence = updated(await store[outcome === "success" ? "complete" : "markUnknown"](fence));
        fence = updated(await store.awaitReconciliation(fence));
        const attempt = (await rows(db, "inference_attempts"))[0]!;
        const base = { fence, reservationId: admitted.reservationId, attemptId: String(attempt.id), provider: h.p.provider, model: h.p.model };
        const failure = new D1FailureAccounting(binding), settlement = new D1UsageSettlement(binding);
        const usage = { kind: "measured" as const, requests: 1, inputTokens: 8, outputTokens: 12, computeUnits: {} };
        const unknown = { ...base, failure: { category: "UNKNOWN_OUTCOME" as const, reason: "response_missing" as const } };
        if (outcome === "unknown") assert.equal((await failure.record(unknown)).state, "recorded");
        const before = await snapshot(db), held = success(await h.holds.record(h.observe()));
        for (const table of tables) assert.deepEqual(await rows(db, table), before[table]);
        assert.equal((await h.send()).status, "model_held");
        if (outcome === "success") assert.equal((await settlement.settle({ ...base, usage })).state, "settled");
        if (outcome === "failure") assert.equal((await failure.record({ ...base, failure: { category: "CONFIRMED_PROVIDER_ERROR",
          reason: "provider_http_error", httpStatus: 500, usage: { requests: { kind: "measured", amount: 1, evidence: "provider_report" } } } })).state, "recorded");
        const accounted = await snapshot(db); now++;
        success(await h.holds.resolve(resolution(h.p, held, now)));
        for (const table of tables) assert.deepEqual(await rows(db, table), accounted[table]);
        if (outcome === "unknown") {
          assert.equal((await failure.record(unknown)).state, "already_recorded");
          assert.ok((await rows(db, "provider_quota_windows")).every(w => Number(w.reserved_amount) > 0));
        }
        const stale = { ...base, fence: claim.fence };
        assert.equal((await settlement.settle({ ...stale, usage })).state, "stale_owner");
        assert.equal((await failure.record({ ...unknown, fence: claim.fence })).state, "stale_owner");
        for (const table of tables) assert.deepEqual(await rows(db, table), accounted[table]);
      });
    }
    await scenario("Qwen availability fails closed at deprecation without creating a cooldown", async h => {
      now = QWEN_REVIEW_BOUNDARY - 1; h.p.reviewAfter = QWEN_REVIEW_BOUNDARY;
      h.p.version++; const quota = await provision(binding, h.p, now);
      assert.equal((await h.send(binding, quota)).admitted, true); now++;
      const r = await h.send(binding, quota); assert.equal(r.status, "provider_policy_unavailable"); assert.equal(r.reason, "model_unavailable");
      assert.ok(!Object.hasOwn(r, "resetAt")); assert.equal((await rows(db, "provider_holds")).length, 0);
      assert.equal(h.p.model, LEGACY_QWEN_MODEL);
    }, "cloudflare_workers_ai");

    const invalid: [string, (e: any) => void][] = [
      ["browser source", e => { e.source = "browser"; }], ["uncertain response", e => { e.source = "uncertain"; }],
      ["raw response metadata", e => { e.response = "PRIVATE RESPONSE"; }], ["credential metadata", e => { e.credentials = "PRIVATE KEY"; }],
      ["student header", e => { e.headers = { "retry-after": 60 }; }], ["student identifier", e => { e.student = "PRIVATE STUDENT"; }],
      ["wrong provider", e => { e.provider = "cloudflare_workers_ai"; }], ["wrong model", e => { e.model = "unknown-model"; }],
      ["wrong account", e => { e.quotaScopeId = "other-account"; }], ["wrong policy version", e => { e.policyVersion++; }],
      ["future evidence", e => { e.observedAt = NOW + 1; }], ["negative evidence time", e => { e.observedAt = -1; }],
      ["fractional deadline", e => { e.until = NOW + 1.5; }], ["unsafe deadline", e => { e.until = Number.MAX_SAFE_INTEGER + 1; }],
      ["past deadline", e => { e.until = NOW - 1; }], ["deadline at observation", e => { e.until = NOW; }],
      ["unknown Retry-After", e => { e.until = null; }], ["raw operation identifier", e => { e.operationId = "student-name"; }],
      ["temporary model cooldown", e => { e.source = "operational"; e.reason = "model_unavailable"; }],
      ["broadened model unavailability", e => { e.source = "operational"; e.reason = "model_unavailable"; e.model = ""; e.until = null; }],
      ["unknown quota dimension", e => { e.dimension = { metric: "compute_units", unit: "neurons", windowSeconds: 60 }; }],
      ["broadened Groq dimension", e => { e.model = ""; e.dimension = { metric: "tokens", unit: "tokens", windowSeconds: 60 }; }],
      ["dimension reason mismatch", e => { e.reason = "daily_requests_exhausted"; e.source = "confirmed_exhaustion"; e.until = NOW + 60; e.dimension = { metric: "tokens", unit: "tokens", windowSeconds: 60 }; }],
      ["invented quota reset", e => { e.reason = "token_rate_exhausted"; e.source = "confirmed_exhaustion"; e.until = NOW + 59; e.dimension = { metric: "tokens", unit: "tokens", windowSeconds: 60 }; }],
      ["contradictory remaining capacity", e => { e.reason = "token_rate_exhausted"; e.source = "verified_quota"; e.remaining = 10; e.until = NOW + 60; e.dimension = { metric: "tokens", unit: "tokens", windowSeconds: 60 }; }],
      ["indefinite window-scoped restriction", e => { e.reason = "token_rate_exhausted"; e.source = "confirmed_exhaustion"; e.until = null; e.dimension = { metric: "tokens", unit: "tokens", windowSeconds: 60, windowId: "old-window" }; }],
    ];
    for (const [name, alter] of invalid) await scenario(`rejects ${name} without writes`, async h => {
      const e = h.observe(); alter(e); const before = await snapshot(db);
      assert.equal((await h.holds.record(e)).state, "invalid_evidence"); assert.deepEqual(await snapshot(db), before);
    });
    await scenario("invalid resolution evidence cannot clear a restriction", async h => {
      const held = success(await h.holds.record(h.observe())); now++;
      const before = await snapshot(db), base = resolution(h.p, held, now);
      for (const invalid of [{ ...base, source: "uncertain" }, { ...base, observedAt: NOW },
        { ...base, expectedRevision: 999 }, { ...base, reason: "capacity_available", source: "verified_quota", remaining: 10000 },
        { ...base, credentials: "PRIVATE KEY" }]) assert.ok(!("holdId" in await h.holds.resolve(invalid)));
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("stored evidence is enumerated metadata and hashes only", async h => {
      success(await h.holds.record(h.observe()));
      const stored = JSON.stringify([await rows(db, "provider_holds"), await rows(db, "provider_hold_operations")]);
      for (const secret of ["PRIVATE RESPONSE", "PRIVATE KEY", "PRIVATE STUDENT", "prompt", "Authorization"]) assert.ok(!stored.includes(secret));
      assert.equal((await rows(db, "usage_accounting")).length, 0); assert.equal((await rows(db, "inference_attempts")).length, 0);
    });
  } finally { await mf.dispose(); }
});

test("default hold clock and deadline guards use D1 UTC", { timeout: 60000 }, async () => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const now = (await db.prepare("SELECT unixepoch() AS now").first<{ now: number }>())!.now;
    const p = policyFixture("groq", now - 100); p.reviewAfter = now + 86400;
    const quota = await provision(db, p, now), store = new D1ProviderHolds(db, p);
    success(await store.record(observation(p, now, { until: now + 100 })));
    const result = await new D1QuotaAdmission(db, [quota]).reserve({ serviceId: "service", requestId: crypto.randomUUID(),
      provider: p.provider, model: p.model, estimate: estimatePolicyReservation(p, now, 10, 20)! });
    assert.equal(result.status, "model_held");
    assert.equal((await store.inspectApplicable()).state, "inspected");
  } finally { await mf.dispose(); }
});

test("provider holds and immutable operation receipts survive a runtime restart", { timeout: 60000 }, async () => {
  const root = fileURLToPath(new URL("../.wrangler/provider-hold-tests/", import.meta.url));
  await mkdir(root, { recursive: true }); const directory = await mkdtemp(`${root}restart-`);
  const p = policyFixture("groq", NOW - 100), e = observation(p, NOW);
  let mf = runtime(directory), quota: QuotaAdmissionPolicy, before: Awaited<ReturnType<typeof snapshot>>;
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const binding = clocked(db, () => NOW); quota = await provision(binding, p, NOW);
    success(await new D1ProviderHolds(binding, p, () => NOW).record(e)); before = await snapshot(db);
  } finally { await mf.dispose(); }
  mf = runtime(directory);
  try {
    const db = await mf.getD1Database("COACH_DB"), binding = clocked(db, () => NOW);
    assert.deepEqual(await snapshot(db), before);
    const store = new D1ProviderHolds(binding, p, () => NOW);
    assert.equal((await store.record(e)).state, "already_recorded");
    const result = await new D1QuotaAdmission(binding, [quota]).reserve({ serviceId: "service", requestId: crypto.randomUUID(),
      provider: p.provider, model: p.model, estimate: estimatePolicyReservation(p, NOW, 10, 20)! });
    assert.equal(result.status, "model_held"); assert.deepEqual(await snapshot(db), before);
  } finally { await mf.dispose(); }
});

test("migration 0010 preserves legacy holds and occupied accounting tables", { timeout: 60000 }, async () => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB");
    const names = (await readdir(new URL("../migrations/", import.meta.url))).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort();
    const apply = async (name: string) => {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await db.batch(sql.replace(/--[^\n]*/g, "").split(/;(?!\s*END\b)/i).map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    };
    for (const name of names.filter(n => n < "0010")) await apply(name);
    const config = await seed(db), admitted = await new D1QuotaAdmission(db, [config.quota]).reserve({ serviceId: "service",
      requestId: crypto.randomUUID(), provider: "mock", model: "mock-model", estimate: config.estimate });
    assert.ok(admitted.admitted);
    await db.prepare("UPDATE provider_quota_windows SET consumed_amount = 5").run();
    await db.prepare("INSERT INTO inference_attempts (id, reservation_id, created_at, updated_at, retain_until) VALUES ('a', ?, 100, 100, 100000)").bind(admitted.reservationId).run();
    await db.prepare("INSERT INTO usage_accounting (id, attempt_id, kind, request_count, created_at, updated_at, retain_until) VALUES ('u', 'a', 'measured', 1, 100, 100, 100000)").run();
    await db.prepare(`INSERT INTO idempotency_records (id, service_id, key_hash, payload_hash, response_version,
      created_at, updated_at, expires_at, retain_until, reservation_id) VALUES ('i', 'service', ?, ?, '2', 100, 100, 200, 100000, ?)`)
      .bind("a".repeat(64), "b".repeat(64), admitted.reservationId).run();
    for (const [model, status, reason, end, created] of [["mock-model", "active", "manual", 200, 100],
      ["expired", "active", "rate_limit", 101, 100], ["released", "released", "unavailable", 200, 100],
      ["old-negative", "released", "manual", -10, -20]] as const) {
      await db.prepare("INSERT INTO provider_holds VALUES ('local-mock', 'mock', ?, ?, ?, ?, ?, ?, 100000)")
        .bind(model, status, reason, end, created, created).run();
    }
    const before = Object.fromEntries(await Promise.all([...tables, "provider_holds", "provider_capacity_policies"].map(async table => [table, await rows(db, table)])));
    await apply(names.find(n => n.startsWith("0010"))!);
    for (const table of [...tables, "provider_capacity_policies"]) assert.deepEqual(await rows(db, table), before[table]);
    const migrated = await rows(db, "provider_holds");
    for (const [index, hold] of migrated.entries()) {
      const original = before.provider_holds![index]!;
      assert.deepEqual(Object.fromEntries(Object.keys(original).map(k => [k, hold[k]])), original);
      assert.equal(hold.hold_key, "legacy"); assert.equal(hold.source_class, "legacy"); assert.equal(hold.evidence_at, original.updated_at);
    }
    assert.equal((await rows(db, "provider_hold_operations")).length, 0);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    await assert.rejects(db.prepare("DELETE FROM provider_quota_windows WHERE id = 'w0'").run(), /FOREIGN KEY/);
  } finally { await mf.dispose(); }
});

test("model-specific and provider-wide predicates keep unrelated local models independent", { timeout: 60000 }, async () => {
  // Synthetic local models exercise SQL scoping without approving another live model.
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const config = await seed(db), first = config.quota, second = structuredClone(first); second.model = "another-mock-model";
    for (const w of second.windows) {
      const id = w.windowId; w.windowId = `other-${id}`; w.model = second.model;
      await db.prepare(`INSERT INTO provider_quota_windows (id, quota_scope_id, provider, model, dimension, unit, window_start,
        window_seconds, window_end, limit_amount, created_at, updated_at, retain_until)
        SELECT ?, quota_scope_id, provider, ?, dimension, unit, window_start, window_seconds, window_end, limit_amount,
          created_at, updated_at, retain_until FROM provider_quota_windows WHERE id = ?`).bind(w.windowId, w.model, id).run();
    }
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(`INSERT INTO provider_holds (quota_scope_id, provider, model, reason_code, hold_until, created_at, updated_at, retain_until)
      VALUES ('local-mock', 'mock', 'mock-model', 'manual', ?, ?, ?, ?)`).bind(now + 100, now, now, now + 1000).run();
    const send = (p: QuotaAdmissionPolicy) => new D1QuotaAdmission(db, [p]).reserve({ serviceId: "service", requestId: crypto.randomUUID(),
      provider: p.provider, model: p.model, estimate: config.estimate });
    assert.equal((await send(first)).status, "model_held"); assert.equal((await send(second)).admitted, true);
    await db.prepare("UPDATE provider_holds SET model = ''").run();
    assert.equal((await send(first)).status, "provider_held"); assert.equal((await send(second)).status, "provider_held");
  } finally { await mf.dispose(); }
});
