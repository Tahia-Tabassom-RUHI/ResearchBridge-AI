-- A pending observation is a dispatch safety barrier, independent of usage.
-- It survives crashes and uncertain hold writes. No new quota/hold counters.
ALTER TABLE inference_attempts ADD COLUMN provider_evidence_state TEXT NOT NULL DEFAULT 'not_required'
  CHECK (provider_evidence_state IN ('not_required', 'pending', 'acknowledged'));
ALTER TABLE inference_attempts ADD COLUMN provider_evidence_policy_hash TEXT
  CHECK (provider_evidence_policy_hash IS NULL OR
    (length(provider_evidence_policy_hash) = 64 AND provider_evidence_policy_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE inference_attempts ADD COLUMN provider_evidence_receipt TEXT
  CHECK (provider_evidence_receipt IS NULL OR
    (provider_evidence_state = 'acknowledged' AND length(provider_evidence_receipt) = 64
      AND provider_evidence_receipt NOT GLOB '*[^0-9a-f]*'));
CREATE INDEX attempts_pending_evidence ON inference_attempts(provider_evidence_state, reservation_id);
