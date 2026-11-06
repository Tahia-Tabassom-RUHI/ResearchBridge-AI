import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { IdempotencyFence, RequestIdentity, TransitionDecision } from "../src/storage";
import { D1IdempotencyStore } from "../src/storage/d1-idempotency";
import { D1QuotaAdmission, type D1Binding, type D1QueryResult, type D1Statement } from "../src/storage/d1-quota-admission";
import { sha256 } from "../src/storage/request-identity";

type DB = Awaited<ReturnType<Miniflare["getD1Database"]>>;
const policy = { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 7200 };
const methods = ["authorizeDispatch", "dispatch", "complete", "failBeforeDispatch", "markUnknown", "awaitReconciliation"] as const;
const files = (await readdir(new URL("../migrations/", import.meta.url))).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort();
const runtime = (directory?: string) => new Miniflare(convertV4MiniflareOptions({
  modules: true, script: "export default { fetch() { return new Response('local lifecycle tests'); } };",
  compatibilityDate: "2026-11-03", cf: false, telemetry: { enabled: false }, d1Databases: { COACH_DB: "lifecycle-tests" },
  ...(directory ? { resourcePersistencePath: directory } : {}),
  outboundService: () => { throw new Error("External networking is forbidden in lifecycle tests"); },
}));
async function migrate(db: DB, names = files) {
  for (const name of names) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    for (const statement of sql.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
}
async function identity(): Promise<RequestIdentity> {
  return { serviceId: "streamlit", keyHash: await sha256(crypto.randomUUID()), payloadHash: await sha256("validated-lifecycle-fixture"),
    fingerprintKeyId: await sha256("local-test-key-identifier"), responseVersion: "2" };
}
async function claim(store: D1IdempotencyStore) {
  const result = await store.claim(await identity());
  assert.equal(result.state, "acquired");
  if (result.state !== "acquired") throw new Error("Claim unavailable");
  return result.fence;
}
function updated(result: TransitionDecision): IdempotencyFence {
  assert.equal(result.state, "updated", JSON.stringify(result));
  if (result.state !== "updated") throw new Error("Transition rejected");
  return result.fence;
}
async function fixture(db: DB) {
  const start = Math.floor(Date.now() / 1000) - 10;
  for (const [id, seconds] of [["rpm", 60], ["rpd", 86400]] as const) {
    await db.prepare(`INSERT INTO provider_quota_windows (id, quota_scope_id, provider, model, dimension, unit,
      window_start, window_seconds, window_end, limit_amount, consumed_amount, created_at, updated_at, retain_until)
      VALUES (?, 'local-account', 'mock', 'mock-model', 'requests', 'requests', ?, ?, ?, 10, 1, ?, ?, ?)`)
      .bind(id, start, seconds, start + seconds, start, start, start + seconds + 10000).run();
  }
  const store = new D1IdempotencyStore(db, policy);
  const initial = await claim(store);
  const admission = new D1QuotaAdmission(db, [{ provider: "mock", model: "mock-model", quotaScopeId: "local-account",
    leaseSeconds: 120, retentionSeconds: 7200, windows: [60, 86400].map(seconds => ({ windowId: seconds === 60 ? "rpm" : "rpd",
      model: "mock-model", metric: "requests", unit: "requests", windowStart: start, windowSeconds: seconds, capacity: 10, safetyMargin: 0 })) }]);
  const result = await admission.reserve({ serviceId: initial.serviceId, requestId: initial.claimId, provider: "mock", model: "mock-model",
    estimate: { kind: "estimated" }, claim: initial });
  assert.ok(result.admitted);
  return { store, fence: { ...initial, generation: initial.generation + 1 } };
}
async function quotaSnapshot(db: DB) {
  return {
    windows: (await db.prepare("SELECT * FROM provider_quota_windows ORDER BY id").all()).results,
    links: (await db.prepare("SELECT * FROM reservation_quota_windows ORDER BY reservation_id, quota_window_id").all()).results,
    usage: (await db.prepare("SELECT * FROM usage_accounting ORDER BY id").all()).results,
  };
}
async function lifecycleSnapshot(db: DB) {
  return {
    claims: (await db.prepare("SELECT * FROM idempotency_records ORDER BY id").all()).results,
    reservations: (await db.prepare("SELECT * FROM request_reservations ORDER BY id").all()).results,
    attempts: (await db.prepare("SELECT * FROM inference_attempts ORDER BY id").all()).results,
  };
}
async function outcome(db: DB, request: string, reservation: string, attempt: string | null) {
  assert.equal((await db.prepare("SELECT processing_state FROM idempotency_records").first()).processing_state, request);
  assert.equal((await db.prepare("SELECT status FROM request_reservations").first()).status, reservation);
  const rows = (await db.prepare("SELECT * FROM inference_attempts").all()).results;
  assert.equal(rows.length, attempt === null ? 0 : 1);
  if (attempt !== null) assert.equal(rows[0].status, attempt);
}
const sent = async (store: D1IdempotencyStore, fence: IdempotencyFence) => updated(await store.dispatch(updated(await store.authorizeDispatch(fence))));

test("reservation lifecycle on real local D1 without quota mutation", { timeout: 120_000 }, async t => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const scenario = (name: string, run: (store: D1IdempotencyStore, fence: IdempotencyFence) => Promise<void>) => t.test(name, async () => {
      await db.batch(["idempotency_records", "inference_attempts", "reservation_quota_windows", "request_reservations", "provider_quota_windows"].map(n => db.prepare(`DELETE FROM ${n}`)));
      const { store, fence } = await fixture(db);
      const before = await quotaSnapshot(db);
      await run(store, fence);
      assert.deepEqual(await quotaSnapshot(db), before, "Lifecycle changed quota windows, dimension links or usage accounting");
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });

    await scenario("reserved -> authorized -> potentially dispatched -> completed -> awaiting reconciliation", async (store, fence) => {
      await outcome(db, "reserved", "reserved", null);
      const quota = await quotaSnapshot(db);
      const authorized = updated(await store.authorizeDispatch(fence));
      assert.equal(authorized.generation, 3);
      await outcome(db, "reserved", "reserved", "prepared");
      assert.equal((await db.prepare("SELECT sent_at FROM inference_attempts").first()).sent_at, null);
      assert.deepEqual(await quotaSnapshot(db), quota);
      const dispatched = updated(await store.dispatch(authorized));
      await outcome(db, "dispatched", "sent", "sent");
      assert.notEqual((await db.prepare("SELECT sent_at FROM inference_attempts").first()).sent_at, null);
      assert.deepEqual(await quotaSnapshot(db), quota);
      const completed = updated(await store.complete(dispatched));
      await outcome(db, "completed", "completed", "completed");
      const finished = await db.prepare("SELECT * FROM inference_attempts").first();
      assert.ok(finished.finished_at >= finished.sent_at);
      assert.deepEqual(await quotaSnapshot(db), quota);
      const awaiting = updated(await store.awaitReconciliation(completed));
      assert.equal(awaiting.generation, 6);
      await outcome(db, "completed", "completed", "completed");
      const reservation = await db.prepare("SELECT * FROM request_reservations").first();
      assert.equal(reservation.reconciliation_state, "awaiting");
      assert.ok(reservation.reconciliation_requested_at >= reservation.created_at);
      assert.deepEqual(await db.prepare("SELECT * FROM inference_attempts").first(), finished);
    });

    await scenario("failure before authorization creates a not_sent terminal attempt", async (store, fence) => {
      const failed = updated(await store.failBeforeDispatch(fence));
      await outcome(db, "failed", "not_sent", "not_sent");
      const attempt = await db.prepare("SELECT * FROM inference_attempts").first();
      assert.equal(attempt.sent_at, null); assert.notEqual(attempt.finished_at, null);
      updated(await store.awaitReconciliation(failed));
      await outcome(db, "failed", "not_sent", "not_sent");
    });

    await scenario("failure after authorization closes the same prepared attempt without dispatch", async (store, fence) => {
      const authorized = updated(await store.authorizeDispatch(fence));
      const id = (await db.prepare("SELECT id FROM inference_attempts").first()).id;
      const failed = updated(await store.failBeforeDispatch(authorized));
      await outcome(db, "failed", "not_sent", "not_sent");
      assert.equal((await db.prepare("SELECT id FROM inference_attempts").first()).id, id);
      updated(await store.awaitReconciliation(failed));
    });

    await scenario("unknown dispatch outcome preserves unknown when queued for reconciliation", async (store, fence) => {
      const dispatched = await sent(store, fence);
      const unknown = updated(await store.markUnknown(dispatched));
      await outcome(db, "outcome_unknown", "unknown", "unknown");
      assert.equal((await store.complete(unknown)).state, "stale_owner");
      updated(await store.awaitReconciliation(unknown));
      await outcome(db, "outcome_unknown", "unknown", "unknown");
    });

    await scenario("dispatch requires prior durable authorization", async (store, fence) => {
      const before = await lifecycleSnapshot(db);
      for (const method of ["dispatch", "complete", "markUnknown", "awaitReconciliation"] as const) {
        assert.equal((await store[method](fence)).state, "stale_owner");
        assert.deepEqual(await lifecycleSnapshot(db), before);
      }
    });

    await scenario("pending unadmitted claim cannot authorize or dispatch; failure has no reservation side effects", async (store) => {
      const pending = await claim(store);
      for (const method of ["authorizeDispatch", "dispatch", "complete", "markUnknown", "awaitReconciliation"] as const) {
        assert.equal((await store[method](pending)).state, "stale_owner");
      }
      const failed = updated(await store.failBeforeDispatch(pending));
      assert.equal((await store.lookup(failed)).state, "failed");
      assert.equal((await store.awaitReconciliation(failed)).state, "stale_owner");
      assert.equal((await db.prepare("SELECT count(*) AS n FROM request_reservations").first()).n, 1);
    });

    await scenario("duplicate authorization cannot create another attempt even with the new revision", async (store, fence) => {
      const authorized = updated(await store.authorizeDispatch(fence));
      const before = await lifecycleSnapshot(db);
      assert.equal((await store.authorizeDispatch(fence)).state, "stale_owner");
      assert.equal((await store.authorizeDispatch(authorized)).state, "stale_owner");
      assert.deepEqual(await lifecycleSnapshot(db), before);
    });

    await scenario("stale generations cannot dispatch or complete a newer lifecycle", async (store, fence) => {
      const authorized = updated(await store.authorizeDispatch(fence));
      for (const method of methods) assert.equal((await store[method](fence)).state, "stale_owner");
      const dispatched = updated(await store.dispatch(authorized));
      for (const method of methods) assert.equal((await store[method](authorized)).state, "stale_owner");
      updated(await store.complete(dispatched));
    });

    for (const terminal of ["complete", "failBeforeDispatch", "markUnknown"] as const) {
      await scenario(`${terminal}: terminal outcome cannot be reopened, including after reconciliation marking`, async (store, fence) => {
        const ending = terminal === "failBeforeDispatch" ? fence : await sent(store, fence);
        const closed = updated(await store[terminal](ending));
        const before = await lifecycleSnapshot(db);
        for (const method of methods.filter(m => m !== "awaitReconciliation")) assert.equal((await store[method](closed)).state, "stale_owner");
        assert.deepEqual(await lifecycleSnapshot(db), before);
        const awaiting = updated(await store.awaitReconciliation(closed));
        const after = await lifecycleSnapshot(db);
        for (const method of methods) {
          assert.equal((await store[method](closed)).state, "stale_owner");
          assert.equal((await store[method](awaiting)).state, "stale_owner");
        }
        assert.deepEqual(await lifecycleSnapshot(db), after);
      });
    }

    await scenario("wrong service, capability, payload, key or response version is unauthorized", async (store, fence) => {
      const before = await lifecycleSnapshot(db);
      const variants = [{ serviceId: "another-service" }, { token: "0".repeat(64) }, { payloadHash: "0".repeat(64) },
        { keyHash: "0".repeat(64) }, { fingerprintKeyId: "0".repeat(64) }, { responseVersion: "1" as const }, { claimId: crypto.randomUUID() }];
      for (const variant of variants) for (const method of methods) assert.equal((await store[method]({ ...fence, ...variant })).state, "stale_owner");
      assert.deepEqual(await lifecycleSnapshot(db), before);
    });

    await scenario("invalid fencing integers fail closed before writes", async (store, fence) => {
      const before = await lifecycleSnapshot(db);
      for (const generation of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal((await store.authorizeDispatch({ ...fence, generation })).state, "stale_owner");
      }
      assert.deepEqual(await lifecycleSnapshot(db), before);
    });

    await scenario("another claim cannot borrow an existing reservation", async (store, fence) => {
      const other = await claim(store);
      const r = (await db.prepare("SELECT reservation_id FROM idempotency_records WHERE id = ?").bind(fence.claimId).first()).reservation_id;
      await db.prepare("UPDATE idempotency_records SET reservation_id = NULL WHERE id = ?").bind(fence.claimId).run();
      await db.prepare("UPDATE idempotency_records SET processing_state = 'reserved', reservation_id = ? WHERE id = ?").bind(r, other.claimId).run();
      const before = await lifecycleSnapshot(db);
      assert.equal((await store.authorizeDispatch(other)).state, "stale_owner");
      assert.deepEqual(await lifecycleSnapshot(db), before);
    });

    await scenario("expired claim lease and quota reservation cannot authorize dispatch", async (store, fence) => {
      const authorized = updated(await store.authorizeDispatch(fence));
      await db.prepare("UPDATE request_reservations SET expires_at = created_at").run();
      const before = await lifecycleSnapshot(db);
      assert.equal((await store.dispatch(authorized)).state, "stale_owner");
      assert.deepEqual(await lifecycleSnapshot(db), before);
      await db.prepare("UPDATE idempotency_records SET lease_expires_at = created_at").run();
      const expired = await lifecycleSnapshot(db);
      for (const method of methods) assert.equal((await store[method](authorized)).state, "stale_owner");
      assert.deepEqual(await lifecycleSnapshot(db), expired);
    });

    await scenario("20 concurrent authorizations create one prepared attempt", async (store, fence) => {
      const results = await Promise.all(Array.from({ length: 20 }, () => store.authorizeDispatch(fence)));
      assert.equal(results.filter(r => r.state === "updated").length, 1);
      assert.equal(results.filter(r => r.state === "stale_owner").length, 19);
      await outcome(db, "reserved", "reserved", "prepared");
    });

    await scenario("authorization and pre-dispatch failure compete for one revision", async (store, fence) => {
      const results = await Promise.all([store.authorizeDispatch(fence), store.failBeforeDispatch(fence)]);
      assert.equal(results.filter(r => r.state === "updated").length, 1);
      assert.equal(results.filter(r => r.state === "stale_owner").length, 1);
      const phase = (await store.lookup(fence)).state;
      await outcome(db, phase, phase === "reserved" ? "reserved" : "not_sent", phase === "reserved" ? "prepared" : "not_sent");
    });

    await scenario("dispatch and failure cannot both win after authorization", async (store, fence) => {
      const authorized = updated(await store.authorizeDispatch(fence));
      const results = await Promise.all([store.dispatch(authorized), store.failBeforeDispatch(authorized)]);
      assert.equal(results.filter(r => r.state === "updated").length, 1);
      assert.equal(results.filter(r => r.state === "stale_owner").length, 1);
      const phase = (await store.lookup(fence)).state;
      await outcome(db, phase, phase === "dispatched" ? "sent" : "not_sent", phase === "dispatched" ? "sent" : "not_sent");
    });

    await scenario("completion and unknown outcome cannot both overwrite a dispatch", async (store, fence) => {
      const dispatched = await sent(store, fence);
      const results = await Promise.all([store.complete(dispatched), store.markUnknown(dispatched)]);
      assert.equal(results.filter(r => r.state === "updated").length, 1);
      assert.equal(results.filter(r => r.state === "stale_owner").length, 1);
      const phase = (await store.lookup(fence)).state;
      await outcome(db, phase, phase === "completed" ? "completed" : "unknown", phase === "completed" ? "completed" : "unknown");
    });

    await scenario("database unavailable denies every lifecycle operation without exposing details", async (_store, fence) => {
      const broken: D1Binding = { prepare() { throw new Error("private database detail"); }, async batch() { throw new Error("unavailable"); } };
      for (const dbBinding of [undefined, broken]) {
        const unavailable = new D1IdempotencyStore(dbBinding, policy);
        for (const method of methods) assert.deepEqual(await unavailable[method](fence), { state: "storage_unavailable", retryable: false });
      }
    });

    await scenario("a later zero-row attempt update rolls back prior claim and reservation writes", async (store, fence) => {
      const authorized = updated(await store.authorizeDispatch(fence));
      const before = await lifecycleSnapshot(db);
      const broken: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        const actual = [...statements];
        actual[4] = db.prepare("UPDATE inference_attempts SET status = 'sent' WHERE 0");
        return db.batch(actual) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await new D1IdempotencyStore(broken, policy).dispatch(authorized)).state, "stale_owner");
      assert.deepEqual(await lifecycleSnapshot(db), before);
    });

    await scenario("a late SQL constraint failure rolls back terminal outcome changes", async (store, fence) => {
      const dispatched = await sent(store, fence);
      const before = await lifecycleSnapshot(db);
      const broken: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        return db.batch([...statements, db.prepare("UPDATE idempotency_records SET transition_check = 0")]) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await new D1IdempotencyStore(broken, policy).complete(dispatched)).state, "stale_owner");
      assert.deepEqual(await lifecycleSnapshot(db), before);
    });

    await scenario("lost acknowledgement keeps durable authorization but grants no new capability", async (store, fence) => {
      const uncertain: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        await db.batch(statements); throw new Error("Acknowledgement lost after commit");
      } };
      assert.equal((await new D1IdempotencyStore(uncertain, policy).authorizeDispatch(fence)).state, "storage_unavailable");
      assert.equal((await store.authorizeDispatch(fence)).state, "stale_owner");
      assert.equal((await store.dispatch(fence)).state, "stale_owner");
      await outcome(db, "reserved", "reserved", "prepared");
    });

    await scenario("unexpected affected-row acknowledgement fails closed after a commit", async (_store, fence) => {
      const uncertain: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        const results = await db.batch(statements); results[1].meta.changes = 0;
        return results as D1QueryResult<T>[];
      } };
      assert.equal((await new D1IdempotencyStore(uncertain, policy).authorizeDispatch(fence)).state, "storage_unavailable");
      await outcome(db, "reserved", "reserved", "prepared");
    });

    await scenario("legacy inconsistent terminal records are not silently repaired or reopened", async (store, fence) => {
      const closed = updated(await store.complete(await sent(store, fence)));
      await db.prepare("UPDATE request_reservations SET status = 'sent'").run();
      const before = await lifecycleSnapshot(db);
      for (const method of methods) assert.equal((await store[method](closed)).state, "stale_owner");
      assert.deepEqual(await lifecycleSnapshot(db), before);
    });
  } finally { await mf.dispose(); }
});

