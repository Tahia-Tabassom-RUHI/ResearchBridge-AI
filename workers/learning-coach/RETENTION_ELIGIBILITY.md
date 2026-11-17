# Replay-safe retention eligibility (F04-A)

Migration 0014 creates permanent compact `request_replay_barriers`, keyed by
the existing hash of service identity and request UUID. Each barrier retains
the original claim ID, D1-created timestamp and expiry, but no private payload,
response, fingerprint secret or owner capability. Existing idempotency rows
are backfilled as legacy without changing their data or replay behavior.

Database triggers register new barriers in the claim transaction and prevent
an old key from creating a new claim when its historical row is absent. This
also protects older Worker code using the migrated database. Duplicate claims
with history present continue through existing fingerprint/version checks.
Exact INSERT RETURNING confirmation is required to grant a fresh capability.
A missing historical row returns `expired` at or after the original expiry,
or conservative `outcome_unknown` before it; neither grants ownership. No
browser timestamp is accepted as authority. Current request TTL configuration
and D1 time continue defining processing freshness, without a protocol change.

Barriers cannot be changed or removed. Their cost still grows one compact row
per accepted UUID. Bounding that ledger requires a separately reviewed signed
request/issuance protocol or equivalent durable epoch mechanism. F04-B cannot
remove these barriers. Request freshness alone cannot safely retire arbitrary
UUIDs while preserving the existing protocol.

`D1RetentionEligibility.inspect(claimId)` is an internal read-only assessment
scoped to the authenticated service principal. It requires an explicit reviewed
`RetentionPolicy`: `decisionReference`, `auditSeconds`,
`providerCorrectionSeconds`, and `receiptSeconds`. There are no default periods.
Zero must be an explicit operational decision, not an inferred provider policy.
Operators must establish audit obligations, maximum delayed provider reporting/
corrections, receipt/dispute requirements, and the existing request TTL/retention
settings. Finite safe integers and safe timestamp additions are required.

The earliest eligible instant is the maximum of stored expiry/lease/retention
timestamps and the latest relevant update plus every configured horizon. Exact
boundary equality is allowed. A time threshold alone never makes a record safe:

- New, barrier-protected failed claims without reservations may qualify only
  when no orphan reservation exists and ownership is structurally valid.
- Request-history graphs require recomputed valid accounting receipts, measured
  completed usage or proven not-sent finality, expired windows, no outstanding
  window capacity, and satisfied retention dependencies.
- Pending provider evidence, unknown/partial outcomes, estimated provider
  finality, inconsistent records, active holds and live owners remain retained.
- Legacy history remains retained even after expiry; backfill is replay
  protection, not evidence that old accounting/dependencies can be discarded.

| Records | F04-A treatment |
| --- | --- |
| Idempotency, reservations, attempts, quota links, ordinary measured usage/failure receipts | Only the complete request-history graph may be a candidate after every check passes. |
| Replay barriers | Permanently retained; independent of historical graph foreign keys. |
| F01 revocations and provider policy receipts | Retained authority; removing them could reopen allocations or mint new capacity. |
| F02 evidence-resolution receipts and their referenced attempts/holds | Retained; existing immutable receipts and dispatch-exclusion guards remain enforced. |
| Recovery operation/fencing receipts | Retained, including completed recovery; a separate operation-replay policy is still required. |
| Holds and hold-operation receipts | Retained, including completed/released records; expiry does not authorize removing evidence dependencies. |
| Quota windows | Retained independently; no window is marked eligible by this service. Other request graphs may still depend on it. |

The returned generation, evaluation time and reason codes are advisory. Reads
are not an atomic deletion authorization: concurrent accounting, holds, recovery
or policy changes may invalidate an earlier assessment. `eligibleAfter` is only
a time floor; non-time retention reasons can keep records ineligible indefinitely.

F04-B must supply separately authorized bounded deletion transactions, recheck
all predicates and fencing atomically, preserve the permanent barrier, respect
foreign-key ordering, and protect every required receipt/authority. It must
define operational batch/read/write budgets and prove crash/race safety. No
deletion, detachment, cleanup scheduling, automatic refund, redispatch, live
provider call or production inference is implemented in F04-A.
