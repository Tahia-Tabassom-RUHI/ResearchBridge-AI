# Local D1 schema (Parts 4A through 4D-1)

This schema adds persistence structures for the ResearchBridge project.
`src/storage/d1-quota-admission.ts` implements the `QuotaAdmission` interface
internally. `D1IdempotencyStore` and `DurableRequests` compose with admission
in an explicitly configured local mock gateway. Production inference remains
disabled. No quota values are seeded. Existing limits and both original
Wrangler configs are unchanged.

| Table | Purpose |
| --- | --- |
| `provider_quota_windows` | Configurable limits, persisted safety margins, reserved counters, and consumed counters for one provider/account/model/dimension/window. |
| `request_reservations` | Service/request correlation and lifecycle for a single potential dispatch; numbered reservations allow fallback attempts to have separate accounting. |
| `reservation_quota_windows` | One reservation's amounts in multiple independent quota windows; one row per reservation/window pair. |
| `inference_attempts` | At most one dispatch attempt per reservation, including prepared/sent/completed/not_sent/unknown status and dispatch timestamps. Provider/model/account are inherited from the reservation. |
| `provider_holds` | One active/released hold deadline per account/provider/model, with an enumerated reason code. |
| `idempotency_records` | Unique service/key hash, keyed payload fingerprint, fingerprint-key identifier, hashed owner token, generation, lease, reservation link, lifecycle and response-version/status metadata. No response body. |
| `usage_accounting` | One current usage summary per attempt, keeping measured/estimated/simulated classification, request/token counts, and optional named compute units. |

`0001_quota_reservations.sql` creates windows, reservations and their dimension
links. `0002_attempts_holds_idempotency_usage.sql` adds the remaining metadata.
`0003_atomic_admission.sql` adds an integer `safety_margin` to windows and a
checked `admission_check` field to reservation/window links. Existing tables,
counters and records are preserved; neither original migration is rewritten.
The assertion makes a zero-row conditional update fail its admission batch.
`0004_durable_idempotency.sql` adds ownership and revision fencing, processing
states, leases, a unique reservation foreign key and checked transition fields.
Legacy records are preserved. See [IDEMPOTENCY.md](IDEMPOTENCY.md) for the
ownership boundary, state machine and status-only replay policy.
`0005_reservation_lifecycle.sql` adds a reconciliation marker/timestamp and index
to reservations without changing previous statuses or accounting. The explicit
reservation/attempt lifecycle is documented in
[RESERVATION_LIFECYCLE.md](RESERVATION_LIFECYCLE.md).
Apply these files in order through Wrangler's migration ledger; append new
versions instead of editing migrations after adoption. The migrations use D1
foreign keys and strict SQLite column types. Foreign keys restrict parent
deletion so accounting cannot silently disappear.

## Dimensions and identifiers

`quota_scope_id` is an opaque identifier for the provider account/budget scope,
never an API key. `service_id` and `request_id` are opaque trusted identifiers,
not student names or content. Provider and model names are explicit identifiers.
An empty `model` means a provider-wide budget/hold. Trusted admission policies
must list every applicable provider-wide and model-specific window.

Each quota window has a positive `window_seconds`, UTC `window_start`, and an
exclusive `window_end = window_start + window_seconds`. Independent request
windows of 60 and 86400 seconds represent RPM/RPD; token windows of those same
durations represent TPM/TPD. Other durations and start alignments are supported.
`compute_units` uses a named unit such as `neurons` or `gpu_seconds`, allowing
independent provider-specific budgets. Part 4A amount columns retain their REAL
storage affinity. Part 4B admits only safe integer values and uses integer SQL
arithmetic; fractional or unsafe legacy counters fail closed without conversion.
Fractional compute estimates require explicit integer units such as
`milli_neurons`, conservatively scaled by trusted caller code. The legacy
`UsageMeasurement.neurons` field requires integer values with configured unit
`neurons`. Token usage fields are integers.

The unique window identity includes scope, provider, model, dimension, unit,
duration and start. The reservation/window primary key prevents duplicate
dimension links. Reservation numbers are unique per service/request and an
attempt is unique per reservation. Part 4B uses reservation number 1, so duplicate
service/request admission cannot create another reservation. Its checked D1
batch writes reservations, counters and links together. No triggers are used.
Actual consumption may exceed a limit, so the schema does not cap recorded
usage at the budget; admission rejects already overspent windows. See
[QUOTA_ADMISSION.md](QUOTA_ADMISSION.md) for the atomicity guarantee.

## Privacy and retention

No tables have raw prompt, reflection, response body, provider error, API key,
or arbitrary metadata columns. Idempotency key/payload/source hashes must be
64 lowercase hexadecimal characters (SHA-256 representation). Callers must
derive hashes before writing and must keep private content out of identifiers.
The schema is metadata only; it does **not** yet satisfy completed-response
replay. Part 4C implements `IdempotencyStore` with status-only replay because
authentication identifies a service, not an individual session. Authorized
private-response storage remains future work. A conflicting payload is a result
of comparing hashes, not a persisted idempotency status.

All timestamps are UTC Unix seconds. Admission uses D1's `unixepoch()` clock;
quota window boundaries are explicitly configured. Mutable records have
`created_at` and `updated_at`. Indexed `retain_until` fields define the earliest
cleanup eligibility, separate from reservation/idempotency `expires_at`, quota
window end, and hold deadline. Reservation/window links inherit retention from
both parents. Cleanup must delete usage, attempts and links before parents and
respect unresolved reservations/attempts. Expiry never automatically releases
quota, permits a resend, deletes a claim, or resolves unknown consumption.
No cleanup or status-transition algorithms are included.

## Local verification

From `workers/learning-coach/`:

```powershell
npm.cmd run db:migrate:local
npm.cmd run test:db
npm.cmd run test:admission
npm.cmd run test:idempotency
npm.cmd run test:lifecycle
```

The migration command uses `wrangler.d1.local.jsonc` and always passes `--local`.
The config's all-zero database ID is a local placeholder, not a remote resource.
Do not use this config for remote commands or deployment. The gateway does not
consume its binding. Wrangler stores development state under ignored `.wrangler/`.

The focused tests apply the actual migration files in local Miniflare D1 and
exercise constraints, dimensions, uniqueness, foreign keys, lifecycle metadata,
retention checks, and failed-batch rollback. A separate Wrangler test applies
all versions to a new isolated `.wrangler/schema-tests/run-*` database, repeats
the migration command and checks the migration ledger. Existing local databases
are preserved. The tests make no provider calls; the Miniflare outbound handler
rejects external requests. No remote Cloudflare resources are needed.

Cloudflare references: [migration files and version tracking](https://developers.cloudflare.com/d1/reference/migrations/),
[local D1 development](https://developers.cloudflare.com/d1/best-practices/local-development/),
and [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).

## Remaining after Part 4D-1

Admission reserves every configured window atomically and validates linked
account/provider/model scopes. Idempotency now binds service ownership and
payload fingerprints to fenced claim, reservation and dispatch states. Part
4D-1 adds explicit authorization, coordinated outcomes and reconciliation
eligibility without changing quota counters. Subsequent parts must define
validated usage and repeat-safe, fenced accounting/settlement. Provider holds,
window provisioning, authorized private replay and safe tombstone retention
remain future work. No automatic refund or resend follows expiry or an unknown
outcome. Live inference integration requires separate authorization.
