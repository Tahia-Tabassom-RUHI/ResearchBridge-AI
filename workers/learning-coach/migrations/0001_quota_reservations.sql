-- Metadata and counters only. Times are UTC Unix seconds supplied by the caller.
CREATE TABLE provider_quota_windows (
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
  CHECK (window_end = window_start + window_seconds),
  CHECK ((dimension = 'requests' AND unit = 'requests') OR
         (dimension = 'tokens' AND unit = 'tokens') OR dimension = 'compute_units'),
  UNIQUE (quota_scope_id, provider, model, dimension, unit, window_seconds, window_start)
) STRICT;

CREATE INDEX quota_windows_retention ON provider_quota_windows(retain_until);
CREATE INDEX quota_windows_active ON provider_quota_windows(status, window_end);

CREATE TABLE request_reservations (
  id TEXT PRIMARY KEY NOT NULL,
  service_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  quota_scope_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  reservation_number INTEGER NOT NULL CHECK (reservation_number > 0),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'sent', 'completed', 'not_sent', 'unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  expires_at INTEGER NOT NULL CHECK (expires_at >= created_at),
  retain_until INTEGER NOT NULL CHECK (retain_until >= expires_at AND retain_until >= updated_at),
  UNIQUE (service_id, request_id, reservation_number)
) STRICT;

CREATE INDEX reservations_expiry ON request_reservations(status, expires_at);
CREATE INDEX reservations_retention ON request_reservations(retain_until);
CREATE INDEX reservations_provider ON request_reservations(quota_scope_id, provider, model, status);

-- One reservation may encumber several independent windows. No admission logic.
CREATE TABLE reservation_quota_windows (
  reservation_id TEXT NOT NULL REFERENCES request_reservations(id) ON DELETE RESTRICT,
  quota_window_id TEXT NOT NULL REFERENCES provider_quota_windows(id) ON DELETE RESTRICT,
  reserved_amount REAL NOT NULL CHECK (reserved_amount >= 0),
  settled_amount REAL CHECK (settled_amount >= 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'settled', 'released', 'unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (reservation_id, quota_window_id)
) STRICT;

CREATE INDEX reservation_windows_window ON reservation_quota_windows(quota_window_id);
