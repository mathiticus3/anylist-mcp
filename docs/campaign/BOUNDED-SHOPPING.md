# Separate fixed-target shopping reader and add-only writer

Contract note: this document records deployed bounded-shopping.v1. The source-only v2 active-item correction and migration are specified in [ACTIVE-ITEMS.md](ACTIVE-ITEMS.md); v2 is not deployed.

Status: deployed and both private credentials delivered after owner authorization on2026-09-20. Source209b39c/MCP1.9.4, [PR12](https://github.com/mathiticus3/anylist-mcp/pull/12) merged. Provider live reader qualification passed before enabling add; add discovery made zero tool calls. Gina owns independent qualification and exact-action approval. No household add was performed by this provider task. See latest [deployment receipt](DEPLOYMENT.md) and [sanitized evidence](bounded-shopping-receipt.json). Household target and exact emitted schemas remain private; all existing scopes are unchanged.

## Authority and schema

Two independent confidential clients use the existing client_credentials grant:

| Client | Profile | Sole tool/action | Maximum authority |
| --- | --- | --- | --- |
| gina-bounded-shopping-read | gina_bounded_read | shopping/list_items | Complete fresh snapshot of one selected list, all checked/unchecked items and notes |
| gina-bounded-shopping-add | gina_bounded_add | shopping/add_item | One new item per call on that same list; no other writes |

Both require a literal list_id generated from a private pinned policy, with optional response_format=structured. Reader optionally accepts include_checked/include_notes=true only. Writer requires name1..128 exact trimmed/nonblank without control/format characters, quantity=1. All other fields forbidden, including notes, item ID, category, store, sorting, update/check/delete/bulk. No model notes or server-created marker notes. No list-name/default routing or generic RPC. No separate recipe/service/GPT exposure.

New profiles return before generic tool registration. Browser OAuth binding is prohibited. Auth checks profile/source binding at every MCP request; handlers check policy before client acquisition, after queue wait, after refresh, and immediately before dispatch. Existing profiles never load this file or use the new handlers.

## Private policy and immutable identity binding

Mode0600 regular non-symlink `/data/gina-bounded-shopping.json`, at most4096 bytes, exact schema:

```json
{"schemaVersion":1,"listId":"00000000000000000000000000000000","readerEnabled":false,"addEnabled":false}
```

The zero ID is a synthetic example, not a selected target. The actual selected binding/expected schemas are in the private owner result artifact. Missing/malformed/insecure policy fails closed. Canonical binding SHA256 covers contract version, selected ID,10000-item bound and8MiB result bound. Operational enabled flags are excluded from the digest so each capability can be disabled independently without replacing an identity. Add also requires readerEnabled; disabling read disables writes too.

Each new OAuth client.source pins `gina/bounded-shopping-read:<digest>` or `gina/bounded-shopping-add:<digest>`. Retargeting breaks authentication until explicit reprovision/requalification; existing sessions also compare the original digest and cannot silently rebind. Identity/target/schema/source/policy digests must be frozen in Gina's approvals. Revocation removes only the selected new role. Already in-flight operations may finish after disable/revoke; no distributed cancellation guarantee.

## Read contract and size

One authenticated getLists(true) refresh selects the exact target, maps ALL returned items in provider order and returns structuredContent with itemCount, complete=true, includesChecked=true, includesNotes=true, freshReadAt, provider provenance and snapshotSha256. Item fields: identifier, name, quantity (original type), checked, note (null when empty), category match ID, categoryAssignments, storeIds and manualSortIndex. No page/filter/partial-read switch. Duplicate/missing IDs or malformed identity fail INVALID_SNAPSHOT. No exact provider snapshot revision, linearizability or account synchronization guarantee is invented; freshReadAt is refresh completion and snapshotSha256 hashes the mapped fields/order.

Limits:10000 items and8MiB UTF-8 serialized MCP tool-result JSON. Text content is a short summary; full data exists once in structuredContent, not a second prose/JSON duplicate. Oversize returns RESPONSE_TOO_LARGE, complete=false and NO partial items. JSON-RPC/SSE framing adds a small envelope; the independent client's response cap must accommodate8MiB plus framing (e.g.9MiB), then verify the8MiB tool-result bound. GPT Actions'95000-character projection cap is unrelated; this is direct MCP only.

Synthetic real HTTP/MCP test with2509 mixed checked/unchecked records, exact notes/IDs/quantity/order,512-byte note padding and Unicode returned1,737,561 bytes with complete=true. Handler test also checks2509 records without alteration. Above-byte/count-bound fixtures fail closed, including Unicode byte accounting. This synthetic result is distinct from the later authorized live qualification: two complete2509-item snapshots,921190 result bytes each, equal observable state. The original source preparation fetched no household contents; later owner qualification used the new reader only, with no item contents retained in receipts. The client library still fetches whole-account list data internally; mapping/output bounds cannot bound that upstream allocation.

## Add semantics and limits

Authenticate/refresh/resolve under the shared participating-client lock. First validate a complete bounded snapshot so writes cannot proceed when identity/verification size is already invalid. Collision key: NFKC, trim, collapse whitespace, lowercase. Any checked/unchecked equivalent name refuses CONFLICT. No generic upsert or automatic uncheck/update. createItem(name,quantity1,details empty,checked=false) then one List.addItem invocation. Preflight also rejects the projected post-add snapshot if it would exceed complete-reader bounds. Server-side enrichment/concurrent changes can still affect subsequent size/state.

Result ACKNOWLEDGED includes canonical created ID and requires independent reader verification. Errors before mutation invocation are NOT_DISPATCHED; errors after are UNKNOWN with attemptedItemId only as a candidate, not creation/ownership proof. Missing whole HTTP response may lose this ID. No provider idempotency store, automatic redispatch, compensating delete or cleanup permission. Existing library explicit401 auth-refresh retry remains; generic POST timeout/5xx retries are not enabled. One semantic/library call is not guaranteed one wire request. Timeout15s per underlying request; auth/queue can extend elapsed time, and caller timeout does not cancel in-flight work.

Same-process participating calls serialize; external clients/processes may race between refresh and add. No external CAS/exactly-once guarantee. Harness owns per-action approvals, budget and recovery. If an add-only action needs removal later, it needs a separately authorized owner path; this credential can never delete.

## Setup procedure (completed under owner authorization)

1. Review exact prepared source/tests/PR, selected private target binding and future deployment revision. Approve service-only deployment plus BOTH exact new grants and private delivery destinations explicitly. Policy target selection alone is not setup/write approval.
2. Use guarded release from current b59db0a/MCP1.9.3 baseline after fresh drift/health/backup checks and green CI. Candidate package1.9.4. Preserve six peer services/Caddy/Compose/all existing identities. No source edits solely on production.
3. Install the reviewed private policy only after approval. Enable reader, provision read, perform discovery/read-only qualification. Enable add only under approved grant scope and after the reader qualifies. Neither enable flag is a harness action approval.
4. Supported scripts (run only after setup authorization):

```sh
node scripts/provision-bounded-shopping.js read --provision
node scripts/provision-bounded-shopping.js add --provision
node scripts/provision-bounded-shopping.js read --status
node scripts/provision-bounded-shopping.js add --status
```

Registration is sole-owner/idempotent/conflict-refusing and never prints credentials. Box files `/data/.env.gina-bounded-shopping-read` and `/data/.env.gina-bounded-shopping-add`, mode0600. Both use fields ANYLIST_TOKEN_URL, ANYLIST_MCP_URL, GINA_BOUNDED_CLIENT_ID, GINA_BOUNDED_CLIENT_SECRET, ANYLIST_LIST_ID, ANYLIST_BINDING_SHA256. Same field names, distinct private files/identities. Delivered local private paths `~/.config/vector72/credentials/gina-bounded-shopping-read.env` and `gina-bounded-shopping-add.env`,0600 in0700 directory. Direct delivery approval recorded; no reuse/export of GPT/canary credentials. Encrypted box-side backups before delivery, no values in logs/prompts/artifacts/git.

5. Authenticate only through own client_credentials/token and /mcp initialize/tools-list. Live writer qualification sends NO tools/call or mutation permission probes. New reader then proves full selected-list state fits bounds, correct schema/identity/binding, timestamp and snapshot behavior. Freeze measured exact schema/source/identity/binding in Gina. Any actual add remains separately authorized by the eventual operational/action contract.

## Revoke, disable, rollback

Policy addEnabled=false stops new writer calls; readerEnabled=false stops both profiles. No existing canary change. Independent role revocation, also supported when policy has been deleted/changed:

```sh
node scripts/provision-bounded-shopping.js add --revoke
node scripts/provision-bounded-shopping.js read --revoke
```

Removes only named role's tokens/codes/client row/private box file. Remove its approved delivered private file separately. Do not reuse a stale policy/secret after reprovision.

Revoke BOTH new identities before baseline rollback; disable flags alone do not remove persistent identities. The release driver recognizes exact reviewed b59db0a image label and preserves existing full/gina/canary-read/canary-write clients while refusing any new bounded profiles BEFORE restoration. Unknown older images retain the conservative existing guards. No old-driver/raw-Docker bypass. Existing readonly/writer canary credentials are preserved. A live guard-only check with both new identities present refused before restoration; no actual rollback was run.
