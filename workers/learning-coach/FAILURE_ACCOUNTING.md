# Failure accounting and unknown outcomes (Part 4D-3)

`D1FailureAccounting` implements the internal `FailureAccounting` interface for
the ResearchBridge project. `record` accounts for one terminal failure observation
per attempt; `inspect` is a read-only check of that same operation. Neither method
calls a provider, dispatches work, reacquires ownership, schedules recovery, or
creates cooldowns. Production inference remains disabled.

## Classification

| Category | Evidence and accounting |
| --- | --- |
| `PROVEN_PRE_DISPATCH_FAILURE` | Requires a durably closed `not_sent` attempt and reservation, a failed claim, NULL `sent_at`, and current fencing ownership. Release every original admission link atomically. |
| `POSSIBLY_DISPATCHED_FAILURE` | Connection failures, interrupted sending and request timeouts may follow provider execution. Require terminal unknown/awaiting state; retain each unreported dimension. |
| `CONFIRMED_PROVIDER_ERROR` | A trusted internal caller identifies an HTTP 400–599 response. Status alone authorizes no refund. Only separately verified per-dimension evidence can change held capacity into known consumption. |
| `UNKNOWN_OUTCOME` | Crash boundaries, missing responses and ambiguous responses retain unknown quota. Never become successful completion. |
| `INVALID_OR_UNTRUSTED_USAGE` | Record only an enumerated missing/malformed/contradictory/untrusted reason. Raw invalid usage is rejected, not persisted; a caller may explicitly submit a sanitized report with only verified fields or no usage. |

Reasons are fixed enums. HTTP status is accepted only for confirmed provider
errors. No raw exception, request, reflection, provider response, credential or
arbitrary diagnostic text is accepted or stored. The receipt contains only
operational identifiers/hashes, numeric usage and enumerated classifications.

## Proof of non-dispatch

The existing gateway's protocol is:

```text
reserve -> authorizeDispatch (prepared) -> acknowledged dispatch (sent) -> provider call
```

`prepared` alone does not authorize release. Call `failBeforeDispatch` using the
current fence. Its conditional D1 transaction closes the original reservation
and attempt as `not_sent` and advances the claim generation. It can win only
before dispatch intent, including when racing a dispatcher. If dispatch wins,
the old fence cannot close non-dispatch; if closure wins, the old dispatcher
cannot obtain an acknowledged `sent` transition. No provider invocation is
permitted before that acknowledgement. All dispatchers must obey this protocol.

After an acknowledged closure, call `awaitReconciliation` with its returned fence.
Use that new fence plus the original reservation ID and terminal attempt ID in
`FailureAccounting.record`. Failure before preparation creates a terminal
attempt through the existing lifecycle method. Successful closure is the durable
dispatch-exclusion guarantee; a local assertion that sending did not occur is
insufficient. A failed unadmitted claim has no reservation to refund.

Release additionally checks claim identity, service, payload/key/fingerprint
hashes, response version, hashed owner capability, exact generation, active
lease/TTL, attempt/reservation binding, and all original admission links. It
requires consistent failed/not_sent terminal states, NULL `sent_at`, a finish
timestamp, and the awaiting marker. An expired lease, prepared row, HTTP error,
crash or missing response is never substitute evidence. A lost dispatch
acknowledgement cannot give the old prepared owner release authority.

For each link with original amount R, proven non-dispatch performs:

```text
reserved_after = reserved_before - R
consumed_after = consumed_before
link.status = released
link.settled_amount = 0
link.failure_basis = proven_not_sent
link.failure_held_amount = 0
```

Zero here records a proven release; it is not provider-measured zero usage.
The attempt remains `not_sent`, and the claim remains failed and non-retryable.
Other outstanding reservations in the same windows are preserved.

## Provider errors, partial usage and estimates

For possibly dispatched attempts, first acknowledge `markUnknown`, then
`awaitReconciliation`, passing each returned generation forward. Accounting
requires consistent `outcome_unknown` / `unknown` / `unknown` states and a durable
dispatch-intent timestamp. HTTP 400, 401/403, 429 and 5xx errors, connection errors,
timeouts and malformed responses do not imply any universal charging policy.
Cloudflare/Groq/model/account associations are checked independently per window.
No reset time, retry interval or provider hold is inferred by this operation.

Each normalized usage field has an independent basis:

- `{kind: 'measured', amount: n, evidence: 'provider_report'}` is a final trusted
  measurement for that dimension, including explicit evidence of zero charge.
- `{kind: 'estimated', amount: n, evidence: 'explicit_upper_bound_v1'}` is an
  explicitly asserted conservative upper bound, at least the original reservation
  for every affected window. It cannot release reserved capacity.
- An omitted field is unknown and stored as NULL (or absent named compute unit).
  No measured-zero default is inserted.

This is an internal trust boundary, not a public/provider JSON schema. Evidence
labels describe the trusted caller's assertion; they are not independent proof
of a provider measurement. Future adapters must verify response/attempt binding,
provider-specific charging semantics and units before constructing these fields.
No live provider adapter is implemented. Existing successful-settlement
normalization remains unchanged.

Request counts, input/output tokens, combined tokens and named integer compute
units are independent. Amounts must be nonnegative safe integers; fractional,
negative, nonfinite, unsafe or untrusted fields reject the operation without
changing accounting. Provider-specific scaling into named integer units happens
outside general accounting. Both token components yield a combined sum; if either
is estimated, the derived total is estimated. Supplied measured totals must be
consistent with known components and their bounds. An upper bound above a measured
total is not itself a contradiction. Unsafe sums fail closed.

