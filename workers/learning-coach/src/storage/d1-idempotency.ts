import type { ClaimDecision, IdempotencyFence, IdempotencyStore, RequestIdentity, RequestState, RequestStatus, TransitionDecision } from "../storage";
import type { D1Binding, D1Statement } from "./d1-quota-admission";
import { sha256, validFence, validIdentity } from "./request-identity";

export interface IdempotencyPolicy { leaseSeconds: number; ttlSeconds: number; retentionSeconds: number }
type Row = { id: string; payload_hash: string; fingerprint_key_id: string | null; response_version: string;
  processing_state: RequestState; generation: number; expires_at: number; lease_expires_at: number | null; now: number };
const status = (state: RequestStatus["state"]): RequestStatus => ({ state, retryable: false });
const states: RequestState[] = ["pending", "reserved", "dispatched", "completed", "failed", "outcome_unknown"];
const SELECT = "SELECT *, unixepoch() AS now FROM idempotency_records WHERE service_id = ? AND key_hash = ?";

function describe(row: Row | undefined, identity: RequestIdentity): RequestStatus {
  if (!row) return status("storage_unavailable");
  if (row.fingerprint_key_id !== identity.fingerprintKeyId) return status("configuration_missing");
  if (row.payload_hash !== identity.payloadHash || row.response_version !== identity.responseVersion) return status("conflict");
  if (row.expires_at <= row.now) return status("expired");
  if (!states.includes(row.processing_state)) return status("storage_unavailable");
  if (["pending", "reserved", "dispatched"].includes(row.processing_state) &&
      (row.lease_expires_at === null || row.lease_expires_at <= row.now)) return status("outcome_unknown");
  return status(row.processing_state);
}

export class D1IdempotencyStore implements IdempotencyStore {
  private readonly policy: IdempotencyPolicy;
  constructor(private readonly db: D1Binding | undefined, policy: IdempotencyPolicy) { this.policy = { ...policy }; }

  async lookup(identity: RequestIdentity): Promise<RequestStatus> {
    if (!this.db || !validIdentity(identity)) return status("storage_unavailable");
    try {
      const result = await this.db.prepare(SELECT).bind(identity.serviceId, identity.keyHash).all<Row>();
      return result.success ? describe(result.results[0], identity) : status("storage_unavailable");
    } catch { return status("storage_unavailable"); }
  }

  async claim(identity: RequestIdentity): Promise<ClaimDecision> {
    const db = this.db;
    const p = this.policy;
    if (!validIdentity(identity) || ![p.leaseSeconds, p.ttlSeconds, p.retentionSeconds].every(v => Number.isSafeInteger(v) && v > 0 && v <= 31_536_000) ||
        p.leaseSeconds > p.ttlSeconds || p.ttlSeconds > p.retentionSeconds) return status("configuration_missing");
    if (!db) return status("storage_unavailable");
    try {
      const claimId = crypto.randomUUID();
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
      const results = await db.batch<Row>([
        db.prepare(`INSERT INTO idempotency_records (id, service_id, key_hash, payload_hash, fingerprint_key_id,
          owner_token_hash, response_version, processing_state, created_at, updated_at, expires_at, lease_expires_at, retain_until)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', unixepoch(), unixepoch(), unixepoch() + ?, unixepoch() + ?, unixepoch() + ?)
          ON CONFLICT(service_id, key_hash) DO NOTHING`)
          .bind(claimId, identity.serviceId, identity.keyHash, identity.payloadHash, identity.fingerprintKeyId,
            await sha256(token), identity.responseVersion, p.ttlSeconds, p.leaseSeconds, p.retentionSeconds),
        db.prepare(SELECT).bind(identity.serviceId, identity.keyHash),
      ]);
      if (results.length !== 2 || results.some(r => !r.success)) return status("storage_unavailable");
      const row = results[1]!.results[0];
      const existing = describe(row, identity);
      if (results[0]!.meta.changes === 1 && row?.id === claimId && existing.state === "pending") {
        return { state: "acquired", fence: { ...identity, claimId, token, generation: 1 } };
      }
      // Duplicates only get status. No capability is recovered or returned.
      return existing;
    } catch {
      // A timed-out insert may have committed. Read status, never retry the write
      // or infer processing ownership from a read (which might itself be stale).
      return this.lookup(identity);
    }
  }

