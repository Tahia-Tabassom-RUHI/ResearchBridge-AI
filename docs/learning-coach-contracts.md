# Learning Coach contracts

ResearchBridge retains its existing Python/Streamlit implementation. This step
adds offline contract definitions and validation only. No v2 task is connected to
the UI or provider dispatch. Provider selection, existing quotas, manual
reflection questions, and session state continue to use the existing code.

## Version selection and compatibility

Contract versions are strings. V2 request and success envelopes require
`"contract_version": "2"` and a registered `task_id`. Unknown versions and tasks
fail closed. Select versions explicitly; do not guess from output shape.

V1 remains the existing bare object with `research_problem`, `method`, `findings`,
and `limitations`. Adding a version field to that object would break its strict
validator, so v1 is identified outside the payload by the legacy call path.
`validate_v1_response()` delegates directly to `services.ai_explainer.validate_pack()`.
Its evidence, numeric, case-folding, length, and missing-information behavior is
unchanged. `contracts/learning-coach/v1/response.schema.json` records the existing
provider schema; its semantic checks still require the existing validator.

V1 and v2 coexist. There is no automatic conversion, UI switch, or v1 retirement.
Changing v2 fields or validation semantics incompatibly requires a new contract
version and fixtures; provider/model changes alone do not change the contract.

## V2 tasks

| Task identifier | Required input | Source requirement | Output |
| --- | --- | --- | --- |
| `abstract_explanation` | `source` | Supplied title and meaningful abstract, or server-resolved retrieval record | `sections`: one to twelve items with unique `id`, `focus`, `explanation`, and `supporting_excerpt` |
| `learning_hints` | `source`, `question` | Same abstract requirements | `hints`: one to twelve items with `hint` and `supporting_excerpt` |
| `term_clarification` | `term` | No paper context; general background only | `definition` and an illustrative `example` |

These are contract capabilities, not newly enabled educational features. Concept
explanations, guided-reading tasks, and reflection feedback can receive dedicated
structures in a later version when needed. They are currently rejected as unknown
tasks. Different responses do not share a mandatory card format. Collection
bounds limit payload size; they do not require a particular number of sections
or hints. Multiple sections may address the same focus.

All tasks accept optional `learner_context` containing a `level` enum and/or a
bounded `learning_goal`. This context is untrusted text, not a student identity
or validated assessment. Reflection answers and assessment results are not
accepted fields in these tasks.

The request and response schemas are self-contained JSON Schema Draft 2020-12
documents under `contracts/learning-coach/v2/`. Every object disallows unknown
fields. `output_schema(task_id)` selects a portable output-only schema for a
future provider adapter. Providers produce only the task output object; the
application constructs and validates the response envelope.

Example request and successful response:

```json
{
  "contract_version": "2",
  "task_id": "term_clarification",
  "input": {"term": "classification"},
  "learner_context": {"level": "beginner"}
}
```

```json
{
  "contract_version": "2",
  "task_id": "term_clarification",
  "source_coverage": {
    "scope": "general_background",
    "origin": "none",
    "source_id": null,
    "full_paper_verified": false
  },
  "output": {
    "definition": "Classification assigns examples to categories.",
    "example": "Sorting messages into spam and ordinary mail is an illustrative classification task."
  }
}
```

## Source trust and coverage

A paper task accepts exactly one of these source forms:

```json
{"kind": "user_abstract", "title": "Supplied title", "abstract": "Supplied abstract text"}
```

```json
{"kind": "retrieved_paper", "source_id": "server_source_reference"}
```

The first form contains no paper ID, DOI, publication metadata, or verification
flag. Its coverage origin is `user_supplied`; pasting text never verifies a paper.

The second form contains only an opaque reference. `verified_sources`, supplied
as a separate server-side argument to the Python API, must map it to a record
from trusted retrieval. The `retrieved-source.schema.json` document specifies a
minimal projection: paper ID, title, optional abstract, and retrieval provenance.
Full paper metadata stays in the retrieval module. Do not populate this mapping
from request JSON, provider output, or a client assertion of verification.
Validating its shape does not independently verify provenance. Retrieval and
authorization to access a record remain the future caller's responsibility.

Only title and abstract are passed to the model; paper IDs and provenance are
excluded. DOI/publication fields are not permitted in model output structures,
and generated DOI/URL/citation-identifier patterns are rejected in explanation
text. Applications must display paper identifiers and publication metadata from
verified retrieval, never extract them from generated prose.

Paper tasks report `scope: title_and_abstract`, with the appropriate origin and
source reference. `full_paper_verified` is always false. Term clarification
reports `general_background` and cannot take a paper source. Coverage is computed
by application code, and response validation compares it against the request;
the model cannot elevate coverage or claim another source.

