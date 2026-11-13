# Durable provider holds (Part 4E-2)

Part 4E-3 now supplies a separate internal normalization layer; see
[trusted provider response evidence](PROVIDER_RESPONSE_EVIDENCE.md). It validates
eligible candidates with the existing rules and never writes holds directly.
The design and verification below describe the Part 4E-2 implementation.

ResearchBridge now has internal durable hold operations and atomic admission
enforcement. Production inference remains disabled. This stage adds no provider
requests, response/header parser, public administration route, gateway routing,
fallback, scheduled cleanup or model migration. The Part 4E-1 policy fixtures are
synthetic; they do not verify a real account or authorize live inference.

## Storage and migration

Migration `0010_durable_provider_holds.sql` rebuilds the existing `provider_holds`
table because its original `(quota_scope_id, provider, model)` primary key allowed
only one reason and its mandatory expiration could not represent unknown resets.
The migration preserves every original field and row, including released/expired
holds. Migrated rows have `hold_key = 'legacy'`, legacy source, conservative
confidence, revision 1, and evidence time copied from `updated_at`. Existing
legacy timestamp values are preserved; modern operations require safe timestamps.
No quota, reservation, link, attempt, idempotency, accounting or policy row changes.

The new primary key adds `hold_key`. Modern keys are SHA-256 over scope, provider,
model, optional dimension/window identity, and reason. Different reasons remain
independent. Empty model means explicitly provider-wide within this allocation.
Rows contain enumerated reason/source, evidence time/hash, creation/update times,
nullable absolute deadline, free plan, policy version, confidence and revision.
Optional dimension fields are metric, unit, window duration and window identity.
No raw evidence, response, prompt, reflection, credential or student identifier is
stored. `quota_scope_id` is the existing internal allocation identifier.

`provider_hold_operations` stores immutable UUID operation acknowledgments with a
hash, hold identity, action and resulting revision. Its restrictive foreign key
prevents deleting a referenced hold. A window-bound hold also has a restrictive
foreign key to its quota window. Scope/expiry and retention indexes support reads.
Apply migrations with the local D1 migration runner, which tracks applied versions;
do not rerun the raw one-time DDL. Occupied migration, data preservation, foreign keys and
runner repeat application are tested. Production migration remains a future task.

## Trusted evidence and scope

Construct `D1ProviderHolds` only from trusted server composition with a validated,
current `ProviderCapacityPolicy` and its provisioned D1 policy receipt. A source
label is the caller's attestation, not authentication. No HTTP route invokes this
service, and no student request body or header is mapped into it.

| Source | Requirements |
| --- | --- |
| `verified_quota` | Verified dimension, exhausted reason and remaining = 0. |
| `verified_retry_after` | Retry reason and a known absolute deadline. |
| `confirmed_exhaustion` | Confirmed exhausted dimension; unknown reset is allowed. |
| `operational` | Explicit trusted scope and availability/exhaustion restriction. |
| Uncertain or incomplete response | Rejected; cannot manufacture a hold or clear one. |

Validation rejects unknown keys, identities outside the configured provider/model/
allocation, browser sources, raw headers, unsafe/fractional/negative times,
future evidence, evidence preceding policy verification, contradictory remaining
capacity, reason/dimension mismatches and invented reset boundaries. Operations
use UTC seconds from D1 by default; tests inject server time. Operation IDs must
be UUID v4, independent of student identifiers.

Cloudflare compute dimensions use the account/provider scope of provisioning
(`model = ''`). Groq token/request dimensions require the selected model. Narrow
evidence cannot be broadened. Provider-wide outages need explicit trusted
provider scope. Optional window identity is checked against the actual persisted
account/provider/model/metric/unit/period in the write transaction. An indefinite
hold cannot be window-bound and silently disappear at rollover.

Cloudflare and Groq remain independent. A model restriction matches only that
model, unless a separate provider-wide restriction exists. Tests use two synthetic
local models to verify the SQL matching; no additional production model is enabled.

## Duration, extension and resolution

`record` creates or extends the deterministic hold. Deadlines are absolute:
verified Retry-After, the verified policy dimension's reset boundary, or explicit
operational availability deadline. There is no universal cooldown. New known
deadlines must still be in the future at the guarded write. A quota exhaustion
deadline must agree with the policy boundary at observation time; mismatches need
review, not guessing. No deadline means an indefinite, fail-closed restriction.

