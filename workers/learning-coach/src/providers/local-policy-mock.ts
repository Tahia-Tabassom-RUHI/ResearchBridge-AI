import { providerPolicyJson, resetBounds, type ProviderCapacityPolicy } from "../config/provider-policy";
import type { ValidatedTask } from "../contracts/types";
import type { FailureUsage } from "../storage";
import { canonicalJson } from "../storage/request-identity";
import { LocalMockProvider } from "./mock";
import type { InferenceProvider, ProviderAttempt, ProviderResult } from "./types";

export const POLICY_MOCK_SCENARIOS = ["success", "overage", "missing_usage", "partial_usage", "malformed_content",
  "daily_exhausted", "temporary_capacity", "paid_required", "deprecated", "access_denied", "model_unavailable",
  "unknown_error", "malformed_metadata", "timeout", "rpd_exhausted", "tpm_exhausted", "retry_after",
  "missing_reset", "zero_remaining", "error", "error_partial_usage", "contradictory_headers"] as const;
export type PolicyMockScenario = typeof POLICY_MOCK_SCENARIOS[number];
export interface LocalResponseFixture { metadata: unknown; counters?: FailureUsage }
type Fixture = (policy: ProviderCapacityPolicy, now: number) => LocalResponseFixture;

function fixture(scenario: PolicyMockScenario, p: ProviderCapacityPolicy, now: number): LocalResponseFixture {
  const measured = (amount: number) => ({ kind: "measured" as const, amount, evidence: "provider_report" as const });
  if (scenario === "timeout") return { metadata: { kind: "transport_failure", failure: "timeout" } };
  if (scenario === "malformed_metadata") return { metadata: { source: "browser", usage: "invalid" } };
  const missing = scenario === "missing_usage", partial = ["partial_usage", "error_partial_usage"].includes(scenario);
  const usage = missing ? undefined : partial ? { prompt_tokens: 8 } : scenario === "overage"
    ? { prompt_tokens: 200, completion_tokens: 300 } : { prompt_tokens: 8, completion_tokens: 12 };
  const headers: [string, string][] = [];
  let status = scenario === "error" || scenario === "error_partial_usage" || scenario === "unknown_error" ? 500 : 200;
  let body: unknown;
  if (p.provider === "cloudflare_workers_ai") {
    const codes: Partial<Record<PolicyMockScenario, [number, number]>> = { daily_exhausted: [3036, 429],
      temporary_capacity: [3040, 429], paid_required: [5035, 403], deprecated: [5028, 410],
      access_denied: [5018, 403], model_unavailable: [3042, 404], unknown_error: [9999, 500] };
    const error = codes[scenario]; if (error) status = error[1];
    body = { success: status < 400, ...(error ? { errors: [{ code: error[0] }] } : {}),
      result: { model: p.model, ...(usage && (status < 400 || partial) ? { usage } : {}) } };
  } else {
    const requests = ["rpd_exhausted", "missing_reset", "zero_remaining"].includes(scenario);
    if (requests || scenario === "tpm_exhausted") {
      const metric = requests ? "requests" : "tokens", seconds = requests ? 86400 : 60;
      const d = p.dimensions.find(d => d.metric === metric && (d.window.kind === "utc_day" ? 86400 : d.window.seconds) === seconds)!;
      headers.push([`x-ratelimit-remaining-${metric}`, "0"]);
      if (scenario !== "missing_reset") headers.push([`x-ratelimit-reset-${metric}`, `${resetBounds(d.window, now).end - now}s`]);
      if (scenario !== "zero_remaining") status = 429;
    }
    if (scenario === "retry_after") { status = 429; headers.push(["retry-after", "17"]); }
    if (scenario === "contradictory_headers") headers.push(["x-ratelimit-limit-tokens", "10"], ["x-ratelimit-remaining-tokens", "20"]);
    body = { model: p.model, ...(status >= 400 ? { error: { type: "synthetic_error" } } : {}),
      ...(usage && (status < 400 || partial) ? { usage } : {}) };
  }
  return { metadata: { kind: "http_response", status, headers, body },
    ...(!missing && status < 400 ? { counters: { requests: measured(1),
      ...(p.provider === "cloudflare_workers_ai" ? { computeUnits: { neurons: measured(scenario === "overage" ? 20 : 1) } } : {}) } } : {}) };
}

// The WeakMap is the local execution capability: a JSON copy or arbitrary
// InferenceProvider cannot manufacture an accepted result. Fixture injection is
// internal only, never read from an HTTP body or header. No transport performs I/O.
export class LocalPolicyMockProvider implements InferenceProvider {
  readonly #policy: ProviderCapacityPolicy;
  readonly #results = new WeakMap<object, { binding: string; fixture: LocalResponseFixture }>();
  constructor(policy: ProviderCapacityPolicy, private readonly scenario: PolicyMockScenario = "success",
    private readonly responseFixture?: Fixture, private readonly clock = () => Math.floor(Date.now() / 1000)) {
    if (!policy || typeof policy.provider !== "string" || typeof policy.model !== "string") throw new Error("Missing local policy");
    this.#policy = structuredClone(policy);
  }
  get identity() { return { provider: this.#policy.provider, model: this.#policy.model }; }
  matches(policy: ProviderCapacityPolicy) { return providerPolicyJson(policy) === providerPolicyJson(this.#policy); }
  async generate(task: ValidatedTask, signal: AbortSignal, attempt?: ProviderAttempt): Promise<ProviderResult> {
    if (!attempt || attempt.provider !== this.#policy.provider || attempt.model !== this.#policy.model) throw new Error("Invalid local attempt");
    const output = await new LocalMockProvider(this.scenario === "malformed_content" ? "malformed" : "success").generate(task, signal);
    const result = { output: output.output };
    this.#results.set(result, { binding: canonicalJson(attempt), fixture: structuredClone(this.responseFixture
      ? this.responseFixture(structuredClone(this.#policy), this.clock()) : fixture(this.scenario, this.#policy, this.clock())) });
    return result;
  }
  take(result: ProviderResult, attempt: ProviderAttempt): LocalResponseFixture | undefined {
    const stored = this.#results.get(result); this.#results.delete(result);
    return stored?.binding === canonicalJson(attempt) ? stored.fixture : undefined;
  }
}
