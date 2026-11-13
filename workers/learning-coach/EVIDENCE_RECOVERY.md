# Pending provider evidence recovery

Migration 0013 adds immutable resolution receipts and an indexed pending scan.
`D1EvidenceRecovery.authenticate` constructs the internal service using a
separate 64-hex `COACH_EVIDENCE_RECOVERY_SECRET`, distinct from the generation
credential. Trusted composition supplies an account/provider/model scope.
No route, scheduler or browser configuration constructs this service. Browser
headers, ordinary service credentials and non-loopback HTTP are rejected.
The credential identifies recovery authority, not a verified individual student.

`inspect(limit, cursor)` returns at most 20 sanitized operational records using
created-time/attempt-ID keyset pagination. It exposes no owner capabilities,
content fingerprints, raw prompts, private responses or credentials. Inspection
is read-only and advisory: resolution always rereads and validates durable state.
Pages are not a transaction snapshot; start a new scan to discover additions
that sort before a previously issued cursor.

`resolve` requires UUID operation/reservation/attempt identifiers, the exact
current claim generation, expired ownership, and one of two evidence paths:

- `not_dispatched`: an expired prepared attempt with no sent timestamp, or a
  receipt-verified not-sent failure/recovery. Prepared ownership is fenced by
  advancing generation. Existing accounting generations remain intact.
- `accounted_with_hold`: independently verified success/failure accounting plus
  an active indefinite operational hold covering the entire affected allocation
  (provider-wide for Cloudflare, selected model for Groq). Its original record
  operation must be linked to this attempt ID. Both hold hashes are recomputed;
  scope, revision, observation time, coverage and immutable receipt must match.
  Unknown/partial failure usage remains held in the original quota windows.

The transaction rechecks every classified owner, reservation, attempt, usage,
quota link and associated window row, plus the hold proof. It conditionally
checks fencing and inserts a unique resolution receipt before acknowledging
this attempt's marker. Receipt hashes bind the request, proof and authority
scope. Competing or stale operations roll back; identical retries inspect the
immutable receipt and return `already_resolved`. A lost acknowledgment returns
unavailable, never inferred success; an explicit retry can inspect the receipt.
Receipts cannot be updated/deleted. A database guard permanently prevents a
resolved not-dispatched attempt from later becoming sent, including older code.

Acknowledging a marker discharges only this attempt's availability barrier.
It never resolves a hold, clears another marker, changes usage/counters, refunds,
redispatches, deletes evidence or removes an F01 revocation. In the hold path,
the allocation remains blocked by the hold until its separate trusted resolution
procedure establishes restored availability. Failure receipt contents and links
are validated, rather than accepting the mere presence of an accounting hash.

Manual review remains necessary for missing or inconsistent accounting, active
owners/recovery leases, sent attempts without durable availability evidence,
success accounting alone, narrow/finite/unlinked/superseded holds, partial hold
persistence, malformed observations, or unrecognized policy/model identities.
This operation does not synthesize missing provider facts. Supported holds must
already have been persisted through trusted hold management; this service never
creates a hold from an assertion. Pending markers can remain unresolved when
their evidence cannot justify either path. There is no automatic recovery,
refund or cleanup. F03 reset semantics and production inference remain unchanged.
