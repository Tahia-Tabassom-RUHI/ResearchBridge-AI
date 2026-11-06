import type { UsageMeasurement } from "./providers/types";

export type QuotaMetric = "requests" | "tokens" | "input_tokens" | "output_tokens" | "compute_units";

// Trusted configuration, supplied internally, never taken from a public request.
export interface QuotaWindowPolicy {
  windowId: string;
  model: string; // Empty means a provider-wide window.
  metric: QuotaMetric;
  unit: string;
  capacity: number; // Must match the persisted limit_amount.
  safetyMargin: number; // Absolute integer units, also persisted.
  windowStart: number;
  windowSeconds: number;
}
export interface QuotaAdmissionPolicy {
  provider: string;
  model: string;
  quotaScopeId: string;
  leaseSeconds: number;
  retentionSeconds: number;
  windows: readonly QuotaWindowPolicy[];
}
export interface QuotaAdmissionInput {
  serviceId: string;
  requestId: string;
  provider: string;
  model: string;
  claim?: IdempotencyFence;
  estimate: UsageMeasurement & {
    requests?: number; // Defaults to one provider dispatch.
    computeUnits?: Readonly<Record<string, number>>;
  };
}
type AdmissionContext = Pick<QuotaAdmissionInput, "requestId" | "provider" | "model">;
export type QuotaAdmissionResult = AdmissionContext & (
  { admitted: true; status: "admitted"; reason: "capacity_reserved"; reservationId: string; leaseExpiresAt: number } |
  { admitted: false; status: "insufficient_capacity" | "configuration_missing" | "invalid_request" | "storage_unavailable";
    reason: "quota_exhausted" | "policy_missing" | "invalid_policy" | "window_unavailable" | "invalid_window" |
      "invalid_identifiers" | "invalid_estimate" | "duplicate_request" | "database_binding_missing" |
      "database_error" | "admission_not_confirmed" | "stale_claim";
    resetAt?: number }
);

// D1QuotaAdmission implements admission only. Production inference stays closed.
export interface QuotaAdmission {
  reserve(input: QuotaAdmissionInput): Promise<QuotaAdmissionResult>;
}
export interface UsageReporter {
  settle(input: { reservationId: string; outcome: "completed" | "not_sent" | "unknown"; usage?: UsageMeasurement }): Promise<void>;
}
export interface ProviderHolds {
  get(provider: string, model: string): Promise<{ until: string } | null>;
  extend(provider: string, model: string, until: string): Promise<void>;
}
export type RequestState = "pending" | "reserved" | "dispatched" | "completed" | "failed" | "outcome_unknown";
export interface RequestIdentity {
  serviceId: string;
  keyHash: string;
  payloadHash: string;
  fingerprintKeyId: string;
  responseVersion: "1" | "2";
}
// Internal capability. Never serialize this token or its hashes into HTTP responses.
export interface IdempotencyFence extends RequestIdentity {
  claimId: string;
  token: string;
  generation: number;
}
export type RequestStatus = { state: RequestState | "conflict" | "expired" | "storage_unavailable" | "stale_owner" | "configuration_missing";
  retryable: false };
export type ClaimDecision = { state: "acquired"; fence: IdempotencyFence } | RequestStatus;
export type TransitionDecision = { state: "updated"; fence: IdempotencyFence } | RequestStatus;
export type ReservationState = "reserved" | "sent" | "completed" | "not_sent" | "unknown";
export type AttemptState = "prepared" | "sent" | "completed" | "not_sent" | "unknown";
export type ReconciliationState = "not_requested" | "awaiting";
export interface ReservationLifecycle {
  authorizeDispatch(fence: IdempotencyFence): Promise<TransitionDecision>;
  dispatch(fence: IdempotencyFence): Promise<TransitionDecision>;
  complete(fence: IdempotencyFence): Promise<TransitionDecision>;
  failBeforeDispatch(fence: IdempotencyFence): Promise<TransitionDecision>;
  markUnknown(fence: IdempotencyFence): Promise<TransitionDecision>;
  awaitReconciliation(fence: IdempotencyFence): Promise<TransitionDecision>;
}
export interface IdempotencyStore extends ReservationLifecycle {
  claim(identity: RequestIdentity): Promise<ClaimDecision>;
  lookup(identity: RequestIdentity): Promise<RequestStatus>;
}
