import { isCapacityModel, LEGACY_QWEN_MODEL, QWEN_REVIEW_BOUNDARY } from "../config/provider-policy";
import type { QuotaAdmissionPolicy, QuotaAdmissionResult } from "../storage";
import type { D1Binding } from "./d1-quota-admission";
import { canonicalJson } from "./request-identity";

export type AvailabilityProblem = Pick<Extract<QuotaAdmissionResult, { admitted: false }>, "status" | "reason" | "resetAt">;
export type Parameter = (value: string | number | null) => string;

// Shared by authoritative admission SQL and read-only inspection. The caller
// supplies SQL placeholders/clock expressions, never public SQL fragments.
export function applicableHoldPredicate(scope: string, provider: string, model: string, windows: string, now: string, modern = true): string {
  return `h.quota_scope_id = ${scope} AND h.provider = ${provider} AND h.model IN ('', ${model})
    AND h.status = 'active' AND (h.hold_until IS NULL OR h.hold_until > ${now})` + (modern ? `
    AND (h.quota_metric IS NULL OR EXISTS (SELECT 1 FROM json_each(${windows}) w
      WHERE h.quota_metric = json_extract(w.value, '$.metric') AND h.unit = json_extract(w.value, '$.unit')
        AND h.window_seconds = json_extract(w.value, '$.windowSeconds')
        AND (h.quota_window_id IS NULL OR h.quota_window_id = json_extract(w.value, '$.windowId'))))` : "");
}

export function currentPolicyPredicate(scope: string, provider: string, model: string, version: string, hash: string, review: string, now: string, windows?: string): string {
  const seconds = "CASE WHEN json_extract(d.value, '$.window.kind') = 'utc_day' THEN 86400 ELSE json_extract(d.value, '$.window.seconds') END";
  const anchor = "coalesce(json_extract(d.value, '$.window.anchor'), 0)";
  // A receipt reference cannot be reused with a subset of required dimensions
  // to evade a dimension hold (or the corresponding quota protection).
  const coverage = windows ? `AND json_array_length(p.policy_json, '$.dimensions') = json_array_length(${windows})
    AND NOT EXISTS (SELECT 1 FROM json_each(p.policy_json, '$.dimensions') d WHERE NOT EXISTS (
      SELECT 1 FROM json_each(${windows}) w WHERE json_extract(w.value, '$.metric') = json_extract(d.value, '$.metric')
        AND json_extract(w.value, '$.unit') = json_extract(d.value, '$.unit')
        AND json_extract(w.value, '$.windowSeconds') = (${seconds})
        AND json_extract(w.value, '$.model') = CASE WHEN p.provider = 'cloudflare_workers_ai' THEN '' ELSE p.model END
        AND json_extract(w.value, '$.capacity') = min(coalesce(json_extract(d.value, '$.documented.amount'), 9007199254740991),
          coalesce(json_extract(d.value, '$.account.amount'), 9007199254740991))
        AND json_extract(w.value, '$.safetyMargin') = json_extract(d.value, '$.safetyMargin')
        AND json_extract(w.value, '$.windowStart') = ${now} - ((${now} - (${anchor})) % (${seconds}) + (${seconds})) % (${seconds})))` : "";
  return `EXISTS (SELECT 1 FROM provider_capacity_policies p WHERE p.quota_scope_id = ${scope} AND p.provider = ${provider}
    AND p.model = ${model} AND p.version = ${version} AND p.policy_hash = ${hash} AND p.review_after = ${review}
    AND p.verified_at <= ${now} AND p.updated_at <= ${now} AND p.review_after > ${now}
    AND json_extract(p.policy_json, '$.enabled') = 1 AND json_extract(p.policy_json, '$.plan') = 'free'
    AND json_extract(p.policy_json, '$.billing') = 'free_only'
    AND json_extract(p.policy_json, '$.eligibility.verified') = 1 AND json_extract(p.policy_json, '$.eligibility.paidOnly') = 0 ${coverage})`;
}

