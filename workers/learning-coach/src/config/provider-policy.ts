import type { QuotaAdmissionInput, QuotaMetric } from "../storage";
import { canonicalJson } from "../storage/request-identity";

export type CapacityProvider = "cloudflare_workers_ai" | "groq";
export interface PolicyEvidence {
  kind: "provider_documentation" | "account_verified";
  reference: string;
  verifiedAt: number; // UTC Unix seconds, verified by the maintainer.
}
export interface CapacityLimit { amount: number; source: PolicyEvidence }
export type ResetWindow = { kind: "utc_day" } |
  { kind: "fixed"; seconds: 60 | 86400; anchor: number };
export interface CapacityDimension {
  metric: QuotaMetric;
  unit: string;
  window: ResetWindow;
  documented?: CapacityLimit;
  account?: CapacityLimit;
  safetyMargin: number; // Absolute units, never a token/neuron conversion.
  safetyReference: string;
  resetSource: PolicyEvidence;
}
export interface ProviderCapacityPolicy {
  schemaVersion: 1;
  provider: CapacityProvider;
  model: string;
  quotaScopeId: string; // One trusted account/organization allocation, never a student.
  plan: "free";
  billing: "free_only";
  enabled: boolean;
  eligibility: { verified: true; paidOnly: false; source: PolicyEvidence };
  quotaInventory: { complete: true; source: PolicyEvidence }; // All enforced account constraints are represented.
  version: number;
  verifiedAt: number;
  reviewAfter: number; // Mandatory finite review boundary.
  provenance: string;
  leaseSeconds: number;
  retentionSeconds: number;
  dimensions: CapacityDimension[];
  estimation: {
    kind: "trusted_token_upper_bounds_v1";
    reference: string;
    compute?: {
      unit: string;
      inputNumerator: number;
      outputNumerator: number;
      denominator: number;
      source: PolicyEvidence;
    };
  };
}

// A public catalog identifies supported combinations, not account eligibility.
// Adding a model requires a reviewed catalog change. No automatic model switch.
export const CAPACITY_MODELS = Object.freeze({
  cloudflare_workers_ai: "@cf/google/gemma-4-26b-a4b-it",
  groq: "openai/gpt-oss-20b",
});
// Historical identity remains recognized for accounting, revocation and recovery.
// Recognition does not migrate a persisted allocation or establish eligibility.
export const LEGACY_QWEN_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
export function isCapacityModel(provider: unknown, model: unknown): boolean {
  return typeof provider === "string" && Object.hasOwn(CAPACITY_MODELS, provider) &&
    (model === CAPACITY_MODELS[provider as CapacityProvider] ||
      (provider === "cloudflare_workers_ai" && model === LEGACY_QWEN_MODEL));
}
export const QWEN_REVIEW_BOUNDARY = 1795132800; // 2026-11-20T00:00:00Z, planned deprecation.
export const MAX_POLICY_DIMENSIONS = 10;
// Resource bound for provider-observed waits, independent of local quota windows.
export const MAX_PROVIDER_RESET_SECONDS = 7 * 86400;
export const safeInteger = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown): v is number => safeInteger(v) && v > 0;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 1000;
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,199}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: unknown, allowed: string[]): boolean => object(v) && Object.keys(v).every(k => allowed.includes(k));
export const windowSeconds = (w: ResetWindow): number => w.kind === "utc_day" ? 86400 : w.seconds;
export const windowAnchor = (w: ResetWindow): number => w.kind === "utc_day" ? 0 : w.anchor;
export const capacityLimit = (d: CapacityDimension): number => Math.min(d.documented?.amount ?? Number.MAX_SAFE_INTEGER,
  d.account?.amount ?? Number.MAX_SAFE_INTEGER);
export const dimensionKey = (d: CapacityDimension): string => canonicalJson([d.metric, d.unit, windowSeconds(d.window)]);
export const providerPolicyJson = (p: ProviderCapacityPolicy): string => canonicalJson({ ...p,
  dimensions: [...p.dimensions].sort((a, b) => dimensionKey(a) < dimensionKey(b) ? -1 : dimensionKey(a) > dimensionKey(b) ? 1 : 0) });

