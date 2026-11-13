import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { RecoveryClaimInput, RecoveryFence, RecoveryScan, TransitionDecision } from "../src/storage";
import { D1ReservationRecovery } from "../src/storage/d1-reservation-recovery";
import { D1FailureAccounting } from "../src/storage/d1-failure-accounting";
import { D1IdempotencyStore } from "../src/storage/d1-idempotency";
import { D1UsageSettlement } from "../src/storage/d1-usage-settlement";
import { D1QuotaAdmission, type D1Binding, type D1Statement, type D1QueryResult } from "../src/storage/d1-quota-admission";
import { sha256 } from "../src/storage/request-identity";

type DB = Awaited<ReturnType<Miniflare["getD1Database"]>>;
const files = (await readdir(new URL("../migrations/", import.meta.url))).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort();
const tables = ["usage_accounting", "idempotency_records", "inference_attempts", "reservation_quota_windows", "request_reservations", "provider_quota_windows"];
const ownerPolicy = { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 7200 };
const secret = "a".repeat(64);
const request = () => new Request("https://internal.invalid/recovery", { headers: { Authorization: `Bearer ${secret}` } });
const service = (db: D1Binding | undefined, leaseSeconds = 60) => D1ReservationRecovery.authenticate(request(),
  { COACH_SERVICE_SECRET: secret, ...(db ? { COACH_DB: db } : {}) }, { leaseSeconds });
