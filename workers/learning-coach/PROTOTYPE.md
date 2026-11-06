# ResearchBridge Learning Coach Worker prototype

This isolated TypeScript Worker implements the existing contracts with local
mock inference. The Streamlit application, its providers and quotas, the shared
JSON schemas, and all educational behavior remain unchanged. There are no AI,
D1, KV, or other remote resource bindings in either Wrangler configuration.

## Layout

```text
workers/learning-coach/
  package.json, package-lock.json, tsconfig.json
  wrangler.jsonc                 production entry; inference always disabled
  wrangler.local.jsonc           loopback-only local mock entry
  .dev.vars.example             empty local secret placeholder
  src/
    index.ts, local.ts
    auth.ts                     server-to-server authentication
    sources.ts                  future retrieval resolver interface
    storage.ts                  future D1 interfaces; no persistence implementation
    config/index.ts             limits and environment types
    contracts/                  v1/v2 validation and pinned Unicode semantics
    errors/index.ts             sanitized contract-compatible errors
    handlers/                   routing, bounded body reads, provider deadline
    providers/                  provider interface and local mocks
  scripts/                      offline schema compilation, builds, Python parity
  tests/                        contracts, gateway, and actual workerd runtime
```

`.generated/`, `dist/`, `.wrangler/`, `node_modules/`, local npm caches, and filled
`.dev.vars` files are ignored. Runtime validators are compiled locally from the
existing JSON Schema Draft 2020-12 documents using Ajv's standalone compiler.
They use no runtime `eval` or `new Function`. The original schemas are not copied
into a divergent contract. See [Ajv standalone validation](https://ajv.js.org/standalone.html).

## Endpoints and versions

| Endpoint | Behavior |
| --- | --- |
| `GET /api/health` | Returns only `{"status":"ok"}`; no credentials, modes, quotas, or configuration |
| `POST /api/coach/generate` | Authenticates the service, validates the request, and permits mock generation only through the local entry |

All bodies use the existing v2 request schema with `contract_version: "2"`.
The existing v1 contract defines a response only, so this prototype does not
invent a v1 request schema. For `abstract_explanation`, the optional
`X-ResearchBridge-Response-Version: 1` header requests the original bare four-card
pack. The default is v2. Other versions, or v1 output for another task, are
rejected. The response header reports the selected version. Existing Python
provider calls are not redirected to this endpoint.

V2 supports `abstract_explanation`, `learning_hints`, and `term_clarification`
with their existing field names and distinct output structures. The Worker
validates all outputs, evidence, numeric strings, source coverage, and unique
section IDs before returning them. Variable section/hint lengths remain valid.

Every response has `Cache-Control: no-store`. Successful local generation also
has `X-ResearchBridge-Inference: mock`. The mock abstract/hint outputs use only
missing-information fixture values; they do not evaluate the supplied abstract.
The term output explicitly says it is a mock. These responses are for contract
testing and must never be presented as real educational inference.

## Authentication and transport

The future Streamlit server sends `Authorization: Bearer <secret>`. Generate a
unique random 32-byte secret encoded as 64 lowercase hexadecimal characters.
The Worker checks its format and uses Web Crypto HMAC verification, rather than
comparing secret strings. Format validation cannot establish randomness; create
the secret with a cryptographic random generator.

`COACH_SERVICE_SECRET` belongs in Cloudflare secrets for a future deployment and
in Streamlit's server environment or secrets configuration for a future client.
It must never be placed in browser code, URLs, Git, or ordinary Wrangler vars.
No Streamlit client is added in this step. See [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

Missing/invalid credentials receive HTTP 401. Missing or malformed server secret
configuration fails closed with a generic 503. Production requires HTTPS.
Local HTTP is allowed only on localhost, 127.0.0.1, or IPv6 loopback. The local
entry also rejects non-loopback URLs even over HTTPS. Browser `Origin` and
`Sec-Fetch-Site` headers are rejected as an additional restriction; CORS is not
the authentication mechanism and no permissive CORS headers are returned.

The authenticated identity is the Streamlit service, not a verified student.
Client-supplied `user_id`, `verified`, or source catalogs are not trusted. The
bearer credential is reusable: this stateless prototype does not prevent replay,
enforce a shared quota, or provide idempotency. These are explicit D1-stage
requirements, not in-memory approximations.

The generation endpoint accepts POST with UTF-8 `application/json`. It rejects
encoded bodies, malformed UTF-8/JSON, and unexpected fields. Both declared and
streamed sizes are bounded to 64 KiB; misleading Content-Length headers do not
bypass the byte counter. Body reads have a five-second deadline. Provider work
has a one-second local deadline and an abort signal. There are no automatic
retries or provider fallbacks. Provider responses are capped at 100,000 bytes.
These are prototype transport bounds, not provider-derived student allowances.

## Error compatibility

All error bodies satisfy the existing v2 error schema:

```json
{"contract_version":"2","error":{"code":"invalid_response","message":"Inference is unavailable; manual learning remains available.","retryable":false}}
```

The existing error enum has no authentication, timeout, rate-limit, or unavailable
codes. This prototype preserves it: HTTP status distinguishes transport/provider
failures, using `invalid_request` or `invalid_response` with a static sanitized
message. `retryable` remains false, so clients must not automatically retry.

| HTTP status | Condition |
| --- | --- |
| 400 | Invalid contract, version, task, source, evidence context, JSON, or HTTPS requirement |
| 401 / 403 | Invalid service credentials / browser-shaped request |
| 404 / 405 | Unknown endpoint / unsupported method |
| 408 / 413 / 415 | Body deadline / byte limit / unsupported content encoding or media type |
| 429 | Simulated provider rate limit; local fixture Retry-After is thirty seconds |
| 502 / 504 | Provider failure or invalid output / provider deadline |
| 503 | Inference disabled or authentication configuration unavailable |
| 500 | Unexpected internal failure, with a generic message |

Raw exceptions, validation diagnostics, request bodies, secrets, and provider
messages are never included in API errors or logged by this Worker. Usage and
administrative ledgers are not exposed by any endpoint. More specific operational
error codes would require an agreed future contract extension.

## Source context and mock provider

`SourceResolver.resolve(sourceId, principal)` is the boundary for a future
authorized OpenAlex/retrieval integration. The local resolver serves only the
controlled synthetic retrieval record already in the shared fixtures. It uses
an exact owned-key lookup; unknown references and malformed server records are
rejected. Request bodies cannot supply a verified source registry or overwrite
retrieved metadata.

User-supplied abstracts keep `origin: user_supplied`. Server-resolved fixture
sources use the existing `verified_retrieval` label to exercise that contract;
the fixture is synthetic, not a real retrieved paper. Every paper response states
title/abstract-only coverage and `full_paper_verified: false`. Term clarification
is general background. Missing abstracts fail before provider invocation. Only
source title/text enters the prepared task; generated publication metadata is
not accepted. Source text and learner context remain untrusted data.

`InferenceProvider.generate(validatedTask, signal)` returns an output and optional
internal usage measurements. Future adapters can implement this interface after
persistent quota admission exists. `UsageMeasurement.kind` distinguishes measured,
estimated, and simulated values. Mock zero counters are explicitly simulated and
are not sent as actual consumption or a remaining balance.

`MOCK_SCENARIO` selects `success`, `error`, `timeout`, `rate_limit`, or `malformed`
through local server configuration only. Requests cannot select it. Timeout
simulation waits for cancellation; the handler also bounds providers that ignore
the abort signal. No mock makes a network request or fabricates scholarly data.

The production entry has no enabling environment flag. It always returns 503
for an authenticated, structurally valid generation request. The production
bundle excludes the mock provider and fixture source records. Both Wrangler
configurations disable workers.dev and preview URLs and define no routes.
Do not deploy the local entry. Configuration follows the supported
[Wrangler JSONC format](https://developers.cloudflare.com/workers/wrangler/configuration/).

## Local setup and verification

Use Node.js 22 or newer and the project's Python environment. On Windows,
`npm.cmd` can be used when PowerShell blocks the `npm.ps1` shim. Dependencies and
the lockfile are isolated here. Installation downloads npm packages; it does not
contact AI providers. Tests, bundling, and schema compilation run locally.

```console
cd workers/learning-coach
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

`npm test` builds both bundles, executes the shared fixtures and HTTP tests, and
starts local workerd runtimes with outbound services blocked and telemetry off.
Authentication tests generate ephemeral credentials in memory; no real secrets
or Cloudflare account is required. The parity test invokes the existing Python
validators with networking forbidden and UTF-8 explicitly configured on pipes.
It locates the repository virtual environment automatically; set
`RESEARCHBRIDGE_PYTHON` to an absolute interpreter path if needed.

For a manual local-only preview, create the ignored secret file once from this
directory. The exclusive-create flag avoids overwriting an existing secret:

```console
node -e "require('node:fs').writeFileSync('.dev.vars','COACH_SERVICE_SECRET='+require('node:crypto').randomBytes(32).toString('hex')+'\n',{flag:'wx'})"
npm run dev
```

The local configuration sets `LOCAL_MOCK_ENABLED=true` and `MOCK_SCENARIO=success`.
The production configuration sets neither. No provider keys, account ID, remote
AI binding, D1 database ID, or paid service configuration is required. No deploy
script is supplied and no Cloudflare resources were created by this step.

## Python/TypeScript parity

All seventeen existing shared fixtures are reused without modification. Additional
boundary cases compare missing fields, source coverage, duplicate IDs, non-BMP
lengths, Unicode numbers, end anchors, and legacy case folding directly against
Python. JSON Schema validation does not coerce types, add defaults, or remove
unknown fields.

V1 preserves Python case folding, whitespace splitting, Unicode decimal matching,
and Unicode word boundaries using checked-in tables from the current Python
Unicode 16.0.0 database. V2 retains its specified ASCII whitespace/case rules and
uses the same pinned Unicode categories for letter/numeric checks. String lengths
are code-point based. The schema compiler preserves Python's end-anchor behavior
without editing the schemas. There is no weaker Python validation to accommodate
JavaScript.

`scripts/python-unicode.py` checks the tables against the current Python runtime;
`--write` is an explicit, reviewable refresh operation. The parity test fails when
Python's Unicode database changes. Other Python Unicode versions are not claimed
compatible until the tables and parity checks have been reviewed together. No
fixture acceptance differences remain on the audited runtime. This does not
establish semantic correctness of generated interpretations or resistance to
every possible prompt injection.

## D1 work required next

`src/storage.ts` defines small interfaces for quota admission, usage settlement,
provider holds, and idempotency. It contains no in-memory admission implementation.
The next stage needs these persistent records and invariants:

| Record | Required behavior |
| --- | --- |
| Quota windows | Account/provider/model limits and measured consumption; indexed by budget window |
| Reservations and attempts | Atomic conditional reservation before each provider dispatch; separate fallback accounting; record sent/unknown/completed states |
| Provider holds | Persist the longest applicable provider deadline across replicas and restarts |
| Idempotency | Unique service/key pair bound to a canonical payload hash, response version, and trusted source fingerprint; pending/completed/unknown states and expiry |
| Replay nonces, if signed requests are adopted | Authenticate timestamp/body/path signatures, then atomically claim a unique service/nonce with expiry |
| Safe cache | Validated outputs only; identity/privacy scope plus source/task/model/prompt/schema/validator versions; indexed expiry and deletion |

Admission and idempotency ownership must be decided atomically at the authoritative
database. A separate budget read followed by an unconditional write is unsafe;
transactional batching alone does not establish the required conditional invariants.
Test simultaneous requests, replica access, midnight boundaries, duplicate keys,
conflicting bodies, stale reads, and crashes before/after dispatch.

After an ambiguous timeout, retain a conservative reservation and an unknown
outcome; do not refund it or resend automatically. Reconcile actual usage when
available. Storage failures must close inference admission. Preserve manual
learning and the current Python safeguards throughout the migration.

Bearer authentication and idempotency alone do not prevent all replay. If signed
requests are adopted, the nonce table must be part of authenticated admission.
Verified per-student enforcement also needs a trusted student identity mechanism;
an arbitrary request field or IP address is insufficient.

No source text or reflection answers belong in quota ledgers. Pasted abstracts
must not enter a cross-student cache by default. Define access authorization,
retention, deletion, account Free-plan confirmation, and consumption-derived
policy before enabling inference. Implement and test these D1 invariants offline
before any separately authorized provider integration or deployment.
