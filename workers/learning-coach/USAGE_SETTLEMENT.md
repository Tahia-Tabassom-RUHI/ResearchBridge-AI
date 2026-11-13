# Atomic successful usage settlement (Part 4D-2)

`D1UsageSettlement` implements the internal `UsageReporter.settle` interface for
the ResearchBridge project. This stage settles successful completed attempts
only. It is not wired into the gateway and adds no HTTP endpoint, provider call,
automatic reconciliation, cleanup, or production inference path.

## Eligibility and lifecycle

The caller supplies the latest acknowledged `IdempotencyFence`, reservation ID,
attempt ID, provider/model identifiers, and trusted normalized usage. The fence
must originate from authenticated claim, quota admission and lifecycle methods;
public usage fields or a reservation ID alone never grant settlement authority.

| Request / reservation / attempt | Reconciliation metadata | Settlement |
| --- | --- | --- |
| completed / completed / completed | `not_requested` | Reject; explicitly call `awaitReconciliation` first. |
| completed / completed / completed | `awaiting`, completion timestamp NULL | Eligible with current owner and valid usage. |
| completed / completed / completed | `awaiting`, completion timestamp present; usage `reconciled` | Completed reconciliation. Identical receipt returns `already_settled`; conflicting data is rejected. |
| Pending, reserved, prepared, dispatched, not-sent or unknown outcome | Any | Reject. |

`reconciliation_state = 'awaiting'` remains the durable request marker introduced
by 0005. `reconciliation_completed_at` closes that request; pending work must
filter for `reconciliation_state = 'awaiting' AND reconciliation_completed_at
IS NULL`. This additive representation avoids rebuilding the reservation table
to expand its CHECK enum. Terminal request/reservation/attempt outcomes and
attempt timestamps are never rewritten by settlement.

## Accounting rules and trust boundary

The `SettlementUsage` structure accepts measured usage or an explicitly named
`explicit_upper_bound_v1` estimate. Only numeric usage fields and that enumerated
policy are allowed. No provider payload, arbitrary metadata or private content
is persisted. Provider/model/account association comes from the owned reservation
and is checked against every quota window. Cloudflare and Groq windows remain
independent even when their unit names match.

| Quota metric | Required normalized usage |
| --- | --- |
| `requests` | Explicit positive integer `requests`; no implicit default at settlement. |
| `input_tokens` | Explicit nonnegative integer `inputTokens`. |
| `output_tokens` | Explicit nonnegative integer `outputTokens`. |
| `tokens` | `totalTokens`, or the safe sum of explicit input and output counts. If all are supplied they must agree. |
| `compute_units` | Explicit integer in `computeUnits[configuredUnit]`. |

All supplied values, even unused ones, must be nonnegative safe integers within
`Number.MAX_SAFE_INTEGER`. Fractions, strings, nulls, nonfinite values, unsafe
sums and contradictory totals fail closed. Explicit measured zero token/compute
usage is allowed; missing usage never becomes zero. Unused absent token fields
remain NULL. One usage row records request counts once, regardless of how many
minute/day windows receive the same consumption.

`src/storage/settlement-usage.ts` validates already normalized accounting values.
It does not parse either provider's raw response format or guess conversion
factors. Future trusted provider adapters must independently validate provenance,
bind measurements to the dispatched attempt, and convert fractional units into
explicit named integer units (for example `milli_neurons`) with conservative
rounding before settlement. The capability authenticates the owning internal
caller; it is not cryptographic proof of provider measurements.

When measurements are unavailable, the internal caller must supply explicit
upper bounds under `explicit_upper_bound_v1`. Each applicable amount must be at
least its reserved amount, so an estimate never releases reserved capacity.
The caller must also know the bound covers actual possible usage and any known
measurement. The admission estimate alone is not proof of an upper bound. If a
reliable bound cannot be supplied, reject/leave the reservation awaiting; do not
invent zero or an automatic fallback. Mixed measured/unknown usage is recorded
as estimated for the entire summary. Later corrections to estimates require a
separately designed reconciliation operation; this stage never overwrites them.

For every applicable window, with original reservation R and accepted usage U:

```text
reserved_after = reserved_before - R
consumed_after = consumed_before + U
link.reserved_amount = R          (preserved audit amount)
link.settled_amount = U
link.status = settled
```

Measured U < R releases genuinely unused capacity; U = R transfers the full
reservation; U > R records the full overage. Usage is not truncated to the
estimate or budget. Existing admission rejects windows whose consumption plus
other outstanding reservations exceeds available capacity, including after an
overage. Its existing `invalid_window` classification for overspent windows is
preserved. Other reservations remain reserved. Closed/elapsed windows can still
receive successful accounting while the owner lease remains valid.

