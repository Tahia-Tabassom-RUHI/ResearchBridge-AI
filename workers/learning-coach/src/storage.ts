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
  requireResponseEvidence?: true;
  provider: string;
  model: string;
  quotaScopeId: string;
  leaseSeconds: number;
  retentionSeconds: number;
  windows: readonly QuotaWindowPolicy[];
  providerPolicy?: { version: number; hash: string; reviewAfter: number };
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
  { admitted: false; status: "insufficient_capacity" | "configuration_missing" | "invalid_request" | "storage_unavailable" |
      "provider_held" | "model_held" | "quota_dimension_held" | "provider_capacity_unknown" | "provider_policy_unavailable";
    reason: "quota_exhausted" | "policy_missing" | "invalid_policy" | "window_unavailable" | "invalid_window" |
      "invalid_identifiers" | "invalid_estimate" | "duplicate_request" | "database_binding_missing" |
      "database_error" | "admission_not_confirmed" | "stale_claim" | "provider_restricted" | "model_restricted" |
      "quota_dimension_restricted" | "capacity_unknown" | "policy_unavailable" | "model_unavailable";
    resetAt?: number }
);

// D1QuotaAdmission implements admission only. Production inference stays closed.
export interface QuotaAdmission {
  reserve(input: QuotaAdmissionInput): Promise<QuotaAdmissionResult>;
}
// Internal provisioning only. The result is an admission configuration snapshot,
// not permission to dispatch. No public request accepts capacity policies.
export type QuotaProvisioningResult = { state: "provisioned"; policy: QuotaAdmissionPolicy } |
  { state: "invalid_policy" | "disabled" | "review_required" | "unsafe_change" | "conflict" | "storage_unavailable" };
export interface QuotaWindowProvisioning {
  provision(trustedPolicy: unknown): Promise<QuotaProvisioningResult>;
}
// Trusted, already normalized server-side usage. Provider payload conversion is
// outside quota accounting. This is not an HTTP request or provider response DTO.
export interface SettlementUsage {
  kind: "measured" | "estimated";
  estimatePolicy?: "explicit_upper_bound_v1";
  requests: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  computeUnits?: Readonly<Record<string, number>>;
}
export interface SuccessfulSettlementInput {
  fence: IdempotencyFence;
  reservationId: string;
  attemptId: string;
  provider: string;
  model: string;
  usage: SettlementUsage;
}
export type SettlementDecision = { state: "settled" | "already_settled" } |
  { state: "invalid_usage" | "stale_owner" | "invalid_state" | "invalid_accounting" | "conflict" | "storage_unavailable"; retryable: false };
export interface UsageReporter {
  settle(input: SuccessfulSettlementInput): Promise<SettlementDecision>;
}
export type FailureMeasurement =
  { kind: "measured"; amount: number; evidence: "provider_report" } |
  { kind: "estimated"; amount: number; evidence: "explicit_upper_bound_v1" };
// Trusted internal evidence only; never bind a public request/provider body here.
export interface FailureUsage {
  requests?: FailureMeasurement;
  inputTokens?: FailureMeasurement;
  outputTokens?: FailureMeasurement;
  totalTokens?: FailureMeasurement;
  computeUnits?: Readonly<Record<string, FailureMeasurement>>;
}
export type FailureReport =
  { category: "PROVEN_PRE_DISPATCH_FAILURE"; reason: "validation_failed" | "preparation_failed" | "dispatch_cancelled" } |
  { category: "POSSIBLY_DISPATCHED_FAILURE"; reason: "connection_failure" | "request_timeout" | "interrupted_send"; usage?: FailureUsage } |
  { category: "CONFIRMED_PROVIDER_ERROR"; reason: "provider_http_error"; httpStatus: number; usage?: FailureUsage } |
  { category: "UNKNOWN_OUTCOME"; reason: "crash_boundary" | "response_missing" | "ambiguous_response"; usage?: FailureUsage } |
  { category: "INVALID_OR_UNTRUSTED_USAGE"; reason: "missing_usage" | "malformed_usage" | "contradictory_usage" | "untrusted_usage" | "malformed_response"; usage?: FailureUsage };
export type FailureAccountingInput = Omit<SuccessfulSettlementInput, "usage"> & { failure: FailureReport };
export type FailureAccountingState = "released" | "held" | "partial" | "accounted";
export type FailureAccountingDecision =
  { state: "recorded" | "already_recorded"; accounting: FailureAccountingState; retryable: false } |
  { state: "not_recorded" | "invalid_usage" | "invalid_failure" | "stale_owner" | "invalid_state" | "invalid_accounting" | "conflict" | "storage_unavailable"; retryable: false };
