import fixtures from "../../../../contracts/learning-coach/fixtures/cases.json";
import { NOT_STATED } from "../contracts/index";
import type { ValidatedTask } from "../contracts/types";
import type { SourceResolver } from "../sources";
import { ProviderFailure, type InferenceProvider, type ProviderResult } from "./types";

export const SCENARIOS = ["success", "error", "timeout", "rate_limit", "malformed"] as const;
export type MockScenario = typeof SCENARIOS[number];
export class LocalMockProvider implements InferenceProvider {
  constructor(private readonly scenario: MockScenario = "success") {}

  async generate(task: ValidatedTask, signal: AbortSignal): Promise<ProviderResult> {
    if (this.scenario === "timeout") return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new ProviderFailure("timeout"));
      else signal.addEventListener("abort", () => reject(new ProviderFailure("timeout")), { once: true });
    });
    if (this.scenario === "error" || this.scenario === "rate_limit") throw new ProviderFailure(this.scenario);
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
    return { output, usage: { kind: "simulated", inputTokens: 0, outputTokens: 0 } };
  }
}

export class MockSourceResolver implements SourceResolver {
  async resolve(sourceId: string): Promise<unknown | undefined> {
    const sources = fixtures.cases.find(item => item.name === "retrieved_abstract")?.verified_sources;
    if (!sources || !Object.hasOwn(sources, sourceId)) return undefined;
    return structuredClone((sources as Record<string, unknown>)[sourceId]);
  }
}
