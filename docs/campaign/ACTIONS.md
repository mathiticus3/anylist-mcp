# Vector72 AnyList GPT Actions

The same AnyList MCP process serves an HTTPS projection at `https://anylist.vector72.io/actions/<operationId>`. Each fixed route validates its bounded schema and calls the registered MCP tool handler with structured output. The registered handler invokes the same stable client/library implementation and per-user serialization as ordinary MCP. There is no caller-selected RPC, endpoint or library method. AnyList remains the source of truth.

Owning repo: `mathiticus3/anylist-mcp`. Package 1.9.0 / Actions adapter 1.0.0 / client 0.8.6 at 1d3c9816c4ecfc3b2d8c5c48dd35619b125381c3. punchlist-sync has no upgrade requirement. Its existing OAuth /mcp contract and the restricted Gina profile are unchanged. Production source remains the deployed `fix/make-mcp-interoperability` compatibility line; main predates this deployment lineage.

## Endpoints and boundaries

- `/mcp`: existing OAuth Streamable HTTP endpoint, unchanged.
- `/actions/*`: dedicated Bearer credential, explicit POST operations, 120 requests/minute/IP, 95KB JSON body and 95,000-character response ceiling. Request/response body and credentials are not logged by this router. Body size/response limits can reject oversized household reads; use recipe search/limit/date ranges. Normal list reads return every item, not silent truncation.
- `/openapi.json`: public generated OpenAPI 3.1, 30 operationIds covering all 40 stable actions. Useful related actions share an explicit enum mode; see CAPABILITIES.md. No arbitrary RPC projection.
- `/healthz`: public process liveness only, no household data.
- `/readyz`: authenticated fresh AnyList synchronization/readiness. `getServiceStatus` is the equivalent GPT operation.
- `/privacy`: public owner-only integration privacy disclosure.

OpenAI Actions requires HTTPS and has a 45s request limit and 100,000-character request/response limit. The adapter stays below the size ceiling. Each underlying AnyList request has a 15s timeout, but multiple requests/queue waits may exceed 45s. There is no automatic action retry or transactional rollback. A lost response can mean an applied or partially applied write: refresh/read and reconcile before any new action. Do not retry mutations blindly. The upstream library may refresh/retry an explicit 401. Existing POST requests do not use got's generic timeout/5xx retry mechanism.

Add-item is an upsert of a unique case-insensitive exact name, not create-only. Deletes select explicit IDs/names; ambiguous names return 409 and candidates. For exact cleanup always use the returned ID and refresh afterwards. Store/list/category/item names resolve through the shared MCP layer. Recipe updates preserve unspecified fields. Meal updates persist details only: moving a meal requires explicit create/delete composition with acknowledgement of its nontransactional nature. No hidden household routing policy is embedded.

Sources: [Actions authentication](https://developers.openai.com/api/docs/actions/authentication), [Actions production requirements](https://developers.openai.com/api/docs/actions/production). The existing Vector72 Trilium generator provides the estate's 30-operation projection precedent; no Trilium code or deployment was changed.

## Dedicated credential

The GPT credential is separate from AnyList passwords and all MCP OAuth credentials. A mode-600 `/data/gpt-actions.json` contains its SHA256 verifier, the sole configured owner's user ID and enabled flag. The raw secret lives only in mode-600 `/data/.env.gpt-actions`, variable `ANYLIST_GPT_ACTIONS_KEY`, in the existing `web-caddy_anylist-mcp-data` volume. This follows the approved box-side .env secret mechanism. No runtime env/Compose/Caddy change or new service is required. The verifier is re-read on each request; missing/malformed/disabled/world-readable configuration fails closed. The key never enters repository artifacts.

Provision once on vector72-2:

```sh
docker exec anylist-mcp node scripts/create-gpt-key.js
```

That command prints only file paths. `--rotate` replaces the key and verifier; `--revoke` disables immediately without restarting MCP or changing AnyList credentials. Both commands require host access. This does not provision or broaden a Gina credential. Read `/data/.env.gpt-actions` only locally as the owner; do not paste it into chat or git. It is not currently mirrored to Infisical; source of truth is the box-side .env, backed by the existing persistent volume. Include it in the normal encrypted volume backup after provisioning.

## Private GPT editor

1. ChatGPT → Explore GPTs → Create → Configure. Name: **Vector72 AnyList**.
2. Instructions: use the concise block below. Keep visibility **Only me**.
3. Actions → Create new action → Import from URL: `https://anylist.vector72.io/openapi.json`.
4. Authentication → **API Key** → **Bearer**. Paste `ANYLIST_GPT_ACTIONS_KEY` from the box-side secret file. Header sent by ChatGPT: `Authorization: Bearer <key>`. No OAuth/callback URL.
5. Privacy policy URL: `https://anylist.vector72.io/privacy`. Save/update the GPT, test getServiceStatus then listShoppingLists.

Owner-only local clipboard retrieval on macOS (prints no credential to terminal):

```sh
ssh vector72-web 'docker exec anylist-mcp sh -c '\''sed -n "s/^ANYLIST_GPT_ACTIONS_KEY=//p" /data/.env.gpt-actions'\''' | pbcopy
```

Suggested GPT instructions:

> Use Actions for current AnyList state. AnyList is authoritative. Resolve human names using discovery and preserve canonical IDs. Ask the user to choose if a response is ambiguous. Item add can update/uncheck an existing same-name item. Bulk add reports individual outcomes; never retry successful entries. Preserve unspecified fields. After uncertain writes or timeouts, read and reconcile; never blindly repeat. Delete only explicit selected resources. Meal updates support details only. Compose recipe ingredients into a bounded shopping-items request when asked. Do not invent unsupported list/store CRUD or collection rename operations. Keep household-specific list routing in these GPT instructions, not the backend.

The GPT editor import/publish smoke is an owner-account UI acceptance step. HTTP/OpenAPI acceptance does not prove a private GPT was created. Ordinary writes are marked nonconsequential so the owner can choose always-allow; destructive operations and mixed category CRUD retain ChatGPT confirmation. No additional server-side approval ceremony is introduced.

## Upgrade and rollback

Run `npm ci`, `npm test`, `npm run test:release`, `node scripts/generate-actions-docs.js`; validate committed OpenAPI. Change capabilities and projection together; response schemas are checked over actual local HTTP. CI tests Node20/24/26. Run `CAMPAIGN_ACTIONS=1 CAMPAIGN_BASE_URL=https://anylist.vector72.io node scripts/campaign-integration.js` inside the deployed container for the real disposable HTTPS gate. It uses the dedicated key internally and creates/deletes one temporary MCP bearer for regression verification, never prints either.

Before release, diff live/repo config and set the release-spec expected baseline to the actual commit. Build a clean committed release using `infra/production/build_release.py`, then use the guarded driver. It verifies peers, source, image, mounts, env hashes and compatibility before recreating only anylist-mcp. Retain prior image/commit and encrypted database/config checkpoint. Roll back with `deploy_anylist.py rollback --candidate <full candidate SHA>` from that release directory. Caddy/Compose unchanged, so no proxy rollback is needed. Revoke GPT access independently if desired; rolling back the adapter leaves existing /mcp intact. Client submodule remains pinned; any future client update requires the same full gates. Unofficial AnyList API behavior can change without notice; qualify with fresh cloud readback rather than trusting HTTP2xx.
