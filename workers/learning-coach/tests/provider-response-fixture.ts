import assert from "node:assert/strict";
import type { CapacityProvider, ProviderCapacityPolicy } from "../src/config/provider-policy";
import { ProviderResponseParser } from "../src/providers/response-parser";
import type { ObservationResult, ResponseTransport } from "../src/providers/response-signals";
import type { HoldAdaptation } from "../src/providers/response-hold-adapter";
import { policyFixture, POLICY_TIME } from "./provider-policy-fixture";
export const NOW = POLICY_TIME;
export function responseFixture(provider: CapacityProvider = "groq", transport: ResponseTransport = provider === "groq" ? "groq_http" : "workers_ai_binding",
  policy: ProviderCapacityPolicy = policyFixture(provider, NOW - 10)) {
  let now = NOW;
  const attempt = { provider, model: policy.model, attemptId: "11111111-1111-4111-8111-111111111111", reservationId: "22222222-2222-4222-8222-222222222222" };
  const create = () => {
    const result = ProviderResponseParser.create(policy, attempt, transport, () => now);
    assert.equal(result.state, "ready", JSON.stringify(result)); if (result.state !== "ready") throw new Error("Invalid fixture"); return result.parser;
  };
  return { policy, attempt, parser: create(), create, time: (value: number) => { now = value; }, clock: () => now };
}
export function observed(result: ObservationResult) { assert.equal(result.state, "observed", JSON.stringify(result)); if (result.state !== "observed") throw new Error("Rejected"); return result.observation; }
export function adapted(result: HoldAdaptation) { assert.ok("evidence" in result, JSON.stringify(result)); return result; }
export const operation = "33333333-3333-4333-8333-333333333333";
export const http = (status = 200, headers: readonly (readonly [string, string])[] = [], body?: unknown) =>
  ({ kind: "http_response", status, headers, ...(body === undefined ? {} : { body }) });
export const header = (name: string, value: string): [string, string] => [`x-ratelimit-${name}`, value];
