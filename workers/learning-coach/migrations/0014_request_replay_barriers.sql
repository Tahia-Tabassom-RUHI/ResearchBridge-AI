-- Compact replay authority survives any future eligible history removal.
CREATE TABLE request_replay_barriers (
  service_id TEXT NOT NULL,
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  claim_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN first_seen_at AND 9007199254740991),
  legacy INTEGER NOT NULL CHECK (legacy IN (0, 1)),
  PRIMARY KEY (service_id, key_hash)
) STRICT;
INSERT INTO request_replay_barriers (service_id, key_hash, claim_id, first_seen_at, expires_at, legacy)
  SELECT service_id, key_hash, id, created_at, expires_at, 1 FROM idempotency_records;
CREATE TRIGGER replay_barrier_claim BEFORE INSERT ON idempotency_records
WHEN EXISTS (SELECT 1 FROM request_replay_barriers b WHERE b.service_id = NEW.service_id AND b.key_hash = NEW.key_hash)
  AND NOT EXISTS (SELECT 1 FROM idempotency_records i WHERE i.service_id = NEW.service_id AND i.key_hash = NEW.key_hash)
BEGIN SELECT RAISE(ABORT, 'request_replay_barrier'); END;
CREATE TRIGGER replay_barrier_register AFTER INSERT ON idempotency_records
BEGIN INSERT INTO request_replay_barriers (service_id, key_hash, claim_id, first_seen_at, expires_at, legacy)
  VALUES (NEW.service_id, NEW.key_hash, NEW.id, NEW.created_at, NEW.expires_at, 0); END;
CREATE TRIGGER replay_barrier_immutable BEFORE UPDATE ON request_replay_barriers
BEGIN SELECT RAISE(ABORT, 'request_replay_barrier_immutable'); END;
CREATE TRIGGER replay_barrier_retained BEFORE DELETE ON request_replay_barriers
BEGIN SELECT RAISE(ABORT, 'request_replay_barrier_immutable'); END;
