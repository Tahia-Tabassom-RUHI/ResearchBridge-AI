import type { FailureMeasurement, FailureReport, QuotaMetric } from "../storage";
import { safeAmount, usageIdentifier } from "./settlement-usage";

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
const reasons = {
  PROVEN_PRE_DISPATCH_FAILURE: ["validation_failed", "preparation_failed", "dispatch_cancelled"],
  POSSIBLY_DISPATCHED_FAILURE: ["connection_failure", "request_timeout", "interrupted_send"],
  CONFIRMED_PROVIDER_ERROR: ["provider_http_error"],
  UNKNOWN_OUTCOME: ["crash_boundary", "response_missing", "ambiguous_response"],
  INVALID_OR_UNTRUSTED_USAGE: ["missing_usage", "malformed_usage", "contradictory_usage", "untrusted_usage", "malformed_response"],
};
export interface NormalizedFailureUsage {
  requests: FailureMeasurement | null;
  inputTokens: FailureMeasurement | null;
  outputTokens: FailureMeasurement | null;
  totalTokens: FailureMeasurement | null;
  computeUnits: Record<string, FailureMeasurement>;
}
export interface NormalizedFailure {
  category: FailureReport["category"];
  reason: FailureReport["reason"];
  httpStatus: number | null;
  usage: NormalizedFailureUsage;
}
function measurement(v: unknown): v is FailureMeasurement {
  return object(v) && Object.keys(v).length === 3 && safeAmount(v.amount) &&
    ((v.kind === "measured" && v.evidence === "provider_report") ||
     (v.kind === "estimated" && v.evidence === "explicit_upper_bound_v1"));
}

// No inference from HTTP status, transport error, provider name or missing field.
// Provider-specific parsing/conversion and evidence verification belong outside
// this internal normalized boundary. Successful settlement validation is unchanged.
export function normalizeFailure(value: FailureReport): NormalizedFailure | "invalid_failure" | "invalid_usage" {
  if (!object(value) || !Object.hasOwn(reasons, value.category) ||
      !reasons[value.category].includes(value.reason) || Object.keys(value).some(k => !["category", "reason", "httpStatus", "usage"].includes(k))) return "invalid_failure";
  const httpStatus = "httpStatus" in value ? value.httpStatus : null;
  if (value.category === "CONFIRMED_PROVIDER_ERROR" ? !Number.isInteger(httpStatus) || httpStatus! < 400 || httpStatus! > 599 : Object.hasOwn(value, "httpStatus")) return "invalid_failure";
  if (value.category === "PROVEN_PRE_DISPATCH_FAILURE" && Object.hasOwn(value, "usage")) return "invalid_usage";
  const raw = "usage" in value ? value.usage : {};
  if (!object(raw) || Object.keys(raw).some(k => !["requests", "inputTokens", "outputTokens", "totalTokens", "computeUnits"].includes(k))) return "invalid_usage";
  for (const k of ["requests", "inputTokens", "outputTokens", "totalTokens"] as const) {
    if (Object.hasOwn(raw, k) && !measurement(raw[k])) return "invalid_usage";
  }
  const compute = Object.hasOwn(raw, "computeUnits") ? raw.computeUnits : {};
  if (!object(compute) || Object.keys(compute).length > 32 || Object.entries(compute).some(([unit, v]) => !usageIdentifier(unit) || !measurement(v))) return "invalid_usage";
  const usage: NormalizedFailureUsage = { requests: raw.requests as FailureMeasurement ?? null,
    inputTokens: raw.inputTokens as FailureMeasurement ?? null, outputTokens: raw.outputTokens as FailureMeasurement ?? null,
    totalTokens: raw.totalTokens as FailureMeasurement ?? null, computeUnits: structuredClone(compute) as Record<string, FailureMeasurement> };
  const input = usage.inputTokens, output = usage.outputTokens, total = usage.totalTokens;
  const partialSum = (input?.amount ?? 0) + (output?.amount ?? 0);
  if (!safeAmount(partialSum)) return "invalid_usage";
  const lower = (input?.kind === "measured" ? input.amount : 0) + (output?.kind === "measured" ? output.amount : 0);
  if (total && total.amount < lower) return "invalid_usage";
  if (input && output) {
    if (total?.kind === "measured" && total.amount > partialSum) return "invalid_usage";
    if (!total) usage.totalTokens = input.kind === "measured" && output.kind === "measured"
      ? { kind: "measured", amount: partialSum, evidence: "provider_report" }
      : { kind: "estimated", amount: partialSum, evidence: "explicit_upper_bound_v1" };
  }
  return { category: value.category, reason: value.reason, httpStatus, usage: structuredClone(usage) };
}

export type FailureAllocation = { basis: "proven_not_sent" | "measured" | "estimated" | "unreported";
  held: number; consumed: number | null; status: "released" | "settled" | "unknown" };
export function failureAllocation(failure: NormalizedFailure, metric: QuotaMetric, unit: string, reserved: number): FailureAllocation | undefined {
  if (failure.category === "PROVEN_PRE_DISPATCH_FAILURE") return { basis: "proven_not_sent", held: 0, consumed: 0, status: "released" };
  const u = failure.usage;
  const fields = { requests: u.requests, input_tokens: u.inputTokens, output_tokens: u.outputTokens, tokens: u.totalTokens,
    compute_units: Object.hasOwn(u.computeUnits, unit) ? u.computeUnits[unit]! : null };
  const m = fields[metric];
  if (m) {
    if (m.kind === "estimated" && m.amount < reserved) return;
    return { basis: m.kind, held: 0, consumed: m.amount, status: m.amount === 0 ? "released" : "settled" };
  }
  // A known component above the original combined-token estimate must not be
  // hidden. This remains a hold, not a claim that total consumption is known.
  const knownComponents = metric === "tokens" ? (u.inputTokens?.amount ?? 0) + (u.outputTokens?.amount ?? 0) : 0;
  return { basis: "unreported", held: Math.max(reserved, knownComponents), consumed: null, status: "unknown" };
}
