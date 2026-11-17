-- Persist the admission metric: token dimensions alone cannot distinguish input,
-- output and combined usage. Ambiguous legacy token links remain NULL.
ALTER TABLE reservation_quota_windows ADD COLUMN quota_metric TEXT
  CHECK (quota_metric IN ('requests', 'input_tokens', 'output_tokens', 'tokens', 'compute_units'));
UPDATE reservation_quota_windows SET quota_metric = (
  SELECT dimension FROM provider_quota_windows WHERE id = quota_window_id
) WHERE quota_window_id IN (SELECT id FROM provider_quota_windows WHERE dimension != 'tokens');

-- Keep the original reconciliation request marker. This timestamp completes it
-- without rebuilding the reservation table or changing immutable outcomes.
ALTER TABLE request_reservations ADD COLUMN reconciliation_completed_at INTEGER
  CHECK (reconciliation_completed_at IS NULL OR
    (status = 'completed' AND reconciliation_state = 'awaiting'
     AND reconciliation_requested_at IS NOT NULL
     AND reconciliation_completed_at >= reconciliation_requested_at
     AND reconciliation_completed_at <= updated_at));

ALTER TABLE usage_accounting ADD COLUMN total_tokens INTEGER
  CHECK (total_tokens BETWEEN 0 AND 9007199254740991);
-- Canonical numeric map, validated by the internal settlement boundary. Supports
-- several named integer units while preserving legacy single-unit columns.
ALTER TABLE usage_accounting ADD COLUMN compute_usage TEXT
  CHECK (compute_usage IS NULL OR (json_valid(compute_usage) AND json_type(compute_usage) = 'object'));
ALTER TABLE usage_accounting ADD COLUMN estimate_policy TEXT
  CHECK (estimate_policy IS NULL OR (kind = 'estimated' AND estimate_policy = 'explicit_upper_bound_v1'));
ALTER TABLE usage_accounting ADD COLUMN settlement_hash TEXT
  CHECK (length(settlement_hash) = 64 AND settlement_hash NOT GLOB '*[^0-9a-f]*');
ALTER TABLE usage_accounting ADD COLUMN settlement_generation INTEGER
  CHECK (settlement_generation BETWEEN 1 AND 9007199254740991);
ALTER TABLE usage_accounting ADD COLUMN settlement_check INTEGER NOT NULL DEFAULT 1
  CONSTRAINT usage_settlement_succeeded CHECK (settlement_check = 1);
