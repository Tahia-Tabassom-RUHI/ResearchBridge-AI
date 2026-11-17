# Trusted provider capacity policies — Part 4E-1

ResearchBridge has an internal policy validator and local D1 window provisioning
service. Neither is connected to an HTTP request, provider adapter, environment
enable flag, or gateway route. Production inference remains disabled. No policy
is enabled by default, no account credentials are required, and no account has
been verified by this implementation. The test fixtures are synthetic.

## Policy and trust boundary

`src/config/provider-policy.ts` defines `ProviderCapacityPolicy`. A maintainer
supplies the exact provider/model and account allocation identity, free plan and
free-only billing classification, enabled status, verified non-paid eligibility,
complete account quota inventory, version, verification/review times, provenance,
lease/retention settings, dimensions, margins and reservation estimation rules.
All amounts and timestamps are nonnegative JavaScript-safe integers; durations,
versions and estimation ratios have additional positive-value checks. Zero
capacity is a valid closed budget. Review deadlines are mandatory and exclusive.

The preferred catalog candidates are `cloudflare_workers_ai` with
`@cf/google/gemma-4-26b-a4b-it`, and `groq` with `openai/gpt-oss-20b`.
Historical `@cf/qwen/qwen3-30b-a3b-fp8` remains recognized, with its original
expiry boundary and accounting rates. See [candidate review](CLOUDFLARE_MODEL_CANDIDATE.md).
The model is an explicit policy field. A different model needs a reviewed catalog
extension and eligibility verification; there is no automatic model replacement.
Account eligibility and a complete quota inventory require explicit trusted
`account_verified` evidence. The inventory attests that all enforced constraints
have been included; a missing value must not be interpreted as unlimited quota.

Sources remain separate:

| Source | Meaning and effect |
| --- | --- |
| `provider_documentation` | HTTPS reference on the provider's official documentation domain and verification time. A public limit is not an account verification. |
| `account_verified` | Maintainer-reviewed account/organization limits, eligibility and reset semantics, with an audit reference and verification time. No dashboard fetching or credentials. |
| Runtime observations | Not policy inputs in this stage. Unknown override fields are rejected; no response headers are parsed. Observations cannot raise capacity or override a stricter limit. |
| Internal safety | Explicit absolute margin and rationale, within each dimension's effective limit. No fabricated conversions. |

The effective limit is the minimum of all configured documented/account limits;
the admission allowance subtracts the safety margin. Conflicting source types,
untrusted documentation domains, missing evidence, future verification times,
invalid/free-ineligible configurations and unsupported fields fail closed.
References are provenance, not cryptographic verification: only trusted internal
composition may supply this configuration. Never load it from a browser body,
provider response, student identifier or arbitrary request header.

## Dimensions and estimates

Supported metrics are requests, combined tokens, input tokens, output tokens and
named compute units. Each may use a 60-second or 86,400-second fixed epoch window,
or an explicit UTC daily boundary. Groq needs verified account limits for every
applicable dimension, an RPM protection and at least one token protection. RPD,
TPD and separate input/output constraints are included when the verified account
inventory says they apply. No quota is fabricated for a documented nonapplicable
dimension. Cloudflare requires RPM and a UTC daily neuron budget.

For a given period, combined tokens and split tokens are alternative policy
representations. Supplying both is rejected rather than summing their capacities
or debiting one shared counter twice. Input and output, when both present, must
use the same reset boundary. Different periods remain independent constraints.
Existing `reservation_quota_windows.quota_metric` continues to drive settlement,
failure and recovery accounting.

`estimatePolicyReservation` accepts trusted upper bounds for the complete input
prompt and maximum output, reserves one dispatch, and computes any configured
compute estimate with exact rational BigInt arithmetic and upward rounding.
The result must fit a safe integer. No characters-to-tokens heuristic or implicit
tokens-to-neurons equivalence exists. A future adapter must enforce the bounds,
include prompt/template/reasoning overhead as applicable, and reconcile measured
usage through the existing accounting services. This stage cannot certify an
estimate's adequacy for live inference.
The Cloudflare policy currently uses whole-neuron integer units. Fractional
provider reports need a reviewed conservative normalization or a reviewed scaled
unit extension before live settlement; this stage does not add that adapter.

## Documentation review on November 7, 2026

Cloudflare's [pricing documentation](https://developers.cloudflare.com/workers-ai/platform/pricing/)
describes a shared free allocation of 10,000 neurons daily, resetting at 00:00 UTC,
and lists this Qwen model at 4,625 neurons per million input tokens and 30,475 per
million output tokens. These are public statements, not a verified remaining
account balance. The validator caps the daily configured neuron limit at 10,000;
an account suballocation and safety margin can reduce it. Review this safeguard
if the documented free allocation changes. Other account workloads must fit
inside the same allocation or be subtracted through verified configuration.

