import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const migrations = (await readdir(new URL("../migrations/", import.meta.url)))
  .filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
const run = promisify(execFile);

test("Wrangler applies versioned migrations locally and skips already applied versions", { timeout: 120_000 }, async () => {
  await mkdir(new URL("../.wrangler/schema-tests/", import.meta.url), { recursive: true });
  // Unique persisted state: existing local databases are never modified or removed.
  const state = await mkdtemp(fileURLToPath(new URL("../.wrangler/schema-tests/run-", import.meta.url)));
  const cli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
  const args = ["--config", "wrangler.d1.local.jsonc", "--local", "--persist-to", state];
  const options = { cwd: root, timeout: 55_000, env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" } };
  await run(process.execPath, [cli, "d1", "migrations", "apply", "COACH_DB", ...args], options);
  const second = await run(process.execPath, [cli, "d1", "migrations", "apply", "COACH_DB", ...args], options);
  assert.match(second.stdout, /No migrations to apply/i);
  const result = await run(process.execPath, [cli, "d1", "execute", "COACH_DB", ...args, "--json", "--command",
    "SELECT name FROM d1_migrations ORDER BY name"], options);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output[0].results.map((row: { name: string }) => row.name), migrations);
});

test("schema constraints on local D1", { timeout: 60_000 }, async t => {
  let outbound = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: "export default { fetch() { return new Response('schema tests'); } };",
    compatibilityDate: "2026-11-03", cf: false, telemetry: { enabled: false },
    d1Databases: ["COACH_DB"],
    outboundService: () => { outbound++; throw new Error("External networking is forbidden in schema tests"); },
  }));
  try {
    const db = await runtime.getD1Database("COACH_DB");
    for (const migration of migrations) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      // These migrations contain plain DDL only, with no triggers or SQL string semicolons.
      for (const statement of sql.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
      }
    }
    const execute = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).bind(...values).run();
    const count = async (table: string) => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    const window = (id: string, dimension = "requests", seconds = 60, unit = dimension, provider = "provider-a", model = "model-a", scope = "account-a") => execute(
      `INSERT INTO provider_quota_windows
       (id, quota_scope_id, provider, model, dimension, unit, window_seconds, window_start, window_end,
        limit_amount, created_at, updated_at, retain_until) VALUES (?, ?, ?, ?, ?, ?, ?, 1000, ?, 100, 1000, 1000, 100000)`,
      id, scope, provider, model, dimension, unit, seconds, 1000 + seconds);
    const reservation = (id: string, number = 1) => execute(
      `INSERT INTO request_reservations (id, service_id, request_id, quota_scope_id, provider, model,
       reservation_number, created_at, updated_at, expires_at, retain_until)
       VALUES (?, 'service-a', 'request-a', 'account-a', 'provider-a', 'model-a', ?, 1000, 1000, 1100, 100000)`, id, number);
    const attempt = (id: string, reservationId: string) => execute(
      "INSERT INTO inference_attempts (id, reservation_id, created_at, updated_at, retain_until) VALUES (?, ?, 1000, 1000, 100000)", id, reservationId);
    const idempotency = (id: string, service = "service-a", key = "a".repeat(64)) => execute(
      `INSERT INTO idempotency_records (id, service_id, key_hash, payload_hash, response_version,
       created_at, updated_at, expires_at, retain_until) VALUES (?, ?, ?, ?, 'v2', 1000, 1000, 1100, 100000)`,
      id, service, key, "b".repeat(64));
    const usage = (id: string, attemptId: string, kind = "measured") => execute(
      `INSERT INTO usage_accounting (id, attempt_id, kind, request_count, input_tokens, output_tokens,
       compute_units, compute_unit, created_at, updated_at, retain_until)
       VALUES (?, ?, ?, 1, 10, 20, 0.5, 'neurons', 1000, 1000, 100000)`, id, attemptId, kind);

    await t.test("creates all seven tables, indexes, and valid foreign keys", async () => {
      const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>();
      assert.deepEqual(tables.results.map((r: { name: string }) => r.name), ["idempotency_records", "inference_attempts", "provider_holds", "provider_quota_windows", "request_reservations", "reservation_quota_windows", "usage_accounting"].sort());
      const indexes = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all<{ name: string }>();
      for (const name of ["quota_windows_retention", "reservations_expiry", "reservation_windows_window", "attempts_retention", "holds_expiry", "idempotency_expiry", "usage_retention"]) {
        assert.ok(indexes.results.some((r: { name: string }) => r.name === name), name);
      }
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });

    await t.test("independent minute/day request/token and configurable compute windows", async () => {
      await window("rpm"); await window("rpd", "requests", 86400);
      await window("tpm", "tokens"); await window("tpd", "tokens", 86400);
      await window("compute", "compute_units", 300, "neurons");
      await window("other-compute", "compute_units", 300, "gpu_seconds");
      await window("other-provider", "requests", 60, "requests", "provider-b");
      await window("other-model", "requests", 60, "requests", "provider-a", "model-b");
      await window("other-account", "requests", 60, "requests", "provider-a", "model-a", "account-b");
      assert.equal(await count("provider_quota_windows"), 9);
      await assert.rejects(window("duplicate"), /UNIQUE/);
    });

    await t.test("rejects invalid dimensions, units, windows, counters, timestamps and retention", async () => {
      for (const update of ["dimension = 'invalid'", "unit = 'neurons'", "window_seconds = 0", "window_end = 0",
        "reserved_amount = -1", "consumed_amount = -1", "limit_amount = -1", "status = 'invalid'",
        "updated_at = 999", "retain_until = 1000", "window_seconds = 1.5"]) {
        await assert.rejects(execute(`UPDATE provider_quota_windows SET ${update} WHERE id = 'rpm'`), /constraint|datatype/i);
      }
    });

    await t.test("one request can have distinct reservations for fallback attempts and many dimensions", async () => {
      await reservation("r1"); await reservation("r2", 2);
      await assert.rejects(reservation("duplicate"), /UNIQUE/);
      for (const id of ["rpm", "rpd", "tpm", "tpd", "compute"]) {
        await execute(`INSERT INTO reservation_quota_windows (reservation_id, quota_window_id, reserved_amount,
          created_at, updated_at) VALUES ('r1', ?, 5, 1000, 1000)`, id);
      }
      assert.equal(await count("reservation_quota_windows"), 5);
      const columns = "(reservation_id, quota_window_id, reserved_amount, settled_amount, status, created_at, updated_at)";
      await assert.rejects(execute(`INSERT INTO reservation_quota_windows ${columns} VALUES ('r1', 'rpm', 1, NULL, 'reserved', 1000, 1000)`), /UNIQUE/);
      await assert.rejects(execute(`INSERT INTO reservation_quota_windows ${columns} VALUES ('missing', 'rpm', 1, NULL, 'reserved', 1000, 1000)`), /FOREIGN KEY/);
      await assert.rejects(execute(`INSERT INTO reservation_quota_windows ${columns} VALUES ('r2', 'missing', 1, NULL, 'reserved', 1000, 1000)`), /FOREIGN KEY/);
    });

    await t.test("attempts and usage are unique per reservation and attempt, with enforced references", async () => {
      await attempt("a1", "r1"); await attempt("a2", "r2");
      await assert.rejects(attempt("duplicate", "r1"), /UNIQUE/);
      await assert.rejects(attempt("orphan", "missing"), /FOREIGN KEY/);
      await usage("u1", "a1"); await usage("u2", "a2", "estimated");
      await assert.rejects(usage("duplicate", "a1"), /UNIQUE/);
      await assert.rejects(usage("orphan", "missing"), /FOREIGN KEY/);
      for (const update of ["kind = 'invalid'", "status = 'invalid'", "input_tokens = -1", "output_tokens = -1",
        "request_count = -1", "compute_units = -1", "compute_unit = NULL", "compute_units = NULL", "retain_until = 999"]) {
        await assert.rejects(execute(`UPDATE usage_accounting SET ${update} WHERE id = 'u1'`), /constraint/i);
      }
      await execute("UPDATE usage_accounting SET kind = 'simulated' WHERE id = 'u2'");
      await assert.rejects(execute("UPDATE inference_attempts SET status = 'failed' WHERE id = 'a1'"), /constraint/i);
      await assert.rejects(execute("UPDATE inference_attempts SET sent_at = 999 WHERE id = 'a1'"), /constraint/i);
    });

    await t.test("reservation and dimension-link lifecycle metadata rejects invalid values", async () => {
      for (const update of ["status = 'invalid'", "reservation_number = 0", "expires_at = 999", "updated_at = 999", "retain_until = 1000"]) {
        await assert.rejects(execute(`UPDATE request_reservations SET ${update} WHERE id = 'r1'`), /constraint/i);
      }
      for (const update of ["status = 'invalid'", "reserved_amount = -1", "settled_amount = -1", "updated_at = 999"]) {
        await assert.rejects(execute(`UPDATE reservation_quota_windows SET ${update} WHERE reservation_id = 'r1'`), /constraint/i);
      }
      for (const status of ["sent", "unknown", "completed", "not_sent"]) {
        await execute("UPDATE request_reservations SET status = ? WHERE id = 'r1'", status);
        await execute("UPDATE inference_attempts SET status = ? WHERE id = 'a1'", status);
      }
    });

    await t.test("D1 rolls back a failed multi-table batch without partial records", async () => {
      const before = await count("request_reservations");
      await assert.rejects(db.batch([
        db.prepare(`INSERT INTO request_reservations (id, service_id, request_id, quota_scope_id, provider,
          model, reservation_number, created_at, updated_at, expires_at, retain_until)
          VALUES ('rollback', 'service-a', 'batch-test', 'account-a', 'provider-a', 'model-a', 1, 1000, 1000, 1100, 100000)`),
        db.prepare("INSERT INTO inference_attempts (id, reservation_id, status, created_at, updated_at, retain_until) VALUES ('rollback', 'rollback', 'invalid', 1000, 1000, 100000)"),
      ]), /constraint/i);
      assert.equal(await count("request_reservations"), before);
      assert.equal(await db.prepare("SELECT id FROM inference_attempts WHERE id = 'rollback'").first(), null);
    });

    await t.test("holds are scoped to account/provider/model and have expiry metadata", async () => {
      const insert = (model: string) => execute(`INSERT INTO provider_holds VALUES
        ('account-a', 'provider-a', ?, 'active', 'rate_limit', 1100, 1000, 1000, 100000)`, model);
      await insert("model-a"); await insert("model-b");
      await assert.rejects(insert("model-a"), /UNIQUE/);
      for (const update of ["hold_until = 999", "retain_until = 1000", "status = 'invalid'", "reason_code = 'raw error'"]) {
        await assert.rejects(execute(`UPDATE provider_holds SET ${update}`), /constraint/i);
      }
    });

    await t.test("idempotency keys are unique per service, hashes only, with completion metadata", async () => {
      await idempotency("i1"); await idempotency("i2", "service-b");
      await assert.rejects(idempotency("duplicate"), /UNIQUE/);
      await assert.rejects(idempotency("raw-key", "service-a", "raw-key"), /constraint/i);
      for (const update of ["status = 'invalid'", "status = 'completed'", "response_status = 600",
        "payload_hash = 'raw prompt'", `source_fingerprint_hash = '${"z".repeat(64)}'`, "expires_at = 999", "retain_until = 1000"]) {
        await assert.rejects(execute(`UPDATE idempotency_records SET ${update} WHERE id = 'i1'`), /constraint/i);
      }
      await execute("UPDATE idempotency_records SET status = 'completed', response_status = 200 WHERE id = 'i1'");
    });

    await t.test("restrictive foreign keys prevent deletion of retained accounting parents", async () => {
      for (const sql of ["DELETE FROM request_reservations WHERE id = 'r1'", "DELETE FROM provider_quota_windows WHERE id = 'rpm'", "DELETE FROM inference_attempts WHERE id = 'a1'"]) {
        await assert.rejects(execute(sql), /FOREIGN KEY/);
      }
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
      assert.equal(outbound, 0);
    });
  } finally { await runtime.dispose(); }
});
