import { validateProviderPolicy, type ProviderCapacityPolicy } from "../config/provider-policy";
import type { FailureUsage, IdempotencyFence, ProviderHoldObservation, SettlementUsage } from "../storage";
import type { D1Binding } from "../storage/d1-quota-admission";
import type { OwnedAttempt } from "../storage/d1-owned-attempt";
import { D1ProviderExecution } from "../storage/d1-provider-execution";
import { D1ProviderHolds } from "../storage/d1-provider-holds";
import { normalizeFailure } from "../storage/failure-usage";
import { consumption, normalizeSettlementUsage, safeAmount } from "../storage/settlement-usage";
import { canonicalJson, sha256 } from "../storage/request-identity";
import { LocalPolicyMockProvider } from "./local-policy-mock";
import { ProviderResponseParser } from "./response-parser";
import type { ProviderObservation } from "./response-signals";
import { ProviderFailure, type InferenceProvider, type ProviderAttempt, type ProviderResult } from "./types";

export interface ExecutionEvidence {
  acknowledged: boolean;
  observation?: ProviderObservation;
  usage?: FailureUsage;
  successUsage?: SettlementUsage;
}
export interface ExecutionSession {
  finish(fence: IdempotencyFence, result?: ProviderResult, failure?: unknown): Promise<ExecutionEvidence>;
}
function successUsage(usage: FailureUsage | undefined, attempt: OwnedAttempt): SettlementUsage | undefined {
  if (!usage?.requests) return;
  const fields = [usage.requests, usage.inputTokens, usage.outputTokens, usage.totalTokens, ...Object.values(usage.computeUnits ?? {})].filter(v => v !== undefined);
  if (!fields.every(v => v.kind === "measured")) return; // Do not relabel estimates as measured.
  const raw: SettlementUsage = { kind: "measured", requests: usage.requests.amount,
    ...(usage.inputTokens ? { inputTokens: usage.inputTokens.amount } : {}),
    ...(usage.outputTokens ? { outputTokens: usage.outputTokens.amount } : {}),
    ...(usage.totalTokens ? { totalTokens: usage.totalTokens.amount } : {}),
    ...(usage.computeUnits ? { computeUnits: Object.fromEntries(Object.entries(usage.computeUnits).map(([k, v]) => [k, v.amount])) } : {}) };
  const normalized = normalizeSettlementUsage(raw);
  if (!normalized || attempt.windows.some(w => !safeAmount(consumption(normalized, w.metric, w.unit)))) return;
  return raw;
}

// This authority is composed with the exact local transport and policy. The
// parser's source labels alone are never accepted as proof of execution origin.
export class LocalProviderExecution {
  readonly #policy: ProviderCapacityPolicy;
  readonly #guard: D1ProviderExecution;
  constructor(private readonly db: D1Binding, policy: ProviderCapacityPolicy, private readonly provider: LocalPolicyMockProvider,
    private readonly clock = () => Math.floor(Date.now() / 1000)) {
    this.#policy = structuredClone(policy); this.#guard = new D1ProviderExecution(db, this.#policy);
  }
  accepts(provider: InferenceProvider): boolean { return provider === this.provider && this.provider.matches(this.#policy); }
  async open(fence: IdempotencyFence, owned: OwnedAttempt): Promise<ExecutionSession | undefined> {
    const p = this.#policy;
    if (validateProviderPolicy(p, this.clock()).state !== "valid" || !this.provider.matches(p)) return;
    const attempt: ProviderAttempt = { provider: owned.provider, model: owned.model, attemptId: owned.attemptId, reservationId: owned.reservationId };
    const parsed = ProviderResponseParser.create(p, attempt, p.provider === "groq" ? "groq_http" : "workers_ai_http", this.clock);
    if (parsed.state !== "ready" || !await this.#guard.arm(fence, attempt)) return;
    let used = false;
    return { finish: async (sent, result, failure) => {
      if (used) return { acknowledged: false }; used = true;
      let usage: FailureUsage | undefined;
      try {
        const envelope = result ? this.provider.take(result, attempt) : undefined;
        const observed = parsed.parser.observe(envelope?.metadata ?? (!result ? { kind: "transport_failure",
          failure: failure instanceof ProviderFailure && failure.kind === "timeout" ? "timeout" : "interrupted" } : undefined));
        if (observed.state !== "observed") return { acknowledged: false };
        const o = observed.observation;
        const reported = parsed.parser.usageEvidence(o, attempt);
        usage = reported;
        // Counters are explicitly simulated transport measurements. Provider
        // token schemas do not prove request counts or neuron consumption.
        const extras = envelope?.counters;
        if (extras && (Object.keys(extras).some(k => !["requests", "computeUnits"].includes(k)) ||
            typeof normalizeFailure({ category: "UNKNOWN_OUTCOME", reason: "response_missing", usage: extras }) === "string")) {
          return { acknowledged: false, observation: o, ...(usage ? { usage } : {}) };
        }
        const combined = { ...reported, ...extras };
        if (Object.keys(combined).length && typeof normalizeFailure({ category: "UNKNOWN_OUTCOME", reason: "response_missing", usage: combined }) !== "string") usage = combined;
        const evidence: ExecutionEvidence = { acknowledged: false, observation: o, ...(usage ? { usage } : {}) };
        const complete = successUsage(usage, owned); if (complete) evidence.successUsage = complete;
        const adapted = await parsed.parser.holdEvidence(o, attempt.attemptId, p);
        if (adapted.state === "rejected") return evidence;
        const holds = new D1ProviderHolds(this.db, p, undefined, () => this.#guard.ownerGate(sent, attempt, "sent"));
        const candidates = [...adapted.evidence];
        const unknownRateLimit = o.classification === "rate_limited" && candidates.length === 0;
        const operational = unknownRateLimit || ["temporary_capacity_unavailable", "model_deprecated", "paid_plan_required", "model_unavailable", "model_access_denied", "provider_authentication_failure"].includes(o.classification);
        if (operational && o.quality !== "invalid") {
          const temporary = unknownRateLimit || o.classification === "temporary_capacity_unavailable";
          const until = temporary && o.retry.state === "known" ? o.retry.until : null;
          candidates.push({ operationId: attempt.attemptId, provider: p.provider, model: p.model, quotaScopeId: p.quotaScopeId,
            policyVersion: p.version, observedAt: o.observedAt, source: "operational",
            reason: temporary ? "temporary_provider_unavailable" : "model_unavailable", until } satisfies ProviderHoldObservation);
        }
        // Ordinary HTTP failures do not confirm exhaustion. Invalid/ambiguous
        // availability evidence keeps the durable barrier for trusted review.
        if (adapted.reasons.some(r => r !== "operational_evidence_required") || o.quality === "invalid" ||
            o.issues.some(i => ["conflicting_headers", "invalid_quota", "invalid_reset", "capacity_above_policy", "unsupported_dimension", "reset_policy_conflict"].includes(i))) return evidence;
        for (const candidate of candidates) {
          const recorded = await holds.record(candidate);
          if (recorded.state !== "recorded" && recorded.state !== "already_recorded") return evidence;
        }
        evidence.acknowledged = await this.#guard.acknowledge(sent, attempt,
          await sha256(canonicalJson([o, candidates.map(c => c.operationId)])));
        return evidence;
      } catch { return { acknowledged: false, ...(usage ? { usage } : {}) }; }
    } };
  }
}