function evidence(v: unknown, provider: CapacityProvider, now: number, verifiedAt: number): v is PolicyEvidence {
  if (!keys(v, ["kind", "reference", "verifiedAt"]) || !object(v) || !text(v.reference) ||
      !safeInteger(v.verifiedAt) || v.verifiedAt > verifiedAt || v.verifiedAt > now) return false;
  if (v.kind === "account_verified") return true;
  if (v.kind !== "provider_documentation") return false;
  try {
    const url = new URL(v.reference);
    return url.protocol === "https:" && !url.username && !url.password &&
      (provider === "cloudflare_workers_ai" ? url.hostname === "developers.cloudflare.com" && url.pathname.startsWith("/workers-ai/") :
        url.hostname === "console.groq.com" && url.pathname.startsWith("/docs/"));
  } catch { return false; }
}

export type PolicyValidation = { state: "valid"; policy: ProviderCapacityPolicy } |
  { state: "invalid_policy" | "disabled" | "review_required" };

// This is a trusted configuration boundary, not an HTTP parser. Validation does
// not authenticate a caller. No request, environment flag, or provider response
// is wired to it. Unknown fields (including runtime capacity overrides) fail closed.
export function validateProviderPolicy(value: unknown, now: number): PolicyValidation {
  const invalid = { state: "invalid_policy" } as const;
  if (!safeInteger(now) || !keys(value, ["schemaVersion", "provider", "model", "quotaScopeId", "plan", "billing", "enabled",
    "eligibility", "quotaInventory", "version", "verifiedAt", "reviewAfter", "provenance", "leaseSeconds", "retentionSeconds", "dimensions", "estimation"]) || !object(value)) return invalid;
  const p = value as unknown as ProviderCapacityPolicy;
  if (p.schemaVersion !== 1 || !isCapacityModel(p.provider, p.model) ||
      !identifier(p.quotaScopeId) || p.plan !== "free" || p.billing !== "free_only" || typeof p.enabled !== "boolean" ||
      !positive(p.version) || !safeInteger(p.verifiedAt) || p.verifiedAt > now || !safeInteger(p.reviewAfter) ||
      p.reviewAfter <= p.verifiedAt || !text(p.provenance) || !positive(p.leaseSeconds) || !positive(p.retentionSeconds) ||
      p.retentionSeconds < p.leaseSeconds || !safeInteger(now + p.retentionSeconds) ||
      !keys(p.eligibility, ["verified", "paidOnly", "source"]) || p.eligibility.verified !== true || p.eligibility.paidOnly !== false ||
      !evidence(p.eligibility.source, p.provider, now, p.verifiedAt) || p.eligibility.source.kind !== "account_verified" ||
      !keys(p.quotaInventory, ["complete", "source"]) || p.quotaInventory.complete !== true ||
      !evidence(p.quotaInventory.source, p.provider, now, p.verifiedAt) || p.quotaInventory.source.kind !== "account_verified" ||
      !Array.isArray(p.dimensions) || p.dimensions.length === 0 || p.dimensions.length > MAX_POLICY_DIMENSIONS ||
      !keys(p.estimation, ["kind", "reference", "compute"]) || p.estimation.kind !== "trusted_token_upper_bounds_v1" || !text(p.estimation.reference)) return invalid;
  const seen = new Set<string>();
  for (const d of p.dimensions) {
    if (!keys(d, ["metric", "unit", "window", "documented", "account", "safetyMargin", "safetyReference", "resetSource"]) ||
        !["requests", "tokens", "input_tokens", "output_tokens", "compute_units"].includes(d.metric) ||
        !identifier(d.unit) || !keys(d.window, d.window?.kind === "utc_day" ? ["kind"] : ["kind", "seconds", "anchor"]) ||
        !["utc_day", "fixed"].includes(d.window.kind) || (d.window.kind === "fixed" &&
          (![60, 86400].includes(d.window.seconds) || !safeInteger(d.window.anchor) || d.window.anchor >= d.window.seconds)) ||
        (d.metric === "requests" ? d.unit !== "requests" : d.metric === "compute_units" ? false : d.unit !== "tokens") ||
        !safeInteger(d.safetyMargin) || !text(d.safetyReference) || !evidence(d.resetSource, p.provider, now, p.verifiedAt)) return invalid;
    if (!d.documented && !d.account) return invalid;
    for (const [kind, limit] of [["provider_documentation", d.documented], ["account_verified", d.account]] as const) {
      if (limit !== undefined && (!keys(limit, ["amount", "source"]) || !safeInteger(limit.amount) ||
          !evidence(limit.source, p.provider, now, p.verifiedAt) || limit.source.kind !== kind)) return invalid;
    }
    if (p.provider === "groq" && (!d.account || d.resetSource.kind !== "account_verified")) return invalid;
    if (d.safetyMargin > capacityLimit(d) || seen.has(dimensionKey(d))) return invalid;
    seen.add(dimensionKey(d));
  }
  // Combined and split caps are alternatives for each period. Never add their
  // values together or charge both representations to one counter.
  for (const seconds of [60, 86400]) {
    const dims = p.dimensions.filter(d => windowSeconds(d.window) === seconds);
    if (dims.some(d => d.metric === "tokens") && dims.some(d => ["input_tokens", "output_tokens"].includes(d.metric))) return invalid;
    const split = dims.filter(d => ["input_tokens", "output_tokens"].includes(d.metric));
    if (split.length === 2 && canonicalJson(split[0]!.window) !== canonicalJson(split[1]!.window)) return invalid;
  }
  const has = (metric: QuotaMetric, seconds: number) => p.dimensions.some(d => d.metric === metric && windowSeconds(d.window) === seconds);
  if (!has("requests", 60)) return invalid;
  if (p.provider === "cloudflare_workers_ai") {
    const compute = p.dimensions.filter(d => d.metric === "compute_units");
    if (compute.length !== 1 || compute[0]!.unit !== "neurons" || compute[0]!.window.kind !== "utc_day" ||
        capacityLimit(compute[0]!) > 10000 || (p.model === LEGACY_QWEN_MODEL && p.reviewAfter > QWEN_REVIEW_BOUNDARY)) return invalid;
  } else if (!p.dimensions.some(d => ["tokens", "input_tokens", "output_tokens"].includes(d.metric)) ||
      p.dimensions.some(d => d.metric === "compute_units")) return invalid;
  const c = p.estimation.compute;
  if (c !== undefined && (!keys(c, ["unit", "inputNumerator", "outputNumerator", "denominator", "source"]) ||
      !identifier(c.unit) || !positive(c.inputNumerator) || !positive(c.outputNumerator) || !positive(c.denominator) ||
      !evidence(c.source, p.provider, now, p.verifiedAt))) return invalid;
  if (p.dimensions.some(d => d.metric === "compute_units" && (!c || c.unit !== d.unit)) ||
      (c && !p.dimensions.some(d => d.metric === "compute_units" && c.unit === d.unit))) return invalid;
  if (!p.enabled) return { state: "disabled" };
  if (now >= p.reviewAfter) return { state: "review_required" };
  return { state: "valid", policy: structuredClone(p) };
}

