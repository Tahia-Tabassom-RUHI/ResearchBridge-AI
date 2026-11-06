import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { fixture } from "./fixtures";
import * as schemas from "../.generated/validators.cjs";

for (const mode of ["production", "local"] as const) test(`workerd runtime: ${mode} bundle`, { timeout: 30_000 }, async () => {
  const secret = randomBytes(32).toString("hex");
  let outbound = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: fileURLToPath(new URL(`../dist/${mode}/index.js`, import.meta.url)),
    compatibilityDate: "2026-11-03", cf: false, telemetry: { enabled: false },
    outboundService: () => { outbound++; throw new Error("External networking is forbidden in runtime tests"); },
    bindings: { COACH_SERVICE_SECRET: secret, LOCAL_MOCK_ENABLED: "true", MOCK_SCENARIO: "success" },
  }));
  try {
    const origin = mode === "production" ? "https://example.test" : "http://127.0.0.1";
    const health = await runtime.dispatchFetch(`${origin}/api/health`);
    assert.deepEqual(await health.json(), { status: "ok" });
    const unauthorized = await runtime.dispatchFetch(`${origin}/api/coach/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fixture("term_clarification").request) });
    assert.equal(unauthorized.status, 401);
    assert.ok(schemas.v2Error(await unauthorized.json()));
    const response = await runtime.dispatchFetch(`${origin}/api/coach/generate`, {
      method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(fixture("retrieved_abstract").request),
    });
    assert.equal(response.status, mode === "production" ? 503 : 200);
    const value = await response.json();
    assert.ok(mode === "production" ? schemas.v2Error(value) : schemas.v2Response(value));
    assert.equal(outbound, 0);
  } finally { await runtime.dispose(); }
});
