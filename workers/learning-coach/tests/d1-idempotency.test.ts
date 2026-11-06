import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { authenticate } from "../src/auth";
import { validateRequest, sourceText } from "../src/contracts/index";
import type { ValidatedTask } from "../src/contracts/types";
import { createGateway } from "../src/handlers/gateway";
import { LocalMockProvider, MockSourceResolver } from "../src/providers/mock";
import { D1QuotaAdmission, type D1Binding, type D1Statement, type D1QueryResult } from "../src/storage/d1-quota-admission";
import { D1IdempotencyStore } from "../src/storage/d1-idempotency";
import { DurableRequests } from "../src/storage/durable-requests";
import { canonicalJson, identifyRequest } from "../src/storage/request-identity";
import type { ClaimDecision, IdempotencyFence, QuotaAdmissionPolicy, TransitionDecision } from "../src/storage";
import { fixture } from "./fixtures";

type DB = Awaited<ReturnType<Miniflare["getD1Database"]>>;
const secret = "a".repeat(64);
const authSecret = "b".repeat(64);
const principal = { serviceId: "streamlit" } as const;
const retention = { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 7200 };
const files = (await readdir(new URL("../migrations/", import.meta.url))).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort();
const makeRuntime = (state?: string, script = "export default { fetch() { return new Response('local idempotency tests'); } };") =>
  new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: "2026-11-03", cf: false,
    telemetry: { enabled: false }, d1Databases: { COACH_DB: "idempotency-tests" },
    bindings: { COACH_SERVICE_SECRET: authSecret }, ...(state ? { resourcePersistencePath: state } : {}),
    outboundService: () => { throw new Error("External networking is forbidden in idempotency tests"); },
  }));
async function migrate(db: DB, names = files) {
  for (const name of names) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    for (const statement of sql.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
}
const uuid = () => crypto.randomUUID();
function task(term = "classification"): ValidatedTask {
  const request = validateRequest({ contract_version: "2", task_id: "term_clarification", input: { term } });
  return { request, source: sourceText(request), responseVersion: "2" };
}
async function seed(db: DB, capacity = 10): Promise<QuotaAdmissionPolicy> {
  const start = Math.floor(Date.now() / 1000) - 10;
  await db.prepare(`INSERT INTO provider_quota_windows (id, quota_scope_id, provider, model, dimension, unit,
    window_seconds, window_start, window_end, limit_amount, created_at, updated_at, retain_until)
    VALUES ('rpm', 'local-account', 'mock', 'mock-model', 'requests', 'requests', 3600, ?, ?, ?, ?, ?, ?)`)
    .bind(start, start + 3600, capacity, start, start, start + 10000).run();
  return { provider: "mock", model: "mock-model", quotaScopeId: "local-account", leaseSeconds: 120, retentionSeconds: 7200,
    windows: [{ windowId: "rpm", model: "mock-model", metric: "requests", unit: "requests", capacity, safetyMargin: 0,
      windowStart: start, windowSeconds: 3600 }] };
}
const plan = () => ({ provider: "mock", model: "mock-model", estimate: { kind: "estimated" as const } });
function services(db: D1Binding | undefined, policy: QuotaAdmissionPolicy) {
  const store = new D1IdempotencyStore(db, retention);
  const admission = new D1QuotaAdmission(db, [policy]);
  return { store, admission, durable: new DurableRequests(store, admission, secret, plan) };
}
function acquired(result: ClaimDecision): IdempotencyFence {
  assert.equal(result.state, "acquired", JSON.stringify(result));
  if (result.state !== "acquired") throw new Error("Ownership was not acquired");
  return result.fence;
}
function updated(result: TransitionDecision): IdempotencyFence {
  assert.equal(result.state, "updated", JSON.stringify(result));
  if (result.state !== "updated") throw new Error("Transition failed");
  return result.fence;
}
async function ready(durable: DurableRequests, id = uuid()) {
  const result = await durable.begin(principal, id, task());
  assert.equal(result.state, "ready", JSON.stringify(result));
  if (result.state !== "ready") throw new Error("Request was not reserved");
  return result.fence;
}
const count = async (db: DB, name: string) => (await db.prepare(`SELECT count(*) AS n FROM ${name}`).first()).n as number;
async function consistent(db: DB) {
  const rows = (await db.prepare(`SELECT w.*, coalesce(sum(l.reserved_amount), 0) AS linked
    FROM provider_quota_windows w LEFT JOIN reservation_quota_windows l ON l.quota_window_id = w.id GROUP BY w.id`).all()).results;
  for (const row of rows) {
    assert.equal(row.reserved_amount, row.linked);
    assert.ok(row.reserved_amount >= 0 && row.consumed_amount + row.reserved_amount <= row.limit_amount - row.safety_margin);
  }
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.equal((await db.prepare(`SELECT count(*) AS n FROM request_reservations r LEFT JOIN idempotency_records i
    ON i.reservation_id = r.id WHERE i.id IS NULL`).first()).n, 0);
  assert.equal((await db.prepare(`SELECT count(*) AS n FROM idempotency_records
    WHERE processing_state IN ('reserved','dispatched','completed') AND reservation_id IS NULL`).first()).n, 0);
}
function httpRequest(id: string, value: unknown = task().request, extra: Record<string, string> = {}) {
  return new Request("http://127.0.0.1/api/coach/generate", { method: "POST", headers: {
    Authorization: `Bearer ${authSecret}`, "Content-Type": "application/json", "X-ResearchBridge-Request-ID": id, ...extra,
  }, body: JSON.stringify(value) });
}
function fault(db: DB, length: number, afterCommit: boolean): D1Binding {
  return { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]): Promise<D1QueryResult<T>[]> {
    if (statements.length === length && !afterCommit) throw new Error("Simulated database timeout");
    const result = await db.batch(statements);
    if (statements.length === length && afterCommit) throw new Error("Simulated lost acknowledgement");
    return result;
  } };
}

