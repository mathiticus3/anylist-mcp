# Vector72 AnyList capability campaign

Owner: [mathiticus3/anylist-mcp](https://github.com/mathiticus3/anylist-mcp). Estate pointer: vector72-io/infra/anylist-mcp/README.md.

## Phase 1 architecture

`src/stable/capabilities.js` is the explicit schema/action registry. `src/stable/client.js` maps those actions onto the pinned client library; `src/stable/tools.js` adds them to existing grouped MCP tools. Existing calls use legacy handlers; `response_format: structured` selects validated machine-readable responses. New actions always use the structured implementation. The existing Gina profile receives no authority expansion. All registered calls share a per-account queue because targetList is mutable state. AnyList remains the only data authority.

`service/status`, `service/capabilities`, and `service/refresh` expose readiness, version coupling, declared capabilities and refresh time without credentials. Structured responses preserve canonical identifiers; duplicate exact names return AMBIGUOUS with candidate IDs/names. Errors distinguish INVALID_INPUT, NOT_FOUND, AMBIGUOUS, CONFLICT, UNSUPPORTED, AUTH_FAILURE and UPSTREAM_FAILURE. A transport failure after a write may be indeterminate; read current state before retrying.

Recipe updates reconstruct the existing library Recipe with only supplied fields replaced. Collection member writes construct a one-member delta: passing every existing member to removeRecipe would remove unrelated memberships. Calendar updates expose only details: fresh cloud reads proved that the pinned save method ignores date/title/link changes. Those fields are deliberately rejected until the client supports them. Recipe website fetches allow public HTTPS only, resolve/pin public IPv4 addresses, validate every redirect, bound response bytes and time, and return normalized recipe fields only.

Bulk add is one bounded MCP call with individual outcomes. The pinned library has no native batch-add method; it still uses sequential library writes. Shopping list create/rename/delete, store create/delete, collection rename, favorite per-set category assignment, meal date/title/link updates, label writes, and arbitrary/internal auth/RPC are intentionally unavailable: no safe implemented library primitive. Uncheck-all is intentionally omitted as an unbounded mutation. See [BASELINE.md](BASELINE.md).

## Deployment and rollback

Production host vector72-2, service anylist-mcp in `/home/deploy/web-caddy`, MCP `https://anylist.vector72.io/mcp`, existing `/health`. Caddy forwards the entire origin; no proxy change or extra service is required. Existing OAuth and confidential consumer credentials remain unchanged. No Trilium service or household data migration.

Use the [guarded release procedure](../production-release.md): clean committed candidate, baseline commit updated only after live verification, online encrypted SQLite backup, immutable release bundle/digest, read-only preflight, isolated candidate smoke and schema rollback test, recreate only anylist-mcp with --no-deps. Previous image/commit are in [BASELINE.md](BASELINE.md). The driver records/tag-preserves exact previous runtime and verifies peer container identities and protected proxy/compose/env fingerprints. Its rollback command restores only AnyList. Never deploy the entire web stack for this campaign.

Run `npm test`, `npm run test:release`, then hosted CI. Run `node scripts/campaign-integration.js` inside the deployed container for disposable authenticated MCP writes and fresh read-backs. The harness borrows the existing punchlist-sync OAuth client identity with a short-lived local bearer, deletes that bearer afterward and prints sanitized receipts only. It creates uniquely prefixed items/favorites/categories/recipes/collections and a 2099-01-01 meal, then sweeps only its own prefix. Run the real punchlist-sync read module separately with its existing client_credentials flow to prove compatibility without writing Trilium.

Source version 1.8.0; pinned anylist-js 0.8.6 / 1d3c9816. Latest upstream has a quantity-text improvement, deliberately not bundled into this release's immutable submodule/rollback contract. Protocol messages and the cloud API are unofficial; successful HTTP is insufficient evidence of persistence. Upgrades require fresh read-back receipts, old OAuth/client regression and cleanup verification.

## Gates

Phase 1 is not complete until live integration, punchlist-sync and hosted CI receipts pass. Phase 2 implementation starts after that gate; Phase 3 starts only after Phase 2's live API parity gate. Current evidence is stored alongside this document as sanitized receipt files.

Phase2 operator/GPT setup: [ACTIONS.md](ACTIONS.md). Exact generated API: [openapi.json](openapi.json). Combined stable MCP/GPT matrix: [CAPABILITIES.md](CAPABILITIES.md). The GPT adapter shares the existing process and calls registered MCP handlers; credentials are separate and independently revocable.
