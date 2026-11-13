import fixtures from "../../../../contracts/learning-coach/fixtures/cases.json";
import { NOT_STATED } from "../contracts/index";
import type { ValidatedTask } from "../contracts/types";
import type { SourceResolver } from "../sources";
import { ProviderFailure, type InferenceProvider, type ProviderResult, type ProviderAttempt } from "./types";
import { mockEnvelope } from "./mock-evidence";

export const SCENARIOS = ["success", "error", "timeout", "rate_limit", "malformed", "unavailable", "pre_dispatch_failure",
  "equal", "overage", "estimated", "missing_usage", "malformed_usage", "error_with_usage", "error_partial_usage"] as const;
export type MockScenario = typeof SCENARIOS[number];
export class LocalMockProvider implements InferenceProvider {
  readonly identity = { provider: "mock", model: "mock-model" };
  constructor(private readonly scenario: MockScenario = "success") {}

  prepare() {
    if (this.scenario === "unavailable" || this.scenario === "pre_dispatch_failure") throw new ProviderFailure("error");
  }

  async generate(task: ValidatedTask, signal: AbortSignal, attempt?: ProviderAttempt): Promise<ProviderResult> {
    if (this.scenario === "timeout") return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new ProviderFailure("timeout"));
      else signal.addEventListener("abort", () => reject(new ProviderFailure("timeout")), { once: true });
    });
    if (this.scenario === "error" || this.scenario === "rate_limit") throw new ProviderFailure(this.scenario);
    if (this.scenario === "error_with_usage" || this.scenario === "error_partial_usage") {
      const measured = (amount: number) => ({ kind: "measured", amount, evidence: "provider_report" });
      const usage = { requests: measured(1), ...(this.scenario === "error_with_usage" ? {
        inputTokens: measured(8), outputTokens: measured(12), computeUnits: { milli_neurons: measured(25) } } : {}) };
      throw new ProviderFailure("error", attempt ? mockEnvelope(attempt, usage) : undefined);
    }
    if (this.scenario === "malformed") return { output: { unexpected: "Malformed local fixture" } };
    let output: unknown;
    if (task.responseVersion === "1") {
      output = Object.fromEntries(["research_problem", "method", "findings", "limitations"].map(key => [key, { explanation: NOT_STATED, supporting_excerpt: null }]));
    } else if (task.request.task_id === "abstract_explanation") {
      output = { sections: [{ id: "mock_problem", focus: "research_problem", explanation: NOT_STATED, supporting_excerpt: null },
        { id: "mock_limitations", focus: "limitations", explanation: NOT_STATED, supporting_excerpt: null }] };
    } else if (task.request.task_id === "learning_hints") {
      output = { hints: [{ hint: NOT_STATED, supporting_excerpt: null }] };
    } else output = { definition: "Mock definition for local contract testing.", example: "Mock example; no educational inference was performed." };
    const accounting = this.scenario === "malformed_usage" ? { kind: "measured", requests: 1, inputTokens: -1 } :
      this.scenario === "equal" ? { kind: "measured", requests: 1, inputTokens: 10, outputTokens: 20, computeUnits: { milli_neurons: 40 } } :
      this.scenario === "overage" || this.scenario === "estimated" ? { kind: this.scenario === "estimated" ? "estimated" : "measured",
        ...(this.scenario === "estimated" ? { estimatePolicy: "explicit_upper_bound_v1" } : {}),
        requests: 2, inputTokens: 20, outputTokens: 30, computeUnits: { milli_neurons: 60 } } :
      { kind: "measured", requests: 1, inputTokens: 8, outputTokens: 12, computeUnits: { milli_neurons: 25 } };
    return { output, usage: { kind: "simulated", inputTokens: 0, outputTokens: 0 },
      ...(attempt && this.scenario !== "missing_usage" ? { accounting: mockEnvelope(attempt, accounting) } : {}) };
  }
}

export class MockSourceResolver implements SourceResolver {
  async resolve(sourceId: string): Promise<unknown | undefined> {
    const sources = fixtures.cases.find(item => item.name === "retrieved_abstract")?.verified_sources;
    if (!sources || !Object.hasOwn(sources, sourceId)) return undefined;
    return structuredClone((sources as Record<string, unknown>)[sourceId]);
  }
}
