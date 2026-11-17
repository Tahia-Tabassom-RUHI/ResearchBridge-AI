CREATE TABLE inference_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES request_reservations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'sent', 'completed', 'not_sent', 'unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  sent_at INTEGER CHECK (sent_at >= created_at),
  finished_at INTEGER CHECK (finished_at >= created_at AND (sent_at IS NULL OR finished_at >= sent_at)),
  retain_until INTEGER NOT NULL CHECK (retain_until >= updated_at AND retain_until >= coalesce(finished_at, sent_at, created_at))
) STRICT;

CREATE INDEX attempts_status ON inference_attempts(status, updated_at);
CREATE INDEX attempts_retention ON inference_attempts(retain_until);

CREATE TABLE provider_holds (
  quota_scope_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('rate_limit', 'unavailable', 'manual')),
  hold_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  retain_until INTEGER NOT NULL CHECK (retain_until >= hold_until AND retain_until >= updated_at),
  CHECK (hold_until >= created_at),
  PRIMARY KEY (quota_scope_id, provider, model)
) STRICT;

CREATE INDEX holds_expiry ON provider_holds(status, hold_until);
CREATE INDEX holds_retention ON provider_holds(retain_until);

-- Hashes only: no raw idempotency keys, request bodies, responses, or error text.
CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY NOT NULL,
  service_id TEXT NOT NULL,
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  source_fingerprint_hash TEXT CHECK (length(source_fingerprint_hash) = 64 AND source_fingerprint_hash NOT GLOB '*[^0-9a-f]*'),
  response_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'unknown')),
  response_status INTEGER CHECK (response_status BETWEEN 100 AND 599),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  expires_at INTEGER NOT NULL CHECK (expires_at >= created_at),
  retain_until INTEGER NOT NULL CHECK (retain_until >= expires_at AND retain_until >= updated_at),
  CHECK (status != 'completed' OR response_status IS NOT NULL),
  UNIQUE (service_id, key_hash)
) STRICT;

CREATE INDEX idempotency_expiry ON idempotency_records(status, expires_at);
CREATE INDEX idempotency_retention ON idempotency_records(retain_until);

-- Usage is reported per attempt, independently of quota-window settlement.
CREATE TABLE usage_accounting (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES inference_attempts(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('measured', 'estimated', 'simulated')),
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'reconciled', 'unknown')),
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  compute_units REAL CHECK (compute_units >= 0),
  compute_unit TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  retain_until INTEGER NOT NULL CHECK (retain_until >= updated_at),
  CHECK ((compute_units IS NULL AND compute_unit IS NULL) OR
         (compute_units IS NOT NULL AND compute_unit IS NOT NULL AND length(compute_unit) > 0))
) STRICT;

CREATE INDEX usage_status ON usage_accounting(status, updated_at);
CREATE INDEX usage_retention ON usage_accounting(retain_until);