The [limits page](https://developers.cloudflare.com/workers-ai/platform/limits/)
lists 300 requests/minute for default text generation, with different treatment
for paid models. The [errors page](https://developers.cloudflare.com/workers-ai/platform/errors/)
explicitly includes paid-plan-required and account-access errors. Public pricing
alone therefore never establishes account/model eligibility.
The [historical Qwen model page](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)
lists planned deprecation on November 20, 2026. This implementation retains the
model and requires its policy review deadline no later than that day's UTC start.
No account eligibility, live inference, or Qwen3 JSON Mode has been verified.
Neuron rates remain explicit, sourced configuration, never operational defaults.

Groq's [rate-limit documentation](https://console.groq.com/docs/rate-limits)
describes organization-level limits and account-specific exceptions, with
combined or split token constraints. Its public table is not imported as account
capacity. The [models page](https://console.groq.com/docs/models) includes
`openai/gpt-oss-20b`; its Developer-plan rate column must not populate a Free policy.
Every Groq limit and reset in a usable policy needs account verification.
The synthetic fixture's numbers and midnight boundaries are test data, not a
claim about a real account. Groq routing and fallback remain disabled.

## Provisioning, updates and concurrency

`D1QuotaProvisioning` implements the storage abstraction's
`QuotaWindowProvisioning.provision(trustedPolicy)` method. Successful provisioning
returns a `QuotaAdmissionPolicy` snapshot for the existing `D1QuotaAdmission`.
It does not authorize a dispatch. There is no automatic gateway integration.
Part 4E-2 now attaches a receipt version/hash/review reference and checks current
eligibility, required quota dimensions and review deadlines inside admission's
write transaction; see [durable provider holds](PROVIDER_HOLDS.md). A later gateway
stage must still compose current policy validation, estimates and dispatch.
Disabled/review-required provisioning leaves counters and reservations intact;
it never clears a budget. Production cannot dispatch in this stage.

The default clock reads `unixepoch()` from D1. Tests may inject an internal clock.
No local timezone, student clock or historical-range argument is used. Fixed
windows use a verified epoch anchor (0 through duration minus one); UTC daily
windows are explicit. A provider's unknown/rolling reset semantics must be
reviewed before selecting a fixed reset policy. This implementation does not
model a sliding limiter or infer exact provider retry times from missing data.
A boundary crossed after planning can produce an already-ended snapshot; existing
admission rechecks D1 time and denies it. The next deliberate provisioning call
creates the then-current windows.

Window IDs hash the allocation, provider, window model scope, metric, unit,
duration and start. Versions and capacities do not enter the identity. Cloudflare
windows use the existing empty-model provider scope so daily neurons are not
multiplied per selected model. Groq windows retain exact model scope. Independent
provider receipts and counters prevent cross-provider budget reuse.

The configuration receipt pins the exact model and dimension/reset topology for
each `(quota_scope_id, provider)`. A repeated version must have the same canonical
policy hash. Later versions must be monotonic and cannot regress verification
times. Reordering dimensions does not change the canonical policy. Provenance is
stored in the full canonical policy JSON, alongside its version, digest and review
boundary. This receipt contains no usage counters and is not a second ledger.

Active limits may only decrease; their effective allowance cannot increase by
reducing a margin. A reduction below consumed plus outstanding reserved units is
rejected without losing the existing encumbrance. Capacity increases require a
newer policy and fresh windows for every affected dimension. Identity/topology
changes require a separately designed migration/transition and are rejected here,
even after rollover. New allocation IDs must never be used to bypass counters.
Overlapping unmanaged/legacy windows cause rejection, not automatic adoption or
replacement under fresh identities.

Every provisioning mutation uses conditional SQL in one D1 `batch` transaction.
Each required write is followed by an unconditional SQL assertion; a zero-row
write raises an error and rolls back the entire receipt and all dimension changes.
Unchanged dimensions receive transactional read assertions instead of writes.
Counter values are rechecked in SQL, not trusted from diagnostic reads. Competing
versions cannot overwrite a stricter active limit. Concurrent admission either
reserves first and blocks an unsafe reduction, or observes the changed capacity
and fails its existing conditional write. No admission algorithm was replaced.
Admission now also verifies the persisted quota metric when present, preventing
reinterpretation of a combined-token window as input/output tokens.

Identical provisioning uses no writes. Boundary rollover creates only current
missing rows. Historical rows, usage, links, owner fences and unknown-outcome
reservations remain untouched, including outstanding reservations on ended
windows. Missing bindings, read/write failures and uncertain acknowledgements
return closed decisions. An explicit retry inspects durable state; no error
falls back to unlimited inference or a paid plan.

## Migration 0009 and D1 cost

`0009_provider_capacity_policies.sql` replaces the original quota-window unique
constraint with a metric-aware expression index. It rebuilds only the parent
window table inside the migration transaction with deferred foreign-key checking,
preserving all existing values, IDs and referencing links. The new nullable
`quota_metric` column stays NULL for legacy windows, preserving ambiguity. The
new receipt table and account/provider/expiry index support provisioning. All
migrations 0001–0008 remain unchanged. Run migration 0009 through the transactional
D1 migration runner, not as independently committed statements on an occupied DB.
The one-time migration copies all existing window rows and rebuilds their indexes;
its read/write cost scales with that table and needs capacity headroom when a
future stage prepares a production migration. No production migration was run.
Local tests cover occupied data, restrictive foreign keys, all nine migrations,
and a second runner invocation skipping applied migrations.

For D configured dimensions (at most 10), an identical provisioning call reads one
clock result, one receipt, D primary-key windows and one indexed overlap probe,
with **zero writes**. Initial provisioning writes one receipt and D window rows,
with D+1 SQL guard reads. A single-minute rollover normally writes one receipt and
only the missing minute rows; unchanged daily rows receive assertions. Index
maintenance adds written rows. These are statement/data-row estimates, not
measured production billing or scalability evidence. The overlap probe uses the
allocation/provider/expiry index and stops at the first unmanaged active row;
queries do not scan all historical windows.

[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) lists Free
daily allowances of 5 million rows read and 100,000 rows written. Exhausting D1
availability remains fail closed. There is no background provisioning, per-student
window, cost monitor, remote migration or scheduled cleanup. Rows accumulate only
for windows actually provisioned; future cleanup must honor retention, referencing
reservations/receipts, unsettled usage and unknown outcomes. Active or referenced
rows must never be deleted to manufacture fresh capacity. Measure actual D1
metadata and traffic before making any free-tier scalability claim.
Policy receipts must also retain their version/topology history for the lifetime
of the allocation; deleting a receipt is not a supported policy transition.

## Files in this change

Paths below are relative to `workers/learning-coach/`. Earlier uncommitted stages
and unrelated local files are preserved.

| File | Change |
| --- | --- |
| `src/config/provider-policy.ts` | Created: policy types, validation, catalog, estimates and reset calculations. |
| `src/storage/d1-quota-provisioning.ts` | Created: conditional D1 provisioning and configuration receipts. |
| `migrations/0009_provider_capacity_policies.sql` | Created: metric-aware window identity, index and receipt schema. |
| `tests/provider-policy-fixture.ts` | Created: explicitly synthetic account configurations. |
| `tests/provider-policy.test.ts` | Created: policy, estimate and reset tests. |
| `tests/d1-quota-provisioning.test.ts` | Created: local D1 concurrency, rollover, integration and occupied migration tests. |
| `PROVIDER_CAPACITY_POLICIES.md` | Created: design, provenance, assumptions, costs, verification and stage boundary. |
| `src/storage.ts` | Modified: provisioning result/interface alongside existing storage services. |
| `src/storage/d1-quota-admission.ts` | Modified: additional metric checks with legacy-schema compatibility; existing transaction structure preserved. |
| `tests/d1-schema.test.ts` | Modified: expected policy receipt table. |
| `package.json` | Modified: focused policy/provisioning test commands, preserving earlier script additions. |

## Verification and next stage

Verified locally on November 7, 2026:

| Check | Result |
| --- | --- |
| Focused provider-policy suite | 49 passed, 0 failed. |
| Focused local D1 provisioning suite | 24 passed, 0 failed. |
| Focused existing D1 admission suite | 28 passed, 0 failed. |
| Full Worker TypeScript suite | 502 passed, 0 failed, 0 skipped. |
| Python/TypeScript contract parity | 17 shared + 39 boundary cases, all 56 agree. |
| TypeScript | `npm run typecheck` and final `tsc --noEmit` passed. |
| Build | Production and local bundles built without networking. |
| Migrations | Local Wrangler applied 0001–0009, then skipped already-applied versions; occupied 0009 migration preserved accounting rows and foreign keys. |
| Whitespace | `git diff --check` passed; created files also checked with `--no-index --check`. |

The final full run used `node --import tsx --test --test-reporter=spec
--test-concurrency=2 tests/*.test.ts` after `npm run build`. It included all existing
D1 admission, idempotency, lifecycle, settlement, failure, recovery, gateway and
runtime tests. Python application code was unchanged, so no separate Python
application suite was run; contract parity executed the existing Python oracle.
All changes remain uncommitted. Unrelated local work and migrations 0001–0008 were
left untouched. No provider calls, remote resources, deployments or remote
migrations were performed.

Run `npm run test:policy`, `npm run test:provisioning`, `npm run typecheck` and
`npm test` from the Worker directory (`npm.cmd` in restricted PowerShell). The full
suite includes existing D1 accounting/recovery/gateway tests, local Wrangler
migration tests and cross-language contract parity. Provider-policy tests never
call a provider; local D1's outbound service rejects external requests.

Part 4E-2 is documented in [PROVIDER_HOLDS.md](PROVIDER_HOLDS.md), including trusted
hold updates, scope, persistence, expiration and atomic admission without releasing
unknown usage. The verification table above records the earlier 4E-1 baseline.
Part 4E-3 response normalization is documented in
[PROVIDER_RESPONSE_EVIDENCE.md](PROVIDER_RESPONSE_EVIDENCE.md); observations cannot
raise these verified limits or change quota policies automatically.
Gateway provisioning/routing remains in 4E-4; the parsing layer does not enable it.
Before any later live integration, verify actual
free account eligibility, complete limits, reset semantics, other account usage,
and model-specific estimation bounds. No deployments, provider calls, commits,
pushes or billing changes are part of this stage.