Exact operation replay reads its immutable receipt without writing. Identical
evidence with another operation ID adds a receipt but does not change the hold,
its revision or deadline. New evidence must be strictly newer than the current
observation; equal-time contradictions conflict and stale observations reject.
An active finite deadline never decreases; indefinite restrictions stay indefinite.
Trusted provider evidence has confidence 2; explicit operational/legacy restrictions
have confidence 3. Weaker observations cannot downgrade the active source or clear
its restriction. Extending a restriction remains conservative.

Known holds cease to apply at `now >= hold_until`. Expiration is a predicate, not
a mutation: no counters or reservations reset, and ordinary policy/capacity checks
still apply. `expired(limit, cursor)` returns up to 20 rows using keyset pagination
without clearing rows. `inspectApplicable()` returns up to 64 current holds and a
truncation flag; authoritative admission checks all applicable holds.

`resolve` requires the expected revision, current policy, strictly newer evidence
and sufficient source confidence. Verified positive capacity can resolve a quota
exhaustion only for its known dimension and within verified capacity. Operational
availability restoration resolves availability restrictions. `policy_reviewed`
requires an explicit operational resolution under a strictly newer policy version.
Updating a policy alone never clears a hold. A policy review can therefore resolve
unknown reset cases after trusted investigation without inventing a deadline.
Resolution changes hold metadata and writes its receipt only.

Replaying an old resolution cannot clear a reopened hold. Expired policy versions
cannot mutate holds, but `inspectOperation()` remains available to confirm an
earlier commit. Receipt acknowledgment is historical; it is not a claim that the
hold remains active at that revision.

## Atomic admission and ordering

The existing admission batch remains: reservation INSERT, optional fenced claim
UPDATE and ownership assertion, then a quota UPDATE and link INSERT per window.
Every quota UPDATE now also requires:

1. The current policy receipt/version/hash/review boundary and free eligibility.
2. Coverage of all required policy dimensions with their exact scope, capacity,
   margin and current reset period; omitting a dimension cannot bypass its hold.
3. `NOT EXISTS` an active applicable `provider_holds` row, matching allocation,
   provider, model, optional dimension and optional window, using D1 time.

The immediately following link INSERT still stores `changes()` in the existing
`quota_admission_succeeded` CHECK constraint. Zero affected rows cause an SQL
failure and roll back the entire D1 batch, including earlier windows, reservation,
links and ownership generation. No process lock or read-then-reserve authorization
is used. Diagnostic reads classify a denial; they do not authorize dispatch.
An ambiguous admission acknowledgment continues to fail closed without refund.

D1 serializes write transactions. If the hold transaction commits before the
admission transaction, that admission observes the hold and cannot reserve. If
admission commits first, its reservation remains valid and accounted for. A hold
does not retroactively cancel it or introduce a new dispatch fence. Simultaneous
invocations are ordered by database execution, not invocation or response time.
Tests inject a committed hold after admission's diagnostic read, exercise many
subsequent admissions, and force a late predicate failure inside a real local D1
batch to verify complete rollback.

Hold writes similarly batch current-policy guards, optional window/future-deadline
guards, a revision-and-observation compare-and-swap mutation, a `changes()` SQL
assertion, receipt INSERT and another assertion. Concurrent creators cannot
duplicate an identity; extensions and resolutions cannot overwrite newer state.
A loser returns conflict and must inspect/reconcile current evidence. It never
blindly reapplies stale evidence. An uncertain acknowledgment is resolved by
reading the immutable operation receipt, without repeating the mutation.

Approved production provider/model pairs require the new policy reference; removing
it fails closed. Existing unmanaged local/legacy fixtures retain schema-compatible
admission. A managed allocation cannot evade receipt checks by omitting metadata.
The application deployment should use migrations 0001 through 0010 together.

## Decisions, accounting and model availability

Admission returns safe internal `provider_held`, `model_held`,
`quota_dimension_held`, `provider_capacity_unknown` or
`provider_policy_unavailable` decisions. It reports the latest known applicable
deadline only when all restrictions are finite. Unknown capacity and permanent
model unavailability have no retry/reset timestamp. Database details and policy
credentials are never included. These are internal storage decisions; public
gateway response/routing changes belong to Part 4E-4.

Provider holds never release reservations, refund usage, settle attempts, redispatch,
change generations, erase receipts or clear unknown outcomes. A previously admitted
request can still settle/account under the existing fenced lifecycle. Tests cover
successful settlement, failure receipts, unknown retained reservations and stale
owners while holds are created and resolved.

