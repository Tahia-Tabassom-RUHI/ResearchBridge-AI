import type { ValidatedTask } from "../contracts/types";

export interface UsageMeasurement {
  kind: "measured" | "estimated" | "simulated";
  inputTokens?: number;
  outputTokens?: number;
  neurons?: number;
}
export interface ProviderAttempt { provider: string; model: string; reservationId: string; attemptId: string }
export interface ProviderResult { output: unknown; usage?: UsageMeasurement; accounting?: unknown }
export interface InferenceProvider {
  readonly identity: { provider: string; model: string };
  // Local preparation only. It must never dispatch or perform external I/O.
  prepare?(task: ValidatedTask): void;
  generate(task: ValidatedTask, signal: AbortSignal, attempt?: ProviderAttempt): Promise<ProviderResult>;
}
export class ProviderFailure extends Error {
  constructor(readonly kind: "error" | "timeout" | "rate_limit", readonly accounting?: unknown) { super("Provider operation failed."); }
}