test("durable idempotency and admission on real local D1", { timeout: 120_000 }, async t => {
  const mf = makeRuntime();
  try {
    const db = await mf.getD1Database("COACH_DB");
    await migrate(db);
    const scenario = (name: string, fn: (p: QuotaAdmissionPolicy) => Promise<void>, capacity = 10) => t.test(name, async () => {
      await db.batch(["idempotency_records", "inference_attempts", "reservation_quota_windows", "request_reservations", "provider_quota_windows"].map(n => db.prepare(`DELETE FROM ${n}`)));
      await fn(await seed(db, capacity));
    });

    await scenario("new request receives one internal ownership capability; pending duplicates get status only", async p => {
      const { store } = services(db, p);
      const identity = await identifyRequest(principal, uuid(), task(), secret);
      const fence = acquired(await store.claim(identity));
      assert.equal(fence.generation, 1);
      assert.deepEqual(await store.claim(identity), { state: "pending", retryable: false });
      assert.equal(await count(db, "idempotency_records"), 1);
      assert.equal(await count(db, "request_reservations"), 0);
    });

    await scenario("changed payload or response version conflicts with the same request ID", async p => {
      const { store } = services(db, p);
      const id = uuid();
      acquired(await store.claim(await identifyRequest(principal, id, task(), secret)));
      assert.equal((await store.claim(await identifyRequest(principal, id, task("regression"), secret))).state, "conflict");
      assert.equal((await store.claim(await identifyRequest(principal, id, { ...task(), responseVersion: "1" }, secret))).state, "conflict");
      assert.equal(await count(db, "idempotency_records"), 1);
    });

    await scenario("same opaque ID in another service scope cannot acquire or read the first scope's record", async p => {
      const { store } = services(db, p);
      const identity = await identifyRequest(principal, uuid(), task(), secret);
      const first = acquired(await store.claim(identity));
      assert.equal((await store.lookup({ ...identity, serviceId: "other-service" })).state, "storage_unavailable");
      const other = acquired(await store.claim({ ...identity, serviceId: "other-service" }));
      assert.notEqual(other.claimId, first.claimId);
      assert.equal((await store.failBeforeDispatch({ ...first, serviceId: "other-service" })).state, "stale_owner");
      assert.equal((await store.lookup(identity)).state, "pending");
    });

    await scenario("40 identical concurrent requests claim once and reserve the last quota slot once", async p => {
      const id = uuid();
      const results = await Promise.all(Array.from({ length: 40 }, () => services(db, p).durable.begin(principal, id, task())));
      assert.equal(results.filter(r => r.state === "ready").length, 1);
      assert.ok(results.every(r => ["ready", "pending", "reserved"].includes(r.state)));
      assert.equal(await count(db, "idempotency_records"), 1);
      assert.equal(await count(db, "request_reservations"), 1);
      await consistent(db);
    }, 1);

    await scenario("different IDs compete safely while concurrent duplicates spend only once", async p => {
      const a = uuid(), b = uuid();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => services(db, p).durable.begin(principal, i % 2 ? a : b, task())));
      assert.equal(results.filter(r => r.state === "ready").length, 1);
      assert.equal(await count(db, "request_reservations"), 1);
      assert.equal(await count(db, "idempotency_records"), 2);
      await consistent(db);
    }, 1);

    await scenario("claim revision and reservation link commit in the same multi-window batch", async p => {
      await db.prepare(`INSERT INTO provider_quota_windows (id, quota_scope_id, provider, model, dimension, unit,
        window_seconds, window_start, window_end, limit_amount, created_at, updated_at, retain_until)
        SELECT 'rpd', quota_scope_id, provider, model, dimension, unit, 86400, window_start,
        window_start + 86400, 0, created_at, updated_at, window_start + 100000 FROM provider_quota_windows WHERE id = 'rpm'`).run();
      const day = { ...p.windows[0]!, windowId: "rpd", windowSeconds: 86400, capacity: 0 };
      const { store } = services(db, p);
      const fence = acquired(await store.claim(await identifyRequest(principal, uuid(), task(), secret)));
      const admission = new D1QuotaAdmission(db, [{ ...p, windows: [...p.windows, day] }]);
      const result = await admission.reserve({ ...plan(), serviceId: fence.serviceId, requestId: fence.claimId, claim: fence });
      assert.equal(result.status, "insufficient_capacity");
      const row = await db.prepare("SELECT * FROM idempotency_records").first();
      assert.equal(row.processing_state, "pending"); assert.equal(row.generation, 1); assert.equal(row.reservation_id, null);
      await consistent(db);
    });

    await scenario("stale or missing claim aborts reservation creation without counter changes", async p => {
      const { store, admission } = services(db, p);
      const fence = acquired(await store.claim(await identifyRequest(principal, uuid(), task(), secret)));
      updated(await store.failBeforeDispatch(fence));
      for (const c of [fence, { ...fence, claimId: uuid() }, { ...fence, token: "0".repeat(64) }]) {
        const result = await admission.reserve({ ...plan(), serviceId: c.serviceId, requestId: c.claimId, claim: c });
        assert.equal(result.reason, "stale_claim");
      }
      assert.equal(await count(db, "request_reservations"), 0);
      await consistent(db);
    });

    await scenario("a later window failure rolls back the claim link, generation and earlier counter update", async p => {
      await db.prepare(`INSERT INTO provider_quota_windows (id, quota_scope_id, provider, model, dimension, unit,
        window_seconds, window_start, window_end, limit_amount, created_at, updated_at, retain_until)
        SELECT 'rpd', quota_scope_id, provider, model, dimension, unit, 86400, window_start,
        window_start + 86400, 1, created_at, updated_at, window_start + 100000 FROM provider_quota_windows WHERE id = 'rpm'`).run();
      const fencedDB: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        if (statements.length === 7) await db.prepare("UPDATE provider_quota_windows SET consumed_amount = 1 WHERE id = 'rpd'").run();
        return db.batch(statements) as Promise<D1QueryResult<T>[]>;
      } };
      const fence = acquired(await services(db, p).store.claim(await identifyRequest(principal, uuid(), task(), secret)));
      const day = { ...p.windows[0]!, windowId: "rpd", windowSeconds: 86400, capacity: 1 };
      const admission = new D1QuotaAdmission(fencedDB, [{ ...p, windows: [...p.windows, day] }]);
      assert.equal((await admission.reserve({ ...plan(), serviceId: fence.serviceId, requestId: fence.claimId, claim: fence })).status, "insufficient_capacity");
      const row = await db.prepare("SELECT * FROM idempotency_records").first();
      assert.equal(row.processing_state, "pending"); assert.equal(row.generation, 1); assert.equal(row.reservation_id, null);
      assert.equal(await count(db, "request_reservations"), 0);
      await consistent(db);
    });

    await scenario("concurrent transitions on one revision produce one dispatch intent", async p => {
      const { durable, store } = services(db, p);
      const fence = updated(await store.authorizeDispatch(await ready(durable)));
      const results = await Promise.all(Array.from({ length: 20 }, () => store.dispatch(fence)));
      assert.equal(results.filter(r => r.state === "updated").length, 1);
      assert.equal(results.filter(r => r.state === "stale_owner").length, 19);
      assert.equal(await count(db, "inference_attempts"), 1);
      await consistent(db);
    });

    await scenario("revision fencing prevents duplicate dispatch, stale completion and overwritten terminal states", async p => {
      const { durable, store } = services(db, p);
      const reserved = await ready(durable);
      const sent = updated(await store.dispatch(updated(await store.authorizeDispatch(reserved))));
      assert.equal((await store.dispatch(reserved)).state, "stale_owner");
      assert.equal((await store.complete(reserved)).state, "stale_owner");
      const completed = updated(await store.complete(sent));
      assert.equal(completed.generation, 5);
      assert.equal((await store.complete(sent)).state, "stale_owner");
      assert.equal((await store.markUnknown(sent)).state, "stale_owner");
      assert.equal((await store.lookup(sent)).state, "completed");
      assert.equal(await count(db, "inference_attempts"), 1);
      assert.equal((await db.prepare("SELECT status FROM inference_attempts").first()).status, "completed");
      assert.equal(await count(db, "usage_accounting"), 0);
      await consistent(db);
    });

    await scenario("unknown provider outcome remains terminal for all repeats", async p => {
      const id = uuid();
      const { durable, store } = services(db, p);
      const sent = updated(await store.dispatch(updated(await store.authorizeDispatch(await ready(durable, id)))));
      updated(await store.markUnknown(sent));
      assert.equal((await durable.begin(principal, id, task())).state, "outcome_unknown");
      assert.equal((await store.complete(sent)).state, "stale_owner");
      assert.equal((await db.prepare("SELECT status FROM inference_attempts").first()).status, "unknown");
      await consistent(db);
    });

    await scenario("known pre-dispatch failure is terminal and cannot obtain another reservation", async p => {
      const id = uuid();
      const { durable, store } = services(db, p);
      const fence = await ready(durable, id);
      updated(await store.failBeforeDispatch(fence));
      assert.equal((await durable.begin(principal, id, task())).state, "failed");
      assert.equal((await store.dispatch(fence)).state, "stale_owner");
      await consistent(db);
    });

    await scenario("definitive quota denial persists failed status with no reservation", async p => {
      const id = uuid(); const { durable } = services(db, p);
      assert.equal((await durable.begin(principal, id, task())).state, "failed");
      assert.equal((await durable.begin(principal, id, task())).state, "failed");
      assert.equal(await count(db, "request_reservations"), 0);
      await consistent(db);
    }, 0);

    await scenario("expired records are tombstones; expired leases cannot be reclaimed or used", async p => {
      const { durable, store } = services(db, p);
      const id = uuid(); const fence = await ready(durable, id);
      await db.prepare("UPDATE idempotency_records SET lease_expires_at = created_at").run();
      assert.equal((await durable.begin(principal, id, task())).state, "outcome_unknown");
      assert.equal((await store.dispatch(fence)).state, "stale_owner");
      await db.prepare("UPDATE idempotency_records SET expires_at = created_at").run();
      assert.equal((await durable.begin(principal, id, task())).state, "expired");
      assert.equal(await count(db, "request_reservations"), 1);
      await consistent(db);
    });

    await scenario("an expired quota reservation prevents dispatch even with an active claim lease", async p => {
      const { durable, store } = services(db, p);
      const fence = await ready(durable);
      await db.prepare("UPDATE request_reservations SET expires_at = created_at").run();
      assert.equal((await store.dispatch(fence)).state, "stale_owner");
      assert.equal((await store.lookup(fence)).state, "reserved");
      assert.equal(await count(db, "inference_attempts"), 0);
      await consistent(db);
    });

    await scenario("fingerprint-key rotation blocks the old ID instead of creating a new ownership record", async p => {
      const id = uuid(); const { store } = services(db, p);
      const first = await identifyRequest(principal, id, task(), secret);
      const changed = await identifyRequest(principal, id, task(), "c".repeat(64));
      assert.equal(first.keyHash, changed.keyHash);
      assert.notEqual(first.payloadHash, changed.payloadHash);
      acquired(await store.claim(first));
      assert.equal((await store.claim(changed)).state, "configuration_missing");
      assert.equal(await count(db, "idempotency_records"), 1);
    });

    await scenario("database binding or fingerprint configuration unavailable fails closed", async p => {
      assert.equal((await services(undefined, p).durable.begin(principal, uuid(), task())).state, "storage_unavailable");
      const { store, admission } = services(db, p);
      const missing = new DurableRequests(store, admission, undefined, plan);
      assert.equal((await missing.begin(principal, uuid(), task())).state, "configuration_missing");
      assert.equal((await missing.begin(principal, "student@example.test", task())).state, "invalid_request");
      assert.equal(await count(db, "idempotency_records"), 0);
    });

    await scenario("ambiguous claim insert returns status without recovering processing ownership", async p => {
      const identity = await identifyRequest(principal, uuid(), task(), secret);
      const store = new D1IdempotencyStore(fault(db, 2, true), retention);
      assert.equal((await store.claim(identity)).state, "pending");
      assert.equal((await services(db, p).store.claim(identity)).state, "pending");
      assert.equal(await count(db, "idempotency_records"), 1);
      assert.equal(await count(db, "request_reservations"), 0);
    });

    await scenario("a pre-write storage failure does not acquire ownership or expose errors", async () => {
      const identity = await identifyRequest(principal, uuid(), task(), secret);
      assert.deepEqual(await new D1IdempotencyStore(fault(db, 2, false), retention).claim(identity), { state: "storage_unavailable", retryable: false });
      assert.equal(await count(db, "idempotency_records"), 0);
    });

    await scenario("ambiguous admission resolves to durable reserved status without authorizing dispatch", async p => {
      const id = uuid();
      const store = services(db, p).store;
      const durable = new DurableRequests(store, new D1QuotaAdmission(fault(db, 5, true), [p]), secret, plan);
      assert.equal((await durable.begin(principal, id, task())).state, "reserved");
      assert.equal((await services(db, p).durable.begin(principal, id, task())).state, "reserved");
      assert.equal(await count(db, "request_reservations"), 1);
      assert.equal(await count(db, "inference_attempts"), 0);
      await consistent(db);
    });

    await scenario("ambiguous dispatch/completion acknowledgements never authorize repeat processing", async p => {
      const { durable, store } = services(db, p);
      const fence = updated(await store.authorizeDispatch(await ready(durable)));
      assert.equal((await new D1IdempotencyStore(fault(db, 6, true), retention).dispatch(fence)).state, "storage_unavailable");
      assert.equal((await store.lookup(fence)).state, "dispatched");
      assert.equal((await store.dispatch(fence)).state, "stale_owner");
      const sent = { ...fence, generation: fence.generation + 1 };
      assert.equal((await new D1IdempotencyStore(fault(db, 6, true), retention).complete(sent)).state, "storage_unavailable");
      assert.equal((await store.lookup(sent)).state, "completed");
      assert.equal((await store.complete(sent)).state, "stale_owner");
      await consistent(db);
    });

    await scenario("late attempt SQL failure rolls back state revision and dispatch intent", async p => {
      const { durable, store } = services(db, p);
      const fence = updated(await store.authorizeDispatch(await ready(durable)));
      const broken: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        statements.push(db.prepare("UPDATE idempotency_records SET transition_check = 0"));
        return db.batch(statements) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await new D1IdempotencyStore(broken, retention).dispatch(fence)).state, "stale_owner");
      assert.equal((await store.lookup(fence)).state, "reserved");
      assert.equal((await db.prepare("SELECT generation FROM idempotency_records").first()).generation, 3);
      assert.equal(await count(db, "inference_attempts"), 1);
      assert.equal((await db.prepare("SELECT status FROM inference_attempts").first()).status, "prepared");
      assert.equal((await db.prepare("SELECT status FROM request_reservations").first()).status, "reserved");
      await consistent(db);
    });

    await scenario("idempotency storage contains hashes and lifecycle metadata, never prompts or capabilities", async p => {
      const { store } = services(db, p);
      const privateTerm = "private-learning-phrase";
      const fence = acquired(await store.claim(await identifyRequest(principal, uuid(), task(privateTerm), secret)));
      const text = JSON.stringify((await db.prepare("SELECT * FROM idempotency_records").all()).results);
      for (const value of [privateTerm, secret, authSecret, fence.token]) assert.ok(!text.includes(value));
      const columns = (await db.prepare("PRAGMA table_info(idempotency_records)").all()).results.map((r: { name: string }) => r.name);
      for (const name of ["response", "response_body", "prompt", "session_id", "email", "user_id"]) assert.ok(!columns.includes(name));
    });

    await scenario("gateway authenticates and validates before touching durable records", async p => {
      const { durable } = services(db, p);
      const gateway = createGateway({ mode: "local", enabled: true, durable, provider: new LocalMockProvider(), sources: new MockSourceResolver() });
      assert.equal((await gateway.fetch(httpRequest(uuid(), task().request, { Authorization: "Bearer invalid" }), { COACH_SERVICE_SECRET: authSecret })).status, 401);
      assert.equal((await gateway.fetch(httpRequest(uuid(), { ...task().request, user_id: "student-a" }), { COACH_SERVICE_SECRET: authSecret })).status, 400);
      assert.equal((await gateway.fetch(httpRequest(uuid(), task().request, { Origin: "http://browser.test" }), { COACH_SERVICE_SECRET: authSecret })).status, 403);
      assert.equal(await count(db, "idempotency_records"), 0);
      const authenticated = await authenticate(httpRequest(uuid()), { COACH_SERVICE_SECRET: authSecret });
      assert.deepEqual(authenticated, principal);
    });

    await scenario("concurrent authenticated mock requests generate once; completed replay is status only across session headers", async p => {
      let calls = 0;
      const mock = new LocalMockProvider();
      const gateway = createGateway({ mode: "local", enabled: true, durable: services(db, p).durable,
        sources: new MockSourceResolver(), provider: { async generate(task, signal) { calls++; return mock.generate(task, signal); } } });
      const id = uuid();
      const responses = await Promise.all(Array.from({ length: 20 }, () => gateway.fetch(httpRequest(id), { COACH_SERVICE_SECRET: authSecret })));
      assert.equal(calls, 1);
      const bodies = await Promise.all(responses.map(r => r.json())) as Record<string, unknown>[];
      assert.equal(bodies.filter(b => "output" in b).length, 1);
      const replay = await gateway.fetch(httpRequest(id, task().request, { "X-Session-ID": "another-session" }), { COACH_SERVICE_SECRET: authSecret });
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), { request_id: id, state: "completed", retryable: false, replay: "status_only" });
      assert.equal(replay.headers.get("Cache-Control"), "no-store");
      assert.equal((await gateway.fetch(httpRequest(id, task().request, { Authorization: "Bearer invalid" }), { COACH_SERVICE_SECRET: authSecret })).status, 401);
      assert.equal(calls, 1);
      assert.equal(await count(db, "request_reservations"), 1);
      await consistent(db);
    }, 1);

    await scenario("gateway provider timeout records unknown and never regenerates on retry", async p => {
      let calls = 0;
      const gateway = createGateway({ mode: "local", enabled: true, durable: services(db, p).durable, timeoutMs: 10,
        sources: new MockSourceResolver(), provider: { async generate() { calls++; return new Promise(() => {}); } } });
      const id = uuid();
      assert.equal((await gateway.fetch(httpRequest(id), { COACH_SERVICE_SECRET: authSecret })).status, 504);
      const replay = await gateway.fetch(httpRequest(id), { COACH_SERVICE_SECRET: authSecret });
      assert.equal(replay.status, 409);
      assert.equal((await replay.json() as { state: string }).state, "outcome_unknown");
      assert.equal(calls, 1);
      await consistent(db);
    });
  } finally { await mf.dispose(); }
});