const runtime = (directory?: string) => new Miniflare(convertV4MiniflareOptions({
  modules: true, script: "export default { fetch() { return new Response('local recovery tests'); } };",
  compatibilityDate: "2026-11-03", cf: false, telemetry: { enabled: false }, d1Databases: { COACH_DB: "recovery-tests" },
  ...(directory ? { resourcePersistencePath: directory } : {}),
  outboundService: () => { throw new Error("External networking is forbidden in recovery tests"); },
}));
async function migrate(db: DB, names = files) {
  for (const name of names) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    for (const statement of sql.replace(/--[^\n]*/g, "").split(/;(?!\s*END\b)/i).map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
}
function updated(r: TransitionDecision) {
  assert.equal(r.state, "updated", JSON.stringify(r)); if (r.state !== "updated") throw new Error("Lifecycle rejected"); return r.fence;
}
type Options = { stage?: "reserved" | "prepared" | "sent" | "unknown" | "completed" | "success" | "released" | "partial" | "accounted" | "unmarked_not_sent";
  active?: boolean; serviceId?: string; legacyDispatchFixture?: boolean };
async function fixture(db: DB, options: Options = {}) {
  const prefix = crypto.randomUUID(), provider = "mock", model = `model-${prefix}`, serviceId = options.serviceId ?? "streamlit";
  const start = Math.floor(Date.now() / 1000) - 10;
  const windows = (["requests", "tokens", "compute_units"] as const).map((metric, index) => ({ windowId: `${prefix}-${index}`, model,
    metric, unit: metric === "requests" ? "requests" : metric === "tokens" ? "tokens" : "milli_neurons", capacity: 1000, safetyMargin: 0,
    windowStart: start, windowSeconds: 600 + index }));
  for (const w of windows) await db.prepare(`INSERT INTO provider_quota_windows (id, quota_scope_id, provider, model, dimension, unit,
    window_start, window_seconds, window_end, limit_amount, consumed_amount, created_at, updated_at, retain_until)
    VALUES (?, 'test-scope', ?, ?, ?, ?, ?, ?, ?, 1000, 2, ?, ?, ?)`)
    .bind(w.windowId, provider, model, w.metric, w.unit, start, w.windowSeconds, start + w.windowSeconds, start, start, start + 10000).run();
  const store = new D1IdempotencyStore(db, ownerPolicy);
  const claim = await store.claim({ serviceId, keyHash: await sha256(prefix), payloadHash: await sha256("recovery fixture"),
    fingerprintKeyId: await sha256("recovery test key id"), responseVersion: "2" });
  assert.equal(claim.state, "acquired"); if (claim.state !== "acquired") throw new Error("Claim rejected");
  let fence = claim.fence;
  const admission = new D1QuotaAdmission(db, [{ provider, model, quotaScopeId: "test-scope", leaseSeconds: 120, retentionSeconds: 7200, windows }]);
  const estimate = { kind: "estimated" as const, inputTokens: 10, outputTokens: 20, computeUnits: { milli_neurons: 40 } };
  const admitted = await admission.reserve({ serviceId, requestId: fence.claimId, provider, model, claim: fence, estimate });
  assert.ok(admitted.admitted); fence = { ...fence, generation: fence.generation + 1 };
  const stage = options.stage;
  const notSent = !stage || stage === "released" || stage === "unmarked_not_sent";
  if (notSent) fence = updated(await store.failBeforeDispatch(fence));
  else if (stage !== "reserved") {
    fence = updated(await store.authorizeDispatch(fence));
    if (stage !== "prepared") {
      if (options.legacyDispatchFixture) {
        // Historical pre-0008 data uses the original sent transition. Current
        // dispatch deliberately requires F01's migration 0012 and fails closed.
        await db.batch([
          db.prepare(`UPDATE idempotency_records SET generation = generation + 1, processing_state = 'dispatched', updated_at = unixepoch()
            WHERE id = ? AND generation = ?`).bind(fence.claimId, fence.generation),
          db.prepare("UPDATE request_reservations SET status = 'sent', updated_at = unixepoch() WHERE id = ?").bind(admitted.reservationId),
          db.prepare("UPDATE inference_attempts SET status = 'sent', sent_at = unixepoch(), updated_at = unixepoch() WHERE reservation_id = ?").bind(admitted.reservationId),
        ]);
        fence = { ...fence, generation: fence.generation + 1 };
      } else fence = updated(await store.dispatch(fence));
      if (stage !== "sent") fence = updated(await store[stage === "success" || stage === "completed" ? "complete" : "markUnknown"](fence));
    }
  }
  if (!stage || ["released", "unknown", "completed", "success", "partial", "accounted"].includes(stage)) fence = updated(await store.awaitReconciliation(fence));
  const attempt = await db.prepare("SELECT id FROM inference_attempts WHERE reservation_id = ?").bind(admitted.reservationId).first();
  const common = { fence, reservationId: admitted.reservationId, attemptId: attempt?.id ?? crypto.randomUUID(), provider, model };
  if (stage === "success") assert.equal((await new D1UsageSettlement(db).settle({ ...common,
    usage: { kind: "measured", requests: 1, inputTokens: 8, outputTokens: 12, computeUnits: { milli_neurons: 25 } } })).state, "settled");
  if (stage === "released") assert.equal((await new D1FailureAccounting(db).record({ ...common,
    failure: { category: "PROVEN_PRE_DISPATCH_FAILURE", reason: "preparation_failed" } })).state, "recorded");
  if (stage === "partial" || stage === "accounted") assert.equal((await new D1FailureAccounting(db).record({ ...common,
    failure: { category: "CONFIRMED_PROVIDER_ERROR", reason: "provider_http_error", httpStatus: 500, usage: {
      requests: { kind: "measured", amount: 1, evidence: "provider_report" }, ...(stage === "accounted" ? {
        totalTokens: { kind: "measured", amount: 20, evidence: "provider_report" },
        computeUnits: { milli_neurons: { kind: "measured", amount: 25, evidence: "provider_report" } } } : {}) } } })).state, "recorded");
  if (!options.active) {
    await db.prepare("UPDATE request_reservations SET expires_at = created_at WHERE id = ?").bind(admitted.reservationId).run();
    await db.prepare("UPDATE idempotency_records SET lease_expires_at = created_at WHERE id = ?").bind(fence.claimId).run();
  }
  const input: RecoveryClaimInput = { reservationId: admitted.reservationId, requestId: fence.claimId,
    attemptId: common.attemptId, expectedGeneration: fence.generation, operationId: crypto.randomUUID() };
  return { input, common, store, admission, estimate, windows, recovery: await service(db) };
}
async function snapshot(db: DB): Promise<Record<string, Record<string, unknown>[]>> {
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
}
async function counters(db: DB): Promise<{ reserved_amount: number; consumed_amount: number }[]> {
  return (await db.prepare("SELECT reserved_amount, consumed_amount FROM provider_quota_windows ORDER BY rowid").all()).results;
}
async function acquired(recovery: D1ReservationRecovery, input: RecoveryClaimInput): Promise<RecoveryFence> {
  const result = await recovery.claim(input); assert.equal(result.state, "acquired", JSON.stringify(result));
  if (result.state !== "acquired") throw new Error("Recovery not acquired"); return result.fence;
}
async function classification(recovery: D1ReservationRecovery, id: string) {
  const result = await recovery.inspect(id); assert.equal(result.state, "inspected", JSON.stringify(result));
  if (result.state !== "inspected") throw new Error("Inspection unavailable"); return result.item;
}

test("stale discovery and controlled recovery on real local D1", { timeout: 240_000 }, async t => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const scenario = (name: string, fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, options: Options = {}) => t.test(name, async () => {
      await db.batch(tables.map(table => db.prepare(`DELETE FROM ${table}`))); await fn(await fixture(db, options));
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });
    await scenario("expiry discovery is read-only and excludes active reservations", async ({ input, recovery }) => {
      const active = await fixture(db, { active: true }); const before = await snapshot(db);
      for (const basis of ["reservation_expiry", "owner_lease"] as const) {
        const page = await recovery.discover({ basis, from: 0, through: Math.floor(Date.now() / 1000), limit: 20 });
        assert.equal(page.state, "page"); if (page.state !== "page") throw new Error("No page");
        assert.deepEqual(page.items.map(i => i.reservationId), [input.reservationId]);
        assert.ok(!page.items.some(i => i.reservationId === active.input.reservationId));
      }
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("owner-lease stream discovers expiry before reservation expiry", async ({ input, recovery }) => {
      await db.prepare("UPDATE idempotency_records SET lease_expires_at = created_at").run();
      const page = await recovery.discover({ basis: "owner_lease", from: 0, through: Math.floor(Date.now() / 1000), limit: 20 });
      assert.equal(page.state, "page"); if (page.state !== "page") throw new Error("No page");
      assert.equal(page.items[0]!.reservationId, input.reservationId); assert.equal(page.items[0]!.recoverable, false);
    }, { active: true });
    for (const [stage, expected] of [[undefined, "provably_not_dispatched"], ["reserved", "dispatch_uncertain"], ["prepared", "dispatch_uncertain"],
      ["sent", "dispatched"], ["unknown", "outcome_unknown"], ["completed", "outcome_unknown"], ["success", "settled_successfully"],
      ["released", "settled_failure"], ["partial", "outcome_unknown"], ["accounted", "settled_failure"]] as const) {
      await scenario(`${stage ?? "not_sent"} has classification ${expected}`, async ({ input, recovery }) => {
        const before = await snapshot(db); const result = await classification(recovery, input.reservationId);
        assert.equal(result.classification, expected); assert.equal(result.recoverable, expected === "provably_not_dispatched");
        assert.deepEqual(await snapshot(db), before);
      }, stage ? { stage } : {});
    }
    await scenario("safe recovery advances fencing, atomically releases every link and preserves failed replay", async ({ input, common, recovery, store }) => {
      const before = await counters(db), ownerBefore = (await snapshot(db)).idempotency_records![0]!;
      const fence = await acquired(recovery, input);
      assert.equal(fence.generation, input.expectedGeneration + 1); assert.deepEqual(await counters(db), before);
      assert.equal((await classification(recovery, input.reservationId)).classification, "recovery_in_progress");
      assert.deepEqual(await recovery.release(fence), { state: "recorded", accounting: "released", retryable: false });
      assert.ok((await counters(db)).every(w => w.reserved_amount === 0 && w.consumed_amount === 2));
      const s = await snapshot(db); assert.equal(s.usage_accounting!.length, 0);
      assert.ok(s.reservation_quota_windows!.every(l => l.status === "released" && l.failure_basis === "proven_not_sent" && l.failure_held_amount === 0));
      const ownerAfter = s.idempotency_records![0]!;
      assert.equal(ownerAfter.owner_token_hash, ownerBefore.owner_token_hash); assert.equal(ownerAfter.lease_expires_at, ownerBefore.lease_expires_at);
      assert.equal(ownerAfter.payload_hash, ownerBefore.payload_hash);
      assert.equal((await store.claim(common.fence)).state, "failed");
      assert.equal((await classification(recovery, input.reservationId)).classification, "already_recovered");
      assert.ok(!JSON.stringify(s).includes(fence.token));
    });
    await scenario("a closed unmarked not_sent attempt can be queued and recovered", async ({ input, recovery }) => {
      const fence = await acquired(recovery, input); assert.equal((await recovery.release(fence)).state, "recorded");
      assert.equal((await db.prepare("SELECT reconciliation_state FROM request_reservations").first()).reconciliation_state, "awaiting");
    }, { stage: "unmarked_not_sent" });
    await scenario("old owner cannot account even if its old lease were extended externally", async ({ input, common, recovery }) => {
      await acquired(recovery, input);
      await db.prepare("UPDATE idempotency_records SET lease_expires_at = unixepoch() + 100").run();
      const before = await snapshot(db);
      assert.equal((await new D1FailureAccounting(db).record({ ...common, failure: { category: "PROVEN_PRE_DISPATCH_FAILURE", reason: "preparation_failed" } })).state, "stale_owner");
      assert.deepEqual(await snapshot(db), before);
    });
    for (const stage of ["reserved", "prepared", "sent", "unknown", "completed", "success", "released", "partial", "accounted"] as const) {
      await scenario(`${stage}: recovery cannot refund, overwrite evidence or redispatch`, async ({ input, common, recovery, store }) => {
        const before = await snapshot(db);
        // An unprepared reservation has no durable attempt matching the supplied ID.
        assert.equal((await recovery.claim(input)).state, stage === "reserved" ? "stale_owner" : "not_eligible");
        for (const method of ["authorizeDispatch", "dispatch", "complete", "failBeforeDispatch"] as const) assert.equal((await store[method](common.fence)).state, "stale_owner");
        assert.deepEqual(await snapshot(db), before);
      }, { stage });
    }
    await scenario("active owner remains in control even if reservation itself expired", async ({ input, recovery }) => {
      await db.prepare("UPDATE request_reservations SET expires_at = created_at").run(); const before = await snapshot(db);
      const result = await classification(recovery, input.reservationId); assert.equal(result.ownerActive, true); assert.equal(result.recoverable, false);
      assert.equal((await recovery.claim(input)).state, "not_eligible"); assert.deepEqual(await snapshot(db), before);
    }, { active: true });
    await scenario("identical recovery and release requests never refund twice", async ({ input, recovery }) => {
      const fence = await acquired(recovery, input); const claimed = await snapshot(db);
      assert.equal((await recovery.claim(input)).state, "already_claimed"); assert.deepEqual(await snapshot(db), claimed);
      assert.equal((await recovery.release(fence)).state, "recorded"); const after = await snapshot(db);
      assert.equal((await recovery.release(fence)).state, "already_recorded");
      assert.equal((await recovery.claim(input)).state, "already_recovered"); assert.deepEqual(await snapshot(db), after);
    });
    await scenario("20 simultaneous claim attempts return one exclusive capability", async ({ input, recovery }) => {
      const results = await Promise.all(Array.from({ length: 20 }, () => recovery.claim(input)));
      assert.equal(results.filter(r => r.state === "acquired").length, 1, JSON.stringify(results));
      assert.equal(results.filter(r => r.state === "already_claimed").length, 19);
      const winner = results.find(r => r.state === "acquired")!; assert.equal(winner.state, "acquired");
      if (winner.state !== "acquired") throw new Error("No winner");
      const releases = await Promise.all(Array.from({ length: 10 }, () => recovery.release(winner.fence)));
      assert.equal(releases.filter(r => r.state === "recorded").length, 1);
      assert.equal(releases.filter(r => r.state === "already_recorded").length, 9, JSON.stringify(releases));
      assert.ok((await counters(db)).every(w => w.reserved_amount === 0));
    });
    await scenario("different competing operation IDs cannot both acquire", async ({ input, recovery }) => {
      const results = await Promise.all([recovery.claim(input), recovery.claim({ ...input, operationId: crypto.randomUUID() })]);
      assert.equal(results.filter(r => r.state === "acquired").length, 1);
      assert.ok(results.some(r => ["conflict", "stale_owner"].includes(r.state)));
    });
    await scenario("one operation ID cannot claim two reservations or leave a partial fencing update", async ({ input, recovery }) => {
      await acquired(recovery, input);
      const other = await fixture(db), before = await snapshot(db);
      assert.equal((await recovery.claim({ ...other.input, operationId: input.operationId })).state, "conflict");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("changed quota links between inspection and claim roll back acquisition", async ({ input }) => {
      let boundary: Awaited<ReturnType<typeof snapshot>> | undefined;
      const sqlByStatement = new Map<D1Statement, string>();
      const raced: D1Binding = {
        prepare(sql) { const statement = db.prepare(sql); sqlByStatement.set(statement, sql); return statement; },
        async batch<T>(statements: D1Statement[]) {
          if (sqlByStatement.get(statements[1]!)?.includes("recovery_precondition_failed")) {
            await db.prepare("UPDATE reservation_quota_windows SET reserved_amount = reserved_amount + 1 WHERE quota_metric = 'tokens'").run();
            boundary = await snapshot(db);
          }
          return db.batch(statements) as Promise<D1QueryResult<T>[]>;
        },
      };
      assert.equal((await (await service(raced)).claim(input)).state, "stale_owner");
      assert.ok(boundary); assert.deepEqual(await snapshot(db), boundary);
    });
    await scenario("counter changes between inspection and refund cannot produce a negative or partial balance", async ({ input, recovery }) => {
      const fence = await acquired(recovery, input);
      let boundary: Awaited<ReturnType<typeof snapshot>> | undefined;
      const raced: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        if (statements.length > 4) {
          await db.prepare("UPDATE provider_quota_windows SET reserved_amount = 0 WHERE dimension = 'tokens'").run();
          boundary = await snapshot(db);
        }
        return db.batch(statements) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await (await service(raced)).release(fence)).state, "invalid_accounting");
      assert.ok(boundary); assert.deepEqual(await snapshot(db), boundary);
    });
    await scenario("wrong identities, stale generations and forged capabilities fail closed", async ({ input, recovery }) => {
      const before = await snapshot(db);
      for (const variant of [{ requestId: crypto.randomUUID() }, { attemptId: crypto.randomUUID() }, { expectedGeneration: input.expectedGeneration - 1 }]) {
        assert.equal((await recovery.claim({ ...input, ...variant })).state, "stale_owner");
      }
      assert.deepEqual(await snapshot(db), before);
      const fence = await acquired(recovery, input), claimed = await snapshot(db);
      for (const variant of [{ generation: fence.generation - 1 }, { claimId: crypto.randomUUID() }, { attemptId: crypto.randomUUID() },
        { token: "0".repeat(64) }, { operationId: crypto.randomUUID() }, { serviceId: "browser-supplied" }]) {
        assert.equal((await recovery.release({ ...fence, ...variant })).state, "stale_owner");
      }
      assert.deepEqual(await snapshot(db), claimed);
    });
    await scenario("authentication and browser-origin checks precede all database access", async () => {
      let reads = 0;
      const spy: D1Binding = { prepare() { reads++; throw new Error("unexpected DB access"); }, async batch() { reads++; throw new Error("unexpected DB access"); } };
      for (const headers of [{}, { Authorization: `Bearer ${"b".repeat(64)}` }, { Authorization: `Bearer ${secret}`, Origin: "https://browser.invalid" },
        { Authorization: `Bearer ${secret}`, "Sec-Fetch-Site": "same-origin" }]) {
        await assert.rejects(D1ReservationRecovery.authenticate(new Request("https://internal.invalid", { headers }),
          { COACH_SERVICE_SECRET: secret, COACH_DB: spy }, { leaseSeconds: 60 }));
      }
      assert.equal(reads, 0);
    });
    await scenario("authenticated service cannot inspect or recover another service's records", async ({ input, recovery }) => {
      assert.equal((await recovery.inspect(input.reservationId)).state, "not_found");
      assert.equal((await recovery.claim(input)).state, "not_found");
      const page = await recovery.discover({ basis: "reservation_expiry", from: 0, through: Math.floor(Date.now() / 1000), limit: 20 });
      assert.equal(page.state, "page"); if (page.state === "page") assert.equal(page.items.length, 0);
    }, { serviceId: "another-service" });
    await scenario("expired recovery lease requires explicit same-operation reacquisition with a newer fence", async ({ input, recovery }) => {
      const old = await acquired(recovery, input);
      await db.prepare("UPDATE request_reservations SET recovery_lease_expires_at = recovery_started_at").run();
      assert.equal((await recovery.release(old)).state, "stale_owner");
      assert.equal((await recovery.claim(input)).state, "stale_owner");
      const latest = await acquired(recovery, { ...input, expectedGeneration: old.generation });
      assert.equal(latest.generation, old.generation + 1); assert.notEqual(latest.token, old.token);
      assert.equal((await recovery.release(old)).state, "stale_owner");
      assert.equal((await recovery.release(latest)).state, "recorded");
    });
    await scenario("different operation cannot replace an expired claim", async ({ input, recovery }) => {
      const fence = await acquired(recovery, input);
      await db.prepare("UPDATE request_reservations SET recovery_lease_expires_at = recovery_started_at").run();
      const before = await snapshot(db);
      assert.equal((await recovery.claim({ ...input, expectedGeneration: fence.generation, operationId: crypto.randomUUID() })).state, "conflict");
      assert.deepEqual(await snapshot(db), before);
    });
    await scenario("lost claim acknowledgement permits inspection without recovering the capability", async ({ input, recovery }) => {
      const uncertain: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        const results = await db.batch(statements);
        if (statements.length === 4 && results[0].meta.changes === 1) throw new Error("Lost claim acknowledgement");
        return results as D1QueryResult<T>[];
      } };
      assert.equal((await (await service(uncertain)).claim(input)).state, "storage_unavailable");
      const before = await snapshot(db); const found = await classification(recovery, input.reservationId);
      assert.equal(found.classification, "recovery_in_progress"); assert.equal(found.operationId, input.operationId);
      const again = await recovery.claim(input); assert.equal(again.state, "already_claimed"); assert.ok(!("fence" in again));
      assert.deepEqual(await snapshot(db), before);
      await db.prepare("UPDATE request_reservations SET recovery_lease_expires_at = recovery_started_at").run();
      const next = await acquired(recovery, { ...input, expectedGeneration: found.generation! });
      assert.equal((await recovery.release(next)).state, "recorded");
    });
    await scenario("lost refund acknowledgement is resolved from the committed receipt", async ({ input, recovery }) => {
      const fence = await acquired(recovery, input);
      const uncertain: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        const results = await db.batch(statements); if (statements.length > 4) throw new Error("Lost release acknowledgement"); return results as D1QueryResult<T>[];
      } };
      assert.equal((await (await service(uncertain)).release(fence)).state, "storage_unavailable");
      const before = await snapshot(db); assert.equal((await classification(recovery, input.reservationId)).classification, "already_recovered");
      assert.equal((await recovery.release(fence)).state, "already_recorded"); assert.deepEqual(await snapshot(db), before);
    });
    for (const index of [0, 2]) await scenario(`zero-row acquisition statement ${index} rolls back the fencing change`, async ({ input }) => {
      const before = await snapshot(db);
      const broken: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        const actual = [...statements];
        // Read snapshots also have four statements; writes contain assertion SELECTs.
        const results = await db.batch(actual.length === 4 && statementSql.get(actual[1]!)?.includes("recovery_precondition_failed")
          ? actual.map((s, i) => i === index ? db.prepare("UPDATE request_reservations SET status = 'not_sent' WHERE 0") : s) : actual);
        return results as D1QueryResult<T>[];
      } };
      const statementSql = new Map<D1Statement, string>();
      broken.prepare = sql => { const s = db.prepare(sql); statementSql.set(s, sql); return s; };
      assert.equal((await (await service(broken)).claim(input)).state, "stale_owner"); assert.deepEqual(await snapshot(db), before);
    });
    for (const index of [0, 2, 4, 6, 8, 10, 12, 14, 16]) await scenario(`zero-row release statement ${index} leaves no partial refund`, async ({ input, recovery }) => {
      const fence = await acquired(recovery, input), before = await snapshot(db);
      const broken: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        const actual = [...statements]; if (actual.length > 4) actual[index] = db.prepare("UPDATE inference_attempts SET status = 'not_sent' WHERE 0");
        return db.batch(actual) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await (await service(broken)).release(fence)).state, "invalid_accounting"); assert.deepEqual(await snapshot(db), before);
    });
    for (const [name, sql] of [
      ["underfunded counter", "UPDATE provider_quota_windows SET reserved_amount = 0 WHERE dimension = 'tokens'"],
      ["unsafe counter", "UPDATE provider_quota_windows SET reserved_amount = 9007199254740992 WHERE dimension = 'tokens'"],
      ["fractional counter", "UPDATE provider_quota_windows SET consumed_amount = 1.5 WHERE dimension = 'tokens'"],
      ["legacy token metric", "UPDATE reservation_quota_windows SET quota_metric = NULL WHERE quota_metric = 'tokens'"],
      ["mismatched state", "UPDATE request_reservations SET status = 'sent'"],
      ["partial failure receipt", "UPDATE inference_attempts SET failure_category = 'PROVEN_PRE_DISPATCH_FAILURE'"],
      ["missing ownership", "DELETE FROM idempotency_records"],
    ]) await scenario(`${name} is classified for review without silent repair`, async ({ input, recovery }) => {
      await db.prepare(sql!).run(); const before = await snapshot(db);
      const item = await classification(recovery, input.reservationId); assert.equal(item.classification, "inconsistent_record"); assert.equal(item.manualReview, true);
      assert.notEqual((await recovery.claim(input)).state, "acquired"); assert.deepEqual(await snapshot(db), before);
    });
    await scenario("fencing integer overflow cannot acquire recovery", async ({ input, recovery }) => {
      await db.prepare("UPDATE idempotency_records SET generation = ?").bind(Number.MAX_SAFE_INTEGER).run();
      const before = await snapshot(db);
      assert.equal((await recovery.claim({ ...input, expectedGeneration: Number.MAX_SAFE_INTEGER })).state, "invalid_request");
      assert.equal((await classification(recovery, input.reservationId)).recoverable, false); assert.deepEqual(await snapshot(db), before);
    });
    await scenario("safe integer counters at the boundary can be released exactly", async ({ input, recovery }) => {
      await db.prepare("UPDATE provider_quota_windows SET consumed_amount = ?").bind(Number.MAX_SAFE_INTEGER).run();
      const fence = await acquired(recovery, input); assert.equal((await recovery.release(fence)).state, "recorded");
      assert.ok((await counters(db)).every(w => w.consumed_amount === Number.MAX_SAFE_INTEGER && w.reserved_amount === 0));
    });
    await scenario("receipt contents are checked, not just the presence of a hash", async ({ input, recovery }) => {
      await db.prepare("UPDATE usage_accounting SET request_count = 2").run(); const before = await snapshot(db);
      assert.equal((await classification(recovery, input.reservationId)).classification, "inconsistent_record");
      assert.equal((await recovery.claim(input)).state, "not_eligible"); assert.deepEqual(await snapshot(db), before);
    }, { stage: "success" });
    await scenario("modified failure receipt is never treated as proof of a refund", async ({ input, recovery }) => {
      await db.prepare("UPDATE inference_attempts SET failure_receipt_hash = ?").bind("0".repeat(64)).run();
      const before = await snapshot(db); assert.equal((await classification(recovery, input.reservationId)).classification, "inconsistent_record");
      assert.equal((await recovery.claim(input)).state, "not_eligible"); assert.deepEqual(await snapshot(db), before);
    }, { stage: "released" });
    await scenario("bounded keyset pagination visits each stale row once, including tied timestamps", async ({ input, recovery }) => {
      const ids = [input.reservationId]; for (let i = 0; i < 4; i++) ids.push((await fixture(db)).input.reservationId);
      const before = await snapshot(db);
      for (const basis of ["reservation_expiry", "owner_lease"] as const) {
        const seen: string[] = []; let cursor: RecoveryScan["cursor"];
        do {
          const page = await recovery.discover({ basis, from: 0, through: Math.floor(Date.now() / 1000), limit: 2, ...(cursor ? { cursor } : {}) });
          assert.equal(page.state, "page"); if (page.state !== "page") throw new Error("No page");
          assert.ok(page.items.length <= 2); seen.push(...page.items.map(i => i.reservationId)); cursor = page.nextCursor ?? undefined;
        } while (cursor);
        assert.deepEqual(seen.sort(), [...ids].sort());
      }
      assert.deepEqual(await snapshot(db), before);
      const queryPlan = await db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM request_reservations INDEXED BY reservations_recovery_scan
        WHERE service_id = 'streamlit' AND expires_at BETWEEN 0 AND unixepoch() ORDER BY expires_at, id LIMIT 3`).all();
      assert.match(JSON.stringify(queryPlan.results), /reservations_recovery_scan/);
    });
    await scenario("invalid bounds, future cutoff and excessive page sizes fail closed", async ({ recovery }) => {
      const base: RecoveryScan = { basis: "reservation_expiry", from: 0, through: Math.floor(Date.now() / 1000), limit: 2 };
      for (const variant of [{ limit: 0 }, { limit: 21 }, { limit: 1.5 }, { from: -1 }, { from: base.through + 1 },
        { through: Number.MAX_SAFE_INTEGER }, { cursor: { time: -1, id: "bad" } }]) assert.equal((await recovery.discover({ ...base, ...variant })).state, "invalid_request");
    });
    await scenario("database unavailable and unexpected claim acknowledgement grant no capability", async ({ input }) => {
      const unavailable = await service(undefined); assert.equal((await unavailable.claim(input)).state, "storage_unavailable");
      assert.equal((await unavailable.inspect(input.reservationId)).state, "storage_unavailable");
      const broken: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        const results = await db.batch(statements); if (results[0]?.meta.changes === 1) results[0].meta.changes = 0; return results as D1QueryResult<T>[];
      } };
      const result = await (await service(broken)).claim(input); assert.equal(result.state, "storage_unavailable"); assert.ok(!("fence" in result));
    });
    await scenario("recovery does not expose owner hashes, raw capabilities or private content", async ({ input, recovery }) => {
      const fence = await acquired(recovery, input); await recovery.release(fence);
      const inspection = JSON.stringify(await recovery.inspect(input.reservationId)); const s = await snapshot(db);
      assert.ok(!inspection.includes(fence.token)); assert.ok(!inspection.includes(String(s.idempotency_records![0]!.payload_hash)));
      assert.ok(!JSON.stringify(s).includes(fence.token)); assert.ok(!JSON.stringify(s).includes(secret));
      assert.equal(s.inference_attempts!.length, 1); assert.equal(s.usage_accounting!.length, 0);
    });
    await scenario("released capacity is available only to a distinct admitted request", async ({ input, common, recovery, admission, store, estimate }) => {
      const fence = await acquired(recovery, input); await recovery.release(fence);
      assert.equal((await store.claim(common.fence)).state, "failed");
      assert.equal((await admission.reserve({ serviceId: "streamlit", requestId: input.requestId, provider: common.provider, model: common.model, estimate })).admitted, false);
      assert.equal((await admission.reserve({ serviceId: "streamlit", requestId: crypto.randomUUID(), provider: common.provider, model: common.model, estimate })).admitted, true);
    });
  } finally { await mf.dispose(); }
});

test("recovery authority and completed receipts survive Worker restart", { timeout: 60_000 }, async () => {
  await mkdir(new URL("../.wrangler/recovery-tests/", import.meta.url), { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL("../.wrangler/recovery-tests/restart-", import.meta.url)));
  let mf = runtime(directory);
  try {
    let db = await mf.getD1Database("COACH_DB"); await migrate(db); const { input, recovery } = await fixture(db);
    const fence = await acquired(recovery, input);
    await mf.dispose(); mf = runtime(directory); db = await mf.getD1Database("COACH_DB");
    assert.equal((await (await service(db)).release(fence)).state, "recorded"); const before = await snapshot(db);
    await mf.dispose(); mf = runtime(directory); db = await mf.getD1Database("COACH_DB");
    const restarted = await service(db); assert.equal((await restarted.release(fence)).state, "already_recorded");
    assert.equal((await classification(restarted, input.reservationId)).classification, "already_recovered"); assert.deepEqual(await snapshot(db), before);
  } finally { await mf.dispose(); }
});

test("migration 0008 adds metadata and indexes without altering prior receipts or counters", { timeout: 30_000 }, async () => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db, files.filter(n => n < "0008"));
    await fixture(db, { stage: "success", legacyDispatchFixture: true }); await fixture(db, { stage: "released" });
    const before = await snapshot(db); await migrate(db, files.filter(n => n.startsWith("0008"))); const after = await snapshot(db);
    for (const table of tables) for (const [index, old] of before[table]!.entries()) {
      for (const key of Object.keys(old)) assert.deepEqual(after[table]![index]![key], old[key], `${table}.${key}`);
    }
    for (const r of after.request_reservations!) assert.equal(r.recovery_operation_id, null);
    await assert.rejects(db.prepare("UPDATE request_reservations SET recovery_completed_at = updated_at").run(), /constraint/i);
    await assert.rejects(db.prepare("UPDATE request_reservations SET recovery_generation = 0").run(), /constraint/i);
  } finally { await mf.dispose(); }
});
