-- Add ownership/fencing metadata without replacing Part 4A tables or statuses.
ALTER TABLE idempotency_records ADD COLUMN processing_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (processing_state IN ('pending', 'reserved', 'dispatched', 'completed', 'failed', 'outcome_unknown'));
ALTER TABLE idempotency_records ADD COLUMN fingerprint_key_id TEXT
  CHECK (length(fingerprint_key_id) = 64 AND fingerprint_key_id NOT GLOB '*[^0-9a-f]*');
ALTER TABLE idempotency_records ADD COLUMN owner_token_hash TEXT
  CHECK (length(owner_token_hash) = 64 AND owner_token_hash NOT GLOB '*[^0-9a-f]*');
ALTER TABLE idempotency_records ADD COLUMN generation INTEGER NOT NULL DEFAULT 1
  CHECK (generation BETWEEN 1 AND 9007199254740991);
ALTER TABLE idempotency_records ADD COLUMN lease_expires_at INTEGER
  CHECK (lease_expires_at >= created_at AND lease_expires_at <= expires_at);
ALTER TABLE idempotency_records ADD COLUMN reservation_id TEXT
  REFERENCES request_reservations(id) ON DELETE RESTRICT;
ALTER TABLE idempotency_records ADD COLUMN transition_check INTEGER NOT NULL DEFAULT 1
  CONSTRAINT idempotency_transition_succeeded CHECK (transition_check = 1);
ALTER TABLE request_reservations ADD COLUMN ownership_check INTEGER NOT NULL DEFAULT 1
  CONSTRAINT idempotency_admission_succeeded CHECK (ownership_check = 1);

UPDATE idempotency_records SET processing_state = CASE status
  WHEN 'completed' THEN 'completed' WHEN 'unknown' THEN 'outcome_unknown' ELSE 'pending' END;
CREATE UNIQUE INDEX idempotency_reservation ON idempotency_records(reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX idempotency_processing_lease ON idempotency_records(processing_state, lease_expires_at);
