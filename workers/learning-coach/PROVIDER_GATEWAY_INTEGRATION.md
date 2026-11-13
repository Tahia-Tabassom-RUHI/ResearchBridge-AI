# Part 4E-4: local provider gateway integration

ResearchBridge's local Worker now connects current provider policies, quota
provisioning, atomic admission, provider response evidence, durable holds and
existing usage accounting. Production inference remains disabled. All execution
in this part uses deterministic local fixtures; there are no provider calls,
credentials, fallback providers or paid inference.

## Execution and policy authority

The gateway authenticates the service, validates V1/V2 input and trusted source
context, and establishes durable request ownership. `localProviderServices`
then validates its current server configuration using D1 UTC time, derives the
configured conservative reservation, provisions every required window, and
calls the existing `D1QuotaAdmission` service.

The local entry point reads `LOCAL_DURABLE_CONFIG` for each request. A
configuration containing `policy` selects this composition and cannot fall back
to legacy mock accounting if invalid. It contains `ownership`, a complete
`ProviderCapacityPolicy`, and `bounds.inputTokens`/`bounds.outputTokens`. These
bounds describe the entire synthetic prompt and maximum synthetic output.
There are no deployable account capacities or default policies. Existing
`quota`/`estimate` configurations still select the earlier mock pipeline.

Validation rejects missing/expired policies, incompatible schemas, invalid
versions, incomplete quota inventories, unverified account capacities, paid
eligibility, unreviewed models, missing dimensions and invalid bounds. The
preferred Cloudflare candidate is `@cf/google/gemma-4-26b-a4b-it`.
Historical Qwen policies retain their 2026-11-20T00:00:00Z cutoff; occupied
allocations are not rewritten. See [candidate review](CLOUDFLARE_MODEL_CANDIDATE.md).

Provisioning produces an exact policy hash/version and complete window set.
Admission repeats the receipt identity, review deadline, dimensions, window
boundaries, capacities, counters and applicable holds inside each conditional
quota write. A zero-row write rolls back the whole D1 batch. A newer policy
committed before admission therefore rejects the older snapshot. An invalid or
more restrictive current configuration never substitutes a previously stored
approval when validation/provisioning fails.

This guarantee concerns the trusted configuration supplied to each instance and
the ordering of committed D1 policy updates. D1 cannot discover a configuration
edit that has not been durably published. A future live rollout needs coordinated
policy publication/revocation across instances; this part does not claim an
instantaneous fleet-wide configuration switch.

## Trusted execution and durable evidence barrier

`LocalPolicyMockProvider` keeps response metadata and simulated counters in a
private WeakMap keyed by the exact returned result and original attempt identity.
`LocalProviderExecution` is paired with that provider and policy. JSON copies,
unrelated providers, student-supplied observations and identity conflicts cannot
be accepted as execution evidence. The parser separately binds provider, model,
account scope, policy version, reservation and attempt; the D1 write gates bind
the original request, owner capability and fencing generation.

Migration `0011_provider_execution_evidence.sql` adds three columns and an index
to `inference_attempts`. It does not replace the existing quota or hold services:

- `provider_evidence_state`: `not_required`, `pending`, or `acknowledged`.
- `provider_evidence_policy_hash`: the original policy snapshot.
- `provider_evidence_receipt`: a digest of normalized evidence and hold operation IDs.

After local preparation, the owner conditionally marks evidence pending before
the sent transition. Only acknowledged writes permit invocation. Admission also
checks for pending evidence in the same D1 transaction as quota reservation.
The new composition requires migration 0011; older accounting fixtures retain
their existing migration compatibility. A pending marker blocks the applicable
account/provider/model; Cloudflare blocks the shared account/provider allocation.
Other Groq accounts/models and other providers remain independent.

The marker covers crashes, invalid observations, stale evidence, failed hold
writes and ambiguous acknowledgements. Lease expiration, usage accounting,
window rollover and Worker restart do not clear it. A failed hold write cannot
silently reopen future admission. There is no automatic marker recovery or
public administrative route: unresolved markers require trusted investigation
and a separately reviewed recovery operation before reopening capacity.

Admissions that committed earlier may still execute. Neither a hold nor a
pending marker retroactively cancels them. Concurrent earlier attempts retain
independent pending markers. Clearing one cannot clear another.

## Evidence, holds and usage ordering

The order after dispatch is: normalize trusted metadata; adapt hold evidence;
persist all applicable holds; acknowledge the evidence marker; validate content;
reconcile usage through the existing success/failure services; deliver content.
Failure to acknowledge any required step suppresses private content. Known usage
is still passed to failure accounting if availability evidence cannot be
acknowledged. If only some holds committed, the pending marker stays in place.

The existing hold adapter supplies quota and Retry-After observations. The
execution boundary supplies explicit operational evidence for recognized
availability/eligibility restrictions. Hold writes include an owner check inside
the same transaction, in addition to their existing policy gate. Immutable hold
operation receipts can confirm a committed write after its acknowledgement is
lost. Stale/conflicting updates fail closed. Duplicate evidence preserves its
original deadline and revision; newer evidence cannot shorten stronger holds.

