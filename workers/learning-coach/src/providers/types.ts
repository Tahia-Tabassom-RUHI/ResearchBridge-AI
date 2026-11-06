import type { ValidatedTask } from "../contracts/types";

export interface UsageMeasurement {
  kind: "measured" | "estimated" | "simulated";
  inputTokens?: number;
  outputTokens?: number;
  neurons?: number;
}
export interface ProviderResult { output: unknown; usage?: UsageMeasurement }
export interface InferenceProvider {
  generate(task: ValidatedTask, signal: AbortSignal): Promise<ProviderResult>;
}
export class ProviderFailure extends Error {
  constructor(readonly kind: "error" | "timeout" | "rate_limit") { super("Provider operation failed."); }
}
