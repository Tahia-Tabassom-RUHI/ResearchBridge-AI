import type { ServicePrincipal } from "../auth";
import type { ValidatedTask } from "../contracts/types";
import type { FailureAccounting, FailureReport, IdempotencyFence, IdempotencyStore, QuotaAdmission, QuotaAdmissionInput, RequestStatus, SettlementUsage, UsageReporter } from "../storage";
import { identifyRequest, requestIdPattern } from "./request-identity";
import type { AttemptDecision, OwnedAttempt } from "./d1-owned-attempt";

type AdmissionPlan = Pick<QuotaAdmissionInput, "provider" | "model" | "estimate">;
export type BeginDecision = { state: "ready"; fence: IdempotencyFence; reservationId: string; provider: string; model: string } | RequestStatus | { state: "invalid_request"; retryable: false };
export interface RequestAccounting {
  readAttempt(fence: IdempotencyFence, reservationId: string): Promise<AttemptDecision>;
  success: UsageReporter;
  failure: FailureAccounting;
}
export type AccountingDecision = { state: "accounted" } | RequestStatus | { state: "reconciliation_failed"; retryable: false };

// Composed only into the local mock gateway. No public admission or replay API.
export class DurableRequests {
  constructor(private readonly store: IdempotencyStore, private readonly admission: QuotaAdmission,
    private readonly fingerprintSecret: string | undefined,
    private readonly plan: (task: ValidatedTask) => AdmissionPlan, private readonly accounting?: RequestAccounting) {}

  get accountingAvailable() { return this.accounting !== undefined; }

  async begin(principal: ServicePrincipal, requestId: string, task: ValidatedTask): Promise<BeginDecision> {
    if (!requestIdPattern.test(requestId)) return { state: "invalid_request", retryable: false };
    let identity;
    try { identity = await identifyRequest(principal, requestId, task, this.fingerprintSecret); }
    catch { return { state: "configuration_missing", retryable: false }; }
    const claim = await this.store.claim(identity);
    if (claim.state !== "acquired") return claim;
    let result;
    try {
      const plan = this.plan(task);
      result = await this.admission.reserve({ ...plan, serviceId: principal.serviceId, requestId: claim.fence.claimId, claim: claim.fence });
    } catch { return { state: "storage_unavailable", retryable: false }; }
    if (result.admitted) return { state: "ready", fence: { ...claim.fence, generation: claim.fence.generation + 1 },
      reservationId: result.reservationId, provider: result.provider, model: result.model };
    if (result.status === "storage_unavailable" || result.reason === "stale_claim") return this.store.lookup(identity);
    // Definitive pre-dispatch denial is terminal for this ID. No refund/retry.
    const failed = await this.store.failBeforeDispatch(claim.fence);
    return failed.state === "updated" ? { state: "failed", retryable: false } : failed;
  }
  authorizeDispatch(fence: IdempotencyFence) { return this.store.authorizeDispatch(fence); }
  dispatch(fence: IdempotencyFence) { return this.store.dispatch(fence); }
  complete(fence: IdempotencyFence) { return this.store.complete(fence); }
  markUnknown(fence: IdempotencyFence) { return this.store.markUnknown(fence); }
  readAttempt(fence: IdempotencyFence, reservationId: string): Promise<AttemptDecision> {
    return this.accounting?.readAttempt(fence, reservationId) ?? Promise.resolve({ state: "configuration_missing", retryable: false });
  }
  async settleSuccess(fence: IdempotencyFence, attempt: OwnedAttempt, usage: SettlementUsage): Promise<AccountingDecision> {
    if (!this.accounting) return { state: "configuration_missing", retryable: false };
    const completed = await this.store.complete(fence);
    if (completed.state !== "updated") return completed;
    const awaiting = await this.store.awaitReconciliation(completed.fence);
    if (awaiting.state !== "updated") return awaiting;
    const result = await this.accounting.success.settle({ ...attempt, fence: awaiting.fence, usage });
    return ["settled", "already_settled"].includes(result.state) ? { state: "accounted" } : this.accountingDenial(result.state);
  }
  async accountFailure(fence: IdempotencyFence, attempt: OwnedAttempt, failure: FailureReport): Promise<AccountingDecision> {
    if (!this.accounting) return { state: "configuration_missing", retryable: false };
    const closed = await (failure.category === "PROVEN_PRE_DISPATCH_FAILURE" ? this.store.failBeforeDispatch(fence) : this.store.markUnknown(fence));
    if (closed.state !== "updated") return closed;
    const awaiting = await this.store.awaitReconciliation(closed.fence);
    if (awaiting.state !== "updated") return awaiting;
    const result = await this.accounting.failure.record({ ...attempt, fence: awaiting.fence, failure });
    return ["recorded", "already_recorded"].includes(result.state) ? { state: "accounted" } : this.accountingDenial(result.state);
  }
  private accountingDenial(state: string): AccountingDecision {
    return { state: state === "storage_unavailable" || state === "stale_owner" ? state : "reconciliation_failed", retryable: false };
  }
}
