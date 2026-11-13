-- One immutable failure observation per existing attempt. Unknown request counts
-- cannot be represented by usage_accounting.request_count (NOT NULL), so failure
-- evidence lives here rather than fabricating a successful/zero-usage receipt.
ALTER TABLE inference_attempts ADD COLUMN failure_category TEXT CHECK (failure_category IN (
  'PROVEN_PRE_DISPATCH_FAILURE', 'POSSIBLY_DISPATCHED_FAILURE', 'CONFIRMED_PROVIDER_ERROR',
  'UNKNOWN_OUTCOME', 'INVALID_OR_UNTRUSTED_USAGE'));
ALTER TABLE inference_attempts ADD COLUMN failure_reason TEXT CHECK (failure_reason IN (
  'validation_failed', 'preparation_failed', 'dispatch_cancelled', 'connection_failure', 'request_timeout',
  'interrupted_send', 'provider_http_error', 'crash_boundary', 'response_missing', 'ambiguous_response',
  'missing_usage', 'malformed_usage', 'contradictory_usage', 'untrusted_usage', 'malformed_response'));
ALTER TABLE inference_attempts ADD COLUMN failure_http_status INTEGER CHECK (failure_http_status BETWEEN 400 AND 599);
ALTER TABLE inference_attempts ADD COLUMN failure_usage TEXT
  CHECK (failure_usage IS NULL OR (json_valid(failure_usage) AND json_type(failure_usage) = 'object'));
ALTER TABLE inference_attempts ADD COLUMN failure_receipt_hash TEXT
  CHECK (length(failure_receipt_hash) = 64 AND failure_receipt_hash NOT GLOB '*[^0-9a-f]*');
ALTER TABLE inference_attempts ADD COLUMN failure_generation INTEGER CHECK (failure_generation BETWEEN 1 AND 9007199254740991);
ALTER TABLE inference_attempts ADD COLUMN failure_accounting_state TEXT
  CHECK (failure_accounting_state IN ('released', 'held', 'partial', 'accounted'));
ALTER TABLE inference_attempts ADD COLUMN failure_recorded_at INTEGER CHECK (failure_recorded_at IS NULL OR
  (status IN ('not_sent', 'unknown') AND finished_at IS NOT NULL AND failure_recorded_at >= finished_at
   AND failure_recorded_at <= updated_at AND failure_category IS NOT NULL AND failure_reason IS NOT NULL
   AND failure_usage IS NOT NULL AND failure_receipt_hash IS NOT NULL AND failure_generation IS NOT NULL
   AND failure_accounting_state IS NOT NULL));

-- Original reserved_amount remains audit data. Unreported dimensions retain a
-- separate outstanding amount; NULL settled_amount continues to mean unknown.
ALTER TABLE reservation_quota_windows ADD COLUMN failure_basis TEXT
  CHECK (failure_basis IN ('proven_not_sent', 'measured', 'estimated', 'unreported'));
ALTER TABLE reservation_quota_windows ADD COLUMN failure_held_amount INTEGER
  CHECK (failure_held_amount BETWEEN 0 AND 9007199254740991);
