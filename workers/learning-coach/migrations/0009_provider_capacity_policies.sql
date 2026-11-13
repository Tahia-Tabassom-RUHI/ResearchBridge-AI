-- Applied atomically by the D1 migration runner. Rebuild only the quota-window
-- parent to replace the old token identity constraint. Retain every original
-- column, value and foreign-key target. Legacy token metrics stay ambiguous.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE provider_quota_windows_v9 (
  id TEXT PRIMARY KEY NOT NULL,
  quota_scope_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('requests', 'tokens', 'compute_units')),
  unit TEXT NOT NULL CHECK (length(unit) > 0),
  window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
  window_start INTEGER NOT NULL CHECK (window_start >= 0),
  window_end INTEGER NOT NULL,
  limit_amount REAL NOT NULL CHECK (limit_amount >= 0),
  reserved_amount REAL NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
  consumed_amount REAL NOT NULL DEFAULT 0 CHECK (consumed_amount >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  retain_until INTEGER NOT NULL CHECK (retain_until >= window_end AND retain_until >= updated_at),
  safety_margin INTEGER NOT NULL DEFAULT 0
    CHECK (safety_margin >= 0 AND safety_margin <= 9007199254740991 AND safety_margin <= limit_amount),
  quota_metric TEXT CHECK (quota_metric IN ('requests', 'tokens', 'input_tokens', 'output_tokens', 'compute_units')),
  CHECK (quota_metric IS NULL OR dimension = CASE WHEN quota_metric IN ('input_tokens', 'output_tokens') THEN 'tokens' ELSE quota_metric END),
  CHECK (window_end = window_start + window_seconds),
  CHECK ((dimension = 'requests' AND unit = 'requests') OR
         (dimension = 'tokens' AND unit = 'tokens') OR dimension = 'compute_units')
) STRICT;
INSERT INTO provider_quota_windows_v9
  SELECT id, quota_scope_id, provider, model, dimension, unit, window_seconds,
    window_start, window_end, limit_amount, reserved_amount, consumed_amount,
    status, created_at, updated_at, retain_until, safety_margin, NULL
  FROM provider_quota_windows;
DROP TABLE provider_quota_windows;
ALTER TABLE provider_quota_windows_v9 RENAME TO provider_quota_windows;
CREATE UNIQUE INDEX quota_windows_identity ON provider_quota_windows
  (quota_scope_id, provider, model, coalesce(quota_metric, dimension), unit, window_seconds, window_start);
CREATE INDEX quota_windows_retention ON provider_quota_windows(retain_until);
CREATE INDEX quota_windows_active ON provider_quota_windows(status, window_end);
CREATE INDEX quota_windows_policy_active ON provider_quota_windows(quota_scope_id, provider, window_end);
PRAGMA defer_foreign_keys = OFF;

-- Configuration receipts only, never a second set of accounting counters.
-- Pin the model and dimension/reset topology per provider allocation so a
-- policy edit cannot mint a fresh budget under a different identity.
CREATE TABLE provider_capacity_policies (
  quota_scope_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  policy_hash TEXT NOT NULL CHECK (length(policy_hash) = 64 AND policy_hash NOT GLOB '*[^0-9a-f]*'),
  topology_hash TEXT NOT NULL CHECK (length(topology_hash) = 64 AND topology_hash NOT GLOB '*[^0-9a-f]*'),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json) AND json_type(policy_json) = 'object'),
  verified_at INTEGER NOT NULL CHECK (verified_at BETWEEN 0 AND 9007199254740991),
  review_after INTEGER NOT NULL CHECK (review_after > verified_at AND review_after <= 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (updated_at >= verified_at AND updated_at <= 9007199254740991),
  PRIMARY KEY (quota_scope_id, provider)
) STRICT;
