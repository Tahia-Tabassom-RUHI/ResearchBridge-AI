-- Service-scoped keyset scanning, bounded independently of historical volume.
CREATE INDEX idempotency_cleanup_scan ON idempotency_records(service_id, retain_until, id);