  authorizeDispatch(fence: IdempotencyFence): Promise<TransitionDecision> { return this.transition(fence, "authorize"); }
  dispatch(fence: IdempotencyFence): Promise<TransitionDecision> { return this.transition(fence, "dispatch"); }
  complete(fence: IdempotencyFence): Promise<TransitionDecision> { return this.transition(fence, "complete"); }
  failBeforeDispatch(fence: IdempotencyFence): Promise<TransitionDecision> { return this.transition(fence, "fail"); }
  markUnknown(fence: IdempotencyFence): Promise<TransitionDecision> { return this.transition(fence, "unknown"); }
  awaitReconciliation(fence: IdempotencyFence): Promise<TransitionDecision> { return this.transition(fence, "await"); }

  private async transition(fence: IdempotencyFence, action: "authorize" | "dispatch" | "complete" | "fail" | "unknown" | "await"): Promise<TransitionDecision> {
    if (!validFence(fence)) return status("stale_owner");
    const db = this.db;
    if (!db) return status("storage_unavailable");
    try {
      // Reuse the durable claim as the authority for every lifecycle edge. A
      // reservation also needs its original admission links; a claim alone is
      // never sufficient authority to prepare or dispatch an inference attempt.
      const admittedReservation = `r.id = i.reservation_id AND r.service_id = i.service_id AND r.request_id = i.id
        AND r.reconciliation_state = 'not_requested'
        AND EXISTS (SELECT 1 FROM reservation_quota_windows l WHERE l.reservation_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM reservation_quota_windows l
          JOIN provider_quota_windows w ON w.id = l.quota_window_id
          WHERE l.reservation_id = r.id AND (l.status != 'reserved' OR l.settled_amount IS NOT NULL
            OR l.reserved_amount <= 0 OR l.reserved_amount > 9007199254740991
            OR l.reserved_amount != CAST(l.reserved_amount AS INTEGER)
            OR w.quota_scope_id != r.quota_scope_id OR w.provider != r.provider OR w.model NOT IN ('', r.model)))`;
      const prepared = `EXISTS (SELECT 1 FROM inference_attempts a WHERE a.reservation_id = r.id
        AND a.status = 'prepared' AND a.sent_at IS NULL AND a.finished_at IS NULL)`;
      const sent = `EXISTS (SELECT 1 FROM inference_attempts a WHERE a.reservation_id = r.id
        AND a.status = 'sent' AND a.sent_at IS NOT NULL AND a.finished_at IS NULL)`;
      const noAttempt = "NOT EXISTS (SELECT 1 FROM inference_attempts a WHERE a.reservation_id = r.id)";
      const owned = (predicate: string) => `EXISTS (SELECT 1 FROM request_reservations r WHERE ${admittedReservation} AND ${predicate})`;
      const predicates = {
        authorize: `i.processing_state = 'reserved' AND ${owned(`r.status = 'reserved' AND r.expires_at > unixepoch() AND ${noAttempt}`)}`,
        dispatch: `i.processing_state = 'reserved' AND ${owned(`r.status = 'reserved' AND r.expires_at > unixepoch() AND ${prepared}`)}`,
        complete: `i.processing_state = 'dispatched' AND ${owned(`r.status = 'sent' AND ${sent}`)}`,
        unknown: `i.processing_state = 'dispatched' AND ${owned(`r.status = 'sent' AND ${sent}`)}`,
        fail: `(i.processing_state = 'pending' AND i.reservation_id IS NULL) OR
          (i.processing_state = 'reserved' AND ${owned(`r.status = 'reserved' AND (${noAttempt} OR ${prepared})`)})`,
        await: owned(`EXISTS (SELECT 1 FROM inference_attempts a WHERE a.reservation_id = r.id AND a.finished_at IS NOT NULL
          AND ((i.processing_state = 'completed' AND r.status = 'completed' AND a.status = 'completed')
            OR (i.processing_state = 'failed' AND r.status = 'not_sent' AND a.status = 'not_sent')
            OR (i.processing_state = 'outcome_unknown' AND r.status = 'unknown' AND a.status = 'unknown')))`),
      };
      const next: RequestState = action === "authorize" ? "reserved" : action === "dispatch" ? "dispatched" :
        action === "complete" ? "completed" : action === "unknown" ? "outcome_unknown" : "failed";
      const assignment = action === "await" ? "" : "processing_state = ?, status = ?, response_status = ?,";
      const values: (string | number | null)[] = action === "await" ? [] : [next,
        next === "completed" ? "completed" : next === "outcome_unknown" ? "unknown" : "pending", next === "completed" ? 200 : null];
      const statements: D1Statement[] = [db.prepare(`UPDATE idempotency_records AS i SET ${assignment}
        generation = generation + 1, updated_at = unixepoch()
        WHERE i.id = ? AND i.service_id = ? AND i.key_hash = ? AND i.payload_hash = ?
          AND i.fingerprint_key_id = ? AND i.response_version = ? AND i.owner_token_hash = ?
          AND i.generation = ? AND i.generation < 9007199254740991
          AND i.status = CASE i.processing_state WHEN 'completed' THEN 'completed' WHEN 'outcome_unknown' THEN 'unknown' ELSE 'pending' END
          AND i.expires_at > unixepoch() AND i.lease_expires_at > unixepoch() AND (${predicates[action]})
        RETURNING reservation_id`)
        .bind(...values, fence.claimId, fence.serviceId, fence.keyHash, fence.payloadHash,
          fence.fingerprintKeyId, fence.responseVersion, await sha256(fence.token), fence.generation)];
      const reservation = "SELECT reservation_id FROM idempotency_records WHERE id = ?";
      const expected = action === "fail" ? `(CASE WHEN (${reservation}) IS NULL THEN 0 ELSE 1 END)` : "1";
      const guard = (optional = false) => db.prepare(`UPDATE idempotency_records SET transition_check =
        CASE WHEN changes() = ${optional ? expected : "1"} THEN 1 ELSE 0 END WHERE id = ?`)
        .bind(...(optional && action === "fail" ? [fence.claimId] : []), fence.claimId);
      statements.push(guard());
      const rowWrites: number[] = [];
      const write = (statement: D1Statement, optional = false) => {
        rowWrites.push(statements.length);
        statements.push(statement, guard(optional));
      };
      if (action === "authorize") {
        write(db.prepare(`INSERT INTO inference_attempts (id, reservation_id, status, created_at, updated_at, retain_until)
          SELECT ?, id, 'prepared', unixepoch(), unixepoch(), retain_until FROM request_reservations
          WHERE id = (${reservation})`).bind(crypto.randomUUID(), fence.claimId));
      } else if (action === "dispatch") {
        write(db.prepare(`UPDATE request_reservations SET status = 'sent', updated_at = unixepoch()
          WHERE id = (${reservation}) AND status = 'reserved' AND expires_at > unixepoch()`).bind(fence.claimId));
        write(db.prepare(`UPDATE inference_attempts SET status = 'sent', sent_at = unixepoch(), updated_at = unixepoch()
          WHERE reservation_id = (${reservation}) AND status = 'prepared' AND sent_at IS NULL AND finished_at IS NULL`).bind(fence.claimId));
      } else if (action === "await") {
        write(db.prepare(`UPDATE request_reservations SET reconciliation_state = 'awaiting',
          reconciliation_requested_at = unixepoch(), updated_at = unixepoch()
          WHERE id = (${reservation}) AND reconciliation_state = 'not_requested'`).bind(fence.claimId));
      } else {
        const outcome = action === "complete" ? "completed" : action === "unknown" ? "unknown" : "not_sent";
        write(db.prepare(`UPDATE request_reservations SET status = ?, updated_at = unixepoch()
          WHERE id = (${reservation}) AND status = ?`).bind(outcome, fence.claimId, action === "fail" ? "reserved" : "sent"), action === "fail");
        if (action === "fail") {
          write(db.prepare(`INSERT INTO inference_attempts (id, reservation_id, status, created_at, updated_at, finished_at, retain_until)
            SELECT ?, id, 'not_sent', unixepoch(), unixepoch(), unixepoch(), retain_until FROM request_reservations
            WHERE id = (${reservation})
            ON CONFLICT(reservation_id) DO UPDATE SET status = 'not_sent', updated_at = unixepoch(), finished_at = unixepoch()
            WHERE inference_attempts.status = 'prepared' AND inference_attempts.sent_at IS NULL AND inference_attempts.finished_at IS NULL`)
            .bind(crypto.randomUUID(), fence.claimId), true);
        } else {
          write(db.prepare(`UPDATE inference_attempts SET status = ?, updated_at = unixepoch(), finished_at = unixepoch()
            WHERE reservation_id = (${reservation}) AND status = 'sent' AND finished_at IS NULL`).bind(outcome, fence.claimId));
        }
      }
      const results = await db.batch<{ reservation_id: string | null }>(statements);
      if (results.length !== statements.length || results.some(r => !r.success)) return status("storage_unavailable");
      if (results[0]!.meta.changes === 0) return status("stale_owner");
      const noReservation = action === "fail" && results[0]!.results[0]?.reservation_id === null;
      if (results.some((r, index) => r.meta.changes !== (noReservation && rowWrites.includes(index) ? 0 : 1))) return status("storage_unavailable");
      return { state: "updated", fence: { ...fence, generation: fence.generation + 1 } };
    } catch (error) {
      if (error instanceof Error && error.message.includes("idempotency_transition_succeeded")) return status("stale_owner");
      // Never replay a possibly committed dispatch/completion after a timeout.
      return status("storage_unavailable");
    }
  }
}
