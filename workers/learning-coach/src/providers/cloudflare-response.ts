import { resetBounds, type ProviderCapacityPolicy } from "../config/provider-policy";
import { ResponseHeaders } from "./response-headers";
import { emptySignals, httpClassification, plainObject, type ParsedSignals, type ResponseClassification } from "./response-signals";
import { parseRetryAfter } from "./response-time";
import { parseTokenUsage } from "./response-usage";

const codes: Record<number, { status: number; classification: ResponseClassification }> = {
  3036: { status: 429, classification: "quota_exhausted" }, 3040: { status: 429, classification: "temporary_capacity_unavailable" },
  5035: { status: 403, classification: "paid_plan_required" }, 5028: { status: 410, classification: "model_deprecated" },
  5018: { status: 403, classification: "model_access_denied" }, 3041: { status: 403, classification: "model_access_denied" },
  5007: { status: 400, classification: "model_unavailable" }, 3042: { status: 404, classification: "model_unavailable" },
  3007: { status: 408, classification: "provider_timeout" }, 3008: { status: 408, classification: "connection_interrupted" },
  5004: { status: 400, classification: "invalid_request" }, 3003: { status: 400, classification: "invalid_request" },
  3006: { status: 413, classification: "invalid_request" }, 5005: { status: 405, classification: "invalid_request" },
};
export function cloudflareSignals(p: ProviderCapacityPolicy, status: number | null, headers: ResponseHeaders,
  body: unknown, bindingCode: number | undefined, now: number): ParsedSignals {
  const result = emptySignals(); result.httpStatus = status; result.issues.push(...headers.issues);
  result.classification = status === null ? "insufficient_evidence" : httpClassification(status);
  let code = bindingCode, usageBody: unknown;
  if (body !== undefined) {
    if (!plainObject(body)) result.issues.push("invalid_body");
    else if (status === null) {
      usageBody = body;
      if (Object.hasOwn(body, "error") || Object.hasOwn(body, "errors") || body.success === false) result.issues.push("contradictory_response");
    }
    else {
      // Native Workers AI REST envelope only. A gateway/generic API namespace
      // must not be attested as workers_ai_http by future transport composition.
      const errors = body.errors;
      if (typeof body.success !== "boolean" || (errors !== undefined && !Array.isArray(errors))) result.issues.push("invalid_body");
      else if (Array.isArray(errors) && errors.length > 0) {
        if (errors.length > 8 || errors.some(e => !plainObject(e) || !Number.isSafeInteger(e.code) || Number(e.code) < 1 || Number(e.code) > 99999)) result.issues.push("invalid_body");
        else {
          const unique = new Set(errors.map(e => (e as { code: number }).code));
          if (unique.size !== 1) result.issues.push("contradictory_response"); else code = [...unique][0];
        }
        if (body.success !== false || status < 400) result.issues.push("contradictory_response");
      } else if (body.success === false && status < 400) result.issues.push("contradictory_response");
      if (body.success === true && status >= 400) result.issues.push("contradictory_response");
      usageBody = body.result;
      if (usageBody !== undefined && usageBody !== null && !plainObject(usageBody)) result.issues.push("invalid_body");
    }
  }
  if (plainObject(usageBody)) {
    const usage = parseTokenUsage(usageBody.usage); result.usage = usage.usage; result.issues.push(...usage.issues);
    if (result.usage && (status === null || status < 400)) result.classification = "usage_observation";
  }
  if (code !== undefined) {
    result.providerErrorCode = code;
    const mapped = codes[code];
    if (!mapped) { result.classification = "provider_error"; result.issues.push("unknown_error_code"); }
    else {
      result.classification = mapped.classification;
      if (status !== null && mapped.status !== status) result.issues.push("contradictory_response");
    }
    if (code === 3036) {
      const d = p.dimensions.find(d => d.metric === "compute_units" && d.unit === "neurons" && d.window.kind === "utc_day");
      if (d) result.quotas.push({ dimension: { metric: "compute_units", unit: "neurons", windowSeconds: 86400 },
        limit: null, remaining: 0, reset: { state: "known", until: resetBounds(d.window, now).end, basis: "policy_utc_day" }, quality: "verified" });
      else result.issues.push("unsupported_dimension");
    }
  }
  const retry = headers.get("retry-after"), date = headers.get("date");
  result.retry = retry.state === "invalid" ? { state: "invalid" } : parseRetryAfter(retry.state === "value" ? retry.value : undefined,
    now, date.state === "value" ? date.value : date.state === "invalid" ? null : undefined);
  if (result.retry.state === "invalid") result.issues.push("invalid_retry");
  if (result.retry.state === "clock_uncertain") result.issues.push("clock_uncertain");
  if (retry.state !== "missing" && (status !== 429 && status !== 503 || ["model_deprecated", "paid_plan_required", "model_unavailable", "model_access_denied"].includes(result.classification))) {
    result.issues.push("unexpected_retry");
  }
  if (retry.state !== "missing" && ["model_deprecated", "paid_plan_required", "model_unavailable", "model_access_denied"].includes(result.classification)) {
    result.retry = { state: "invalid" }; // Permanent/eligibility failures carry no temporary retry deadline.
  }
  return result;
}