| Observation | Integrated behavior |
| --- | --- |
| Cloudflare 3036 | Shared daily neuron hold, using the verified policy UTC reset |
| Cloudflare 3040 | Operational unavailability; no deadline unless a verified Retry-After exists |
| Cloudflare 5035, 5028, access denied, model unavailable | Indefinite model restriction; no paid upgrade, model switch or cooldown |
| Groq remaining requests = 0 | RPD dimension hold, distinct from RPM |
| Groq remaining tokens = 0 | TPM dimension hold, distinct from TPD |
| Valid Retry-After | Exact verified model-scoped restriction |
| Zero capacity without reset | Indefinite dimension hold requiring trusted resolution |
| 429 without usable dimension or reset evidence | Indefinite operational availability hold; no claim of a specific exhausted quota |
| Success with zero capacity | Settle this response and block later applicable admission |
| Unknown provider error / ordinary 500 / timeout | Preserve unknown usage; no invented quota exhaustion or deadline |
| Malformed, contradictory, conflicting or stale metadata | Preserve the pending marker and return a safe status |

Positive capacity observations do not increase configured limits. Hold expiration
does not reset counters, change models or authorize paid inference. Every later
request repeats current policy, quota and remaining-hold checks. Indefinite holds
use the existing trusted resolution service; successful responses do not silently
clear them.

Availability and usage remain independent. The provider parsers supply only the
usage fields they support. Request counts and Cloudflare neuron measurements in
these tests come from an explicitly synthetic local counter sidecar, never from
token conversion or a guessed live billing rule. The sidecar is bound to the
same execution result. Missing required measurements retain reservations;
partial measurements remain partial; measured overages are recorded. Estimated
sidecar values remain estimated in failure accounting and are never relabeled
as measured successful usage. The existing legacy estimated-settlement path
and all settlement/failure receipts remain intact.

Cloudflare can settle with partial token detail when every required request and
compute dimension has an independent synthetic measurement. This does not imply
that a future live Cloudflare response provides measured neurons.

## Privacy and production separation

Authentication identifies a trusted service, not a verified student. Completed
replays return status only, including after restarts or lost response delivery.
No response text, reflections, prompts, raw provider payloads, owner tokens or
credentials are written to D1 or logged. Only existing numeric accounting,
identifiers, normalized hold metadata and digests are persisted.

The local entry remains loopback-only. The production entry ignores mock flags
and configurations. The build rejects local provider/execution classes or the
evidence composition in the production bundle. No browser capacity override,
administrative endpoint, scheduled cleanup, cache or automatic fallback was added.
The older mock gateway's invented 30-second Retry-After header was removed.

## Files changed for this part

Created: this document; `migrations/0011_provider_execution_evidence.sql`;
`src/storage/d1-provider-execution.ts`; `src/providers/local-policy-mock.ts`;
`src/providers/local-provider-execution.ts`; `tests/d1-provider-gateway.test.ts`.

Modified: `package.json`; `scripts/build-worker.mjs`; `src/local.ts`;
`src/local-services.ts`; `src/handlers/gateway.ts`; `src/providers/response-parser.ts`;
`src/storage.ts`; `src/storage/d1-quota-admission.ts`;
`src/storage/provider-availability.ts`; `src/storage/d1-provider-holds.ts`;
`src/storage/settlement-usage.ts`; `tests/gateway.test.ts`.

The accounting identifier validator now accepts the configured Cloudflare model's
leading `@`. V1/V2 contracts were not changed. The unrelated `.env.example`,
`screens/paper_reader.py`, `tests/test_paper_reader.py`, and `docs/module5-review.md`
were verified unchanged against their initial SHA-256 hashes. Existing tracked
and untracked work remains uncommitted.

## Verification and remaining work

The focused command is `npm run test:provider-gateway`. It runs real local D1
transactions with deterministic clocks, synthetic observations, transaction-boundary
fault injection and persisted restart tests. Existing parser, hold, provisioning,
admission, idempotency, settlement, failure and recovery suites remain applicable.
`npm test` also runs the local Wrangler migration/reapplication and cross-language
contract parity checks. Exact final counts are recorded below after verification.

| Verification | Final result |
| --- | --- |
| `npm run test:provider-gateway` | 107 passed, 0 failed, 0 skipped; includes compiled workerd and restart tests |
| `npm test` | 909 passed, 0 failed, 0 skipped; 520.183 seconds |
| Existing Groq / Cloudflare parser tests | 47 / 54 passed |
| Existing time parser / evidence adapter tests | 65 / 55 passed |
| Existing holds, policy, provisioning, admission, idempotency, lifecycle, settlement, failure and recovery suites | Passed in the full Worker run |
| Python/TypeScript contract parity | 17 shared + 39 boundary cases = 56 passed |
| `npm run typecheck` | Passed |
| `npm run build` and isolated production/local runtime checks | Passed |
| Local Wrangler migrations | 0001-0011 applied to unique local test state; repeated application reported no migrations to apply |
| `git diff --check` | Passed |
| New/untracked Worker file whitespace | All 56 untracked Worker files passed, including all 6 created in this part |
| Four unrelated files | All four SHA-256 hashes match the initial values |

No Python application code changed, so no Python application tests were run.
The required cross-language contract parity checks did run. Test logs are local
ignored artifacts under `.wrangler/provider-gateway-check.log` and
`.wrangler/part4e4-final-worker.log`.

Local tests do not prove future live transport authenticity, account eligibility,
account capacities, prompt/output bounds, billing units, provider clock behavior,
remote D1 behavior or credential handling. Those require separate verification.
A live rollout also needs reviewed pending-evidence recovery and coordinated
policy revocation. Future retention cleanup must preserve unresolved evidence
markers. The Gemma candidate still requires account eligibility and structured
JSON verification, plus a reviewed transition for any occupied Qwen allocation.

Part 4E-4 provides a local integration foundation for a separately authorized
Part 4F. Production deployment remains blocked. No Part 4F work was performed.