export function admissionAvailabilitySql(p: QuotaAdmissionPolicy, modernHolds: boolean, policySchema: boolean, bind: Parameter, evidenceSchema = false): { held: string; eligible: string } {
  const scope = bind(p.quotaScopeId), provider = bind(p.provider), model = bind(p.model);
  const windows = modernHolds || p.providerPolicy ? bind(canonicalJson(p.windows)) : "''";
  const held = applicableHoldPredicate(scope, provider, model, windows, "unixepoch()", modernHolds);
  const approvedModel = isCapacityModel(p.provider, p.model);
  let eligible: string;
  if (p.providerPolicy) {
    eligible = policySchema ? currentPolicyPredicate(scope, provider, model, bind(p.providerPolicy.version),
      bind(p.providerPolicy.hash), bind(p.providerPolicy.reviewAfter), "unixepoch()", windows) : "0";
  } else {
    // A managed allocation cannot evade version checks by omitting its receipt
    // reference. Unmanaged local/legacy fixtures retain their existing contract.
    eligible = approvedModel ? "0" : policySchema ?
      `NOT EXISTS (SELECT 1 FROM provider_capacity_policies p WHERE p.quota_scope_id = ${scope} AND p.provider = ${provider})` : "1";
  }
  if (p.provider === "cloudflare_workers_ai" && p.model === LEGACY_QWEN_MODEL) {
    eligible += ` AND unixepoch() < ${QWEN_REVIEW_BOUNDARY}`;
  }
  if (p.requireResponseEvidence && !evidenceSchema) eligible += " AND 0";
  if (evidenceSchema) {
    // Pending transport evidence cannot disappear on lease/window expiry or
    // usage reconciliation. Cloudflare shares its allocation across models.
    eligible += ` AND NOT EXISTS (SELECT 1 FROM inference_attempts a
      JOIN request_reservations r ON r.id = a.reservation_id
      WHERE a.provider_evidence_state = 'pending' AND r.quota_scope_id = ${scope}
        AND r.provider = ${provider} AND (${provider} = 'cloudflare_workers_ai' OR r.model = ${model}))`;
  }
  return { held, eligible };
}

// Diagnostic only. Admission repeats both predicates in every conditional quota
// write, followed by the existing changes() assertion that rolls back the batch.
export async function inspectAvailability(db: D1Binding, p: QuotaAdmissionPolicy, modernHolds: boolean, policySchema: boolean, evidenceSchema = false): Promise<AvailabilityProblem | undefined> {
  const values: (string | number | null)[] = [];
  const sql = admissionAvailabilitySql(p, modernHolds, policySchema, value => { values.push(value); return `?${values.length}`; }, evidenceSchema);
  const result = await db.prepare(`SELECT (${sql.eligible}) AS eligible, unixepoch() AS now, count(*) AS held,
    coalesce(max(h.hold_until IS NULL), 0) AS indefinite,
    coalesce(max(h.reason_code = 'model_unavailable'), 0) AS model_unavailable,
    coalesce(max(h.model = '' ${modernHolds ? "AND h.quota_metric IS NULL" : ""}), 0) AS provider_held,
    coalesce(max(h.model != '' ${modernHolds ? "AND h.quota_metric IS NULL" : ""}), 0) AS model_held,
    max(h.hold_until) AS reset_at FROM provider_holds h WHERE ${sql.held}`).bind(...values).all<{
      eligible: number; now: number; held: number; indefinite: number; model_unavailable: number; provider_held: number; model_held: number; reset_at: number | null;
    }>();
  const row = result.results[0];
  if (!result.success || !row) throw new Error("Availability read unavailable");
  if (!row.eligible) return { status: "provider_policy_unavailable", reason:
    p.provider === "cloudflare_workers_ai" && p.model === LEGACY_QWEN_MODEL && row.now >= QWEN_REVIEW_BOUNDARY ? "model_unavailable" : "policy_unavailable" };
  if (!row.held) return;
  if (row.model_unavailable) return { status: "model_held", reason: "model_unavailable" };
  if (row.indefinite) return { status: "provider_capacity_unknown", reason: "capacity_unknown" };
  if (!Number.isSafeInteger(row.reset_at) || row.reset_at! <= row.now) return { status: "provider_capacity_unknown", reason: "capacity_unknown" };
  const until = { resetAt: row.reset_at! };
  if (row.provider_held) return { status: "provider_held", reason: "provider_restricted", ...until };
  if (row.model_held) return { status: "model_held", reason: "model_restricted", ...until };
  return { status: "quota_dimension_held", reason: "quota_dimension_restricted", ...until };
}
