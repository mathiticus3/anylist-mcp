# Dedicated household writes — code only, inactive

Two new confidential machine profiles are separate from all readers and legacy
clients: `estate_hub_shopping_writer` / `estate-household-shopping-writer` and
`estate_hub_mealplan_writer` / `estate-household-mealplan-writer`. Each exposes
only `shopping_write` or `meal_plan_write`. Authorization-code/callback binding,
legacy tools and cross-profile sessions are refused. Existing credentials gain
no new operations. Account/client/source/policy state is checked at token issue,
bearer admission and each tool boundary; actual upstream account UID is checked
before and after refresh. A dedicated snapshot-only client disables background
listeners, data retries and the native authentication-after-response replay hook.
Authentication is refreshed before any possible write boundary, not by replaying
a data POST. Profiles are not provisioned, deployed or enabled by this change.

## Source policy and custody

Owned private regular files under DATA_DIR:
`estate-hub-shopping-write-policy.json` and
`estate-hub-mealplan-write-policy.json`. Required common fields: schemaVersion1,
clientId and userId UUIDs, upstreamUserId (actual AnyList token subject), enabled,
positive revision, journalId UUID and a nonempty unique exact operations array.
Shopping additionally binds one32hex listId. Meal binds America/Denver,
maxPastDays0–31, maxFutureDays0–366 (combined inclusive window<=366days), and an
exact labelIds array. Existing and new event dates/labels must remain in scope;
unlabeled events are allowed. Proposed commissioning bounds are past7/future93.
Read scope and action names never imply that a source policy is enabled.
Policy digest is SHA256 of recursively key-sorted compact UTF-8 JSON containing
contract/profile/source and the exact policy fields. No secret enters it.

Shopping operations: `shopping.add`, `.check`, `.uncheck`, `.update`, `.remove`.
Add has name1–128 trimmed characters, quantity integer1–99/default1, note<=2000.
Update changes only a nonempty subset of those fields. Other changes use exact
record_id and empty fields. No bulk/name-based upsert, category/store edits,
sort changes or list discovery. Active normalized-name collisions are refused.
Source IDs and per-item list containment are validated before native constructors
can invent IDs or send a field update to an unbound list.

Meal operations: `meal.create`, `.update`, `.delete`. Create takes a real date,
title1–128, details<=2000/defaultempty and optional allowed label_id/defaultnull.
Update accepts a nonempty subset, deletion takes an exact ID and empty fields.
Existing recipe links are retained; this version cannot create/change recipe
links or mutate recipes. Human/native source interfaces remain the owner of
unsupported work. Date bounds are Denver calendar days, including DST changes.
Snapshots are bounded to10000records/1MiB; oversized state fails closed.

## Wire and outcomes

Contract `estate-household-write.v1`. Strict actions:

- inspect: operation and optional exact record_id (required for non-create).
  Returns before and expected_digest. A create inspect has an absence projection
  with a bounded source snapshot digest; inspect with an assigned ID can read back
  a creation. Inspect makes no business mutation.
- apply: operation, UUID change_id, expected_digest64hex, fields and record_id for
  non-create. A create ID is allocated by the source and durably recorded before
  dispatch; callers cannot choose it. Same key/content returns its receipt; changed
  content or policy cannot reuse that key.
- receipt: exact change_id. Returns authorized durable outcome only.
- reconcile: exact change_id. Reads current state and never dispatches.

PREPARED is persisted before preflight. UNKNOWN is persisted before the one-way
network boundary. ACKNOWLEDGED is persisted after the native call resolves.
Only ACK plus independent fresh matching readback gives CONFIRMED. Lost ACK or
crash remains UNKNOWN even if a postcondition is later observed. Failed readback
retains ACKNOWLEDGED and can later confirm through read-only reconciliation.
A PREPARED command can become NOT_DISPATCHED before any network boundary.
Unexpected outer errors say REQUEST_REFUSED or UNKNOWN, never invent a historical
no-effect result. Response text is the exact JSON structuredContent. request_id
is a new request correlation value, not a fabricated source audit/event ID.
Source modification time is unavailable and remains null.

AnyList has no atomic CAS/exactly-once API. The adapter performs a fresh optimistic
precondition check and observes the postcondition; it cannot lock external users.
Responses explicitly report upstream_atomic_cas=false and upstream_exactly_once=false.
Do not describe a matching later state as causal proof after a lost ACK. No
automatic retry, undo or compensating mutation exists. Hub must preserve these
outcomes and independently verify command/receipt identity and readback.

## Durable journal and explicit recovery

Runtime opens only an existing private SQLite file at
DATA_DIR/estate-write-journals/shopping.sqlite3 or meal.sqlite3; directory0700,
file0600, service-owned, no symlinks/hard links. Explicit source-administrator
bootstrap is `node scripts/initialize-household-write-journal.js --kind shopping`
(or meal). It creates only a new journal and prints its non-secret journal UUID;
existing state is never replaced. Pin that UUID in the separately approved policy.
This bootstrap and policy installation require commissioning authorization.
There is no additional encryption-key handoff or credential creation here.

SQLite FULL synchronous WAL and atomic row transitions preserve dispatch state.
A unique client/change key and persistent domain fence prevent two source workers
from dispatching the same command or competing with unresolved commands. At10000
journal rows writes fail closed; no automatic purge/reset/expiry removes replay
history. Back up the journal and its consistent WAL state with source data.
Never restore an older ledger independently while keeping newer business effects
or writable clients; revoke/quiesce affected writers before reviewed recovery.

UNKNOWN/ACKNOWLEDGED fences do not expire. For recovery, stop/quiesce the source
service, independently inspect actual AnyList state and obtain explicit owner
acceptance of that command's outcome or uncertainty. Only then a source admin may
run `scripts/resolve-household-write-journal.js` with --offline-recovery, exact
kind/journal-id/client-id/change-id/expected-command-hash, approval-reference and
reviewed-outcome=effect_observed or uncertainty_accepted. The flag is a trusted
local administrator attestation of quiescence, not a remote lease or proof that
a malicious OS administrator cannot race the service. It is never an MCP action.
It appends immutable operator metadata and releases that exact domain fence.
Original UNKNOWN/ACK outcome, request and replay key remain unchanged; the old
command can never be dispatched again. This recovery step is not blanket
approval to resolve any future uncertainty or to repeat a business mutation.

## Rollout and rollback

After source/Hub code review and exact-head CI, propose one bounded commissioning
packet: separate client identities, exact source policies/UIDs/targets/operations,
journal initialization/backup, dedicated native secret custody, exact Hub bindings
and action grants. Preserve all meal/shopping/recipe readers. Source before Hub,
flags/policies disabled until attestation matches; no real write canary without
specific owner intent. Native/source, service-path and actual Gina acceptance
remain distinct. Existing release tooling still requires a fresh exact baseline
manifest; this document does not authorize using an old release-spec unchanged.

Rollback disables/revokes/removes only the new writer client registrations and
Hub grants before restoring an older source that does not know these profiles.
Keep journals and all source records/effects. Known immutable b570d935 and
c3c099eb rollback baselines preserve their supported read-only identities; unknown
images retain conservative refusal. No DB snapshot rollback over newer effects.

Current authorization is checked against the current HTTP/SSE message bearer,
OAuth registration, local account, exact profile/source and policy after asynchronous
reads and before dispatch/receipt. Deleting/rebinding a client or revoking/expiring
the token stops queued work. Authority lost after a possible effect withholds the
receipt and reports UNKNOWN; it never authorizes a replay. Meal updates preserve
both ordering indices and compare their protected digest on readback.
