import { providerPolicyJson, validateProviderPolicy, type ProviderCapacityPolicy } from "../config/provider-policy";
import type { FailureUsage } from "../storage";
import { requestIdPattern } from "../storage/request-identity";
import { cloudflareSignals } from "./cloudflare-response";
import { groqSignals } from "./groq-response";
import { ResponseHeaders } from "./response-headers";
import { adaptHoldSignals, type HoldAdaptation } from "./response-hold-adapter";
import { emptySignals, onlyKeys, plainObject, type ObservationResult, type ParsedSignals, type ParseRejection,
  type ProviderObservation, type ResponseTransport } from "./response-signals";
import { MAX_OBSERVATION_AGE_SECONDS, timestamp } from "./response-time";
import type { ProviderAttempt } from "./types";

const reject = (reason: ParseRejection["reason"]): ParseRejection => ({ state: "rejected", reason });
function validAttempt(a: unknown, p: ProviderCapacityPolicy): a is ProviderAttempt {
  return onlyKeys(a, ["provider", "model", "reservationId", "attemptId"]) && a.provider === p.provider && a.model === p.model &&
    typeof a.reservationId === "string" && requestIdPattern.test(a.reservationId) && typeof a.attemptId === "string" && requestIdPattern.test(a.attemptId);
}

// Internal capability, never constructed from a public request. Creating this
// object attests to transport origin; parsing bytes cannot authenticate it.
// No live adapter, route, fetch, D1 binding or provider credential is used here.
export class ProviderResponseParser {
  readonly #policy: ProviderCapacityPolicy;
  readonly #attempt: ProviderAttempt;
  readonly #transport: ResponseTransport;
  readonly #clock: () => number;
  readonly #startedAt: number;
  readonly #observations = new WeakMap<object, ProviderObservation>();
  #used = false;
  private constructor(p: ProviderCapacityPolicy, attempt: ProviderAttempt, transport: ResponseTransport,
    clock: () => number, startedAt: number) {
    this.#policy = structuredClone(p); this.#attempt = structuredClone(attempt);
    this.#transport = transport; this.#clock = clock; this.#startedAt = startedAt;
  }
  static create(policy: unknown, attempt: unknown, transport: ResponseTransport, clock: () => number):
    { state: "ready"; parser: ProviderResponseParser } | ParseRejection {
    try {
      const now = clock(); if (!timestamp(now)) return reject("clock_unavailable");
      const valid = validateProviderPolicy(policy, now);
      if (valid.state !== "valid") return reject("policy_unavailable");
      if (!validAttempt(attempt, valid.policy)) return reject("invalid_context");
      if (valid.policy.provider === "groq" ? transport !== "groq_http" : !["workers_ai_http", "workers_ai_binding"].includes(transport)) return reject("invalid_transport");
      return { state: "ready", parser: new ProviderResponseParser(valid.policy, attempt, transport, clock, now) };
    } catch { return reject("invalid_context"); }
  }

