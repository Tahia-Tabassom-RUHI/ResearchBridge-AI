import type { ProviderCapacityPolicy } from "../config/provider-policy";
import { MAX_PROVIDER_RESET_SECONDS, resetBounds, safeInteger, windowSeconds } from "../config/provider-policy";
import type { ProviderHoldObservation, ProviderHoldResolution, ProviderHoldSource } from "../storage";
import { canonicalJson, requestIdPattern } from "./request-identity";

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: unknown, names: string[]): boolean => object(v) && Object.keys(v).every(k => names.includes(k));
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(v);
export const holdIdValid = (v: unknown): v is string => typeof v === "string" && (v === "legacy" || /^ph1\.[0-9a-f]{64}$/.test(v));
export const holdConfidence = (source: ProviderHoldSource): number => source === "operational" ? 3 : 2;
export const operationIdValid = (v: unknown): v is string => typeof v === "string" && requestIdPattern.test(v);
const reasons = ["request_rate_exhausted", "daily_requests_exhausted", "token_rate_exhausted", "daily_tokens_exhausted",
  "compute_capacity_exhausted", "provider_retry_after", "temporary_provider_unavailable", "model_unavailable"];
const sources = ["verified_quota", "verified_retry_after", "confirmed_exhaustion", "operational"];

function identity(v: Record<string, unknown>, p: ProviderCapacityPolicy, now: number): boolean {
  return operationIdValid(v.operationId) && v.provider === p.provider && v.quotaScopeId === p.quotaScopeId &&
    (v.model === "" || v.model === p.model) && v.policyVersion === p.version &&
    safeInteger(v.observedAt) && v.observedAt <= now && v.observedAt >= p.verifiedAt;
}

// Internal normalized evidence only. A source label is an attestation by the
// trusted caller, not authentication. No HTTP route or student request parser
// calls this. The trusted response adapter validates its derived candidates here.
// Time-of-write freshness is checked separately so exact operation replays can
// inspect their immutable receipt after the original deadline has passed.
export function normalizeHoldObservation(value: unknown, p: ProviderCapacityPolicy, now: number): ProviderHoldObservation | undefined {
  if (!keys(value, ["operationId", "quotaScopeId", "provider", "model", "dimension", "reason", "source", "observedAt", "until", "policyVersion", "remaining"]) || !object(value) ||
      !identity(value, p, now) || !reasons.includes(value.reason as string) || !sources.includes(value.source as string) ||
      !(value.until === null || (safeInteger(value.until) && value.until > (value.observedAt as number)))) return;
  const e = value as unknown as ProviderHoldObservation;
  const d = e.dimension;
  if (d !== undefined) {
    if (!keys(d, ["metric", "unit", "windowSeconds", "windowId"]) || !identifier(d.unit) ||
        !p.dimensions.some(w => w.metric === d.metric && w.unit === d.unit && windowSeconds(w.window) === d.windowSeconds) ||
        (d.windowId !== undefined && (!identifier(d.windowId) || e.until === null))) return;
    // Use the same quota scope as provisioning; narrow token evidence may not
    // become a provider-wide Groq restriction, or a model-only CF allocation.
    if (e.model !== (p.provider === "cloudflare_workers_ai" ? "" : p.model)) return;
  }
  const quotaReason = e.reason.endsWith("_exhausted");
  if (quotaReason) {
    if (!d || !["verified_quota", "confirmed_exhaustion", "operational"].includes(e.source)) return;
    const expected = d.metric === "compute_units" ? "compute_capacity_exhausted" :
      d.metric === "requests" ? (d.windowSeconds === 60 ? "request_rate_exhausted" : "daily_requests_exhausted") :
        (d.windowSeconds === 60 ? "token_rate_exhausted" : "daily_tokens_exhausted");
    if (e.reason !== expected) return;
    const dimension = p.dimensions.find(w => w.metric === d.metric && w.unit === d.unit && windowSeconds(w.window) === d.windowSeconds)!;
    // Only attested Groq quota observations may use a provider deadline. Keep
    // them dimension-scoped and unbound to a local window so rollover cannot
    // remove the restriction. Other evidence retains its fixed-window rules.
    const providerDeadline = p.provider === "groq" && e.source === "verified_quota" && d.windowId === undefined &&
      ((d.metric === "requests" && d.unit === "requests" && d.windowSeconds === 86400) ||
        (d.metric === "tokens" && d.unit === "tokens" && d.windowSeconds === 60));
    try { if (e.until !== null && (providerDeadline ? e.until - e.observedAt > MAX_PROVIDER_RESET_SECONDS :
      e.until !== resetBounds(dimension.window, e.observedAt).end)) return; }
    catch { return; }
  } else if (e.reason === "provider_retry_after") {
    if (e.source !== "verified_retry_after" || e.until === null) return;
  } else {
    // Availability restrictions are explicit operational facts in this stage,
    // not a conversion of arbitrary provider errors into quota exhaustion.
    if (d || e.source !== "operational") return;
    if (e.reason === "model_unavailable" && (e.model !== p.model || e.until !== null)) return;
  }
  if (e.source === "verified_quota" ? e.remaining !== 0 : Object.hasOwn(e, "remaining")) return;
  try { canonicalJson(e); return structuredClone(e); } catch { return; }
}

export function normalizeHoldResolution(value: unknown, p: ProviderCapacityPolicy, now: number): ProviderHoldResolution | undefined {
  if (!keys(value, ["operationId", "quotaScopeId", "provider", "model", "holdId", "expectedRevision", "policyVersion", "observedAt", "source", "reason", "remaining"]) ||
      !object(value) || !identity(value, p, now) || !holdIdValid(value.holdId) || !safeInteger(value.expectedRevision) || value.expectedRevision === 0 ||
      !["operational", "verified_quota"].includes(value.source as string) ||
      !["capacity_available", "availability_restored", "policy_reviewed"].includes(value.reason as string)) return;
  const e = value as unknown as ProviderHoldResolution;
  if (e.reason === "capacity_available") {
    if (!safeInteger(e.remaining) || e.remaining === 0) return;
  } else if (e.source !== "operational" || Object.hasOwn(e, "remaining")) return;
  try { canonicalJson(e); return structuredClone(e); } catch { return; }
}
