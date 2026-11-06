# Atomic quota admission (Part 4B)

`D1QuotaAdmission` implements `QuotaAdmission` from `src/storage.ts` for the
ResearchBridge project. It is internal code. `Env.COACH_DB` is an optional typed
binding for composition. Part 4C's optional durable local mock gateway composes
admission with idempotency; the default local entry remains a stateless contract
mock and the production entry point still refuses inference.

## Configuration and amounts

Construct `new D1QuotaAdmission(env.COACH_DB, policies)` with a trusted, explicit
`QuotaAdmissionPolicy` for each provider/model. Every policy lists its account
scope, lease and retention durations, and **all** applicable window IDs,
including shared provider-wide windows (empty model) and model-specific windows.
No student generation allowance, provider capacity, window or policy is inferred.
These policies must not be populated from public request fields. A stale policy
whose boundaries, capacity or safety margin differ from D1 fails closed.

Each policy window selects a reservation metric:

| Metric | Integer reservation amount | Stored dimension/unit |
| --- | --- | --- |
| `requests` | `estimate.requests`, or one provider dispatch | `requests` / `requests` |
| `tokens` | Required input plus output token estimates | `tokens` / `tokens` |
| `input_tokens` | Required input token estimate | `tokens` / `tokens` |
| `output_tokens` | Required output token estimate | `tokens` / `tokens` |
| `compute_units` | `estimate.computeUnits[unit]`, or integer `estimate.neurons` for unit `neurons` | `compute_units` / explicit named unit |

Window duration and start are explicit, supporting minute/day and other aligned
intervals. The existing unique window key is preserved: only one token budget
can occupy a particular account/provider/model/duration/start identity. The
trusted policy chooses total, input or output measurement for that budget. A
provider needing independent input and output budgets at that identical identity
would need a separately reviewed extension of the unique key. Provider-wide
and model-specific token budgets can already coexist.

Every configured capacity, safety margin, counter and requested amount must be
an exact integer between zero and `Number.MAX_SAFE_INTEGER`; requested amounts
must be positive. Input/output addition is checked for overflow. Units and
account/provider/model/window identity must match. Fractional compute accounting
requires explicit scaled integer units and conservative rounding by a future
trusted estimator. No rounding or capacity conversion is invented here.

For each window:

```text
configured_safe_capacity = limit_amount - safety_margin
available_capacity = configured_safe_capacity - consumed_amount - reserved_amount
admit only when requested_amount <= available_capacity for every required window
```

Migration `0003_atomic_admission.sql` adds the persisted integer safety margin
and an assertion column to the existing tables. The original REAL counter
columns remain to preserve Part 4A data. Admission checks their values are safe
integers and uses integer casts in SQL. Legacy fractional data remains intact
but cannot authorize admission. No quota configuration or limits are seeded.

## Exact transaction mechanism

Reads classify missing, invalid, closed, expired or exhausted windows. They do
not authorize writes. Admission then submits **one prepared D1 batch**:

1. Insert the request reservation with a random identifier, reservation number
   1, status `reserved`, creation/update times and lease/retention times.
2. For each required window, conditionally increment its reserved counter.
   The `WHERE` clause checks identity, unit, configured capacity/margin, integer
   counters, live window boundaries and sufficient available capacity again.
3. Immediately after each update, insert its reservation/window link with
   `admission_check = changes()`. The named database constraint
   `quota_admission_succeeded CHECK (admission_check = 1)` forces an error if
   that update changed zero rows. The primary key limits updates to one window.

When a Part 4C claim is supplied, admission also advances that fenced claim and
links its reservation before the window updates, with a checked affected-row
assertion in the same batch. A stale claim rolls back the reservation and all
quota writes. See [IDEMPOTENCY.md](IDEMPOTENCY.md).

`changes()` reports the preceding write's affected row count. Keeping that
assertion immediately after its update is essential. Its value is evaluated
before the link insert completes. See [SQLite's definition](https://www.sqlite.org/lang_corefunc.html#changes).

D1 batches are transactions and roll back on a statement error. A successful
zero-row update alone does **not** cause rollback. The checked link insert turns
that case into an actual error, rolling back the reservation, every previous
counter increment and every link. The same guarantee covers uniqueness,
foreign-key and other SQL failures. No JavaScript mutex, interactive
`BEGIN`/`COMMIT`, or post-commit compensating refund is used. See
[D1 batch behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

Concurrent writers execute these conditions against D1's serialized writes.
The controller also requires `meta.changes === 1` and success for every returned
batch statement before acknowledging admission. That acknowledgement check is
additional validation, not the rollback mechanism. All dimensions must be in
the same D1 database and every admission writer must use this checked path.
Arbitrary manual counter edits are outside that guarantee.

Lease expiry is the earlier of the configured lease deadline and the earliest
required window end. Times come from D1, not a caller's clock. Expired/unknown
reservations continue consuming capacity: this part does not implement refunds,
settlement, retries or lease reclamation. A future dispatcher must enforce lease
validity before use.

The existing unique `(service_id, request_id, reservation_number)` key rejects
duplicate service/request admission. Duplicates are denied without returning
the earlier reservation or replaying a response. This is reservation uniqueness,
not authenticated ownership or complete idempotency. Fallback dispatch admission
is not implemented; future work must preserve distinct, authorized reservations.

## Decisions and failure boundaries

Results carry request ID, provider/model and one of `admitted`,
`insufficient_capacity`, `configuration_missing`, `invalid_request`, or
`storage_unavailable`, plus a fixed machine-readable reason. Success adds a
reservation ID and lease expiry. Insufficient capacity can include the latest
known end among exhausted windows as `resetAt`; it is a window boundary, not a
promise that a replacement window or capacity will exist. Other denials omit
reset information. There is no public admission endpoint and results contain
no SQL errors, window IDs, account scope, remaining capacity or configuration.

A lost response after commit is ambiguous. The controller denies dispatch and
leaves the reservation intact. It does not refund, retry the write, or assert
that the transaction did not commit. Diagnostic reads after a constraint failure
may explain a denial, but never turn it into an admission. Replica staleness can
therefore cause conservative denials without authorizing oversubscription.

## Local verification

```powershell
npm.cmd run test:admission
npm.cmd run test:db
npm.cmd run typecheck
npm.cmd test
```

Admission tests use actual local Miniflare/workerd D1. Independent controller
instances contend concurrently; no JavaScript lock serializes them. Tests prove
the zero-row behavior of an unguarded batch and then force a competing commit
between diagnostic reads and a multi-window write to verify full rollback.
Other checks cover integer boundaries, safety margins, units, invalid/missing
configuration, duplicate requests, storage failures, counter/link agreement,
uncertain acknowledgements and runtime restart persistence. Migration tests
apply all versions locally through Wrangler and preserve seeded Part 4A data,
including fractional counters. Unique ignored `.wrangler/` test directories
preserve existing local databases. No remote database or provider is contacted.

## Remaining work

Trusted quota configuration and conservative usage estimation are prerequisites
for future integration. This controller cannot discover omitted provider limits
or protect against other applications consuming the same provider allowance.
Automatic window provisioning and rollover are not implemented; missing or
expired configuration denies admission.

Part 4C now binds claims to authenticated service identity and keyed payload
fingerprints, couples claim ownership with reservation writes, and fences
dispatch/completion states. See [IDEMPOTENCY.md](IDEMPOTENCY.md). Replay is status
only; no private response is stored. Later parts must add fenced settlement,
reconciliation, provider holds and safe tombstone retention. Production dispatch,
provider routing and inference enablement remain separate work.
