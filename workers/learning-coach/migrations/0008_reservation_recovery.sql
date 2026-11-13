-- Recovery authority is separate from the original dispatch owner. No normal
-- owner lease is extended and no outcome/counter/receipt is rewritten here.
ALTER TABLE request_reservations ADD COLUMN recovery_operation_id TEXT;
ALTER TABLE request_reservations ADD COLUMN recovery_token_hash TEXT
  CHECK (length(recovery_token_hash) = 64 AND recovery_token_hash NOT GLOB '*[^0-9a-f]*');
ALTER TABLE request_reservations ADD COLUMN recovery_generation INTEGER
  CHECK (recovery_generation BETWEEN 1 AND 9007199254740991);
ALTER TABLE request_reservations ADD COLUMN recovery_started_at INTEGER
  CHECK (recovery_started_at >= created_at AND recovery_started_at <= updated_at);
ALTER TABLE request_reservations ADD COLUMN recovery_lease_expires_at INTEGER
  CHECK (recovery_lease_expires_at >= recovery_started_at AND recovery_lease_expires_at <= retain_until);
ALTER TABLE request_reservations ADD COLUMN recovery_receipt_hash TEXT
  CHECK (length(recovery_receipt_hash) = 64 AND recovery_receipt_hash NOT GLOB '*[^0-9a-f]*');
ALTER TABLE request_reservations ADD COLUMN recovery_completed_at INTEGER
  CHECK (recovery_completed_at IS NULL OR (status = 'not_sent' AND reconciliation_state = 'awaiting'
    AND recovery_operation_id IS NOT NULL AND recovery_token_hash IS NOT NULL AND recovery_generation IS NOT NULL
    AND recovery_started_at IS NOT NULL AND recovery_lease_expires_at IS NOT NULL AND recovery_receipt_hash IS NOT NULL
    AND recovery_completed_at >= recovery_started_at AND recovery_completed_at <= updated_at));
CREATE UNIQUE INDEX reservations_recovery_operation ON request_reservations(recovery_operation_id)
  WHERE recovery_operation_id IS NOT NULL;
CREATE INDEX reservations_recovery_scan ON request_reservations(service_id, expires_at, id);
CREATE INDEX idempotency_recovery_scan ON idempotency_records(service_id, lease_expires_at, id);