## Atomicity, fencing and retries

Planning reads identify all durable admission links, their original amounts and
their stored quota metrics. They do not authorize writes. One prepared D1 batch:

1. Conditionally checks the full owner identity, token hash, exact generation,
   active lease/TTL, request/reservation/attempt linkage, completed/awaiting
   lifecycle, absence of existing accounting and expected number of links.
2. Inserts the unique per-attempt reconciled usage record and canonical receipt
   hash. Its `settlement_check = changes()` requires the preceding owner update
   to have affected exactly one row, even if the owner row does not exist.
3. Updates every quota window using integer arithmetic and conditional bounds,
   then marks each original admission link settled with its consumption.
4. Sets the reconciliation completion timestamp only when all links are settled.

Every counter/link/final marker write is immediately followed by a checked SQL
`changes()` assertion on the inserted usage row. A zero-row mutation raises a
constraint error, rolling back all preceding writes. This uses documented
[D1 batch transaction semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
Returned success flags, result count and affected-row counts are also verified.
Counters are bounded before subtraction/addition; fractional legacy values,
reserved underflow and consumed overflow reject the entire transaction. The
existing REAL columns represent only safe integers on this path.

Settlement keeps the exact current fencing generation. It performs a terminal
accounting write, not another ownership transfer. The unique attempt receipt,
link statuses and completion marker permit one writer and prevent re-entry.
Every call, including receipt reads, checks the current generation and active
owner lease/TTL. A stale fence cannot read success through the settlement API.
The unchanged current fence permits an identical explicit retry after a lost
acknowledgement without recovering a capability or accepting an old generation.

The receipt hashes canonical normalized usage, request/attempt/reservation IDs,
provider/model, generation and all window allocations. It contains no token or
response body. Concurrent identical settlements yield one `settled` writer and
`already_settled` receipt reads; conflicting data yields `conflict`. Existing
legacy accounting without this receipt is never overwritten. Database failures
or uncertain acknowledgements return `storage_unavailable`. There is no blind
retry, compensating refund, redispatch, or exactly-once provider execution claim.
Idempotency HTTP replay remains status-only.

## Migration and limits

`0006_successful_settlement.sql` adds fields to existing tables only:

- Admission links: `quota_metric`. New admission writes the configured metric.
  Existing request/compute links are unambiguous and backfilled. Legacy token
  links remain NULL because their dimension cannot reveal input/output/combined
  intent. Settlement rejects them; no guessed conversion or recovery is added.
- Reservations: nullable `reconciliation_completed_at` with lifecycle/time CHECKs.
- Usage: `total_tokens`, canonical numeric `compute_usage` map, `estimate_policy`,
  `settlement_hash`, `settlement_generation`, and a checked transaction assertion.
  A single compute unit also populates the old scalar unit/value columns; multiple
  units use the map with both old scalar columns NULL.

Migrations 0001-0005, legacy amounts/records and existing quota limits remain
unchanged. No table is added. The original window uniqueness constraint still
allows only one token metric per identical scope/provider/model/duration/start;
input/output/combined windows must have distinct existing window identities.
Supporting three token budgets at that exact same identity would require a
separate window-identity migration. Settlement uses persisted admission metrics,
not a potentially changed current policy, and handles at most 32 linked windows.

Administrative SQL can bypass application invariants. No cleanup, lease renewal,
stale-owner takeover or repair of inconsistent legacy state is implemented.
Expired owners cannot settle here. Measured usage must be final; corrected or
late measurements are not overwritten through this API.

Run `npm.cmd run test:settlement`, `npm.cmd run typecheck`, and `npm.cmd test`.
Tests use local D1 with external requests blocked, isolated persistent directories
for restart cases, and all versioned migrations. The full suite includes local
Wrangler migration reapplication and Python/TypeScript contract parity.

## Failure accounting in Part 4D-3

The separate `D1FailureAccounting` interface now handles durably proven
non-dispatch release and trusted partial failure usage. Missing dimensions remain
held; successful receipts cannot be overwritten by failure reports. See
[FAILURE_ACCOUNTING.md](FAILURE_ACCOUNTING.md) for its receipt and evidence rules.
Part 4D-5's [local pipeline](DURABLE_PIPELINE.md) integrates these accounting APIs.
Provider cooldowns and live inference remain separate work. Successful-settlement
validation and accounting behavior described here are unchanged.

Part 4D-4 [recovery inspection](RESERVATION_RECOVERY.md) verifies this receipt's
canonical usage/allocation hash and durable links without recovering an owner
capability or settling again. Successful receipts are never taken over or refunded.