  observe(metadata: unknown): ObservationResult {
    if (this.#used) return reject("already_observed");
    this.#used = true;
    try {
      const now = this.#clock(); if (!timestamp(now)) return reject("clock_unavailable");
      if (now < this.#startedAt || now - this.#startedAt > MAX_OBSERVATION_AGE_SECONDS) return reject("stale_context");
      if (!plainObject(metadata)) return reject("invalid_metadata");
      let parsed: ParsedSignals;
      if (metadata.kind === "transport_failure") {
        if (!onlyKeys(metadata, ["kind", "failure"]) || !["timeout", "interrupted"].includes(metadata.failure as string)) return reject("invalid_metadata");
        parsed = emptySignals(); parsed.classification = metadata.failure === "timeout" ? "provider_timeout" : "connection_interrupted";
      } else if (metadata.kind === "http_response") {
        if (this.#transport === "workers_ai_binding" || !onlyKeys(metadata, ["kind", "status", "headers", "body"]) ||
            !Number.isInteger(metadata.status) || Number(metadata.status) < 200 || Number(metadata.status) > 599 ||
            (Number(metadata.status) >= 300 && Number(metadata.status) < 400)) return reject("invalid_metadata");
        if (!this.modelMatches(metadata.body)) return reject("identity_mismatch");
        const headers = new ResponseHeaders(metadata.headers);
        parsed = this.#transport === "groq_http" ? groqSignals(this.#policy, Number(metadata.status), headers, metadata.body, now) :
          cloudflareSignals(this.#policy, Number(metadata.status), headers, metadata.body, undefined, now);
      } else if (metadata.kind === "binding_error") {
        if (this.#transport !== "workers_ai_binding" || !onlyKeys(metadata, ["kind", "namespace", "code"]) || metadata.namespace !== "workers_ai" ||
            !Number.isSafeInteger(metadata.code) || Number(metadata.code) < 1 || Number(metadata.code) > 99999) return reject("invalid_metadata");
        parsed = cloudflareSignals(this.#policy, null, new ResponseHeaders(undefined), undefined, Number(metadata.code), now);
      } else if (metadata.kind === "binding_result") {
        if (this.#transport !== "workers_ai_binding" || !onlyKeys(metadata, ["kind", "body"]) || !Object.hasOwn(metadata, "body")) return reject("invalid_metadata");
        if (!this.modelMatches(metadata.body)) return reject("identity_mismatch");
        parsed = cloudflareSignals(this.#policy, null, new ResponseHeaders(undefined), metadata.body, undefined, now);
      } else return reject("invalid_metadata");
      parsed.issues = [...new Set(parsed.issues)];
      const observation: ProviderObservation = { ...this.#attempt, provider: this.#policy.provider, quotaScopeId: this.#policy.quotaScopeId,
        policyVersion: this.#policy.version, source: this.#transport, observedAt: now, ...parsed,
        quality: parsed.issues.includes("contradictory_response") || parsed.issues.includes("invalid_body") ? "invalid" :
          parsed.issues.length ? "partial" : parsed.classification === "insufficient_evidence" ? "insufficient" : "verified" };
      // Private immutable snapshot: callers may display or mutate their view,
      // but mutations and JSON copies can never alter authorized evidence.
      this.#observations.set(observation, structuredClone(observation));
      return { state: "observed", observation };
    } catch { return reject("invalid_metadata"); }
  }
  private modelMatches(body: unknown): boolean {
    if (!plainObject(body)) return true;
    const matches = (value: Record<string, unknown>) => Object.entries({ provider: this.#policy.provider, model: this.#attempt.model,
      quotaScopeId: this.#policy.quotaScopeId, account_id: this.#policy.quotaScopeId,
      reservationId: this.#attempt.reservationId, attemptId: this.#attempt.attemptId, policyVersion: this.#policy.version })
      .every(([key, expected]) => !Object.hasOwn(value, key) || value[key] === expected);
    return matches(body) && (!plainObject(body.result) || matches(body.result));
  }
  private trusted(value: unknown): ProviderObservation | undefined {
    if (!plainObject(value)) return;
    const original = this.#observations.get(value);
    // Reject mutation instead of silently interpreting a changed displayed view.
    if (!original || JSON.stringify(original) !== JSON.stringify(value)) return;
    return original;
  }
  async holdEvidence(value: unknown, operationId: string, currentPolicy: unknown = this.#policy): Promise<HoldAdaptation> {
    try {
      const o = this.trusted(value); if (!o) return { state: "rejected", reason: "untrusted_observation" };
      const now = this.#clock();
      if (!timestamp(now) || now < o.observedAt || now - o.observedAt > MAX_OBSERVATION_AGE_SECONDS) return { state: "rejected", reason: "stale_observation" };
      const valid = validateProviderPolicy(currentPolicy, now);
      if (valid.state !== "valid" || providerPolicyJson(valid.policy) !== providerPolicyJson(this.#policy)) return { state: "rejected", reason: "policy_unavailable" };
      return await adaptHoldSignals(o, valid.policy, operationId, now);
    } catch { return { state: "rejected", reason: "untrusted_observation" }; }
  }
  usageEvidence(value: unknown, attempt: ProviderAttempt): FailureUsage | undefined {
    try {
      const o = this.trusted(value); if (!o || !validAttempt(attempt, this.#policy) ||
          attempt.attemptId !== o.attemptId || attempt.reservationId !== o.reservationId || o.quality === "invalid") return;
      // Measured usage remains a historical fact after a quota/reset/review
      // boundary. Actual settlement still requires current durable ownership.
      return o.usage ? structuredClone(o.usage.measurements) : undefined;
    } catch { return; }
  }
}
