import { CAPACITY_MODELS, LEGACY_QWEN_MODEL, QWEN_REVIEW_BOUNDARY, type CapacityDimension, type CapacityProvider,
  type PolicyEvidence, type ProviderCapacityPolicy } from "../src/config/provider-policy";

export const POLICY_TIME = 1794009600; // 2026-11-07T00:00:00Z.
export function policyFixture(provider: CapacityProvider = "cloudflare_workers_ai", now = POLICY_TIME): ProviderCapacityPolicy {
  const account: PolicyEvidence = { kind: "account_verified", reference: "local synthetic account verification; no real account verified", verifiedAt: now - 1 };
  const documented: PolicyEvidence = { kind: "provider_documentation", reference: provider === "groq" ?
    "https://console.groq.com/docs/rate-limits" : "https://developers.cloudflare.com/workers-ai/platform/pricing/", verifiedAt: now - 1 };
  const dim = (metric: CapacityDimension["metric"], amount: number, daily = false): CapacityDimension => ({
    metric, unit: metric === "compute_units" ? "neurons" : metric === "requests" ? "requests" : "tokens",
    window: daily ? { kind: "utc_day" } : { kind: "fixed", seconds: 60, anchor: 0 },
    account: { amount, source: structuredClone(account) }, safetyMargin: 0,
    safetyReference: "synthetic test margin", resetSource: structuredClone(account),
  });
  const dimensions = provider === "cloudflare_workers_ai" ? [dim("requests", 300), dim("compute_units", 10000, true)] :
    [dim("requests", 30), dim("requests", 1000, true), dim("tokens", 8000), dim("tokens", 200000, true)];
  if (provider === "cloudflare_workers_ai") {
    dimensions[1]!.documented = { amount: 10000, source: documented };
  }
  // Keep existing accounting/regression fixtures on their historical Qwen policy.
  return { schemaVersion: 1, provider, model: provider === "cloudflare_workers_ai" ? LEGACY_QWEN_MODEL : CAPACITY_MODELS[provider], quotaScopeId: "synthetic-account",
    plan: "free", billing: "free_only", enabled: true, eligibility: { verified: true, paidOnly: false, source: account },
    quotaInventory: { complete: true, source: structuredClone(account) },
    version: 1, verifiedAt: now - 1, reviewAfter: Math.min(now + 7 * 86400, QWEN_REVIEW_BOUNDARY),
    provenance: "local test fixture only; not a deployable account policy", leaseSeconds: 30, retentionSeconds: 172800,
    dimensions, estimation: { kind: "trusted_token_upper_bounds_v1", reference: "synthetic complete prompt/output bounds",
      ...(provider === "cloudflare_workers_ai" ? { compute: { unit: "neurons", inputNumerator: 4625,
        outputNumerator: 30475, denominator: 1000000, source: documented } } : {}) } };
}

export function gemmaPolicyFixture(now = POLICY_TIME): ProviderCapacityPolicy {
  const p = policyFixture("cloudflare_workers_ai", now);
  p.model = CAPACITY_MODELS.cloudflare_workers_ai;
  p.reviewAfter = now + 7 * 86400; // Synthetic review horizon only.
  p.estimation.compute!.inputNumerator = 9091;
  p.estimation.compute!.outputNumerator = 27273;
  return p;
}
