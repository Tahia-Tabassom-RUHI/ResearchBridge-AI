import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import * as schemas from "../.generated/validators.cjs";
import production from "../src/index";
import localEntry from "../src/local";
import { createGateway } from "../src/handlers/gateway";
import { readJson } from "../src/handlers/body";
import { MAX_REQUEST_BYTES } from "../src/config/index";
import { LocalMockProvider, MockSourceResolver, type MockScenario } from "../src/providers/mock";
import type { InferenceProvider } from "../src/providers/types";
import { fixture } from "./fixtures";

const secret = randomBytes(32).toString("hex");
const env = { COACH_SERVICE_SECRET: secret };
const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
const path = "http://127.0.0.1/api/coach/generate";
const body = () => fixture("term_clarification").request;
function request(value: unknown = body(), extra: Record<string, string> = {}): Request {
  return new Request(path, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(value) });
}
function local(scenario: MockScenario = "success", provider: InferenceProvider = new LocalMockProvider(scenario)) {
  return createGateway({ mode: "local", enabled: true, provider, sources: new MockSourceResolver(), timeoutMs: 25 });
}
async function error(response: Response, status: number, code?: string): Promise<void> {
  assert.equal(response.status, status);
  const text = await response.text();
  assert.ok(!text.includes(secret));
  const parsed = JSON.parse(text);
  assert.ok(schemas.v2Error(parsed), text);
  if (code) assert.equal(parsed.error.code, code);
  assert.equal(parsed.error.retryable, false);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
}

for (const authorization of ["", "Bearer wrong", `Bearer ${randomBytes(32).toString("hex")}`, `Basic ${secret}`]) {
  test(`unauthorized request ${authorization ? authorization.split(" ")[0] : "missing"}`, async () => {
    let calls = 0;
    const gateway = local("success", { async generate() { calls++; throw new Error("Must not be called"); } });
    const req = request(body(), { Authorization: authorization });
    await error(await gateway.fetch(req, env), 401, "invalid_request");
    assert.equal(req.bodyUsed, false);
    assert.equal(calls, 0);
  });
}

for (const config of [{}, { COACH_SERVICE_SECRET: "" }, { COACH_SERVICE_SECRET: "short" }]) test("missing or malformed configured secret fails closed", async () => {
  await error(await local().fetch(request(), config), 503);
});

