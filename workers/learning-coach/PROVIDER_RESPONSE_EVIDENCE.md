# Trusted provider response evidence (Part 4E-3)

ResearchBridge now normalizes supported Groq and Cloudflare Workers AI response
metadata into internal observations and eligible hold candidates. Production
inference remains disabled. No gateway route, provider invocation, settlement
algorithm, quota counter, admission SQL or database migration changes in this
stage. All fixtures are synthetic. Part 4E-4 orchestration is not implemented.

## Reviewed provider semantics

Documentation reviewed on November 7, 2026:

| Source | Semantics used |
| --- | --- |
| [Groq rate limits](https://console.groq.com/docs/rate-limits) | `limit/remaining/reset-requests` refer to RPD; `limit/remaining/reset-tokens` refer to TPM. Reset values are durations. Groq documents `retry-after` for HTTP 429. Illustrative account limits are not provisioning evidence. |
| [Workers AI errors](https://developers.cloudflare.com/workers-ai/platform/errors/) | 3036: daily free exhaustion; 3040: temporary capacity; 5035: paid plan required; 5028: deprecated; 5018/3041: model access denied; 5007/3042: unavailable/invalid model. Workers AI and AI Gateway error namespaces differ. |
| [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) | Daily free allocation resets at 00:00 UTC. This is used only with an applicable verified UTC-day compute policy. |
| [HTTP semantics, RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after) | Retry-After supports integer delay-seconds and HTTP dates. Date parsing includes the obsolete recipient formats and their two-digit-year rule. |
| [Groq API](https://console.groq.com/docs/api-reference) and [Workers AI API](https://developers.cloudflare.com/api/resources/ai/methods/run/) | Supported chat usage fields are `prompt_tokens`, `completion_tokens` and `total_tokens`. |
| [Historical Qwen model](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/) | Its November 20, 2026 policy boundary is preserved. The preferred [Gemma candidate](CLOUDFLARE_MODEL_CANDIDATE.md) does not inherit that date. |

The parser never imports a published example limit as an account allowance.
Reported capacity is retained for review; it cannot increase or replace a trusted
policy limit, safety margin, reset topology or free-only eligibility.

## Internal trust boundary

`ProviderResponseParser.create(policy, attempt, transport, trustedUtcClock)` is
the intended internal entry point. Construction validates the configured free-only
policy, exact provider/model, allocation and UUID reservation/attempt identities.
Allowed transports are `groq_http`, `workers_ai_http` and `workers_ai_binding`;
provider/transport mismatches reject. Configuration, attempt and clock references
are held privately. Caller changes to the original configuration do not change
the parser's captured authority.

Construction is a **trusted server-side attestation**, not authentication of
arbitrary bytes. Only future real provider adapters may construct this context
after establishing the genuine provider transport, configured account/model and
owned attempt. Header names, JSON source labels and error messages cannot prove
origin. Do not construct this service from student input, forward student headers,
or expose it as a public endpoint. No route currently imports it.

`observe(metadata)` consumes the context once, stamps evidence from the injected
UTC-seconds clock and binds the observation to that attempt. It rejects public
Request objects, client context fields, invalid statuses, redirects, malformed
transport envelopes and mismatched response model identities. Supported metadata:

- HTTP: status, a header tuple array and an optional already-decoded JSON body.
- Binding success: the returned result object, without invented HTTP headers.
- Binding error: `{namespace: 'workers_ai', code: integer}` supplied by trusted
  binding error normalization; arbitrary Error text is never searched for codes.
- Transport failure: an internal `timeout` or `interrupted` classification.

A private WeakMap records the sanitized observation snapshot. `holdEvidence()` and
`usageEvidence()` accept only that parser's original, unmodified observation.
Copies, JSON deserialization, cross-account/parser reuse and changed fields reject.
Lower-level signal helpers are internal implementation details, not authenticated
entry points. No credentials or raw response strings are stored or logged.

## Observation schema

`ProviderObservation` contains provider/model, allocation, policy version, internal
attempt/reservation UUIDs, transport source, evidence timestamp, nullable HTTP
status/provider code, classification, quality, quota signals, retry evidence,
optional measured usage and enumerated issues. Missing numeric fields remain null
or absent. It contains no raw body, header map, error message, generated text,
prompt, reflection, personal identifier or policy credential.

Each quota signal contains metric/unit/window duration, nullable reported limit
and remaining values, reset evidence, and its own quality. Reset/retry evidence
is `known` with an absolute UTC deadline and basis, `missing`, `invalid` or
`clock_uncertain`. Top-level classification describes the provider event, not a
settlement decision or permission to dispatch. For example, HTTP 500 can remain a
provider error while independent valid token measurements are retained.

## Parsing and time rules

Header names are case-insensitive. Identical duplicates are accepted once;
conflicting duplicates invalidate that field. Combined ambiguous numeric values
also reject. Limits/remaining must be nonnegative safe integers; remaining cannot
exceed a reported limit. Unsupported quota dimensions, reset/policy disagreement,
and reported capacity above the verified policy are marked for review. Groq RPD
cannot be reinterpreted as RPM, and TPM cannot be remapped to TPD or split caps.

Groq reset syntax supports ordered hours/minutes/seconds, including fractional
seconds such as `7.66s`, `2m59.56s` and `1h2m3s`. Integer arithmetic rounds any
fraction upward before adding it to the trusted observation second. The result
remains visible even when it conflicts with a fixed policy boundary. Such a
conflict cannot be silently snapped to policy time or replaced by an indefinite
hold. Missing reset with independently verified zero remaining can produce an
indefinite dimension restriction under the existing hold rules.

Retry-After delta-seconds require decimal integers. HTTP-date validation checks
format, calendar, weekday and GMT; it does not rely on permissive Date.parse.
IMF-fixdate, RFC 850 and asctime recipient forms are supported. Leap seconds and
pre-epoch dates are rejected rather than approximated. Dates in the past remain
expired and cannot create a fresh cooldown. Zero delay never becomes an unknown
reset. Missing retry metadata never becomes zero.

For a valid provider Date, the parser uses the later of the absolute retry date
and the provider's relative wait measured from trusted receipt time. It never
shortens the absolute instruction or adds guessed skew padding. Invalid/conflicting
Date metadata or skew over 300 seconds makes date-based retry evidence uncertain.
Delta-seconds do not depend on Date. Without Date, an HTTP retry date retains its
absolute meaning using the trusted server clock; skew cannot be measured.

Validation bounds are seven days per parsed duration, year 9999 for timestamps,
300 seconds for context/hold-evidence freshness, 128 header tuples, 16,384 total
header characters, 128-character names, 4096-character values and eight Workers
AI error entries. Duration strings are at most 64 characters with at most nine
fractional digits. These are parser/freshness safeguards, **not provider cooldowns**.
Out-of-bound evidence is rejected, never clamped into a guessed deadline. Whole
UTC seconds are required from the injected server clock; student time is unused.

Groq Retry-After outside 429 is reported as unexpected and cannot create a hold.
Workers AI HTTP 429/503 may carry a genuine retry instruction. Error 3040 alone
does not manufacture one. Permanent/model-eligibility errors carry no temporary
retry deadline, even if contradictory retry metadata is present. HTTP status and
recognized Workers AI code must agree. Malformed error lists, conflicting codes
and success/error contradictions cannot authorize holds.

## Existing hold compatibility

`await parser.holdEvidence(observation, durableOperationId, currentPolicy?)`
returns `eligible`, `review_required`, `no_hold` or a sanitized rejection. It
rechecks freshness and the full policy identity/version before conversion. The
optional current policy allows orchestration to reject an invalidated snapshot;
the hold service independently verifies its current durable policy receipt.

Eligible conversions are deliberately narrow:

| Evidence | Candidate |
| --- | --- |
| Groq zero RPD/TPM remaining with supported scope | `verified_quota`, daily requests or minute tokens, exact model. |
| Applicable HTTP Retry-After | `verified_retry_after`, exact model, original validated deadline. |
| Workers AI 3036 with verified UTC-day neuron policy | `confirmed_exhaustion`, account/provider compute dimension and next UTC reset. |
| Missing retry/dimension on generic 429 | No hold; no reset is guessed. |
| 3040, deprecation, paid-plan requirement, model/access failures | Review required; availability classification is preserved. A separate valid HTTP retry instruction can remain eligible for temporary capacity. |

Part 4E-2 accepts availability holds only from explicit operational evidence.
Provider parsing must not impersonate that source. Therefore the adapter does
not automatically create `model_unavailable` or operational outage holds from
these codes, and does not weaken their validator or add a new database source.
Review is required before an operational restriction is created. Positive remaining
values never resolve holds, refund reservations or increase capacity.

The adapter calls the unchanged Part 4E-2 evidence validator on every candidate.
For independent signals it derives distinct UUID-shaped operation IDs from the
caller's durable operation UUID, attempt/reservation and scope/reason/dimension.
Repeated conversion produces the same IDs and evidence. Orchestration must retain
the original durable operation identity; using a fresh identity to replay an old
response is not a recovery strategy. Existing immutable receipts, revisions,
stale-evidence rejection and stronger-hold protection remain authoritative.

`review_required` may include individually valid candidates plus review reasons.
It must not be treated as permission to dispatch or to clear the unresolved
restriction. The parser never calls D1. Tests explicitly record candidates through
`D1ProviderHolds` afterward and verify atomic admission blocking and unchanged
accounting; parsing/conversion alone leaves every database table untouched.

## Usage boundary

Supported token measurements use existing `FailureUsage` fields with measured
`provider_report` provenance. `usageEvidence(observation, attempt)` verifies the
same attempt and returns a copy of only validated measurements. It preserves
partial reports, explicit measured zero and overages. It rejects negative,
fractional, string, unsafe, contradictory or unsupported-unit measurements.
Unreported totals remain absent; existing accounting can validate/derive a sum.
Quota limits/remaining are never interpreted as per-request consumption.

No request count or neuron charge is inferred from a token usage object. These
schemas do not establish complete successful-settlement evidence: the existing
settlement interface also needs a request count and all reserved dimensions.
Missing request/compute measurements must stay unresolved until separately trusted
evidence exists. Token pricing is not a measured neuron report. Neither successful
settlement nor failure accounting is modified, and no retry/redispatch is performed.
Historical measured usage can still be read after quota/policy review time; actual
accounting must independently verify current durable ownership and fencing.

## Limits and Part 4E-4 requirements

This is deterministic, local normalization of non-streaming metadata. It does not
authenticate real transports, decode streams, fetch dashboards, parse AI Gateway
errors, store observations durably, or integrate a live provider. Private observation
capabilities do not survive JSON serialization or Worker restarts. Durable hold
receipts do; future orchestration must define crash recovery without promoting
deserialized arbitrary JSON to trusted evidence.

Part 4E-4 must establish genuine endpoint/binding origin, disallow untrusted
redirects/proxies, bind the configured account/model to the fenced attempt,
decode bounded provider responses, supply server UTC time, handle unavailable
headers and binding namespaces, and validate current policy before dispatch.
It must deliberately persist eligible holds with stable operation IDs, handle
review-required restrictions, inspect ambiguous acknowledgments, retain unknown
usage and require complete trusted accounting evidence. None of these observations
can authorize paid fallback or automatic model replacement. A future deprecation
announcement alone does not classify today's successful response as deprecated;
an actual trusted 5028 is distinct from that announcement.

## Files and verification

Created under `src/providers/`: `response-parser.ts`, `response-signals.ts`,
`response-headers.ts`, `response-time.ts`, `response-usage.ts`, `groq-response.ts`,
`cloudflare-response.ts`, `response-hold-adapter.ts`.

Created under `tests/`: `provider-response-fixture.ts`, `response-time.test.ts`,
`groq-response.test.ts`, `cloudflare-response.test.ts`,
`provider-response-evidence.test.ts`. This document is also new.

Modified: `package.json` (focused test scripts),
`src/storage/provider-hold-evidence.ts` (comment only), `PROVIDER_HOLDS.md` and
`PROVIDER_CAPACITY_POLICIES.md` (stage cross-references). No migration is needed.
All earlier tracked/untracked work and the four protected unrelated files remain.

Run `npm run test:groq-response`, `npm run test:cloudflare-response`,
`npm run test:response-time`, `npm run test:response-evidence`,
`npm run typecheck` and `npm test` in this directory (`npm.cmd` in PowerShell).

Verified locally on November 7, 2026:

| Check | Result |
| --- | --- |
| Focused Groq response tests | 47 passed. |
| Focused Cloudflare response tests | 54 passed. |
| Focused Retry-After/reset/time tests | 65 passed. |
| Focused evidence/adapter tests | 55 passed, including local D1 integration. |
| Existing provider holds | 79 passed in the full run. |
| Existing provider policies | 49 passed in the full run. |
| Existing provisioning/admission | 24 / 28 passed in the full run. |
| Full Worker suite | 802 passed, 0 failed, 0 skipped. |
| Contract parity | 17 shared + 39 boundary cases; all 56 agree. |
| TypeScript | `npm.cmd run typecheck` passed. |
| Build | Production and local bundles built without network access. |
| Local migration compatibility | Existing 0001 through 0010 applied; repeat invocation skipped applied versions. No new migration. |
| Whitespace | Tracked diff and all untracked Worker files checked successfully. |

The final full run used `node --import tsx --test --test-reporter=spec
--test-concurrency=2 tests/*.test.ts` after `npm.cmd run build`; test duration was
approximately 221 seconds. All existing D1, settlement, failure, recovery, gateway,
idempotency and runtime tests were included. Focused tests used the four files
listed above individually. No Python application files changed; only the existing
Python contract oracle ran. SHA-256 checks confirm the four protected unrelated
files are unchanged from task start. All changes remain uncommitted. No live
inference, deployment, remote migration, paid service or later-stage implementation
was performed.
