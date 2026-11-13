import { capacityLimit, windowSeconds, type ProviderCapacityPolicy } from "../config/provider-policy";
import { ResponseHeaders } from "./response-headers";
import { emptySignals, httpClassification, plainObject, type ParsedSignals, type QuotaSignal } from "./response-signals";
import { parseResetDuration, parseRetryAfter, unsignedInteger } from "./response-time";
import { parseTokenUsage } from "./response-usage";

export function groqSignals(p: ProviderCapacityPolicy, status: number, headers: ResponseHeaders, body: unknown, now: number): ParsedSignals {
  const result = emptySignals(); result.httpStatus = status; result.classification = httpClassification(status);
  result.issues.push(...headers.issues);
  if (body !== undefined && !plainObject(body)) result.issues.push("invalid_body");
  if (plainObject(body)) {
    if (Object.hasOwn(body, "error") && body.error !== null) {
      if (!plainObject(body.error)) result.issues.push("invalid_body");
      if (status < 400) result.issues.push("contradictory_response");
    }
    const usage = parseTokenUsage(body.usage); result.usage = usage.usage; result.issues.push(...usage.issues);
  }
  for (const [name, seconds] of [["requests", 86400], ["tokens", 60]] as const) {
    const limit = headers.get(`x-ratelimit-limit-${name}`), remaining = headers.get(`x-ratelimit-remaining-${name}`), reset = headers.get(`x-ratelimit-reset-${name}`);
    if ([limit, remaining, reset].every(h => h.state === "missing")) continue;
    const q: QuotaSignal = { dimension: { metric: name, unit: name, windowSeconds: seconds },
      limit: limit.state === "value" ? unsignedInteger(limit.value) ?? null : null,
      remaining: remaining.state === "value" ? unsignedInteger(remaining.value) ?? null : null,
      reset: reset.state === "invalid" ? { state: "invalid" } : parseResetDuration(reset.state === "value" ? reset.value : undefined, now),
      quality: "verified" };
    if (limit.state === "invalid" || remaining.state === "invalid" || (limit.state === "value" && q.limit === null) ||
        (remaining.state === "value" && q.remaining === null) || (q.limit !== null && q.remaining !== null && q.remaining > q.limit)) {
      q.quality = "invalid"; result.issues.push("invalid_quota");
    }
    if (q.reset.state === "invalid") { q.quality = "invalid"; result.issues.push("invalid_reset"); }
    const d = p.dimensions.find(d => d.metric === name && windowSeconds(d.window) === seconds && d.unit === name);
    if (!d) { if (q.quality !== "invalid") q.quality = "unsupported"; result.issues.push("unsupported_dimension"); }
    else {
      if ((q.limit !== null && q.limit > capacityLimit(d)) || (q.remaining !== null && q.remaining > capacityLimit(d))) {
        if (q.quality !== "invalid") q.quality = "unsupported"; result.issues.push("capacity_above_policy");
      }
      // Groq reports relative provider deadlines, not our internal bucket ends.
      // These observations can restrict admission but never provision capacity.
    }
    if (q.quality === "verified" && (q.limit === null || q.remaining === null || q.reset.state === "missing")) q.quality = "partial";
    result.quotas.push(q);
  }
  const retry = headers.get("retry-after"), date = headers.get("date");
  result.retry = retry.state === "invalid" ? { state: "invalid" } :
    parseRetryAfter(retry.state === "value" ? retry.value : undefined, now, date.state === "value" ? date.value : date.state === "invalid" ? null : undefined);
  if (result.retry.state === "invalid") result.issues.push("invalid_retry");
  if (result.retry.state === "clock_uncertain") result.issues.push("clock_uncertain");
  if (retry.state !== "missing" && status !== 429) result.issues.push("unexpected_retry");
  if (status < 400) result.classification = result.quotas.some(q => q.remaining === 0 && ["verified", "partial"].includes(q.quality)) ? "quota_exhausted" :
    result.usage ? "usage_observation" : result.quotas.some(q => ["verified", "partial"].includes(q.quality)) ? "capacity_observation" : "insufficient_evidence";
  return result;
}