test("health contains only non-sensitive readiness data", async () => {
  const response = await production.fetch(new Request("https://example.test/api/health"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

for (const [endpoint, method, status, allow] of [["/api/coach/generate", "GET", 405, "POST"], ["/api/coach/generate", "OPTIONS", 405, "POST"], ["/api/health", "POST", 405, "GET"], ["/unknown", "GET", 404, null]] as const) {
  test(`method and path validation: ${method} ${endpoint}`, async () => {
    const response = await production.fetch(new Request(`https://example.test${endpoint}`, { method }), env);
    assert.equal(response.headers.get("Allow"), allow);
    await error(response, status);
  });
}

test("production requires HTTPS and never enables inference from environment flags", async () => {
  await error(await production.fetch(request(), env), 400);
  const req = new Request("https://example.test/api/coach/generate", request());
  const response = await production.fetch(req, { ...env, LOCAL_MOCK_ENABLED: "true", MOCK_SCENARIO: "success" });
  assert.equal(response.headers.get("X-ResearchBridge-Inference"), null);
  await error(response, 503, "invalid_response");
});

test("local entry refuses public hostnames and missing explicit mock mode", async () => {
  await error(await localEntry.fetch(new Request("https://example.test/api/coach/generate", request()), { ...env, LOCAL_MOCK_ENABLED: "true" }), 503);
  await error(await localEntry.fetch(request(), env), 503);
  await error(await localEntry.fetch(request(), { ...env, LOCAL_MOCK_ENABLED: "true", MOCK_SCENARIO: "not-a-scenario" }), 503);
});

for (const extra of [{ Origin: "https://student.example" }, { "Sec-Fetch-Site": "same-origin" }]) test("browser-shaped requests are rejected even with a service token", async () => {
  await error(await local().fetch(request(body(), extra), env), 403);
});

for (const name of ["abstract_one_section", "learning_hints", "term_clarification", "retrieved_abstract"]) test(`valid mock task: ${name}`, async () => {
  const response = await local().fetch(request(fixture(name).request), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-ResearchBridge-Inference"), "mock");
  assert.equal(response.headers.get("X-ResearchBridge-Response-Version"), "2");
  const value = await response.json() as { source_coverage: { origin: string; full_paper_verified: boolean } };
  assert.ok(schemas.v2Response(value));
  assert.equal(value.source_coverage.full_paper_verified, false);
  assert.equal(value.source_coverage.origin, name === "retrieved_abstract" ? "verified_retrieval" : name === "term_clarification" ? "none" : "user_supplied");
});

test("v1 response selection retains the bare four-card pack", async () => {
  const response = await local().fetch(request(fixture("abstract_one_section").request, { "X-ResearchBridge-Response-Version": "1" }), env);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.ok(schemas.v1Response(value));
  assert.deepEqual(Object.keys(value as object), ["research_problem", "method", "findings", "limitations"]);
  assert.equal(response.headers.get("X-ResearchBridge-Response-Version"), "1");
  await error(await local().fetch(request(body(), { "X-ResearchBridge-Response-Version": "1" }), env), 400);
  await error(await local().fetch(request(body(), { "X-ResearchBridge-Response-Version": "3" }), env), 400, "unsupported_version");
});

for (const name of ["unknown_task", "unknown_version", "unknown_paper_reference", "missing_abstract"]) test(`request rejection: ${name}`, async () => {
  const item = fixture(name);
  await error(await local().fetch(request(item.request), env), 400, item.expected_error!);
});

for (const value of [null, [], {}, { contract_version: "2", task_id: "term_clarification", input: {} }, { contract_version: "2", task_id: "term_clarification", input: { term: "classification" }, user_id: "trusted-student" }]) {
  test("malformed request shape is rejected", async () => { await error(await local().fetch(request(value), env), 400); });
}

test("inline trusted source context is rejected", async () => {
  const item = fixture("retrieved_abstract");
  const value = { ...(item.request as object), verified_sources: item.verified_sources };
  await error(await local().fetch(request(value), env), 400, "invalid_request");
});

test("server-owned source schema is checked after resolution", async () => {
  const gateway = createGateway({ mode: "local", enabled: true, provider: new LocalMockProvider(), sources: { async resolve() { return { title: "Unverified record" }; } } });
  await error(await gateway.fetch(request(fixture("retrieved_abstract").request), env), 400, "invalid_source");
});

test("malformed UTF-8, malformed JSON, unsupported media, and encoding are rejected", async () => {
  for (const malformed of ["{", "NaN", new Uint8Array([255])]) await error(await local().fetch(new Request(path, { method: "POST", headers, body: malformed }), env), 400);
  await error(await local().fetch(request(body(), { "Content-Type": "text/plain" }), env), 415);
  await error(await local().fetch(request(body(), { "Content-Encoding": "gzip" }), env), 415);
});

test("declared and actual byte sizes are both bounded", async () => {
  await error(await local().fetch(request(body(), { "Content-Length": String(MAX_REQUEST_BYTES + 1) }), env), 413);
  const payload = JSON.stringify({ padding: "🧪".repeat(MAX_REQUEST_BYTES / 3) });
  await error(await local().fetch(new Request(path, { method: "POST", headers: { ...headers, "Content-Length": "1" }, body: payload }), env), 413);
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close();
  } });
  const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body: stream, duplex: "half" };
  await error(await local().fetch(new Request(path, init), env), 413);
});

test("a stalled body reader has a bounded deadline", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body: stream, duplex: "half" };
  await assert.rejects(readJson(new Request(path, init), 10), { status: 408 });
  assert.ok(cancelled);
});

for (const [scenario, status] of [["error", 502], ["timeout", 504], ["rate_limit", 429], ["malformed", 502]] as const) test(`mock fault: ${scenario}`, async () => {
  const response = await local(scenario).fetch(request(), env);
  if (scenario === "rate_limit") assert.equal(response.headers.get("Retry-After"), "30");
  await error(response, status, "invalid_response");
});

test("provider errors and invalid results never leak raw secrets or source text", async () => {
  const privateText = "private-student-source-content";
  const provider: InferenceProvider = { async generate() { throw new Error(`${secret} ${privateText}`); } };
  const response = await local("success", provider).fetch(request(), env);
  const text = await response.clone().text();
  assert.ok(!text.includes(privateText));
  await error(response, 502);
});

test("the timeout also bounds a provider that ignores cancellation", async () => {
  const provider: InferenceProvider = { generate() { return new Promise(() => undefined); } };
  await error(await local("success", provider).fetch(request(), env), 504);
});

test("provider usage is explicitly simulated and stays out of the response contract", async () => {
  const provider = new LocalMockProvider();
  const parsed = fixture("term_clarification").request;
  const { validateRequest } = await import("../src/contracts/index");
  const result = await provider.generate({ request: validateRequest(parsed), source: null, responseVersion: "2" }, new AbortController().signal);
  assert.equal(result.usage?.kind, "simulated");
  const response = await local("success", provider).fetch(request(), env);
  assert.equal("usage" in (await response.json() as object), false);
});

test("mock execution has no outbound fetch dependency", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Outbound networking forbidden"); };
  try { assert.equal((await local().fetch(request(), env)).status, 200); }
  finally { globalThis.fetch = saved; }
});
