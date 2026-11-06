import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { D1QuotaAdmission, type D1Binding, type D1QueryResult, type D1Statement } from "../src/storage/d1-quota-admission";
import type { QuotaAdmissionInput, QuotaAdmissionPolicy, QuotaAdmissionResult, QuotaWindowPolicy } from "../src/storage";

type LocalDB = Awaited<ReturnType<Miniflare["getD1Database"]>>;
const MAX = Number.MAX_SAFE_INTEGER;
const migrations = (await readdir(new URL("../migrations/", import.meta.url))).filter(n => /^\d{4}_.+\.sql$/.test(n)).sort();
const runtime = (state?: string) => new Miniflare(convertV4MiniflareOptions({
  modules: true, script: "export default { fetch() { return new Response('local admission tests'); } };",
  compatibilityDate: "2026-11-03", cf: false, telemetry: { enabled: false },
  d1Databases: { COACH_DB: "admission-tests" },
  ...(state ? { resourcePersistencePath: state } : {}),
  outboundService: () => { throw new Error("External networking is forbidden in admission tests"); },
}));
async function migrate(db: LocalDB, files = migrations) {
  for (const file of files) {
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    for (const statement of sql.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}
const input = (requestId = "request-1", overrides: Partial<QuotaAdmissionInput> = {}): QuotaAdmissionInput => ({
  serviceId: "service-a", requestId, provider: "provider-a", model: "model-a",
  estimate: { kind: "estimated", inputTokens: 2, outputTokens: 3, neurons: 4 }, ...overrides,
});
const policy = (windows: QuotaWindowPolicy[], overrides: Partial<QuotaAdmissionPolicy> = {}): QuotaAdmissionPolicy => ({
  provider: "provider-a", model: "model-a", quotaScopeId: "account-a", leaseSeconds: 30, retentionSeconds: 7200,
  windows, ...overrides,
});
async function seed(db: LocalDB, id: string, options: Partial<QuotaWindowPolicy> & {
  provider?: string; scope?: string; consumed?: number; reserved?: number;
} = {}): Promise<QuotaWindowPolicy> {
  const w: QuotaWindowPolicy = { windowId: id, model: "model-a", metric: "requests", unit: "requests", capacity: 10,
    safetyMargin: 0, windowStart: Math.floor(Date.now() / 1000) - 10, windowSeconds: 3600, ...options };
  const dimension = ["tokens", "input_tokens", "output_tokens"].includes(w.metric) ? "tokens" : w.metric;
  await db.prepare(`INSERT INTO provider_quota_windows (id, quota_scope_id, provider, model, dimension, unit,
    window_seconds, window_start, window_end, limit_amount, consumed_amount, reserved_amount, safety_margin,
    created_at, updated_at, retain_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(w.windowId, options.scope ?? "account-a", options.provider ?? "provider-a", w.model, dimension, w.unit,
      w.windowSeconds, w.windowStart, w.windowStart + w.windowSeconds, w.capacity, options.consumed ?? 0,
      options.reserved ?? 0, w.safetyMargin, w.windowStart, w.windowStart, w.windowStart + w.windowSeconds + 7200).run();
  return w;
}
async function state(db: LocalDB) {
  const windows = await db.prepare("SELECT * FROM provider_quota_windows ORDER BY id").all();
  const reservations = await db.prepare("SELECT * FROM request_reservations ORDER BY id").all();
  const links = await db.prepare("SELECT * FROM reservation_quota_windows ORDER BY reservation_id, quota_window_id").all();
  return { windows: windows.results, reservations: reservations.results, links: links.results };
}
async function consistent(db: LocalDB, seededReservations: Record<string, number> = {}) {
  const rows = (await db.prepare(`SELECT w.id, w.limit_amount, w.safety_margin, w.consumed_amount, w.reserved_amount,
    coalesce(sum(l.reserved_amount), 0) AS linked FROM provider_quota_windows w
    LEFT JOIN reservation_quota_windows l ON l.quota_window_id = w.id GROUP BY w.id`).all()).results;
  for (const w of rows) {
    assert.ok(Number.isSafeInteger(w.reserved_amount) && w.reserved_amount >= 0);
    assert.ok(w.consumed_amount + w.reserved_amount <= w.limit_amount - w.safety_margin, w.id);
    assert.equal(w.reserved_amount, w.linked + (seededReservations[w.id] ?? 0), `Counter/link agreement: ${w.id}`);
  }
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.equal((await db.prepare(`SELECT count(*) AS n FROM request_reservations r
    WHERE NOT EXISTS (SELECT 1 FROM reservation_quota_windows l WHERE l.reservation_id = r.id)`).first()).n, 0);
}
function admitted(result: QuotaAdmissionResult) {
  assert.equal(result.status, "admitted", JSON.stringify(result));
  assert.ok(result.admitted);
  return result;
}
// Hook only the real D1 write batch, to deterministically arrange a competing
// commit after diagnostic reads. SQL still executes in the actual local D1.
function beforeWrite(db: LocalDB, action: () => Promise<void>): D1Binding {
  return {
    prepare: sql => db.prepare(sql),
    async batch<T>(statements: D1Statement[]): Promise<D1QueryResult<T>[]> {
      if (statements.length > 1) await action();
      return db.batch(statements);
    },
  };
}

test("quota admission on real local D1", { timeout: 120_000 }, async t => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB");
    await migrate(db);
    const scenario = (name: string, fn: () => Promise<void>) => t.test(name, async () => {
      await db.batch(["reservation_quota_windows", "request_reservations", "provider_quota_windows"].map(name => db.prepare(`DELETE FROM ${name}`)));
      await fn();
    });

    await scenario("single window reserves durably with bounded lease and initial status", async () => {
      const w = await seed(db, "rpm", { windowSeconds: 60 });
      const decision = admitted(await new D1QuotaAdmission(db, [policy([w])]).reserve(input()));
      const s = await state(db);
      assert.equal(s.windows[0].reserved_amount, 1);
      assert.equal(s.links[0].reserved_amount, 1);
      assert.equal(s.links[0].admission_check, 1);
      assert.equal(s.reservations[0].id, decision.reservationId);
      assert.equal(s.reservations[0].request_id, "request-1");
      assert.equal(s.reservations[0].status, "reserved");
      assert.equal(s.reservations[0].expires_at, decision.leaseExpiresAt);
      assert.ok(s.reservations[0].expires_at > s.reservations[0].created_at);
      assert.ok(s.reservations[0].expires_at <= w.windowStart + w.windowSeconds);
      await consistent(db);
    });

    await scenario("all minute/day request/token and named compute dimensions reserve together", async () => {
      const windows = [await seed(db, "rpm", { windowSeconds: 60 }), await seed(db, "rpd", { windowSeconds: 86400 }),
        await seed(db, "tpm", { metric: "tokens", unit: "tokens", windowSeconds: 60 }),
        await seed(db, "tpd", { metric: "tokens", unit: "tokens", windowSeconds: 86400 }),
        await seed(db, "compute", { metric: "compute_units", unit: "neurons", windowSeconds: 300 })];
      admitted(await new D1QuotaAdmission(db, [policy(windows)]).reserve(input()));
      const s = await state(db);
      assert.equal(s.reservations.length, 1);
      assert.deepEqual(s.windows.map((w: { id: string; reserved_amount: number }) => [w.id, w.reserved_amount]),
        [["compute", 4], ["rpd", 1], ["rpm", 1], ["tpd", 5], ["tpm", 5]]);
      assert.equal(s.links.length, windows.length);
      await consistent(db);
    });

    await scenario("input-only and output-only token budgets derive the corresponding amounts", async () => {
      const a = await seed(db, "input", { metric: "input_tokens", unit: "tokens", model: "" });
      const b = await seed(db, "output", { metric: "output_tokens", unit: "tokens" });
      admitted(await new D1QuotaAdmission(db, [policy([a, b])]).reserve(input()));
      assert.deepEqual((await state(db)).windows.map((w: { reserved_amount: number }) => w.reserved_amount), [2, 3]);
      await consistent(db);
    });

    await scenario("consumed usage, prior reservations and persisted safety margin reduce capacity", async () => {
      const w = await seed(db, "rpm", { capacity: 10, safetyMargin: 2, consumed: 4, reserved: 3 });
      const controller = new D1QuotaAdmission(db, [policy([w])]);
      admitted(await controller.reserve(input("last")));
      const result = await controller.reserve(input("denied"));
      assert.equal(result.status, "insufficient_capacity");
      assert.equal(result.admitted ? undefined : result.resetAt, w.windowStart + w.windowSeconds);
      await consistent(db, { rpm: 3 });
    });

    await scenario("an exhausted later dimension leaves every window and record unchanged", async () => {
      const a = await seed(db, "rpm");
      const b = await seed(db, "tokens", { metric: "tokens", unit: "tokens", capacity: 4 });
      const before = await state(db);
      assert.equal((await new D1QuotaAdmission(db, [policy([a, b])]).reserve(input())).status, "insufficient_capacity");
      assert.deepEqual(await state(db), before);
      await consistent(db);
    });

    await scenario("missing window or absent/empty/duplicate policy fails closed", async () => {
      const w = await seed(db, "rpm");
      for (const config of [[], [policy([])], [policy([w, w])], [policy([w]), policy([w])], [policy([{ ...w, windowId: "absent" }])]]) {
        assert.equal((await new D1QuotaAdmission(db, config).reserve(input())).status, "configuration_missing");
      }
      assert.equal((await state(db)).reservations.length, 0);
    });

    await scenario("expired, future and closed windows fail closed", async () => {
      const w = await seed(db, "rpm");
      await db.prepare("UPDATE provider_quota_windows SET status = 'closed' WHERE id = 'rpm'").run();
      assert.equal((await new D1QuotaAdmission(db, [policy([w])]).reserve(input())).status, "configuration_missing");
      for (const start of [Math.floor(Date.now() / 1000) - 100, Math.floor(Date.now() / 1000) + 100]) {
        await db.prepare("DELETE FROM provider_quota_windows").run();
        const expired = await seed(db, "rpm", { windowStart: start, windowSeconds: 60 });
        assert.equal((await new D1QuotaAdmission(db, [policy([expired])]).reserve(input())).status, "configuration_missing");
      }
      assert.equal((await state(db)).reservations.length, 0);
    });

    await scenario("mismatched account/provider/model/unit/capacity/margin/time configuration is denied", async () => {
      const w = await seed(db, "rpm");
      for (const changed of [{ model: "" }, { unit: "tokens" }, { capacity: 11 }, { safetyMargin: 1 }, { windowSeconds: 60 }, { windowStart: w.windowStart - 1 }]) {
        assert.equal((await new D1QuotaAdmission(db, [policy([{ ...w, ...changed }])]).reserve(input())).status, "configuration_missing");
      }
      for (const changed of [{ quotaScopeId: "other-account" }, { provider: "provider-b" }, { model: "model-b" }]) {
        const p = policy([w], changed);
        assert.equal((await new D1QuotaAdmission(db, [p]).reserve(input("x", { provider: p.provider, model: p.model }))).status, "configuration_missing");
      }
      await consistent(db);
    });

    await scenario("two independent controllers compete for the last slot", async () => {
      const w = await seed(db, "rpm", { capacity: 1 });
      const results = await Promise.all(["a", "b"].map(id => new D1QuotaAdmission(db, [policy([w])]).reserve(input(id))));
      assert.equal(results.filter(r => r.admitted).length, 1);
      assert.equal(results.filter(r => r.status === "insufficient_capacity").length, 1);
      assert.equal((await state(db)).reservations.length, 1);
      await consistent(db);
    });

    await scenario("60 concurrent multi-window requests cannot exceed seven available slots", async () => {
      const a = await seed(db, "rpm", { capacity: 8, safetyMargin: 1 });
      const b = await seed(db, "tokens", { metric: "tokens", unit: "tokens", capacity: 35 });
      const results = await Promise.all(Array.from({ length: 60 }, (_, i) => new D1QuotaAdmission(db, [policy([a, b])]).reserve(input(`request-${i}`))));
      assert.equal(results.filter(r => r.admitted).length, 7);
      assert.equal(results.filter(r => r.status === "insufficient_capacity").length, 53);
      const s = await state(db);
      assert.equal(s.reservations.length, 7);
      assert.equal(s.links.length, 14);
      await consistent(db);
    });

    await scenario("D1 zero-row updates do not automatically roll back earlier statements", async () => {
      await seed(db, "rpm");
      const results = await db.batch([
        db.prepare("UPDATE provider_quota_windows SET reserved_amount = reserved_amount + 1 WHERE id = 'rpm'"),
        db.prepare("UPDATE provider_quota_windows SET reserved_amount = reserved_amount + 1 WHERE id = 'absent'"),
        db.prepare("SELECT changes() AS affected"),
      ]);
      assert.equal(results[0].meta.changes, 1);
      assert.equal(results[1].meta.changes, 0);
      assert.equal(results[2].results[0].affected, 0);
      assert.equal((await state(db)).windows[0].reserved_amount, 1);
    });

    await scenario("guarded zero-row update rolls back an already incremented first dimension", async () => {
      const a = await seed(db, "rpm");
      const b = await seed(db, "tokens", { metric: "tokens", unit: "tokens", capacity: 5 });
      let raced = false;
      // The two read statements must run normally; distinguish the write by its length.
      const wrapped: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        if (statements.length === 5 && !raced) {
          raced = true;
          admitted(await new D1QuotaAdmission(db, [policy([b])]).reserve(input("competitor")));
        }
        return db.batch(statements) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await new D1QuotaAdmission(wrapped, [policy([a, b])]).reserve(input("loser"))).status, "insufficient_capacity");
      assert.equal(raced, true);
      const s = await state(db);
      assert.equal(s.windows[0].reserved_amount, 0);
      assert.equal(s.windows[1].reserved_amount, 5);
      assert.equal(s.reservations.length, 1);
      assert.equal(s.reservations[0].request_id, "competitor");
      assert.equal(s.links.length, 1);
      await consistent(db);
    });

    await scenario("configuration changes after reads abort the write transaction", async () => {
      const w = await seed(db, "rpm");
      const wrapped = beforeWrite(db, async () => { await db.prepare("UPDATE provider_quota_windows SET safety_margin = 1 WHERE id = 'rpm'").run(); });
      assert.equal((await new D1QuotaAdmission(wrapped, [policy([w])]).reserve(input())).status, "configuration_missing");
      assert.equal((await state(db)).reservations.length, 0);
      await consistent(db);
    });

    await scenario("duplicate service/request cannot reserve twice, including simultaneous duplicates", async () => {
      const w = await seed(db, "rpm");
      const results = await Promise.all(Array.from({ length: 6 }, () => new D1QuotaAdmission(db, [policy([w])]).reserve(input())));
      assert.equal(results.filter(r => r.admitted).length, 1);
      assert.equal(results.filter(r => r.reason === "duplicate_request").length, 5);
      admitted(await new D1QuotaAdmission(db, [policy([w])]).reserve(input("request-1", { serviceId: "service-b" })));
      await consistent(db);
    });

    await scenario("provider and model budgets remain independent; shared provider windows apply to both models", async () => {
      const shared = await seed(db, "shared", { model: "", capacity: 2 });
      const a = await seed(db, "a", { capacity: 1 });
      const b = await seed(db, "b", { model: "model-b", capacity: 1 });
      const c = await seed(db, "c", { provider: "provider-b", capacity: 1 });
      const policies = [policy([shared, a]), policy([shared, b], { model: "model-b" }), policy([c], { provider: "provider-b" })];
      const controller = new D1QuotaAdmission(db, policies);
      admitted(await controller.reserve(input("a")));
      assert.equal((await controller.reserve(input("a2"))).status, "insufficient_capacity");
      admitted(await controller.reserve(input("b", { model: "model-b" })));
      admitted(await controller.reserve(input("c", { provider: "provider-b" })));
      await consistent(db);
    });

    await scenario("invalid, missing, fractional, zero and unsafe reservation amounts cannot write", async () => {
      const w = await seed(db, "tokens", { metric: "tokens", unit: "tokens" });
      const controller = new D1QuotaAdmission(db, [policy([w])]);
      for (const amount of [-1, 0, 0.5, NaN, Infinity, MAX + 1]) {
        assert.equal((await controller.reserve(input("bad", { estimate: { kind: "estimated", inputTokens: amount, outputTokens: 0 } }))).status, "invalid_request");
      }
      assert.equal((await controller.reserve(input("missing", { estimate: { kind: "estimated", inputTokens: 1 } }))).status, "invalid_request");
      assert.equal((await controller.reserve(input("overflow", { estimate: { kind: "estimated", inputTokens: MAX, outputTokens: 1 } }))).status, "invalid_request");
      assert.equal((await controller.reserve(input("simulated", { estimate: { kind: "simulated", inputTokens: 1, outputTokens: 1 } }))).status, "invalid_request");
      assert.equal((await state(db)).reservations.length, 0);
    });

    await scenario("scaled integer compute units are supported; incompatible units and fractions are denied", async () => {
      const w = await seed(db, "compute", { metric: "compute_units", unit: "milli_neurons", capacity: 1000 });
      const controller = new D1QuotaAdmission(db, [policy([w])]);
      assert.equal((await controller.reserve(input())).status, "invalid_request");
      admitted(await controller.reserve(input("scaled", { estimate: { kind: "estimated", computeUnits: { milli_neurons: 500 } } })));
      for (const value of [0, -1, 0.5, MAX + 1]) {
        assert.equal((await controller.reserve(input("bad", { estimate: { kind: "estimated", computeUnits: { milli_neurons: value } } }))).status, "invalid_request");
      }
      await consistent(db);
    });

    await scenario("safe integer boundary arithmetic remains exact", async () => {
      const w = await seed(db, "rpm", { capacity: MAX, consumed: MAX - 1 });
      const controller = new D1QuotaAdmission(db, [policy([w])]);
      admitted(await controller.reserve(input("last")));
      assert.equal((await controller.reserve(input("overflow"))).status, "insufficient_capacity");
      await consistent(db);
    });

    await scenario("legacy fractional/unsafe counters and malformed policy numbers fail closed", async () => {
      const w = await seed(db, "rpm");
      for (const changed of [{ capacity: -1 }, { capacity: MAX + 1 }, { capacity: 1.5 }, { safetyMargin: 11 },
        { safetyMargin: -1 }, { windowSeconds: 0 }, { windowSeconds: MAX, windowStart: 1 }]) {
        assert.equal((await new D1QuotaAdmission(db, [policy([{ ...w, ...changed }])]).reserve(input())).status, "configuration_missing");
      }
      for (const value of [0.5, MAX + 1]) {
        await db.prepare("UPDATE provider_quota_windows SET reserved_amount = ? WHERE id = 'rpm'").bind(value).run();
        assert.equal((await new D1QuotaAdmission(db, [policy([w])]).reserve(input())).status, "configuration_missing");
      }
      assert.equal((await state(db)).reservations.length, 0);
    });

    await scenario("invalid identities and missing database binding produce structured denials", async () => {
      const w = await seed(db, "rpm");
      const controller = new D1QuotaAdmission(undefined, [policy([w])]);
      const missing = await controller.reserve(input());
      assert.equal(missing.status, "storage_unavailable");
      assert.equal(missing.reason, "database_binding_missing");
      assert.equal(missing.requestId, "request-1");
      for (const key of ["serviceId", "requestId", "provider", "model"]) {
        assert.equal((await controller.reserve(input("bad", { [key]: "" }))).status, "invalid_request");
      }
    });

    await scenario("storage exceptions fail closed without exposing database messages", async () => {
      const w = await seed(db, "rpm");
      const failing: D1Binding = { prepare() { throw new Error("private database details"); }, async batch() { throw new Error("unavailable"); } };
      const result = await new D1QuotaAdmission(failing, [policy([w])]).reserve(input());
      assert.equal(result.status, "storage_unavailable");
      assert.ok(!JSON.stringify(result).includes("private"));
      await consistent(db);
    });

    await scenario("a late SQL failure rolls back counters, reservation and links", async () => {
      const w = await seed(db, "rpm");
      const failing: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        if (statements.length === 3) statements.push(db.prepare("UPDATE reservation_quota_windows SET admission_check = 0"));
        return db.batch(statements) as Promise<D1QueryResult<T>[]>;
      } };
      assert.equal((await new D1QuotaAdmission(failing, [policy([w])]).reserve(input())).status, "storage_unavailable");
      assert.equal((await state(db)).reservations.length, 0);
      await consistent(db);
    });

    await scenario("lost acknowledgement retains committed capacity and denies dispatch", async () => {
      const w = await seed(db, "rpm");
      const uncertain: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        const result = await db.batch(statements);
        if (statements.length === 3) throw new Error("Acknowledgement lost");
        return result as D1QueryResult<T>[];
      } };
      assert.equal((await new D1QuotaAdmission(uncertain, [policy([w])]).reserve(input())).status, "storage_unavailable");
      assert.equal((await state(db)).windows[0].reserved_amount, 1);
      await consistent(db);
    });

    await scenario("unexpected affected-row acknowledgement fails closed without refunding a commit", async () => {
      const w = await seed(db, "rpm");
      const uncertain: D1Binding = { prepare: sql => db.prepare(sql), async batch<T>(statements: D1Statement[]) {
        const result = await db.batch(statements);
        if (statements.length === 3) result[1].meta.changes = 0;
        return result as D1QueryResult<T>[];
      } };
      const result = await new D1QuotaAdmission(uncertain, [policy([w])]).reserve(input());
      assert.equal(result.status, "storage_unavailable");
      assert.equal(result.reason, "admission_not_confirmed");
      await consistent(db);
    });

    await scenario("expired or unknown reservations continue to consume capacity", async () => {
      const w = await seed(db, "rpm", { capacity: 1 });
      const controller = new D1QuotaAdmission(db, [policy([w])]);
      admitted(await controller.reserve(input("first")));
      await db.prepare("UPDATE request_reservations SET expires_at = created_at, status = 'unknown'").run();
      assert.equal((await controller.reserve(input("second"))).status, "insufficient_capacity");
      await consistent(db);
    });
  } finally { await mf.dispose(); }
});

test("existing Part 4A data survives migration 0003 without conversion or deletion", { timeout: 30_000 }, async () => {
  const mf = runtime();
  try {
    const db = await mf.getD1Database("COACH_DB");
    await migrate(db, migrations.filter(n => n.startsWith("0001") || n.startsWith("0002")));
    await db.prepare(`INSERT INTO provider_quota_windows (id, quota_scope_id, provider, model, dimension, unit,
      window_seconds, window_start, window_end, limit_amount, reserved_amount, created_at, updated_at, retain_until)
      VALUES ('legacy', 'account-a', 'provider-a', 'model-a', 'compute_units', 'neurons', 60, 1000, 1060, 10, 0.5, 1000, 1000, 2000)`).run();
    await db.prepare(`INSERT INTO request_reservations (id, service_id, request_id, quota_scope_id, provider, model,
      reservation_number, created_at, updated_at, expires_at, retain_until)
      VALUES ('legacy-r', 'service-a', 'request-a', 'account-a', 'provider-a', 'model-a', 1, 1000, 1000, 1100, 2000)`).run();
    await db.prepare(`INSERT INTO reservation_quota_windows (reservation_id, quota_window_id, reserved_amount, created_at, updated_at)
      VALUES ('legacy-r', 'legacy', 0.5, 1000, 1000)`).run();
    const before = await state(db);
    await migrate(db, migrations.filter(n => n.startsWith("0003")));
    const after = await state(db);
    assert.deepEqual(after.reservations, before.reservations);
    const { safety_margin: _margin, ...oldWindow } = after.windows[0];
    const { admission_check: _check, ...oldLink } = after.links[0];
    assert.deepEqual(oldWindow, before.windows[0]);
    assert.deepEqual(oldLink, before.links[0]);
    assert.equal(after.windows[0].reserved_amount, 0.5);
    assert.equal(after.links[0].reserved_amount, 0.5);
    assert.equal(after.windows[0].safety_margin, 0);
    assert.equal(after.links[0].admission_check, 1);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await mf.dispose(); }
});

test("reservation and capacity persist across local Worker runtime restarts", { timeout: 45_000 }, async () => {
  await mkdir(new URL("../.wrangler/admission-tests/", import.meta.url), { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL("../.wrangler/admission-tests/restart-", import.meta.url)));
  let mf = runtime(directory);
  try {
    let db = await mf.getD1Database("COACH_DB");
    await migrate(db);
    const w = await seed(db, "rpm", { capacity: 1 });
    const first = admitted(await new D1QuotaAdmission(db, [policy([w])]).reserve(input("first")));
    await mf.dispose();
    mf = runtime(directory);
    db = await mf.getD1Database("COACH_DB");
    assert.equal((await new D1QuotaAdmission(db, [policy([w])]).reserve(input("second"))).status, "insufficient_capacity");
    assert.equal((await state(db)).reservations[0].id, first.reservationId);
    await consistent(db);
  } finally { await mf.dispose(); }
});
