import type { ServicePrincipal } from "../auth";
import type { ValidatedTask } from "../contracts/types";
import type { IdempotencyFence, IdempotencyStore, QuotaAdmission, QuotaAdmissionInput, RequestStatus } from "../storage";
import { identifyRequest, requestIdPattern } from "./request-identity";

type AdmissionPlan = Pick<QuotaAdmissionInput, "provider" | "model" | "estimate">;
export type BeginDecision = { state: "ready"; fence: IdempotencyFence } | RequestStatus | { state: "invalid_request"; retryable: false };

// Composed only into the local mock gateway. No public admission or replay API.
export class DurableRequests {
  constructor(private readonly store: IdempotencyStore, private readonly admission: QuotaAdmission,
    private readonly fingerprintSecret: string | undefined,
    private readonly plan: (task: ValidatedTask) => AdmissionPlan) {}

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
    if (result.admitted) return { state: "ready", fence: { ...claim.fence, generation: claim.fence.generation + 1 } };
    if (result.status === "storage_unavailable" || result.reason === "stale_claim") return this.store.lookup(identity);
    // Definitive pre-dispatch denial is terminal for this ID. No refund/retry.
    const failed = await this.store.failBeforeDispatch(claim.fence);
    return failed.state === "updated" ? { state: "failed", retryable: false } : failed;
  }
  authorizeDispatch(fence: IdempotencyFence) { return this.store.authorizeDispatch(fence); }
  dispatch(fence: IdempotencyFence) { return this.store.dispatch(fence); }
  complete(fence: IdempotencyFence) { return this.store.complete(fence); }
  markUnknown(fence: IdempotencyFence) { return this.store.markUnknown(fence); }
}
