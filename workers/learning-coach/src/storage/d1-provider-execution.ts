import { providerPolicyJson, type ProviderCapacityPolicy } from "../config/provider-policy";
import type { IdempotencyFence } from "../storage";
import type { ProviderAttempt } from "../providers/types";
import type { D1Binding, D1Statement } from "./d1-quota-admission";
import { currentPolicyPredicate } from "./provider-availability";
import { sha256, validFence } from "./request-identity";

// Dispatch evidence acknowledgement, not usage settlement or another hold store.
export class D1ProviderExecution {
  constructor(private readonly db: D1Binding, private readonly policy: ProviderCapacityPolicy) {}

  async ownerGate(f: IdempotencyFence, a: ProviderAttempt, state: "prepared" | "sent"): Promise<D1Statement> {
    if (!validFence(f)) throw new Error("Invalid owner");
    return this.db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM idempotency_records i JOIN request_reservations r ON r.id = i.reservation_id
      JOIN inference_attempts a ON a.reservation_id = r.id
      WHERE i.id = ? AND i.service_id = ? AND i.key_hash = ? AND i.payload_hash = ? AND i.fingerprint_key_id = ?
        AND i.response_version = ? AND i.owner_token_hash = ? AND i.generation = ?
        AND i.lease_expires_at > unixepoch() AND i.expires_at > unixepoch()
        AND i.processing_state = ? AND r.id = ? AND a.id = ? AND a.status = ?
        AND r.quota_scope_id = ? AND r.provider = ? AND r.model = ?
        AND r.recovery_operation_id IS NULL
    ) THEN 1 ELSE json('provider_execution_stale_owner') END AS checked`)
      .bind(f.claimId, f.serviceId, f.keyHash, f.payloadHash, f.fingerprintKeyId, f.responseVersion,
        await sha256(f.token), f.generation, state === "prepared" ? "reserved" : "dispatched",
        a.reservationId, a.attemptId, state, this.policy.quotaScopeId, this.policy.provider, this.policy.model);
  }

  async arm(f: IdempotencyFence, a: ProviderAttempt): Promise<boolean> {
    try {
      const p = this.policy, hash = await sha256(providerPolicyJson(p));
      const gate = this.db.prepare(`SELECT CASE WHEN ${currentPolicyPredicate("?1", "?2", "?3", "?4", "?5", "?6", "unixepoch()")}
        THEN 1 ELSE json('provider_execution_policy_changed') END AS checked`)
        .bind(p.quotaScopeId, p.provider, p.model, p.version, hash, p.reviewAfter);
      const results = await this.db.batch([await this.ownerGate(f, a, "prepared"), gate,
        this.db.prepare(`UPDATE inference_attempts SET provider_evidence_state = 'pending', provider_evidence_policy_hash = ?
          WHERE id = ? AND reservation_id = ? AND provider_evidence_state = 'not_required'`).bind(hash, a.attemptId, a.reservationId),
        this.db.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('provider_execution_conflict') END AS checked")]);
      // A lost acknowledgement never permits a dispatch. The barrier remains.
      return results.length === 4 && results.every((r, i) => r.success && (i === 2 ? r.meta.changes === 1 :
        r.meta.changes === 0 && r.results[0]?.checked === 1));
    } catch { return false; }
  }

  async acknowledge(f: IdempotencyFence, a: ProviderAttempt, receiptHash: string): Promise<boolean> {
    try {
      const hash = await sha256(providerPolicyJson(this.policy));
      const results = await this.db.batch([await this.ownerGate(f, a, "sent"),
        this.db.prepare(`UPDATE inference_attempts SET provider_evidence_state = 'acknowledged', provider_evidence_receipt = ?
          WHERE id = ? AND reservation_id = ? AND provider_evidence_policy_hash = ? AND provider_evidence_state = 'pending'`)
          .bind(receiptHash, a.attemptId, a.reservationId, hash),
        this.db.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('provider_execution_conflict') END AS checked")]);
      return results.length === 3 && results.every((r, i) => r.success && (i === 1 ? r.meta.changes === 1 :
        r.meta.changes === 0 && r.results[0]?.checked === 1));
    } catch { return false; }
  }
}
