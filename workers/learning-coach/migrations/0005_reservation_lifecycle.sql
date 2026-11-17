-- Reconciliation eligibility is independent of the immutable dispatch outcome.
-- Existing statuses and all counters are preserved. No recovery or settlement.
ALTER TABLE request_reservations ADD COLUMN reconciliation_state TEXT NOT NULL DEFAULT 'not_requested'
  CHECK (reconciliation_state IN ('not_requested', 'awaiting'));
ALTER TABLE request_reservations ADD COLUMN reconciliation_requested_at INTEGER
  CHECK ((reconciliation_state = 'not_requested' AND reconciliation_requested_at IS NULL) OR
         (reconciliation_state = 'awaiting' AND reconciliation_requested_at IS NOT NULL
          AND reconciliation_requested_at >= created_at AND reconciliation_requested_at <= updated_at));
CREATE INDEX reservations_reconciliation ON request_reservations(reconciliation_state, updated_at);
