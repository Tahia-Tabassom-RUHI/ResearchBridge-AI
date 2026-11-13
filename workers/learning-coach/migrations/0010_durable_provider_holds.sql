-- The original key permits only one hold per model. Preserve every original
-- field while allowing independent reasons/dimensions and unknown deadlines.
-- No quota, reservation, attempt, ownership or accounting row is modified.
CREATE TABLE provider_holds_v10 (
  quota_scope_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('rate_limit', 'unavailable', 'manual',
    'request_rate_exhausted', 'daily_requests_exhausted', 'token_rate_exhausted',
    'daily_tokens_exhausted', 'compute_capacity_exhausted', 'provider_retry_after',
    'temporary_provider_unavailable', 'model_unavailable')),
  hold_until INTEGER CHECK (source_class = 'legacy' OR hold_until BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  retain_until INTEGER NOT NULL CHECK (retain_until >= updated_at AND (hold_until IS NULL OR retain_until >= hold_until)),
  hold_key TEXT NOT NULL DEFAULT 'legacy',
  source_class TEXT NOT NULL DEFAULT 'legacy' CHECK (source_class IN
    ('legacy', 'verified_quota', 'verified_retry_after', 'confirmed_exhaustion', 'operational')),
  evidence_at INTEGER NOT NULL DEFAULT 0 CHECK (source_class = 'legacy' OR
    (evidence_at BETWEEN 0 AND 9007199254740991 AND evidence_at <= updated_at)),
  evidence_hash TEXT CHECK (length(evidence_hash) = 64 AND evidence_hash NOT GLOB '*[^0-9a-f]*'),
  confidence INTEGER NOT NULL DEFAULT 3 CHECK (confidence BETWEEN 1 AND 3),
  policy_version INTEGER CHECK (policy_version BETWEEN 1 AND 9007199254740991),
  plan TEXT CHECK (plan = 'free'),
  quota_metric TEXT CHECK (quota_metric IN ('requests', 'tokens', 'input_tokens', 'output_tokens', 'compute_units')),
  unit TEXT,
  window_seconds INTEGER CHECK (window_seconds IN (60, 86400)),
  quota_window_id TEXT REFERENCES provider_quota_windows(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  CHECK (hold_until IS NULL OR hold_until >= created_at),
  CHECK ((quota_metric IS NULL AND unit IS NULL AND window_seconds IS NULL AND quota_window_id IS NULL) OR
    (quota_metric IS NOT NULL AND unit IS NOT NULL AND window_seconds IS NOT NULL)),
  CHECK (quota_window_id IS NULL OR hold_until IS NOT NULL),
  CHECK (source_class = 'legacy' OR
    (evidence_hash IS NOT NULL AND policy_version IS NOT NULL AND plan = 'free')),
  PRIMARY KEY (quota_scope_id, provider, model, hold_key)
) STRICT;
INSERT INTO provider_holds_v10
  (quota_scope_id, provider, model, status, reason_code, hold_until, created_at, updated_at, retain_until, evidence_at)
  SELECT quota_scope_id, provider, model, status, reason_code, hold_until, created_at, updated_at, retain_until, updated_at
  FROM provider_holds;
DROP TABLE provider_holds;
ALTER TABLE provider_holds_v10 RENAME TO provider_holds;
CREATE INDEX holds_expiry ON provider_holds(status, hold_until);
CREATE INDEX holds_retention ON provider_holds(retain_until);
CREATE INDEX holds_scope_expiry ON provider_holds(quota_scope_id, provider, status, hold_until, model, hold_key);

-- Immutable operation acknowledgements. Their hashes contain no raw response,
-- prompt, account credential, request body or arbitrary observation metadata.
CREATE TABLE provider_hold_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  operation_hash TEXT NOT NULL CHECK (length(operation_hash) = 64 AND operation_hash NOT GLOB '*[^0-9a-f]*'),
  quota_scope_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  hold_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('record', 'resolve')),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  recorded_at INTEGER NOT NULL CHECK (recorded_at BETWEEN 0 AND 9007199254740991),
  retain_until INTEGER NOT NULL CHECK (retain_until BETWEEN recorded_at AND 9007199254740991),
  FOREIGN KEY (quota_scope_id, provider, model, hold_key)
    REFERENCES provider_holds(quota_scope_id, provider, model, hold_key) ON DELETE RESTRICT
) STRICT;
CREATE INDEX hold_operations_retention ON provider_hold_operations(retain_until);
