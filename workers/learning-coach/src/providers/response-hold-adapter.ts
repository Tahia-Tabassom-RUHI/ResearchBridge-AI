import { resetBounds, windowSeconds, type ProviderCapacityPolicy } from "../config/provider-policy";
import type { ProviderHoldObservation } from "../storage";
import { normalizeHoldObservation, operationIdValid } from "../storage/provider-hold-evidence";
import { canonicalJson, sha256 } from "../storage/request-identity";
import type { ProviderObservation } from "./response-signals";
import { timestamp } from "./response-time";

export type HoldAdaptation = { state: "eligible" | "review_required" | "no_hold"; evidence: ProviderHoldObservation[];
  reasons: ("operational_evidence_required" | "invalid_signal" | "unsupported_signal" | "expired_signal" | "reset_policy_conflict")[] } |
  { state: "rejected"; reason: "untrusted_observation" | "stale_observation" | "policy_unavailable" | "invalid_operation_ids" };

// Called only after the facade verifies its private observation identity. This
// pure conversion cannot read/write D1, resolve holds, raise limits or settle.
export async function adaptHoldSignals(o: ProviderObservation, p: ProviderCapacityPolicy, operationId: string, now: number): Promise<HoldAdaptation> {
  if (o.provider !== p.provider || o.model !== p.model || o.quotaScopeId !== p.quotaScopeId || o.policyVersion !== p.version ||
      !timestamp(o.observedAt) || o.observedAt < p.verifiedAt || o.observedAt > now) return { state: "rejected", reason: "untrusted_observation" };
  if (!operationIdValid(operationId)) return { state: "rejected", reason: "invalid_operation_ids" };
  const candidates: Omit<ProviderHoldObservation, "operationId">[] = [];
  const reasons: Extract<HoldAdaptation, { evidence: unknown }>["reasons"] = [];
  if (["contradictory_response", "invalid_body", "invalid_headers"].some(i => o.issues.includes(i as typeof o.issues[number]))) {
    return { state: "review_required", evidence: [], reasons: ["invalid_signal"] };
  }
  const base = { provider: p.provider, quotaScopeId: p.quotaScopeId, model: p.model, policyVersion: p.version, observedAt: o.observedAt };
  for (const q of o.quotas) {
    if (q.quality === "invalid" || q.quality === "unsupported") { reasons.push(q.quality === "invalid" ? "invalid_signal" : "unsupported_signal"); continue; }
    if (q.remaining !== 0) continue;
    const d = p.dimensions.find(d => d.metric === q.dimension.metric && d.unit === q.dimension.unit && windowSeconds(d.window) === q.dimension.windowSeconds);
    if (!d) { reasons.push("unsupported_signal"); continue; }
    if (q.reset.state !== "missing" && q.reset.state !== "known") { reasons.push("invalid_signal"); continue; }
    const until = q.reset.state === "known" ? q.reset.until : null;
    if (until !== null && until <= now) { reasons.push("expired_signal"); continue; }
    if (p.provider !== "groq" && until !== null && until !== resetBounds(d.window, o.observedAt).end) { reasons.push("reset_policy_conflict"); continue; }
    const reason = d.metric === "compute_units" ? "compute_capacity_exhausted" : d.metric === "requests" ? "daily_requests_exhausted" : "token_rate_exhausted";
    candidates.push({ ...base, model: p.provider === "cloudflare_workers_ai" ? "" : p.model, dimension: q.dimension, reason, until,
      ...(p.provider === "cloudflare_workers_ai" ? { source: "confirmed_exhaustion" as const } : { source: "verified_quota" as const, remaining: 0 as const }) });
  }
  if (o.retry.state === "known" && !o.issues.includes("unexpected_retry") &&
      (o.httpStatus === 429 || (p.provider === "cloudflare_workers_ai" && o.httpStatus === 503))) {
    if (o.retry.until <= now) reasons.push("expired_signal");
    else candidates.push({ ...base, source: "verified_retry_after", reason: "provider_retry_after", until: o.retry.until });
  } else if (o.retry.state === "invalid" || o.retry.state === "clock_uncertain") reasons.push("invalid_signal");
  if (["temporary_capacity_unavailable", "model_deprecated", "paid_plan_required", "model_unavailable", "model_access_denied"].includes(o.classification)) reasons.push("operational_evidence_required");
  const evidence = await Promise.all(candidates.map(async e => {
    // One durable caller operation can yield several independent restrictions.
    // Stable child UUIDs prevent replay with later timestamps extending a hold.
    const digest = await sha256(canonicalJson(["provider-response-hold-v1", operationId, o.attemptId, o.reservationId,
      e.quotaScopeId, e.provider, e.model, e.reason, e.dimension ?? null]));
    const hex = digest.slice(0, 12) + "4" + digest.slice(13, 16) + (8 + (parseInt(digest[16]!, 16) % 4)).toString(16) + digest.slice(17, 32);
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return normalizeHoldObservation({ ...e, operationId: id }, p, now);
  }));
  if (evidence.some(e => !e)) return { state: "review_required", evidence: [], reasons: ["invalid_signal"] };
  return { state: reasons.length ? "review_required" : evidence.length ? "eligible" : "no_hold",
    evidence: evidence as ProviderHoldObservation[], reasons: [...new Set(reasons)] };
}