export interface FailureAccounting {
  record(input: FailureAccountingInput): Promise<FailureAccountingDecision>;
  // Read-only inspection of the same operation after an uncertain acknowledgement.
  inspect(input: FailureAccountingInput): Promise<FailureAccountingDecision>;
}
export type RecoveryClassification = "provably_not_dispatched" | "dispatch_uncertain" | "dispatched" |
  "settled_successfully" | "settled_failure" | "outcome_unknown" | "inconsistent_record" | "already_recovered" | "recovery_in_progress";
export interface RecoveryInspection {
  reservationId: string;
  requestId: string | null;
  attemptId: string | null;
  generation: number | null;
  classification: RecoveryClassification;
  ownerActive: boolean;
  recoverable: boolean;
  manualReview: boolean;
  operationId: string | null;
}
export interface RecoveryScan {
  basis: "reservation_expiry" | "owner_lease";
  from: number;
  through: number;
  limit: number; // 1..20; caller persists the cursor for this fixed interval/basis.
  cursor?: { time: number; id: string };
}
export interface RecoveryClaimInput {
  reservationId: string;
  requestId: string;
  attemptId: string;
  expectedGeneration: number;
  operationId: string;
}
// Internal recovery-only capability. It is not an IdempotencyFence and cannot dispatch.
export interface RecoveryFence {
  serviceId: string;
  claimId: string;
  reservationId: string;
  attemptId: string;
  operationId: string;
  generation: number;
  token: string;
}
export type RecoveryDenial = { state: "invalid_request" | "not_found" | "not_eligible" | "stale_owner" | "conflict" | "storage_unavailable"; retryable: false };
export type RecoveryClaimDecision = { state: "acquired"; fence: RecoveryFence } |
  { state: "already_claimed" | "already_recovered"; retryable: false } | RecoveryDenial;
export interface ReservationRecovery {
  discover(input: RecoveryScan): Promise<{ state: "page"; items: RecoveryInspection[]; nextCursor: RecoveryScan["cursor"] | null } | RecoveryDenial>;
  inspect(reservationId: string): Promise<{ state: "inspected"; item: RecoveryInspection } | RecoveryDenial>;
  claim(input: RecoveryClaimInput): Promise<RecoveryClaimDecision>;
  release(fence: RecoveryFence): Promise<FailureAccountingDecision | RecoveryDenial>;
}
export type ProviderHoldReason = "request_rate_exhausted" | "daily_requests_exhausted" | "token_rate_exhausted" |
  "daily_tokens_exhausted" | "compute_capacity_exhausted" | "provider_retry_after" | "temporary_provider_unavailable" | "model_unavailable";
export type ProviderHoldSource = "verified_quota" | "verified_retry_after" | "confirmed_exhaustion" | "operational";
export interface ProviderHoldDimension { metric: QuotaMetric; unit: string; windowSeconds: 60 | 86400; windowId?: string }
export interface ProviderHoldObservation {
  operationId: string;
  quotaScopeId: string;
  provider: string;
  model: string; // Empty only for explicitly authoritative provider-wide scope.
  dimension?: ProviderHoldDimension;
  reason: ProviderHoldReason;
  source: ProviderHoldSource;
  observedAt: number;
  until: number | null; // NULL requires trusted resolution, never a guessed retry.
  policyVersion: number;
  remaining?: 0; // Required for verified_quota observations.
}
export interface ProviderHoldResolution {
  operationId: string;
  quotaScopeId: string;
  provider: string;
  model: string;
  holdId: string;
  expectedRevision: number;
  policyVersion: number;
  observedAt: number;
  source: "verified_quota" | "operational";
  reason: "capacity_available" | "availability_restored" | "policy_reviewed";
  remaining?: number;
}
export type ProviderHoldDenial = { state: "invalid_evidence" | "policy_unavailable" | "stale_evidence" |
  "conflict" | "not_found" | "storage_unavailable"; retryable: false };
export type ProviderHoldDecision = { state: "recorded" | "already_recorded" | "resolved" | "already_resolved";
  holdId: string; revision: number } | ProviderHoldDenial;
export interface ProviderHoldView {
  holdId: string; model: string; reason: string; source: string; observedAt: number;
  until: number | null; revision: number; metric: QuotaMetric | null; unit: string | null;
  windowSeconds: number | null; windowId: string | null;
}
export interface ExpiredHoldCursor { until: number; model: string; holdId: string }
export interface ProviderHolds {
  record(evidence: unknown): Promise<ProviderHoldDecision>;
  resolve(evidence: unknown): Promise<ProviderHoldDecision>;
  inspectOperation(operationId: string): Promise<ProviderHoldDecision>;
  inspectApplicable(): Promise<{ state: "inspected"; holds: ProviderHoldView[]; truncated: boolean } | ProviderHoldDenial>;
  expired(limit: number, after?: ExpiredHoldCursor): Promise<{
    state: "page"; holds: ProviderHoldView[]; nextCursor: ExpiredHoldCursor | null } | ProviderHoldDenial>;
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