test("canonicalization, payload identity and exact Unicode rules", async () => {
  const id = uuid();
  const original = task("caf\u00e9");
  const reordered = { ...original, request: validateRequest(JSON.parse('{"input":{"term":"caf\\u00e9"},"task_id":"term_clarification","contract_version":"2"}')) };
  assert.equal((await identifyRequest(principal, id, original, secret)).payloadHash, (await identifyRequest(principal, id, reordered, secret)).payloadHash);
  const hashes = await Promise.all(["cafe\u0301", "caf\u00e9", "CAF\u00c9", " caf\u00e9 ", "\ud800", "\ufffd"].map(async text => {
    // This check isolates canonical string encoding. Contract validation remains
    // the gateway's prerequisite; unsupported values are not admitted here.
    return canonicalJson({ text });
  }));
  assert.equal(new Set(hashes).size, hashes.length);
  assert.notEqual(canonicalJson(["a", "b"]), canonicalJson(["b", "a"]));
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.throws(() => canonicalJson({ invalid: undefined }));
  assert.throws(() => canonicalJson(NaN));
  const f = fixture("retrieved_abstract");
  const sources = new Map(Object.entries(f.verified_sources ?? {}));
  const request = validateRequest(f.request, sources);
  const source = sourceText(request, sources)!;
  const first = await identifyRequest(principal, id, { request, source, responseVersion: "2" }, secret);
  const changed = await identifyRequest(principal, id, { request, source: { ...source, abstract: source.abstract + " Changed." }, responseVersion: "2" }, secret);
  assert.notEqual(first.payloadHash, changed.payloadHash);
});

