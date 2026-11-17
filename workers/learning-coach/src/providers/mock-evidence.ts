import type { FailureMeasurement, FailureReport, FailureUsage, SettlementUsage } from "../storage";
import { normalizeFailure } from "../storage/failure-usage";
import { consumption, normalizeSettlementUsage, safeAmount } from "../storage/settlement-usage";
import type { OwnedAttempt } from "../storage/d1-owned-attempt";
import type { ProviderAttempt } from "./types";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
// Synthetic local evidence only. This is never a public request DTO or a live
// provider usage parser. Measured fields describe deterministic mock counters.
export function mockEnvelope(attempt: ProviderAttempt, usage: unknown) {
  return { source: "local_mock", ...attempt, usage };
}
function evidence(value: unknown, attempt: ProviderAttempt): unknown {
  if (!object(value) || Object.keys(value).some(k => !["source", "provider", "model", "reservationId", "attemptId", "usage"].includes(k)) ||
      value.source !== "local_mock" || attempt.provider !== "mock" || attempt.model !== "mock-model" ||
      ["provider", "model", "reservationId", "attemptId"].some(k => value[k] !== attempt[k as keyof ProviderAttempt])) return;
  return value.usage;
}
export function successfulMockUsage(value: unknown, attempt: OwnedAttempt): SettlementUsage | undefined {
  const raw = evidence(value, attempt), usage = normalizeSettlementUsage(raw as SettlementUsage);
  if (!usage || attempt.windows.some(w => {
    const amount = consumption(usage, w.metric, w.unit);
    return !safeAmount(amount) || (usage.kind === "estimated" && amount < w.reserved);
  })) return;
  return structuredClone(raw) as SettlementUsage;
}
export function failedMockUsage(value: unknown, attempt: ProviderAttempt): FailureUsage | undefined {
  const raw = evidence(value, attempt);
  if (!object(raw)) return;
  // Content rejection does not invalidate independent, validated accounting
  // evidence. Preserve reported overages/partial usage even without a response.
  const usage = normalizeSettlementUsage(raw as unknown as SettlementUsage);
  if (usage) {
    const measure = (amount: number): FailureMeasurement => usage.kind === "measured"
      ? { kind: "measured", amount, evidence: "provider_report" }
      : { kind: "estimated", amount, evidence: "explicit_upper_bound_v1" };
    return { requests: measure(usage.requests), ...(usage.inputTokens === null ? {} : { inputTokens: measure(usage.inputTokens) }),
      ...(usage.outputTokens === null ? {} : { outputTokens: measure(usage.outputTokens) }),
      ...(usage.totalTokens === null ? {} : { totalTokens: measure(usage.totalTokens) }),
      computeUnits: Object.fromEntries(Object.entries(usage.computeUnits).map(([unit, amount]) => [unit, measure(amount)])) };
  }
  const normalized = normalizeFailure({ category: "UNKNOWN_OUTCOME", reason: "response_missing", usage: raw as FailureUsage });
  return typeof normalized === "string" ? undefined : structuredClone(raw) as FailureUsage;
}
export function malformedUsageFailure(missing: boolean): Extract<FailureReport, { category: "INVALID_OR_UNTRUSTED_USAGE" }> {
  return { category: "INVALID_OR_UNTRUSTED_USAGE", reason: missing ? "missing_usage" : "untrusted_usage" };
}
