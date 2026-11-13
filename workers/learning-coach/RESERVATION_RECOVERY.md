# Stale reservation recovery and retention (Part 4D-4)

The ResearchBridge project exposes internal `ReservationRecovery` operations via
`D1ReservationRecovery.authenticate(request, env, { leaseSeconds })`. Existing
service authentication verifies the request and supplies its service ID. Browser
origin/fetch headers are rejected. Transport must be HTTPS or local loopback HTTP.
The server supplies the D1 binding and recovery lease policy, not browser JSON.
No public recovery route, scheduled job, provider call or production inference
path is added. Part 4D-5 now composes this service through an explicit internal
function; see [DURABLE_PIPELINE.md](DURABLE_PIPELINE.md).

## Read-only discovery and classification

`discover` takes a fixed `from`/`through` interval, a basis, a page size of 1–20,
and an optional `(time, id)` keyset cursor. `through` cannot exceed the D1 clock.
Use both indexed streams:

- `reservation_expiry`: service-scoped reservation `(expires_at, id)` index.
- `owner_lease`: service-scoped idempotency `(lease_expires_at, id)` index, joined
  to the matching reservation/service.

Each query reads at most page size + 1 candidates; at most 20 reservations are
inspected per invocation. Inspection uses a four-statement D1 snapshot per
reservation and at most 33 link rows (more than 32 is rejected). Queries do not
enumerate an unbounded history or aggregate all tenants' accounting. Callers must
persist each stream's cursor and fixed interval, advance completed intervals,
and configure any bounded overlap for late records. Starting at zero repeatedly
is not a recovery schedule. The two streams can overlap; deduplicate reservation
IDs. Cursors are discovery positions, never authorization capabilities.

`inspect(reservationId)` reads one service-owned reservation. Neither discovery
nor inspection writes, repairs, refunds or takes ownership. Returned data contains
operational IDs, generation, classification, active-owner/recoverable/manual-review
flags and recovery operation ID. It excludes tokens, owner/payload hashes, private
content and usage payloads. A page is not a global snapshot across reservations;
every mutation rechecks durable predicates in its own transaction.

| Classification | Meaning / permitted action |
| --- | --- |
| `provably_not_dispatched` | Consistent failed claim and terminal `not_sent` reservation/attempt with NULL dispatch timestamp and no accounting receipt. Recovery is eligible only after both reservation and original owner lease expire. |
| `dispatch_uncertain` | Unclosed reserved work, including no attempt or `prepared` authorization. No refund. |
| `dispatched` | Durable `sent` intent. It does not prove provider execution, but forbids a non-dispatch refund. |
| `outcome_unknown` | Unknown outcome, partial/held failure accounting, or completion without a valid settlement receipt. Preserve capacity/evidence for review. |
| `settled_successfully` | Valid successful receipt and matching accounting links. No second settlement or refund. |
| `settled_failure` | Valid released/accounted failure receipt. No second accounting. A possibly dispatched outcome still carries manual-review status. |
| `inconsistent_record` | Missing ownership/metric, mismatched lifecycle, incomplete or altered receipts, invalid counter/link amounts, or malformed recovery metadata. Explicit review only. |
| `recovery_in_progress` | A non-dispatch recovery operation owns an unexpired recovery lease. No other capability is returned. |
| `already_recovered` | Valid release receipt and matching recovery completion marker. Read-only confirmation. |

Active reservations with active leases are absent from both expiry streams. A
reservation may have expired while its original owner still has a valid lease;
discovery reports it, but recovery cannot take over. Successful/failed receipts
are verified using the same canonical hash formats and normalization as their
writers, not merely the presence of a hash. Link amounts, bases and scopes must
match the receipt. Window counters must be safe integers and cover that record's
held/consumed contributions. This is a bounded consistency check, not a complete
ledger audit across every reservation sharing a window.

## Authority and fencing

`claim` requires the exact request/reservation/attempt IDs, observed generation,
and a stable caller-generated UUIDv4 operation ID. An authenticated service can
act only on its own records. The operation ID is unique across recovery records.
The only action implemented is release of proven non-dispatch capacity.