test("idempotency and completed state persist across local Worker restarts", { timeout: 45_000 }, async () => {
  await mkdir(new URL("../.wrangler/idempotency-tests/", import.meta.url), { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL("../.wrangler/idempotency-tests/restart-", import.meta.url)));
  let mf = makeRuntime(directory);
  try {
    let db = await mf.getD1Database("COACH_DB"); await migrate(db);
    const p = await seed(db, 1), id = uuid();
    const { durable, store } = services(db, p);
    updated(await store.complete(updated(await store.dispatch(updated(await store.authorizeDispatch(await ready(durable, id)))))));
    await mf.dispose(); mf = makeRuntime(directory); db = await mf.getD1Database("COACH_DB");
    assert.equal((await services(db, p).durable.begin(principal, id, task())).state, "completed");
    assert.equal(await count(db, "request_reservations"), 1);
    await consistent(db);
  } finally { await mf.dispose(); }
});

test("migration 0004 preserves legacy idempotency records and marks legacy unknown outcomes", { timeout: 30_000 }, async () => {
  const mf = makeRuntime();
  try {
    const db = await mf.getD1Database("COACH_DB");
    await migrate(db, files.filter(n => n < "0004"));
    await db.prepare(`INSERT INTO idempotency_records (id, service_id, key_hash, payload_hash, response_version, status,
      created_at, updated_at, expires_at, retain_until) VALUES ('legacy', 'streamlit', ?, ?, '2', 'unknown', 1000, 1000, 2000, 3000)`)
      .bind("a".repeat(64), "b".repeat(64)).run();
    await migrate(db, files.filter(n => n.startsWith("0004")));
    const row = await db.prepare("SELECT * FROM idempotency_records").first();
    assert.equal(row.id, "legacy"); assert.equal(row.status, "unknown"); assert.equal(row.payload_hash, "b".repeat(64));
    assert.equal(row.processing_state, "outcome_unknown"); assert.equal(row.owner_token_hash, null);
  } finally { await mf.dispose(); }
});