For every known dimension, subtract R from reserved and add accepted usage U to
consumed. Preserve full overages, settle the link with its measured/estimated
basis, and set its held amount to zero. Explicit trusted U=0 releases that
dimension only. For every unreported dimension, leave consumption unchanged,
retain R and mark the link unknown with NULL settled amount. If reported token
components exceed an unknown combined-token reservation, increase its hold to
at least their sum; never disguise a known overage. That hold is not a claim that
the full total is known. Existing admission fails closed against overages/holds.

The receipt reports accounting state `released`, `held`, `partial`, or `accounted`.
`accounted` means every configured dimension was recorded, including any explicit
estimates; it does not mean provider execution succeeded or estimates became
measurements. Unknown outcomes remain unknown even with fully accounted usage.

## Atomicity and receipts

One prepared D1 batch conditionally creates the attempt receipt, updates every
quota window and original admission link, then marks the receipt recorded. All
ownership, lifecycle, link-count, link-amount, scope and counter preconditions are
checked inside that transaction. Safe integer bounds prevent counter underflow
and overflow; closed windows can still receive accounting. No process-local lock
authorizes a write.

After each mutation, an unconditional SQL assertion evaluates `changes() = 1`.
Failure deliberately evaluates `json()` on a fixed invalid literal, raising a
SQL error and rolling back the entire batch. This follows admission's strategy
of turning a zero-row update into a transactional failure. Unlike a guard UPDATE,
this assertion cannot silently miss a deleted guard row. Returned write counts,
guard result values and result count are also verified. See
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
and [SQLite JSON error behavior](https://www.sqlite.org/json1.html#the_json_function).

The existing unique attempt ID plus operation format `failure-accounting-v1`
identifies the operation. A canonical receipt hash includes the owner generation,
request/attempt/reservation, provider/model, normalized failure evidence and every
window allocation. There is only one receipt slot per attempt. Identical repeats
return `already_recorded` with no writes; conflicting classifications or evidence
are rejected. Receipt inspection also validates stored usage, link amounts and
bases. Successful usage records are never overwritten or manufactured here.

As in successful settlement, accounting preserves the exact current generation;
it does not transfer ownership. Every call, including inspection and duplicates,
checks that generation and active lease/TTL. Lifecycle terminal states cannot
reopen. Status-only replay remains failed or outcome_unknown and never returns
private responses. No exactly-once provider execution guarantee is claimed.

An uncertain D1 acknowledgement returns `storage_unavailable`, never a claimed
refund or a successful inference result. `inspect` with the identical input can
confirm `already_recorded` or report `not_recorded` without writing. An explicit
identical repeat is also safe. If ownership has expired or changed, inspection
fails closed; this stage does not recover credentials or extend the lease.
`not_recorded` describes that read, not the eventual outcome of another in-flight
transaction, and never authorizes redispatch or an unconditional refund.

## Migration and integration boundary

`0007_failure_accounting.sql` adds nullable classification, numeric usage,
generation, receipt-hash, recording timestamp and accounting-state fields to
`inference_attempts`. It adds `failure_basis` and integer `failure_held_amount` to
`reservation_quota_windows`. No tables are added and migrations 0001–0006 are
unchanged. Existing successful receipts and counters are preserved.

Failure evidence lives on attempts because legacy `usage_accounting.request_count`
is NOT NULL. Writing a generic usage row for missing request usage would require
inventing a count. Per-window links remain the accounting record for applied
failure consumption and outstanding holds. Their original reserved amounts remain
audit data. `usage_accounting` remains the successful-settlement record.

Failure recording does not set the successful-only `reconciliation_completed_at`.
The awaiting marker and unknown/not_sent outcome remain. Later recovery must use
the attempt's receipt state and each link's held amount: `held`/`partial` retain
outstanding capacity, while `released`/`accounted` must not be charged/refunded
again. Changes to previously recorded evidence require a separately designed
reconciliation operation, not a second failure notification.

The internal interface composes with existing lifecycle calls as described above.
Part 4D-5's [local pipeline](DURABLE_PIPELINE.md) wires trusted mock evidence,
attempt IDs and acknowledgement failure handling into the gateway. Local tests
use deterministic failure reports and the real D1 lifecycle; no provider calls
are made. No scheduler, takeover, cleanup, routing or cooldown logic is added.

Legacy token links without a quota metric and inconsistent historical state fail
closed. The existing window-identity and 32-window limits remain. Administrative
SQL can bypass application invariants; all dispatch/accounting writers must use
the documented protocols.

Run `npm.cmd run test:failure`, `npm.cmd run typecheck`, and `npm.cmd test`.
The full suite includes successful settlement, lifecycle, admission, idempotency,
local Wrangler migration reapplication, runtime and contract parity tests.

## Recovery in Part 4D-4

Part 4D-4 adds bounded discovery and separate authenticated recovery authority
for already closed `not_sent` attempts without accounting receipts. It reuses
this release transaction, advances the original fencing generation and commits
the recovery completion marker with the failure receipt. Original owner leases
remain expired. Existing failure/success receipts and unknown holds are inspected
and preserved, never refunded again. See [RESERVATION_RECOVERY.md](RESERVATION_RECOVERY.md)
for the evidence rules, uncertain acknowledgements and retention prerequisites.
Post-dispatch reconciliation and provider cooldowns remain separate work.
