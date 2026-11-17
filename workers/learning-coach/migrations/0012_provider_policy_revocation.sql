-- Terminal account/provider revocation, independent of mutable policy receipts.
CREATE TABLE provider_policy_revocations (
  quota_scope_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version BETWEEN 1 AND 9007199254740991),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  revoked_at INTEGER NOT NULL CHECK (revoked_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (quota_scope_id, provider)
) STRICT;

-- Each trigger has one body statement. RAISE aborts the caller's D1 batch.
CREATE TRIGGER revoked_policy_admission BEFORE INSERT ON request_reservations
WHEN EXISTS (SELECT 1 FROM provider_policy_revocations v
  WHERE v.quota_scope_id = NEW.quota_scope_id AND v.provider = NEW.provider)
BEGIN SELECT RAISE(ABORT, 'provider_policy_revoked'); END;

CREATE TRIGGER revoked_policy_dispatch BEFORE UPDATE OF status ON request_reservations
WHEN NEW.status = 'sent' AND EXISTS (SELECT 1 FROM provider_policy_revocations v
  WHERE v.quota_scope_id = NEW.quota_scope_id AND v.provider = NEW.provider)
BEGIN SELECT RAISE(ABORT, 'provider_policy_revoked'); END;

CREATE TRIGGER revoked_policy_insert BEFORE INSERT ON provider_capacity_policies
WHEN EXISTS (SELECT 1 FROM provider_policy_revocations v
  WHERE v.quota_scope_id = NEW.quota_scope_id AND v.provider = NEW.provider)
BEGIN SELECT RAISE(ABORT, 'provider_policy_revoked'); END;

CREATE TRIGGER revoked_policy_update BEFORE UPDATE ON provider_capacity_policies
WHEN EXISTS (SELECT 1 FROM provider_policy_revocations v
  WHERE v.quota_scope_id = OLD.quota_scope_id AND v.provider = OLD.provider)
BEGIN SELECT RAISE(ABORT, 'provider_policy_revoked'); END;

CREATE TRIGGER revocation_monotonic BEFORE UPDATE ON provider_policy_revocations
WHEN NEW.quota_scope_id != OLD.quota_scope_id OR NEW.provider != OLD.provider
  OR NEW.model != OLD.model OR NEW.policy_version != OLD.policy_version
  OR OLD.generation = 9007199254740991 OR NEW.generation != OLD.generation + 1
  OR NEW.revoked_at < OLD.revoked_at
BEGIN SELECT RAISE(ABORT, 'provider_revocation_not_monotonic'); END;

CREATE TRIGGER revocation_permanent BEFORE DELETE ON provider_policy_revocations
BEGIN SELECT RAISE(ABORT, 'provider_revocation_permanent'); END;
