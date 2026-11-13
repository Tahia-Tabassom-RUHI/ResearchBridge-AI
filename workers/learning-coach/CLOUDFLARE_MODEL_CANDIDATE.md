# Cloudflare model candidate review

Preferred candidate: `@cf/google/gemma-4-26b-a4b-it`. Production inference remains
disabled; the catalog is not an account eligibility receipt or a transport.
No environment enable switch, live adapter or account policy is added.

## Documented compatibility (reviewed 2026-11-13)

Cloudflare's [model reference](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)
documents prompt or role/content messages, a 256,000-token context, and binding
and native REST access. Prefer `max_completion_tokens`; `max_tokens` is deprecated.
The schema lists `response_format`, `chat_template_kwargs`, `temperature` (0–2),
`top_p`, `stop`, and `stream`. Listing an option does not verify its behavior on
this account. Do not carry over Qwen's `/no_think` instruction or assume an
undocumented reasoning toggle works for Gemma.

The synchronous schema describes `choices` and `usage`, rather than assuming
Qwen's `response` field. Synthetic binding and native REST fixtures exercise the
existing token-usage parser; native REST still requires its success/result
envelope. The OpenAI-compatible endpoint is a separate transport and must not be
attested as native Workers AI HTTP. No content extraction adapter is enabled.

The [JSON mode guide](https://developers.cloudflare.com/workers-ai/features/json-mode/)
describes `response_format` with `json_object`/`json_schema`, warns of schema
failures, and does not list Gemma in its supported-model list. Gemma's parameter
listing alone does not establish working structured JSON. Before enabling any
transport, verify the actual response format and schema dialect, completion
limits (including reasoning), truncation behavior and usage reporting with V1/V2
fixtures. Continue applying the existing application validators, source grounding
and safety checks to every output. Streaming remains outside this review.

## Cost and accounting

The [pricing table](https://developers.cloudflare.com/workers-ai/platform/pricing/)
lists $0.10 per million input tokens and $0.30 per million output tokens;
9,091 input and 27,273 output neurons per million tokens. These are model rates,
not measured usage or permission to incur charges. Synthetic candidate policies
test the existing upward-rounded rational reservation calculation. They are not
deployable account verification. No runtime reservation estimate or historical
Qwen conversion is rewritten.

Cloudflare windows remain account scoped (`model = ''`), with unchanged identities,
limits, margins, counters and UTC reset boundaries. Holds and pending evidence
retain their existing allocation-wide effects. Existing receipts pin the model:
provisioning Gemma over a Qwen receipt fails closed. Do not rename the scope or
create a second allocation to bypass that refusal. An eventual operational
cutover needs a separately reviewed policy transition that preserves all shared
counters, restrictions, revocations and historical obligations.

Historical Qwen policies retain their original review/deprecation boundary;
Gemma does not inherit that date. Qwen revocation and evidence recovery remain
recognized, including after expiry. No migrations or stored records change.

## Remaining verification before activation

Verify actual free-account eligibility and complete account-wide quota inventory,
usage and reasoning-token semantics, conservative input/output bounds and
structured JSON compatibility. Supply explicitly reviewed account policy evidence
and a finite review horizon. Public documentation and synthetic tests do not
satisfy these account checks. Production stays closed until that separate review.