export function resetBounds(window: ResetWindow, now: number): { start: number; end: number } {
  const seconds = windowSeconds(window), anchor = windowAnchor(window);
  if (!safeInteger(now) || ![60, 86400].includes(seconds) || !safeInteger(anchor) || anchor >= seconds) throw new Error("Invalid reset");
  const start = now - ((now - anchor) % seconds + seconds) % seconds;
  if (!safeInteger(start) || !safeInteger(start + seconds)) throw new Error("Unsafe reset boundary");
  return { start, end: start + seconds };
}

// Counts must bound the complete provider prompt and configured maximum output.
// No browser text-length heuristic and no implicit neuron/token equivalence.
export function estimatePolicyReservation(p: ProviderCapacityPolicy, now: number, inputTokens: number, outputTokens: number): QuotaAdmissionInput["estimate"] | undefined {
  const validated = validateProviderPolicy(p, now);
  if (validated.state !== "valid" || !positive(inputTokens) || !positive(outputTokens) || !safeInteger(inputTokens + outputTokens)) return;
  const c = validated.policy.estimation.compute;
  if (!c) return { kind: "estimated", requests: 1, inputTokens, outputTokens };
  const numerator = BigInt(inputTokens) * BigInt(c.inputNumerator) + BigInt(outputTokens) * BigInt(c.outputNumerator);
  const amount = (numerator + BigInt(c.denominator) - 1n) / BigInt(c.denominator);
  if (amount < 1n || amount > BigInt(Number.MAX_SAFE_INTEGER)) return;
  return { kind: "estimated", requests: 1, inputTokens, outputTokens, computeUnits: { [c.unit]: Number(amount) } };
}
