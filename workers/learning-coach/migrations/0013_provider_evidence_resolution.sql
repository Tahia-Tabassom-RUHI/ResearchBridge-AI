CREATE TABLE provider_evidence_resolutions (
  operation_id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES inference_attempts(id) ON DELETE RESTRICT,
  service_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  proof_hash TEXT NOT NULL CHECK (length(proof_hash) = 64 AND proof_hash NOT GLOB '*[^0-9a-f]*'),
  method TEXT NOT NULL CHECK (method IN ('not_dispatched', 'accounted_with_hold')),
  expected_generation INTEGER NOT NULL CHECK (expected_generation BETWEEN 1 AND 9007199254740990),
  resulting_generation INTEGER NOT NULL CHECK (resulting_generation BETWEEN 1 AND 9007199254740991),
  hold_operation_id TEXT REFERENCES provider_hold_operations(operation_id) ON DELETE RESTRICT,
  resolved_at INTEGER NOT NULL CHECK (resolved_at BETWEEN 0 AND 9007199254740991),
  CHECK ((method = 'not_dispatched' AND hold_operation_id IS NULL AND resulting_generation IN (expected_generation, expected_generation + 1))
    OR (method = 'accounted_with_hold' AND hold_operation_id = attempt_id AND resulting_generation = expected_generation))
) STRICT;
CREATE INDEX evidence_pending_scan ON inference_attempts(provider_evidence_state, created_at, id);
CREATE TRIGGER evidence_resolution_immutable BEFORE UPDATE ON provider_evidence_resolutions
BEGIN SELECT RAISE(ABORT, 'evidence_resolution_immutable'); END;
CREATE TRIGGER evidence_resolution_retained BEFORE DELETE ON provider_evidence_resolutions
BEGIN SELECT RAISE(ABORT, 'evidence_resolution_immutable'); END;
CREATE TRIGGER evidence_resolution_no_dispatch BEFORE UPDATE OF status ON request_reservations
WHEN NEW.status = 'sent' AND EXISTS (SELECT 1 FROM provider_evidence_resolutions e
  JOIN inference_attempts a ON a.id = e.attempt_id WHERE a.reservation_id = NEW.id AND e.method = 'not_dispatched')
BEGIN SELECT RAISE(ABORT, 'evidence_resolution_not_dispatched'); END;
