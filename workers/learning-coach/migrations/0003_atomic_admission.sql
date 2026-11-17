-- Preserve existing counters and records. Admission validates integer values in
-- the original REAL columns and uses integer SQL arithmetic within the JS-safe range.
ALTER TABLE provider_quota_windows ADD COLUMN safety_margin INTEGER NOT NULL DEFAULT 0
  CHECK (safety_margin >= 0 AND safety_margin <= 9007199254740991 AND safety_margin <= limit_amount);

-- Each admission counter UPDATE is immediately followed by a link INSERT with
-- admission_check = changes(). Zero affected rows must raise a database error,
-- causing D1 batch() to roll back the reservation, links and all counter updates.
ALTER TABLE reservation_quota_windows ADD COLUMN admission_check INTEGER NOT NULL DEFAULT 1
  CONSTRAINT quota_admission_succeeded CHECK (admission_check = 1);