test("durable mock gateway executes Web Crypto and fenced D1 writes inside workerd", { timeout: 30_000 }, async () => {
  const start = Math.floor(Date.now() / 1000) - 10;
  const result = await build({ stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)), contents: `
    import { createGateway } from './src/handlers/gateway';
    import { LocalMockProvider, MockSourceResolver } from './src/providers/mock';
    import { D1QuotaAdmission } from './src/storage/d1-quota-admission';
    import { D1IdempotencyStore } from './src/storage/d1-idempotency';
    import { DurableRequests } from './src/storage/durable-requests';
    export default { fetch(request, env) {
      const policy = { provider: 'mock', model: 'mock-model', quotaScopeId: 'local-account', leaseSeconds: 120, retentionSeconds: 7200,
        windows: [{ windowId: 'rpm', model: 'mock-model', metric: 'requests', unit: 'requests', capacity: 1, safetyMargin: 0,
          windowStart: ${start}, windowSeconds: 3600 }] };
      const store = new D1IdempotencyStore(env.COACH_DB, { leaseSeconds: 300, ttlSeconds: 3600, retentionSeconds: 7200 });
      const durable = new DurableRequests(store, new D1QuotaAdmission(env.COACH_DB, [policy]), '${secret}',
        () => ({ provider: 'mock', model: 'mock-model', estimate: { kind: 'estimated' } }));
      return createGateway({ mode: 'local', enabled: true, durable, provider: new LocalMockProvider(), sources: new MockSourceResolver() }).fetch(request, env);
    } };` }, bundle: true, format: "esm", platform: "browser", write: false });
  const mf = makeRuntime(undefined, result.outputFiles[0]!.text);
  try {
    const db = await mf.getD1Database("COACH_DB"); await migrate(db); await seed(db, 1);
    await db.prepare("UPDATE provider_quota_windows SET window_start = ?, window_end = ?").bind(start, start + 3600).run();
    const id = uuid();
    const send = async () => {
      const request = httpRequest(id);
      return mf.dispatchFetch(request.url, { method: "POST", headers: Object.fromEntries(request.headers), body: await request.text() });
    };
    const first = await send();
    assert.equal(first.status, 200); assert.ok("output" in (await first.json() as object));
    const replay = await send();
    assert.equal((await replay.json() as { state: string }).state, "completed");
    await consistent(db);
  } finally { await mf.dispose(); }
});
