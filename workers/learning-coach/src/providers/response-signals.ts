import type { CapacityProvider } from "../config/provider-policy";
import type { FailureUsage, ProviderHoldDimension } from "../storage";
import type { ProviderAttempt } from "./types";
import type { Deadline } from "./response-time";

export type ResponseTransport = "groq_http" | "workers_ai_http" | "workers_ai_binding";
export type ResponseClassification = "quota_exhausted" | "rate_limited" | "temporary_capacity_unavailable" |
  "model_deprecated" | "paid_plan_required" | "model_unavailable" | "model_access_denied" |
  "provider_authentication_failure" | "invalid_request" | "provider_error" | "provider_timeout" |
  "connection_interrupted" | "usage_observation" | "capacity_observation" | "insufficient_evidence";
export type EvidenceIssue = "invalid_headers" | "conflicting_headers" | "invalid_quota" | "invalid_reset" |
  "invalid_retry" | "unexpected_retry" | "clock_uncertain" | "capacity_above_policy" | "unsupported_dimension" |
  "reset_policy_conflict" | "invalid_body" | "contradictory_response" | "invalid_usage" | "unsupported_usage" |
  "unknown_error_code";
export interface QuotaSignal {
  dimension: ProviderHoldDimension;
  limit: number | null;
  remaining: number | null;
  reset: Deadline;
  quality: "verified" | "partial" | "invalid" | "unsupported";
}
export interface ProviderObservation extends ProviderAttempt {
  provider: CapacityProvider;
  quotaScopeId: string;
  policyVersion: number;
  source: ResponseTransport;
  observedAt: number;
  httpStatus: number | null;
  providerErrorCode: number | null;
  classification: ResponseClassification;
  quality: "verified" | "partial" | "insufficient" | "invalid";
  quotas: QuotaSignal[];
  retry: Deadline;
  usage: { origin: "provider_report"; measurements: FailureUsage } | null;
  issues: EvidenceIssue[];
}
export type ParsedSignals = Pick<ProviderObservation, "httpStatus" | "providerErrorCode" | "classification" | "quotas" | "retry" | "usage" | "issues">;
export type ParseRejection = { state: "rejected"; reason: "invalid_context" | "policy_unavailable" | "invalid_transport" |
  "invalid_metadata" | "identity_mismatch" | "clock_unavailable" | "stale_context" | "already_observed" };
export type ObservationResult = { state: "observed"; observation: ProviderObservation } | ParseRejection;
export type ProviderResponseMetadata =
  { kind: "http_response"; status: number; headers?: readonly (readonly [string, string])[]; body?: unknown } |
  { kind: "binding_result"; body: unknown } |
  { kind: "binding_error"; namespace: "workers_ai"; code: number } |
  { kind: "transport_failure"; failure: "timeout" | "interrupted" };

export const plainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
export const onlyKeys = (v: unknown, keys: string[]): v is Record<string, unknown> => plainObject(v) && Object.keys(v).every(k => keys.includes(k));
export const emptySignals = (): ParsedSignals => ({ httpStatus: null, providerErrorCode: null, classification: "insufficient_evidence",
  quotas: [], retry: { state: "missing" }, usage: null, issues: [] });
export function httpClassification(status: number): ResponseClassification {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "provider_authentication_failure";
  if (status === 408 || status === 504) return "provider_timeout";
  if (status === 400 || status === 422) return "invalid_request";
  return status >= 400 ? "provider_error" : "insufficient_evidence";
}
