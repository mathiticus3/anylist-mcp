# Dedicated Gina canary READ-ONLY provider client

Follow-up authorization2026-09-20: provision a separate `gina-canary-harness` confidential client and qualify READ identity only. ZERO AnyList data mutations. Gina owns the adapter, independent qualification and later canary decision/execution. This client does not authorize a canary add or cleanup.

## Effective permissions and gap

Profile `gina_canary_readonly`, source `gina/action-harness-readonly`. Only tool `shopping`, actions `list_lists` and `list_items`. Both require literal `list_id=297966c79aa64357a5f765bb2214470c` (existing MCP Category Test). List discovery is filtered to that same list; no account-wide list inventory escapes. Optional `response_format` accepts only `structured`; include_checked/include_notes accept only true and default true. Missing/wrong list IDs are rejected before provider reads. No name-based targeting, paging, recipes, service refresh, experiments or mutation tools.

Success preserves the canonical structured list/items fields plus:

```json
{"provider":{"profile":"gina_canary_readonly","allowedListId":"297966c79aa64357a5f765bb2214470c","readOnly":true,"mutationsEnabled":false},"freshReadAt":"<ISO timestamp>","complete":true}
```

Each read executes a fresh authenticated user-data request and includes every returned target-list item (checked and unchecked) and notes. complete means no local truncation/filtering; no provider revision, linearizability or eventual-consistency guarantee is invented. Existing item notes can be absent when empty. Stable core source semantics remain unchanged.

**Enforcement gap explicitly closed by withholding writes:** the existing MCP/OAuth architecture does not enforce exactly one separately approved add and a separately approved cleanup tied to its created ID. Generic add is an upsert. Therefore this dedicated profile receives NO writes. A future narrow mutation protocol/profile needs separate authorization, design and qualification; no unrestricted replacement is granted. Existing Gina, GPT, kiosk and punchlist identities are unchanged and must not be borrowed.

## Supported registration, authentication and delivery

Use the existing confidential-client DB registration and client_credentials grant; no auth redesign or new database columns. `createConfidentialClient` now optionally accepts profile/source, retaining full-profile defaults for existing callers.

```sh
docker exec anylist-mcp node scripts/provision-canary-client.js --provision
docker exec anylist-mcp node scripts/provision-canary-client.js --status
```

Provisioning selects the sole configured owner, refuses conflicting/duplicate registrations/files, writes the private file mode600, and is idempotent when registration and credential match. Only sanitized metadata is printed, including SHA256(client_id) for independent binding comparison without exposing the identifier. It never logs the client secret, bearer, AnyList credentials or full client ID. If multiple accounts are configured, it stops for explicit account selection rather than guessing.

Private source-of-truth file: `/data/.env.gina-canary-harness` inside anylist-mcp on vector72-2, existing persistent volume. Schema (names only):

```text
ANYLIST_TOKEN_URL
ANYLIST_MCP_URL
GINA_CANARY_CLIENT_ID
GINA_CANARY_CLIENT_SECRET
ANYLIST_LIST_ID
```

Approved local delivery: `/Users/matthewmaupin/.config/vector72/credentials/gina-canary-harness.env`, file mode600 in a mode700 directory, transmitted over authenticated SSH directly to a private file. This is a credential store, not a receipt/artifact. Do not print values, pass secrets in argv, commit them, or reuse another client's credentials. An encrypted box-side backup uses the campaign recovery key; ciphertext receipt paths/hashes contain no values.

POST `https://anylist.vector72.io/token` with application/x-www-form-urlencoded fields grant_type=client_credentials, client_id and client_secret, read from the private file in process memory. Use the returned short-lived Bearer at `https://anylist.vector72.io/mcp`; initialize, preserve Mcp-Session-Id, list tools and issue exact read calls. This machine profile cannot bind a browser OAuth callback: /authorize rejects it before any profile update. Unknown profiles fail bearer authorization rather than falling through to full. DCR remains public-PKCE-only and cannot select this profile.

## Revocation and rollback — mandatory order

```sh
docker exec anylist-mcp node scripts/provision-canary-client.js --revoke
```

Deletes only this named dedicated client's OAuth tokens/codes/client row and its box-side private delivery file. Existing tokens/sessions fail on their next authenticated request; in-flight reads may finish. Delete the local private delivery copy too. Reprovisioning after explicit authorization creates a new independent credential. Tests prove revocation using synthetic accounts, not real mutation probes.

**Revoke before ANY rollback to an older runtime.** Historical code treats unknown profiles as full. This release's guarded `deploy_anylist.py rollback` checks the persistent DB through an isolated network-disabled read-only container BEFORE restoring the old image/source, and refuses while any profile other than full/gina exists. The documented supported rollback path is the driver packaged with THIS release, after revocation. Older retained drivers predate the guard and MUST NOT be used while this registration exists. This guard does not prevent an operator from bypassing the supported procedure with raw Docker commands.

Revoke the dedicated client first; then run this release driver's `rollback --candidate <full SHA>`. GPT/ordinary MCP remain intact. No Caddy/Compose/Trilium or existing Gina profile change. Rollback baseline is26392a003c312789c0a531bdd549b992e8bb4441, image sha256:edae35c2d514c161ac2ecbc9fc3efcdbf89ac78dcc35c54854a421df82d94623.

## Qualification boundary

`node scripts/qualify-canary-readonly.js` uses ONLY the newly provisioned dedicated client_credentials grant, initialize, tools/list and two exact shopping/list_items reads. No campaign/internal token minting, reused consumer tokens, add/delete calls or permission-mutation probes. It verifies fixed identity/profile, fresh complete read metadata, canonical IDs and equal observable snapshots, emits only sanitized counts/hash/schema, closes its MCP session and deletes its own temporary grant token.

Synthetic tests cover prohibited calls, conflicting targets, browser callback escalation, idempotent registration, credential permissions and immediate revocation. These tests never authenticate to AnyList. Independent Action Harness read-only qualification is owned by the Gina task. READY_FOR_GINA_READONLY may be true while CANARY_WRITE_ENABLED remains false; no executable canary hash/approval follows from client setup.
