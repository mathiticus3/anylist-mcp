# Vector72 AnyList campaign handback

2026-09-20 campaign handback. **Current follow-up:** MCP1.9.5/3dd4147d deployed with active-only collision semantics; separate fixed-target reader and add-only credentials privately delivered after direct authorization. Provider complete-reader and add-discovery gates pass; Gina owns independent qualification and actual action execution. See [ACTIVE-ITEMS.md](ACTIVE-ITEMS.md) and latest [DEPLOYMENT.md](DEPLOYMENT.md). Earlier canary identities remain unchanged. AnyList remains the source of truth; no Trilium/mcp.vector72.io/Caddy/Compose runtime changes or household migration.

| Phase | Result | Delivered / remaining |
|---|---|---|
| Discovery | COMPLETE | Live versions, consumer inventory, schemas, health, source/library gaps and rollback recorded before changes. |
| 1: client parity | COMPLETE for qualified client capabilities |40 bounded stable actions, typed errors/canonical IDs, compatible legacy defaults, preservation-safe recipe updates, favorites and membership support, repaired category delete. Explicit unsupported/unsafe gaps remain documented, not advertised. |
| 2: GPT Actions | COMPLETE deployed API; owner confirmed GPT works |30 semantic operations cover40 stable actions; dedicated revocable bearer; HTTPS OpenAPI3.1/health/readiness/privacy; actual public read/write gate passed. Owner confirmed meal-calendar functionality works. |
| 3: selective expansion | COMPLETE bounded scope |Current store-price and folder reads implemented/tested/deployed, individually disabled by default, no GPT exposure. Historical pricing/barcode blocked by endpoint evidence; remaining candidates deferred or verified-read-only/not implemented. |

## Versions and receipts

- Client0.8.6 / `1d3c9816c4ecfc3b2d8c5c48dd35619b125381c3` unchanged.
- MCP1.9.5; GPT adapter1.0.0; deployed runtime `3dd4147d2b1bdf729f629b05224878c50c471aff`.
- Current image `sha256:0d359b33632e3de2776ce581fa5e204f98638958f30fdffc1af7b5ce3c978492`.
- Host vector72-2, service anylist-mcp, source `/home/deploy/web-caddy/anylist-upstream`.
- [Phase1 PR5](https://github.com/mathiticus3/anylist-mcp/pull/5): codex/anylist-stable-parity; runtime972b019, accepted test/docsff40cfb; merged into fix/make-mcp-interoperability.
- [Phase2 PR6](https://github.com/mathiticus3/anylist-mcp/pull/6): codex/anylist-gpt-actions; runtime7289282, receiptb677aeb; merged into the same production lineage.
- [Phase3 PR7](https://github.com/mathiticus3/anylist-mcp/pull/7): codex/anylist-experimental-reads; runtime26392a0 plus final documentation receipts; merge status is visible on the PR.
- [Estate PR368](https://github.com/mathiticus3/vector72-io/pull/368): codex/anylist-campaign-runbook; ed750c2; merged to main. Docs only, no estate runtime deployment.
- The fork's default main is historically behind production. Deployment deliberately follows its established compatibility branch, not stale main. Exact candidate commits are built/verified before service-only rollout.

## Capability matrices and limitations

- Final [client/library → MCP](LIBRARY-PARITY.md).
- Final [MCP → GPT Actions](CAPABILITIES.md), all40 stable actions mapped to30 operations. Legacy health_check is represented by getServiceStatus; recipe search by listRecipes.search; store assignment by updateShoppingItem.
- Final [experimental candidates/evidence/defaults/next experiments](EXPERIMENTAL.md).
- Shopping-list/store CRUD, collection rename, arbitrary text quantities and meal updates beyond details are not qualified in the pinned client. A meal move can be composed as explicit create/delete but is not atomic. No generic destructive bulk/RPC/export-token endpoint.

## Regression proof

Current source165 Node tests;22 release-driver tests; CI green on20/24/26. Phase1 actual MCP67 calls and Phase2 public HTTPS78 checks passed. Live receipt JSON and CI links: [DEPLOYMENT.md](DEPLOYMENT.md). Legacy MCP and restricted-profile unit regressions pass. Actual unchanged punchlist-sync authenticated structured reads passed at every release (final93 items, writes0); timer active, last exit0. Disposable prefix cleanup and fresh absence checks passed; no ordinary household records were unnecessarily changed. Experimental qualification made0 provider writes and left flags absent. All acceptance OAuth tokens were deleted. Six peer services and protected config state were verified unchanged by the deployment driver.

## Private GPT setup

Name **Vector72 AnyList**. Schema [https://anylist.vector72.io/openapi.json](https://anylist.vector72.io/openapi.json). Authentication **API Key → Bearer**, sending `Authorization: Bearer <dedicated key>`. Privacy [https://anylist.vector72.io/privacy](https://anylist.vector72.io/privacy). No OAuth or callback URL. Secret name `ANYLIST_GPT_ACTIONS_KEY`, box-side `/data/.env.gpt-actions` inside anylist-mcp's persistent volume; verifier `/data/gpt-actions.json`. No secret values in this handback. Independently revoke/rotate through scripts/create-gpt-key.js.

Shortest path: ChatGPT → Explore GPTs → Create → Configure → name above → Actions/Create new action → Import from URL above → Authentication/API Key/Bearer → paste owner-retrieved key → privacy URL above → save **Only me** → test getServiceStatus and listShoppingLists. [ACTIONS.md](ACTIONS.md) gives the exact local clipboard command and suggested instructions. The owner subsequently confirmed GPT meal-calendar functionality works; this agent did not perform the private editor UI steps.

## Health and rollback

[MCP](https://anylist.vector72.io/mcp) keeps OAuth; unauthenticated401 expected. [healthz](https://anylist.vector72.io/healthz) public liveness; /readyz requires GPT bearer and checks fresh AnyList readiness. /actions paths use that separate bearer.

**Current rollback:** revoke both separate bounded-shopping clients with `docker exec anylist-mcp node scripts/provision-bounded-shopping.js read --revoke` and the equivalent `add --revoke`; remove their local private copies. Then use `/home/deploy/anylist-release-3dd4147d/deploy_anylist.py rollback --candidate 3dd4147d2b1bdf729f629b05224878c50c471aff`. This driver preserves the existing canary profiles and refuses restore while either new bounded identity remains. Baseline209b39c/image0e56f3da retained. Do not use older drivers or revoke unrelated identities. Experiments need only flag removal, already the default. See latest DEPLOYMENT.md for verified encrypted backups and checkpoints; keys remain box-side. No proxy rollback needed.

The Gina coordination artifact records separate provider and harness evidence. Original exact add/read/remove/read canary was independently executed and accepted by Gina under its own explicit action approvals; this provider task did not perform it. Both later household reader/add-only credentials are delivered. Provider readiness never substitutes for Gina's independent qualification or exact-action authorization; no household add was performed during the new setup.