Historical Cloudflare model `@cf/qwen/qwen3-30b-a3b-fp8` is preserved. Its
[announced November 20, 2026 deprecation](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)
is enforced at the existing policy boundary, 2026-11-20 00:00:00 UTC. Admission
checks that boundary inside the write transaction even for an older snapshot.
It returns model-unavailable policy failure without a temporary cooldown. There
is no automatic allocation transition or paid fallback. The preferred
[Gemma candidate](CLOUDFLARE_MODEL_CANDIDATE.md) retains shared account restrictions.
Groq remains
`openai/gpt-oss-20b`.

## Operational limits and next stage

This is a local implementation verified with local D1, not a production load test.
Admission adds one diagnostic aggregate read and indexed hold/policy predicates to
each existing window UPDATE. Policy coverage uses bounded configured dimension
arrays. Writes do not add another quota transaction or quota accounting row.
New/changed hold operations normally write one hold and one receipt, plus indexes;
exact operation replays write nothing. Unknown holds remain active regardless of
retention timestamps. No cleanup is implemented: future cleanup must preserve
active restrictions, tombstones needed for stale-evidence rejection, operation
idempotency, window references and unsettled accounting. Rows and receipt storage
accumulate; measure D1 query metadata before asserting production cost/scalability.

Admission checks the durable provisioned policy receipt. A rejected disabled or
invalid provisioning input does not revoke an older receipt. Future gateway
composition must validate its current trusted configuration before using a
snapshot; an explicit operational hold can stop new reservations under a still
valid policy. No new policy-revocation API is introduced in this stage.

The source classification is an internal trust boundary, not cryptographic proof
that an external provider said something. Part 4E-3 now validates account/model/
dimension scope, normalizes time and units, checks policy reset agreement, and
rejects contradictory or uncertain signals; see
[response evidence](PROVIDER_RESPONSE_EVIDENCE.md). Real transport authentication
and gateway composition remain in Part 4E-4. Future integration must not trust
student headers, broaden scope, infer exhaustion from every error or treat unknown
capacity as unlimited. It must handle conflicts and ambiguous acknowledgments using
durable inspection. No live transport or gateway integration is implemented here.

## Files and verification

New: this document, migration 0010, `src/storage/d1-provider-holds.ts`,
`src/storage/provider-hold-evidence.ts`, `src/storage/provider-availability.ts`,
and `tests/d1-provider-holds.test.ts`.

Modified for this stage: `src/storage.ts`, `src/config/provider-policy.ts`,
`src/storage/d1-quota-provisioning.ts`, `src/storage/d1-quota-admission.ts`,
`tests/d1-quota-provisioning.test.ts`, `tests/d1-schema.test.ts`, `package.json`
and the Part 4E-1 documentation cross-reference. Existing uncommitted work is
preserved. No Python, Streamlit, README, gateway or provider implementation change
is part of 4E-2.

Run `npm run test:holds`, `npm run test:policy`, `npm run test:provisioning`,
`npm run test:admission`, `npm run typecheck` and `npm test` from this directory
(`npm.cmd` under restricted PowerShell). Full tests include all D1 suites, local
migration runner repeat application and the Python contract oracle. Verification
results for November 7, 2026:

| Check | Final result |
| --- | --- |
| Provider holds suite | 79 passed, including concurrency, restart, occupied migration and accounting compatibility. |
| Provider policy suite | 49 passed. |
| Quota provisioning suite | 24 passed. |
| Atomic admission suite | 28 passed. |
| Full Worker suite | 581 passed, 0 failed, 0 skipped. Includes all existing D1, gateway and runtime suites. |
| Contract parity | 17 shared + 39 boundary cases: all 56 agree. |
| TypeScript | `npm.cmd run typecheck` passed. |
| Build | Production and local Worker bundles built without network access. |
| Local migration runner | Applied 0001 through 0010; repeat invocation skipped applied versions. |
| Whitespace | `git diff --check` and checks of all untracked Worker files passed. |

The final full run used `node --import tsx --test --test-reporter=spec
--test-concurrency=2 tests/*.test.ts` after `npm.cmd run build`; elapsed test time
was approximately 239 seconds. The per-suite counts above are from this final
successful run. Earlier standalone focused runs exercised the hold and provisioning
suites; an expanded migration test initially attempted `PRAGMA integrity_check`,
which D1 does not support. It was removed before the final run. Migration checks
retain exact occupied-data comparison, foreign-key checks and restrictive deletes.

The four protected unrelated files have unchanged SHA-256 hashes relative to the
start of this task. Python application code was untouched, so only the existing
Python contract oracle ran. All work remains uncommitted. No live provider calls,
remote migrations, remote resources, deployment, paid inference or later stage
implementation occurred.