Missing, null, empty, or ASCII-whitespace-only abstracts stop paper tasks with
`missing_abstract` before messages are prepared. There is no title-only summary
or invented replacement abstract. Supplied abstracts require at least twenty
letter-containing words; title plus abstract cannot exceed 12,000 Unicode code
points. Term clarification works independently of abstract availability.

## Evidence and untrusted text

`build_messages()` puts a fixed policy in the system message and serializes task
input, source text, and learner context in a separate user JSON message. Embedded
role labels and instructions remain data. No provider request is made by any
contract helper. This boundary reduces prompt-injection risk; it does not prove
that a model will obey the policy.

Paper explanations and hints require matching excerpts, at most ninety words
and 800 code points of generated text, and at most 600 code points per excerpt.
A null excerpt requires the exact text `Not stated in the abstract.`; that text
cannot be paired with a non-null excerpt. New numeric strings absent from the
abstract are rejected. General background definitions and examples are not
represented as paper findings. Source matching does not establish entailment,
scientific correctness, or semantic absence of invented publication claims.

V2 portability rules are explicit and intentionally independent of v1:

| Rule | Python/TypeScript contract |
| --- | --- |
| String length | Unicode code points; use `Array.from(text).length` for custom TypeScript checks |
| Whitespace normalization and word splitting | Only space, tab, LF, CR, form feed, vertical tab |
| Excerpt case normalization | Lowercase ASCII A-Z only; preserve other characters literally |
| Letter-containing source words | At least one Unicode General Category `L` character; TypeScript `/\p{L}/u` |
| Numeric strings | All matches of `[0-9]+(?:[.,][0-9]+)*%?`, without a word-boundary assumption |
| Non-ASCII numeric output | Reject Unicode General Category `N` characters outside ASCII digits in paper claims; TypeScript `/\p{N}/u` |
| Identifiers and fields | Case-sensitive, explicit schema allowlists; no coercion or unknown fields |

Thus v2 does not silently inherit Python's Unicode `casefold()` or `split()`
behavior. Its non-ASCII matching is stricter; v1 retains its existing behavior.
Semantic rules supplement JSON Schema and must also be implemented by a future
Worker. Use a Draft 2020-12 validator with code-point-aware string lengths and
without coercion, defaults, or removal of extra properties. Schemas use local
references only and require no network lookup.

## Errors and offline use

`ContractError` is a `ValueError` with a stable `code`. `as_dict()` returns the v2
error envelope described by `error.schema.json`; it never includes source text,
raw validation exceptions, or provider messages. Contract errors are not
retryable and never trigger fallback or automatic regeneration.

| Code | Meaning |
| --- | --- |
| `unsupported_version` | A supplied contract version is unsupported |
| `unknown_task` | The request task is not registered |
| `invalid_request` | Required request fields, types, bounds, or source length fail |
| `unknown_source` | The reference is absent from the server-owned retrieval context |
| `invalid_source` | The trusted record lacks its required structure or provenance |
| `missing_abstract` | The paper task has no usable abstract |
| `invalid_response` | Output shape, length, task binding, or section IDs fail |
| `invalid_evidence` | Excerpt, missing-information, number, or citation checks fail |
| `source_mismatch` | Response coverage disagrees with application-derived coverage |

For a future adapter: validate the request against a trusted source snapshot,
prepare messages and `output_schema(task_id)`, obtain output, then call
`build_response(request, output, verified_sources=the_same_snapshot)`. This step
implements only validation/message preparation, not the provider call. A Worker
must authenticate the caller and enforce source access before source resolution.

## Shared fixtures and remaining work

`contracts/learning-coach/fixtures/cases.json` is plain JSON with self-contained
cases. Each names an operation (`v1_response`, `v2_request`, or `v2_output`), its
input, optional trusted fixture records, and an optional expected error code.
The retrieval fixture is synthetic and is not a claim about an actual paper.
Cases cover v1, one/six-section responses, distinct task structures, missing
sources, invalid versions/tasks, fabricated evidence, injected metadata, and
ASCII/Unicode behavior. A future TypeScript test runner should consume the same
file and compare its outcomes with Python before any runtime switch.

`jsonschema==4.26.0` is now a direct requirement because this module imports it.
It was already installed through Streamlit's Altair dependency. No packages were
installed during this step.

Worker authentication, provider adapters for v2, D1 reservations and caching,
adaptive consumption-based limits, privacy/access policy, account Free-plan
verification, live model compatibility checks, and deployment remain later
stages. The next step is an offline Worker prototype using these schemas and
fixtures, with mocked inference and authenticated request handling. Keep the
existing v1 UI until that path is proven.
