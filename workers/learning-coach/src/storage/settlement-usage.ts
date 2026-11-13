import type { QuotaMetric, SettlementUsage } from "../storage";

export const safeAmount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export const usageIdentifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,199}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

export interface NormalizedUsage {
  kind: "measured" | "estimated";
  estimatePolicy: "explicit_upper_bound_v1" | null;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  computeUnits: Record<string, number>;
}

// Only allow numeric accounting fields, never arbitrary provider metadata. No
// Cloudflare/Groq payload assumptions or implicit fractional-unit conversion.
export function normalizeSettlementUsage(value: SettlementUsage): NormalizedUsage | undefined {
  if (!object(value) || Object.keys(value).some(k => !["kind", "estimatePolicy", "requests", "inputTokens", "outputTokens", "totalTokens", "computeUnits"].includes(k)) ||
      !["measured", "estimated"].includes(value.kind) || !safeAmount(value.requests) || value.requests < 1 ||
      (value.kind === "estimated" ? value.estimatePolicy !== "explicit_upper_bound_v1" : value.estimatePolicy !== undefined)) return;
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (Object.hasOwn(value, key) && !safeAmount(value[key])) return;
  }
  const compute = value.computeUnits;
  if (Object.hasOwn(value, "computeUnits") && (!object(compute) || Object.keys(compute).length > 32 ||
      Object.entries(compute).some(([key, amount]) => !usageIdentifier(key) || !safeAmount(amount)))) return;
  let total = value.totalTokens ?? null;
  if (value.inputTokens !== undefined && value.outputTokens !== undefined) {
    if (value.inputTokens > Number.MAX_SAFE_INTEGER - value.outputTokens) return;
    const sum = value.inputTokens + value.outputTokens;
    if (total !== null && total !== sum) return;
    total = sum;
  }
  if (total !== null && ((value.inputTokens ?? 0) > total || (value.outputTokens ?? 0) > total)) return;
  return { kind: value.kind, estimatePolicy: value.estimatePolicy ?? null, requests: value.requests,
    inputTokens: value.inputTokens ?? null, outputTokens: value.outputTokens ?? null, totalTokens: total,
    computeUnits: Object.fromEntries(Object.entries(compute ?? {}).sort(([a], [b]) => a.localeCompare(b))) };
}

export function consumption(usage: NormalizedUsage, metric: QuotaMetric, unit: string): number | undefined {
  switch (metric) {
    case "requests": return usage.requests;
    case "input_tokens": return usage.inputTokens ?? undefined;
    case "output_tokens": return usage.outputTokens ?? undefined;
    case "tokens": return usage.totalTokens ?? undefined;
    case "compute_units": return Object.hasOwn(usage.computeUnits, unit) ? usage.computeUnits[unit] : undefined;
  }
}
