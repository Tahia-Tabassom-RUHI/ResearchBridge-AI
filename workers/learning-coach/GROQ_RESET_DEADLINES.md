# Groq observed reset deadlines

Groq request headers describe RPD and token headers describe TPM. Reset values
are relative durations received through the trusted `groq_http` execution
context. `2m59.56s` yields an observed deadline 180 seconds after receipt and
`7.66s` yields 8 seconds after receipt, rounding upward to whole seconds.
Retry-After is independent evidence and retains its separate validation/hold.

These deadlines do not describe or modify ResearchBridge's configured quota
windows. Provisioning, quota identities, safety margins, reservations and usage
accounting remain unchanged. Scope, model, policy, units, documented header
dimensions, capacity bounds, context freshness and transport provenance still
must validate. Waits beyond seven days or invalid/overflowing durations fail
closed. The bound is a parser resource limit, not an invented provider reset.

A zero remaining count may create a verified RPD/TPM dimension hold until the
observed deadline. It is not tied to a local window ID, so local rollover cannot
erase it. Missing resets keep an indefinite hold; positive/unknown remaining
counts never mint local capacity. Existing hold updates preserve the maximum
deadline and stronger confidence, including indefinite restrictions. Expiring
a hold only removes that restriction: admission must still satisfy every local
quota, other hold, pending-evidence barrier, and F01 revocation check.

Unsafe evidence retains explicit parser/adaptation reasons: `invalid_reset`
requires checking duration format, timestamp and range; `unsupported_dimension`
requires checking the account's verified quota inventory; `capacity_above_policy`
requires policy/account review, not automatic capacity increases. Contradictory
headers and stale observations remain rejected. The gateway retains pending
evidence when restrictions cannot be safely interpreted or persisted. F02's
separate authorized recovery and evidence requirements remain in effect.

Before live integration, verify actual account/model free eligibility, complete
quota inventory, rolling/refill behavior and observed reset meanings. Local
fixed buckets remain conservative application limits; synthetic fixtures do
not establish their adequacy for a live provider's rolling limits. Validate
complete token/output bounds, usage accounting and real transport behavior
under separate authorization. No provider call or production inference is
enabled by this change.
