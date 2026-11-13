# Manually invoked retention cleanup (F04-B)

`D1RetentionCleanup` is an internal service, absent from all HTTP routes and
schedulers. `authenticate(request, env, config)` requires a dedicated 64-hex
`COACH_CLEANUP_SECRET` distinct from generation and evidence-recovery secrets.
Browser headers and public HTTP origins are rejected. Runtime-private authority
prevents constructing a cleanup service from a claimed role or identifier.

Calling `run(cursor?)` is disabled when configuration is omitted or disabled.
Enabling requires `enabled: true`, `approved: true`, a nonempty
`approvalReference`, and the complete F04-A retention policy with its separate
`decisionReference`, `auditSeconds`, `providerCorrectionSeconds`, and
`receiptSeconds`. There are no production defaults or automatic approvals.
Operators must explicitly approve those horizons and any intentional zero
values. Credentials/configuration remain in trusted composition, never in a
student request. This change does not configure a production cleanup service.

Migration 0015 adds only a service/retention-time/claim-ID index. A configured
batch size from 1 through 5 bounds the number of inspected request graphs, not
just successful deletions. Keyset cursors allow progress past retained records;
new scans discover later additions before an existing cursor. One extra row
indicates continuation. Missing schema, authority, approval, policy, or D1 access
cannot authorize deletion. Results contain per-table confirmed deletion counts,
aggregate skip reason codes, a cursor, and an uncertainty flag, without private
content, fingerprint hashes, owner capabilities, or raw database errors.

Cleanup reuses F04-A eligibility including receipt hash reconstruction. It
captures every assessment/graph SELECT, including empty results and ownership,
accounting, replay barriers, quota dependencies, and active restriction checks.
Each complete result is compared again inside the same D1 transaction that
performs deletion. Shared snapshot guards also protect F02 resolution. Clock
checks before and after deletion enforce the approved eligibility deadline and
reject clock rollback. Generation and exact affected-row assertions provide
additional conditional fencing; any mismatch aborts and rolls back the graph.
Earlier read-only eligibility is never a deletion authorization.

For an eligible graph, deletion order is usage, quota links, attempt, idempotency
claim, then reservation. Foreign keys stay enabled. Ordinary finalized accounting
receipts can leave only with their complete eligible history after every
approved horizon. Unknown outcomes, partial accounting, pending evidence,
legacy history, active owners/holds, recovery operations, and required F02/hold
receipts remain retained under F04-A. Barriers, quota windows, policies, provider
holds/operations, revocations and evidence-resolution receipts are never targets.
No quota counters, provider restrictions, or replay authorities are reset.

Each graph commits independently, so a later failed graph does not undo prior
confirmed work. Concurrent changes skip a graph when proof revalidation fails;
concurrent cleanups cannot both delete it. An ambiguous acknowledgment stops
the run and sets `uncertain`; that graph contributes no confirmed deletion count.
An explicit later call may inspect the remaining history, but cannot infer how
many records an earlier uncertain run removed. Repeating cleanup is safe and
cannot reopen a deleted UUID: F04-A's permanent barrier still rejects it.

The five-graph cap permits at most 31 D1 binding calls in a normal run. SQL
statement count, row scans, foreign-key/index checks and billable row writes
are larger than binding-call counts. A graph may contain 32 quota links.
Deletion and index maintenance consume D1 writes; proof comparisons consume
reads and Worker CPU. These are design bounds, not production measurements.
Use smaller batches, review skip counts, and measure account consumption before
any separately authorized production use. No entire database sweep, automatic
retry, scheduler, live inference, remote migration or deployment is added.

Permanent UUID barriers still grow one row per accepted key. Bounding that
ledger requires a future issuance/replay protocol decision. Legacy history,
retained authorities and required receipts can also grow; this service makes
no claim to bound total storage.