test("lifecycle terminal state and fences survive local Worker restart", { timeout: 45_000 }, async () => {
  await mkdir(new URL("../.wrangler/lifecycle-tests/", import.meta.url), { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL("../.wrangler/lifecycle-tests/restart-", import.meta.url)));
  let mf = runtime(directory);
  try {
    let db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const { store, fence } = await fixture(db);
    const dispatched = await sent(store, fence);
    const completed = updated(await store.complete(dispatched));
    const before = await lifecycleSnapshot(db), quota = await quotaSnapshot(db);
    await mf.dispose(); mf = runtime(directory); db = await mf.getD1Database("COACH_DB");
    const restarted = new D1IdempotencyStore(db, policy);
    assert.equal((await restarted.lookup(completed)).state, "completed");
    assert.equal((await restarted.complete(dispatched)).state, "stale_owner");
    assert.deepEqual(await lifecycleSnapshot(db), before);
    updated(await restarted.awaitReconciliation(completed));
    await outcome(db, "completed", "completed", "completed");
    assert.deepEqual(await quotaSnapshot(db), quota);
  } finally { await mf.dispose(); }
});

test("migration 0005 preserves prior reservation data and counters", { timeout: 30_000 }, async () => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB");
    await migrate(db, files.filter(n => n < "0005"));
    await fixture(db);
    const before = await lifecycleSnapshot(db), quota = await quotaSnapshot(db);
    await migrate(db, files.filter(n => n.startsWith("0005")));
    const after = await lifecycleSnapshot(db);
    assert.deepEqual(after.claims, before.claims); assert.deepEqual(after.attempts, before.attempts);
    const { reconciliation_state, reconciliation_requested_at, ...old } = after.reservations[0];
    assert.equal(reconciliation_state, "not_requested"); assert.equal(reconciliation_requested_at, null);
    assert.deepEqual(old, before.reservations[0]); assert.deepEqual(await quotaSnapshot(db), quota);
  } finally { await mf.dispose(); }
});
