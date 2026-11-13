import type { ProviderAttempt } from "../providers/types";
import type { IdempotencyFence, QuotaMetric, RequestStatus } from "../storage";
import type { D1Binding } from "./d1-quota-admission";
import { classifyRecovery, readRecoverySnapshot } from "./recovery-inspection";
import { sha256, validFence } from "./request-identity";

export interface OwnedAttempt extends ProviderAttempt { windows: { metric: QuotaMetric; unit: string; reserved: number }[] }
export type AttemptDecision = { state: "owned"; attempt: OwnedAttempt } | RequestStatus;
// Read metadata only. The following lifecycle/accounting write must independently
// check current ownership; this snapshot never grants dispatch authority.
export async function readOwnedAttempt(db: D1Binding | undefined, fence: IdempotencyFence, reservationId: string): Promise<AttemptDecision> {
  if (!db) return { state: "storage_unavailable", retryable: false };
  if (!validFence(fence)) return { state: "stale_owner", retryable: false };
  try {
    const snapshot = await readRecoverySnapshot(db, fence.serviceId, reservationId), r = snapshot.r, a = snapshot.a;
    const inspection = await classifyRecovery(snapshot);
    if (!r || !a || !inspection?.ownerActive || inspection.classification === "inconsistent_record" ||
        r.claim_id !== fence.claimId || r.claim_generation !== fence.generation || r.key_hash !== fence.keyHash ||
        r.payload_hash !== fence.payloadHash || r.fingerprint_key_id !== fence.fingerprintKeyId || r.response_version !== fence.responseVersion ||
        r.owner_token_hash !== await sha256(fence.token) || r.recovery_operation_id !== null) return { state: "stale_owner", retryable: false };
    return { state: "owned", attempt: { reservationId: r.id, attemptId: a.id, provider: r.provider, model: r.model,
      windows: snapshot.links.map(l => ({ metric: l.quota_metric!, unit: l.unit, reserved: l.reserved_amount })) } };
  } catch { return { state: "storage_unavailable", retryable: false }; }
}
