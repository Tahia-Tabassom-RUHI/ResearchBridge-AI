import type { FailureUsage } from "../storage";
import { normalizeFailure } from "../storage/failure-usage";
import { safeAmount } from "../storage/settlement-usage";
import { plainObject, type EvidenceIssue, type ProviderObservation } from "./response-signals";

// Both reviewed chat-completion schemas use these token fields. A usage object
// is not proof of a request count or measured compute/neuron charge.
export function parseTokenUsage(raw: unknown): { usage: ProviderObservation["usage"]; issues: EvidenceIssue[] } {
  if (raw === undefined) return { usage: null, issues: [] };
  if (!plainObject(raw)) return { usage: null, issues: ["invalid_usage"] };
  if (["neurons", "compute_units", "requests", "input_tokens", "output_tokens", "unit", "kind"].some(k => Object.hasOwn(raw, k))) {
    return { usage: null, issues: ["unsupported_usage"] };
  }
  const usage: FailureUsage = {};
  for (const [source, target] of [["prompt_tokens", "inputTokens"], ["completion_tokens", "outputTokens"], ["total_tokens", "totalTokens"]] as const) {
    if (!Object.hasOwn(raw, source)) continue;
    const amount = raw[source]; if (!safeAmount(amount)) return { usage: null, issues: ["invalid_usage"] };
    usage[target] = { kind: "measured", amount, evidence: "provider_report" };
  }
  if (!Object.keys(usage).length) return { usage: null, issues: ["unsupported_usage"] };
  if (typeof normalizeFailure({ category: "UNKNOWN_OUTCOME", reason: "response_missing", usage }) === "string") {
    return { usage: null, issues: ["invalid_usage"] };
  }
  // Preserve missing fields, including a missing total. Existing accounting can
  // derive a validated sum later; this layer records only reported measurements.
  return { usage: { origin: "provider_report", measurements: usage }, issues: [] };
}