In one prepared, guarded D1 batch, acquisition:

1. Rechecks expired owner/reservation leases, the terminal non-dispatch proof,
   expected generation, absence of successful/failure accounting and eligibility
   of the existing recovery operation.
2. Increments the existing idempotency generation exactly once, rejecting integer
   overflow. This invalidates every previous owner/recovery fence.
3. Rechecks the exact original quota links and current scope/unit/counter bounds.
4. Records the operation ID, random capability hash, new generation, start time
   and bounded recovery lease on the reservation. It marks awaiting reconciliation
   if the original failed attempt had not yet been queued.

The configured recovery lease is 1–3600 seconds; it is an operational bound, not a
provider quota/reset value. Only a successful acknowledgement returns the raw
256-bit capability. Only its hash is stored. Original owner token, lease, TTL,
payload identity and terminal state are preserved. Recovery authority is a
distinct `RecoveryFence`; it never grants normal owner or dispatch authority.
There is no takeover for prepared, sent, unknown or successfully completed work.

Concurrent acquisition on one revision yields one capability. A duplicate using
the same operation ID gets only status, never a recovered token. A different
operation cannot replace it. After the recovery lease expires, an explicit,
authenticated claim for the same operation and exact current generation may
acquire a new capability, advancing generation again. This is not a scheduled
retry. Old capabilities remain stale. A completed recovery cannot be reclaimed.

## Refund evidence and transaction

Only an already closed `not_sent` attempt is refundable. The existing dispatch
protocol requires an acknowledged durable `sent` transition before any provider
invocation. Its fenced `failBeforeDispatch` transition can close work only before
that transition wins. The terminal closure, NULL `sent_at`, finish timestamp and
consistent failed claim therefore provide dispatch-exclusion evidence under that
protocol. All dispatchers must obey it. An expired lease, missing timestamp on an
unclosed attempt, prepared authorization, crash or timeout alone is insufficient.

`release(fence)` rechecks the authenticated service, IDs, operation ID, capability
hash, current generation and recovery lease. It delegates to Part 4D-3's failure
accounting transaction using a recovery-specific authority predicate. That
predicate replaces neither the original token nor its expired lease. The release
has fixed evidence `PROVEN_PRE_DISPATCH_FAILURE / dispatch_cancelled`.

