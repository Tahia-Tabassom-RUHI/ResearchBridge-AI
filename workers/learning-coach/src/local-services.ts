import type { Env } from "./config/index";
import type { QuotaAdmissionInput, QuotaAdmissionPolicy } from "./storage";
import { D1IdempotencyStore, type IdempotencyPolicy } from "./storage/d1-idempotency";
import { D1QuotaAdmission } from "./storage/d1-quota-admission";
import { D1UsageSettlement } from "./storage/d1-usage-settlement";
import { D1FailureAccounting } from "./storage/d1-failure-accounting";
import { D1ReservationRecovery, type RecoveryPolicy } from "./storage/d1-reservation-recovery";
import { readOwnedAttempt } from "./storage/d1-owned-attempt";
import { DurableRequests } from "./storage/durable-requests";
import { hashPattern } from "./storage/request-identity";
import { estimatePolicyReservation, validateProviderPolicy, type ProviderCapacityPolicy } from "./config/provider-policy";
import { D1QuotaProvisioning } from "./storage/d1-quota-provisioning";
import { LocalPolicyMockProvider } from "./providers/local-policy-mock";
import { LocalProviderExecution } from "./providers/local-provider-execution";

export interface LocalDurableConfig {
  ownership: IdempotencyPolicy;
  quota: QuotaAdmissionPolicy;
  estimate: QuotaAdmissionInput["estimate"];
}
// Local-only composition. No defaults for quota capacity/windows, automatic
// provisioning, real providers, or fallback to unmetered execution.
export function localServices(env: Env, config: LocalDurableConfig) {
  if (!env.COACH_DB || !hashPattern.test(env.COACH_FINGERPRINT_SECRET ?? "") || !config?.ownership ||
      !config.quota || config.quota.provider !== "mock" || config.quota.model !== "mock-model" || !config.estimate) return;
  const fixed = structuredClone(config), db = env.COACH_DB;
  const store = new D1IdempotencyStore(db, fixed.ownership);
  const durable = new DurableRequests(store, new D1QuotaAdmission(db, [fixed.quota]), env.COACH_FINGERPRINT_SECRET,
    () => ({ provider: fixed.quota.provider, model: fixed.quota.model, estimate: fixed.estimate }), {
      readAttempt: (fence, reservationId) => readOwnedAttempt(db, fence, reservationId),
      success: new D1UsageSettlement(db), failure: new D1FailureAccounting(db),
    });
  return { durable, recovery: (request: Request, policy: RecoveryPolicy) => D1ReservationRecovery.authenticate(request, env, policy) };
}

export interface LocalProviderConfig {
  ownership: IdempotencyPolicy;
  policy: ProviderCapacityPolicy;
  // Reviewed complete prompt and maximum output bounds for this local fixture.
  bounds: { inputTokens: number; outputTokens: number };
}
export function localProviderServices(env: Env, config: LocalProviderConfig, provider: LocalPolicyMockProvider, clock?: () => number) {
  if (!env.COACH_DB || !hashPattern.test(env.COACH_FINGERPRINT_SECRET ?? "") || !config?.ownership ||
      !config.policy || !config.bounds || !provider.matches(config.policy)) return;
  const fixed = structuredClone(config), db = env.COACH_DB, p = fixed.policy;
  const store = new D1IdempotencyStore(db, fixed.ownership);
  const durable = new DurableRequests(store, { reserve: async input => {
    const deny = (storage = false) => ({ admitted: false as const, requestId: input.requestId, provider: input.provider, model: input.model,
      status: storage ? "storage_unavailable" as const : "configuration_missing" as const,
      reason: storage ? "database_error" as const : "invalid_policy" as const });
    try {
      const clock = await db.prepare("SELECT unixepoch() AS now").all<{ now: number }>();
      if (!clock.success || clock.results.length !== 1) return deny(true);
      const now = clock.results[0]!.now, checked = validateProviderPolicy(p, now);
      if (checked.state !== "valid") return deny();
      const estimate = estimatePolicyReservation(checked.policy, now, fixed.bounds.inputTokens, fixed.bounds.outputTokens);
      if (!estimate) return deny();
      const provisioned = await new D1QuotaProvisioning(db).provision(checked.policy);
      if (provisioned.state !== "provisioned") return deny(provisioned.state === "storage_unavailable");
      // Exact current policy hash/version, all required windows and pending
      // evidence are checked again inside the atomic admission transaction.
      return new D1QuotaAdmission(db, [{ ...provisioned.policy, requireResponseEvidence: true }]).reserve({ ...input, estimate });
    } catch { return deny(true); }
  } }, env.COACH_FINGERPRINT_SECRET, () => ({ provider: p.provider, model: p.model,
    estimate: { kind: "estimated", requests: 1 } }), {
    readAttempt: (fence, reservationId) => readOwnedAttempt(db, fence, reservationId),
    success: new D1UsageSettlement(db), failure: new D1FailureAccounting(db),
  });
  return { durable, execution: new LocalProviderExecution(db, p, provider, clock) };
}
