# Dedicated bounded Gina canary writer

Owner authorization2026-09-20 permits separate writer client setup, deployment, discovery and synthetic tests only. ZERO live AnyList mutations or mutation permission probes. Gina owns the disabled journaled remote executor, exact-action hash approval and separately approved cleanup. The AnyList provider owner owns this profile, registration and deployment. This setup is not an executable canary approval. Do not attach this client to a general model tool surface.

## Independent identity and maximum grant

Client `gina-canary-harness-write`, profile `gina_canary_write`, source `gina/action-harness-write`. Existing readonly verifier `gina-canary-harness` / `gina_canary_readonly` and existing Gina/consumer registrations are unchanged. Only tool `shopping`, actions `add_item` and `delete_item`. Both require literal list_id `297966c79aa64357a5f765bb2214470c` (existing MCP Category Test). No read, bulk, update, check, category, favorites, recipes, service or experiment tool. The independent readonly client remains the readback channel.

| Action | Required fields | Optional fields |
| --- | --- | --- |
| add_item | action, literal list_id, name, quantity=1 | notes, response_format=structured |
| delete_item | action, literal list_id, item_id, expected_name | response_format=structured |

Names1..128 characters, exact trimmed nonblank strings without control characters. Notes<=256. Item ID32 lowercase hex characters. Action-specific extra fields are forbidden by a discriminated union before client acquisition; no name-only deletion or caller-supplied creation ID. The advertised MCP object schema bounds all fields and describes conditional requirements; the handler enforces the full action-specific union. Frozen schemas are exported from src/profiles/canary-write-shopping.js.

## Provider semantics and limits

Every valid operation acquires the shared per-account client lock, authenticates and refreshes getLists(true), then selects only the fixed canonical list ID. Missing/ambiguous lists fail. Add rejects ANY existing trimmed/case-insensitive equal name, including checked items. It uses createItem with quantity1/details/checked=false followed by one library List.addItem; it never calls the stable full-profile upsert, Item.save, category/store/check operations. A fresh locally generated canonical item identifier is returned after acknowledgment. Synthetic contract tests decode the pinned library's protobuf and verify one add-shopping-list-item operation with correct quantity, notes and ID.

Delete requires a unique exact item_id in that freshly loaded list AND case-sensitive exact expected_name, then calls List.removeItem once. No name fallback, cross-list selection or bulk deletion. Exact-name precondition is checked locally; AnyList has no verified CAS primitive, so a concurrent external rename/change between read and write remains possible. The provider does not prove that the item belongs to a previously approved add: Gina's durable journal and separate exact cleanup approval own that provenance restriction. Possession of this credential grants both bounded operations on the fixed test list; it does not bind an approval hash or single-use quota.

The shared lock only serializes operations using this process's shared client, not other AnyList apps/processes. Add rejects observed collisions but cannot prevent a same-name external creation race. No linearizability, transactional absence, exactly-once or cross-process exclusivity claim.

Success returns structuredContent ok/action/listId, canonical item (add) or identifier/name/deleted (delete), provider profile/allowedListId/readOnly=false/boundedWriter=true/mutationsEnabled=true/executionApprovalIncluded=false, dispatchAttempted=true, outcome=ACKNOWLEDGED and independentReadRequired=true. ACKNOWLEDGED is not independent state verification.

Failure before library mutation invocation reports NOT_DISPATCHED/dispatchAttempted=false. Failure after invocation reports UNKNOWN/dispatchAttempted=true, independentReadRequired=true and attemptedItemId when available. attemptedItemId is a candidate identity, never proof that creation occurred or permission to clean it up. If the HTTP response is lost entirely, the caller may not receive this ID. Errors are sanitized and typed; never infer absence from an error. No automatic action retry or provider idempotency store. Generic POST timeout/5xx retry is disabled in the library, but the existing explicit401 authentication-refresh retry remains; a library invocation is not a guaranteed single wire attempt. Underlying request timeout15s; auth/queue may take longer. Caller timeout does not cancel already dispatched work. UNKNOWN requires read-only reconciliation and operator handling, never automatic redispatch.

## Registration, delivery and qualification

Supported box-side commands in anylist-mcp:

```sh
node scripts/provision-canary-writer.js --provision
node scripts/provision-canary-writer.js --status
node scripts/qualify-canary-writer-discovery.js
```

Provision exactly once; repeated provision validates existing identity/secret and returns created=false. Sole configured owner required, conflicts fail closed. Separate private file `/data/.env.gina-canary-harness-write`, mode0600, existing approved persistent-volume env secret mechanism. Keys:

```text
ANYLIST_TOKEN_URL
ANYLIST_MCP_URL
GINA_CANARY_WRITE_CLIENT_ID
GINA_CANARY_WRITE_CLIENT_SECRET
ANYLIST_LIST_ID
```

Proposed supported private delivery `/Users/matthewmaupin/.config/vector72/credentials/gina-canary-harness-write.env`, mode0600 in mode0700 directory. Follow actual approval review for THIS credential/destination; earlier readonly export consent alone is not a new writer export grant. No values in argv/logs/prompts/receipts/git; authenticated SSH direct-to-private-file delivery only. Box-side encrypted backup with the existing campaign recovery key, no plaintext artifact. Client-ID SHA256 is the independent identity receipt.

Grant client_credentials at https://anylist.vector72.io/token (form fields grant_type/client_id/client_secret read privately in process); MCP https://anylist.vector72.io/mcp, initialize and preserve Mcp-Session-Id. No browser callback binding/DCR profile selection. Bearer auth recognizes only explicitly supported profiles and redacts this client's identity in logs. Revocation checked per request; already in-flight calls may finish.

Discovery qualifier structurally contains no tools/call request: own grant, initialize, tools/list, exact schema comparison, close session/delete its own temporary grant. Never invoke add/delete, even with an invalid argument, as a production permission probe. Live mutation semantics remain UNQUALIFIED until Gina's future separately approved canary. Source tests cover valid simulated mutations and fail-closed paths without AnyList access.

## Revocation and rollback

```sh
docker exec anylist-mcp node scripts/provision-canary-writer.js --revoke
```

Removes only named writer registration, tokens/codes and box private file. Remove any delivered private writer copies separately. Readonly verifier and existing Gina remain intact. Reprovision only when explicitly authorized.

Before rollback, revoke the writer and use THIS release's guarded deploy_anylist.py rollback with its exact candidate commit. Reviewed rollback baseline f085f2d29317fdc658be0b9a98a0dfead176d44d / image sha256:b91d0cc271223425c5a5f97160c19ca39474f13c8eba72e46b0deea9d1b8d257 understands the readonly profile. The guard recognizes this exact release image label, permits existing full/gina/readonly registrations, and refuses writer/other profiles BEFORE image/source restore. Thus rolling back only this writer change preserves the readonly verifier. Other unknown historical images retain the conservative full/gina-only guard and require revoking all custom identities, because older code could broaden unknown profiles. Do not use raw Docker or older drivers to bypass the guard. No Caddy/Compose/Trilium/household data changes accompany deployment.