The transaction checks the proof and all links again, releases every original
reserved amount, preserves consumed counters, writes the existing-format failure
receipt, and sets the recovery completion timestamp/hash together. A zero-row
write raises a SQL error via an unconditional `changes()` assertion, rolling back
the entire batch. Returned row counts and assertion results are also checked.
The mechanism uses [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
No process-local lock or compensating refund is used.

Successful receipts are never overwritten. Existing failure receipts, including
partial usage/holds, are classified and preserved. Unknown evidence never becomes
measured zero or a successful settlement. No new attempt is created by recovery,
and no admission, routing or provider invocation follows a refund. Original
idempotency remains terminal and status-only; only a distinct admitted request
can use genuinely released capacity.

## Uncertain acknowledgements and restarts

An ambiguous claim or release returns `storage_unavailable`, not a refund claim
or recovered capability. Inspect the stable reservation/operation IDs afterward:

- A committed claim is `recovery_in_progress`; inspection reveals no token.
  If the capability was not received, wait for lease expiry and explicitly
  reacquire that same operation with its current generation.
- A committed release is `already_recovered` only after its failure receipt,
  links, generation and completion hash have been verified.
- An identical release with the same current capability returns the existing
  receipt without writes. This confirmation can be read after lease expiry;
  an expired lease cannot authorize a new mutation.
- Missing/inconsistent state or an unavailable database does not establish that
  a write failed. A read observes one point in time; another in-flight transaction
  may still commit. Do not blindly replay or infer permission to redispatch.

Both claimed authority and completed receipts persist across Worker restarts.
This implementation does not claim exactly-once provider execution.

## Migration and limitations

`0008_reservation_recovery.sql` adds seven nullable recovery metadata fields to
`request_reservations`, a unique operation-ID index, and the two service/expiry
scan indexes. It adds no table and changes no historical counters, statuses or
receipts. Migrations 0001–0007 are unchanged. Receipt hash construction is shared
with settlement/failure writers without changing their durable formats.

Legacy missing ownership, ambiguous token metrics and inconsistent records fail
closed. Unclosed reservations cannot be converted into proof by recovery. No
provider evidence retrieval, post-dispatch reconciliation, generation reset,
receipt correction, scheduled discovery, cleanup or gateway route is added.
The service authentication currently identifies Streamlit, not individual admins;
any future broader access model requires separate authorization design. Raw
administrative SQL can bypass application invariants.

Run `npm.cmd run test:recovery`, `npm.cmd run typecheck`, and `npm.cmd test`.
All database tests use local D1, block provider networking, and preserve existing
local databases using isolated migration/restart directories.

## Retention policy and cleanup prerequisites

No deletion or cleanup scheduler is implemented. `retain_until` is an earliest
eligibility timestamp, never an automatic delete instruction. Lease/TTL/window
expiry is distinct from accounting finality. Active quota windows and outstanding
holds remain operational state even when an individual reservation has expired.

| Records | Required prerequisites before any future cleanup |
| --- | --- |
| Idempotency records | Preserve key/payload identity, terminal outcome and fencing while replay or recovery is possible. Current UUID reuse protection relies on retained tombstones. |
| Reservations and recovery metadata | No active recovery lease; no unclosed or uncertain operation; matching terminal receipt and links; all retention and replay horizons satisfied. Preserve operation ID/completion hash for duplicate detection. |
| Reservation quota links | No reserved/unknown held capacity; receipt-matching final accounting; all referencing reservation/window audit horizons satisfied. Use `failure_held_amount`, not original reserved amount, for outstanding failure capacity. |
| Inference attempts and failure receipts | Preserve dispatch exclusion/intent and usage evidence while outcome/accounting remains unresolved. `accounted` estimates alone do not prove provider quiescence. |
| Successful receipts / usage accounting | Preserve until replay, dispute/correction, recovery and quota-accounting verification horizons have all elapsed. Never remove receipt while a repeated operation could charge/refund again. |
| Provider holds | Inactive/released or expired under an explicit future hold policy, past retention, and no unresolved dependency requiring its evidence. No cooldown policy is invented here. |
| Quota windows | Past their configured end and retention, no outstanding reserved balance, no unresolved references, and all required historical usage/audit evidence safely retained. Closed windows can still be needed for late accounting. |

Unknown outcomes, held/partial failure receipts, inconsistent data and ambiguous
recovery operations are not eligible for deletion merely because time elapsed.
Their safe retention horizon requires an explicit evidence-resolution policy.
Bounded retention elsewhere requires configured maximum provider reporting/
correction delay, retry/replay validity, operational audit requirements, recovery
duration and any applicable data-retention obligations. This stage invents none
of those durations or provider reset times.

In particular, deleting an expired idempotency record today allows the same UUID
to claim again. Until a separately enforced request-freshness/replay horizon or
equivalent durable tombstone mechanism exists, those tombstones must remain.
Their reservation foreign keys can also keep the associated graph retained.
Do not silently detach ownership evidence to bypass this restriction.

When all prerequisites and horizons are proven, a future cleanup transaction must
respect foreign keys and evidence dependencies: remove eligible usage records,
then reservation links and inference attempts (including failure receipts), then
eligible idempotency references/tombstones, then the reservation and its recovery
metadata. Remove a quota window only after every referring link is gone and its
independent prerequisites hold. Provider holds have their own eligibility check.
Deletion of an interdependent graph must be atomic or retain equivalent durable
evidence throughout; partial receipt deletion must not reopen accounting.

## Integration in Part 4D-5

The [local pipeline](DURABLE_PIPELINE.md) propagates acknowledged fences and
attempt IDs, validates mock evidence and invokes existing accounting. Its
`localServices(...).recovery(...)` function authenticates explicit internal
recovery invocation; ordinary requests never scan or recover unrelated work.
Operator query budgets, persistent scan cursors and unresolved-record review
remain operational prerequisites. Production inference remains disabled.
Provider cooldowns, fallback changes and scheduled cleanup remain outside this stage.
