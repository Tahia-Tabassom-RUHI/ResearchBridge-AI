import type { RecoveryFence } from "../storage";
import { hashPattern, requestIdPattern } from "./request-identity";

export function validRecoveryFence(f: RecoveryFence): boolean {
  return !!f && typeof f.serviceId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(f.serviceId) &&
    [f.claimId, f.reservationId, f.attemptId, f.operationId].every(v => typeof v === "string" && requestIdPattern.test(v)) &&
    typeof f.token === "string" && hashPattern.test(f.token) && Number.isSafeInteger(f.generation) && f.generation > 1 && f.generation <= Number.MAX_SAFE_INTEGER;
}
// Does not extend the original owner's lease/TTL or replace its token. Only a
// separately authenticated, durably acquired capability passes this predicate.
export const RECOVERY_AUTH = `i.id = ? AND i.service_id = ? AND i.generation = ?
  AND r.service_id = i.service_id AND r.request_id = i.id AND r.id = ? AND a.id = ?
  AND r.provider = ? AND r.model = ? AND r.recovery_operation_id = ? AND r.recovery_token_hash = ?
  AND r.recovery_generation = i.generation AND r.recovery_lease_expires_at > unixepoch()
  AND r.recovery_completed_at IS NULL AND r.recovery_receipt_hash IS NULL
  AND i.lease_expires_at <= unixepoch() AND r.expires_at <= unixepoch()
  AND i.updated_at <= unixepoch() AND r.updated_at <= unixepoch() AND a.updated_at <= unixepoch()`;
