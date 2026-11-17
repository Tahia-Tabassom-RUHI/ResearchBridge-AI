# Durable provider policy revocation

Migration 0012 adds a terminal barrier per trusted account allocation and
provider. `D1PolicyRevocation.revoke` is an internal administrative service;
there is no HTTP route or browser-controlled configuration for it. Supply the
exact persisted policy version and expected revocation generation (initially
zero). D1 conditionally writes the next generation. Stale versions/generations
conflict; uncertain acknowledgments return unavailable without removing a
possibly committed barrier. Repeating a stale write cannot undo revocation.

Disabling an instance's configuration still disables that instance only. To
disable the allocation across instances, explicitly publish revocation through
this service. Revocation does not depend on valid/unexpired eligibility or
available quota, and must be durably acknowledged before claiming it succeeded.

Database triggers reject new admissions, policy publication, and the reserved
to sent transition after revocation. They execute inside the existing D1 batch,
so rejection rolls back its fencing and lifecycle writes. This also protects
against older Worker code using the same migrated database. Revocation records
cannot be deleted or moved, and generation updates must advance exactly once.
No re-enable operation exists; future reauthorization requires separate review
and must preserve this barrier and all accounting history.

Ordinary policy updates retain existing behavior: admission requires the current
receipt, arming checks that receipt, and work already armed may dispatch under
its prior policy. Explicit revocation overrides that grandfathering for every
dispatch transaction committed afterward, including earlier admissions/arms.
D1 serializes concurrent dispatch and revocation: a dispatch committed first
may proceed and finish accounting; revocation committed first blocks dispatch.
There is no transaction spanning D1 and external inference and no cancellation
guarantee for already committed dispatch. Unknown acknowledgments never grant
invocation authority. Quotas, holds, settlement, and completed replay remain
intact. Blocked pending evidence retains its existing conservative behavior;
its recovery is outside F01. Production inference remains disabled.
