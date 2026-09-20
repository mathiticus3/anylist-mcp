# Deployment receipt — Phase 1 candidate

2026-09-20: deployed committed `e3b7e6f4cd92105d0581cdceeb6cdd17d65a5421` with the guarded production release driver. Driver reports deployment verified. Six peer services unchanged; protected Caddy/compose/environment/volume checks passed. Preflight source was clean `201e1faf2edcffe178031b84ce7f032d9c335215`.

Encrypted online SQLite/config backup: `/home/deploy/web-caddy/backups/anylist-campaign-20260920/pre-phase1.tar.gz.enc`, SHA256 `f0648356c9bc46a1baec6418c2fb418507bad6d2503afc80616b9d727d8d3321`; recovery key is a separate mode-600 box-side file in that directory. Backup decrypt/list verification passed; no secret entered an artifact or commit.

Rollback checkpoint: `/home/deploy/.local/state/anylist-mcp/releases/e3b7e6f4cd92105d0581cdceeb6cdd17d65a5421`. Driver: `/home/deploy/anylist-release-e3b7e6f/deploy_anylist.py rollback --candidate e3b7e6f4cd92105d0581cdceeb6cdd17d65a5421`.

Local checks: 129/129 Node tests, 18/18 release driver tests. punchlist-sync source regression 30/30. Real unchanged punchlist-sync module: client_credentials → existing /mcp → structured items PASS, 93 items; 0 Trilium writes. Current live disposable MCP campaign and hosted CI are pending; this is not the Phase-1 gate acceptance.

PR: https://github.com/mathiticus3/anylist-mcp/pull/5 (base is deployed compatibility line). CI run: https://github.com/mathiticus3/anylist-mcp/actions/runs/35530133886.

## First persistence gate — failed, correctly held

Hosted CI run 35530133886 passed all three Node versions (20/24/26). Live MCP test completed 58 successful calls but failed fresh-read meal-title persistence. Inspection demonstrated that the pinned Event.save implements only set-event-details: a second disposable event proved details updates and delete persist. The structured update schema is therefore being narrowed to details, with title/date/label/recipe changes recorded as unsupported until a later qualified client enhancement.

A separate post-cleanup read found one disposable category remained: removeCategory's implemented remove-category operation returned 2xx but did not delete it. The library sends originalValue instead of its typed originalCategory. A narrowly isolated compatibility repair is being qualified. All disposable items, favorites, recipes, collections and events were verified absent. Remaining category is uniquely named V72-CAMPAIGN-1789930065545-Category2 on the pre-existing scratch list; it must be removed and fresh absence proven before the gate passes. No Phase 2 or 3 runtime has been introduced.

## Correction to category-delete diagnosis

The first originalCategory repair was disproven by fresh read and is superseded. Official web-client source at `https://www.anylist.com/static/webapp/js/app.js` identifies the existing list-category delete operation as `remove-category-ids`, operationClass ListCategoryGroupOperation (4), with updatedCategoryGroup containing only the selected category records. The library/reference Rust implementation had confused this with the separate user-level `remove-category` handler. This is a repair of the pre-existing delete_category capability, not a new experimental capability. The exact one-category delta is contract-tested; cloud absence remains the acceptance gate.

Release ebce391 passed 130 tests and hosted CI run 35530427369; its live harness completed 67 calls but correctly failed on shopping cleanup residue. No ordinary household records changed. Both uniquely prefixed scratch categories remain tracked for cleanup after the corrected handler is deployed.

## Phase 1 gate PASS — 2026-09-20

Runtime `972b019389e2d6ad9ebd6e7f93527b524ac6a249`, package 1.8.0, pinned client unchanged. 130 Node tests, 18 release tests, hosted CI [35530629758](https://github.com/mathiticus3/anylist-mcp/actions/runs/35530629758) green on Node 20/24/26. Strengthened committed harness d55fed9 completed 67 successful MCP calls, including actual URL normalize/native-import fallback, field-level shopping quantity/note, favorite note, recipe metadata and meal-details fresh read-back. All disposable cleanup passed. Both earlier disposable categories were independently verified absent after the official-operation repair. Receipt: phase1-mcp-receipt.json.

punchlist-sync unchanged: 30 regression tests pass; actual existing client_credentials/MCP structured read returned 93 items with zero Trilium writes. Legacy tool regression suite and live health/discovery/list/recipe/collection/meal reads pass. The restricted Gina profile remains unchanged. No household list was created/deleted; all acceptance writes used uniquely prefixed objects on the pre-existing scratch list and disposable account recipes/collections/2099 meal events.

Explained gaps: shopping-list CRUD/store CRUD/collection rename/meal title-date-label-recipe updates lack a safe implemented primitive in the pinned library. Meal details updates are qualified. Uncheck-all, raw credentials/RPC and broken favorite per-set category helpers are intentionally excluded. No unexplained supported-client gap remains. Phase 2 is authorized to start.

## Phase 2 preparation — not yet accepted

Phase1 PR5 merged into the deployed compatibility line after final test/docs CI run35530886683 passed. Adapter implementation is a same-process projection over registered MCP handlers with dedicated independently revocable bearer authentication, generated OpenAPI3.1 and 30 operations covering40 stable capabilities. Existing /mcp and restricted Gina schemas unchanged. No new resident service, Caddy edit or Compose edit. Deployment baseline is972b019; preserve rollback image sha256:28dc48bf07b8470121320a3e1bf880805e85cc3cc604a37e005026e62843ad68. Phase2 live/CI gates remain pending.

## Phase 2 gate PASS — 2026-09-20

Runtime `7289282f09d787f6bb78f18f9da656e2fa1fae63`, package1.9.0 / adapter1.0.0 / unchanged client0.8.6 pin. Image `sha256:75ad7cd8e712937870f3552569592a1cd63b122fb2d8d44d13e50d5c968075d7`; healthy. Guarded deployment verified all six peers and protected files unchanged. Release checkpoint `/home/deploy/.local/state/anylist-mcp/releases/7289282f09d787f6bb78f18f9da656e2fa1fae63`; rollback driver `/home/deploy/anylist-release-7289282f/deploy_anylist.py`.

132 Node tests /18 release tests pass. Hosted CI [35531681753](https://github.com/mathiticus3/anylist-mcp/actions/runs/35531681753) passed Node20/24/26. Real public HTTPS acceptance passed78 checks, including bearer failures, authenticated readiness, full shopping/favorites/recipe/collection/meal CRUD within qualified semantics, recipe URL import/normalize, raw-text normalize, exact fresh readback, 409 ambiguity with two disposable same-name recipes, malformed input and all cleanup. Receipt `phase2-actions-receipt.json`. Fetched public OpenAPI3.1 validates with SwaggerParser; 30 operationIds cover40 stable MCP actions. Existing MCP legacy reads and all-tools inventory also passed within the same harness. Unchanged punchlist-sync module again completed client_credentials/MCP structured read of93 items, zero writes. No household migration or unrelated item mutation. No residual disposable records; temporary acceptance bearer deleted.

Dedicated key provisioned in existing /data volume, no secret printed. Mode600 raw .env plus verifier are backed up encrypted in `/home/deploy/web-caddy/backups/anylist-campaign-20260920/gpt-actions-credential.tar.enc`, SHA256 `5a7b2e18a40c088705077e154b695e150568bcd64cbe0f606716d9184c583edd`; decrypt/list verified. Uses separate recovery.key already retained for the campaign; no secret in git. Revocation is independent of AnyList/MCP credentials.

Phase3 is now permitted. Private GPT editor import/key paste remains an owner UI setup step; no private GPT creation claim is made. Exact setup is ACTIONS.md.

## Phase 3 bounded preparation

Phase2 PR6 merged after final receipt CI35531963817 passed. Read-only protocol probe confirmed current price records and complete folder snapshots. Isolated client-layer extensions and a separate flag-gated read-only MCP tool implement only those two candidates. Flags default absent/off; stable GPT registry unchanged; no experimental mutation or Gina canary execution. Full evidence/classification is EXPERIMENTAL.md. Live experimental qualification and final deployment receipts pending.

## Phase 3 bounded acceptance PASS — final runtime

Deployed `26392a003c312789c0a531bdd549b992e8bb4441`, package1.9.1, adapter1.0.0, unchanged client0.8.6/1d3c9816. Image `sha256:edae35c2d514c161ac2ecbc9fc3efcdbf89ac78dcc35c54854a421df82d94623`. Guarded deployment passed from7289282; six peers/protected Caddy/Compose/env/volume state unchanged. Checkpoint `/home/deploy/.local/state/anylist-mcp/releases/26392a003c312789c0a531bdd549b992e8bb4441`; rollback driver `/home/deploy/anylist-release-26392a00/deploy_anylist.py`.

135 Node regressions and18 release tests pass; hosted CI [35532296751](https://github.com/mathiticus3/anylist-mcp/actions/runs/35532296751) passed Node20/24/26. Actual MCP experimental qualification at19:28Z verified both read schemas, complete2-folder snapshot,42 priced items/46 stored current price records, all-list paging, independent price disabling while folders remained callable, stable readiness after disabling, and no experimental tool in a newly initialized default session. Provider writes0. Flags file removed and temporary bearer deleted. Receipt `phase3-mcp-receipt.json`. Experiments remain OFF and absent from stable GPT.

Final public OpenAPI matches generated source exactly and validates. Final unchanged punchlist-sync client_credentials/structured read again returned93 items with writes0; timer active and last service result success/exit0. Final Docker health healthy. No new peer service or household migration. Phase1/2 disposable records were cleaned; Phase3 did not create any. Remaining candidate dispositions and next bounded experiments are explicit in EXPERIMENTAL.md.

Estate documentation/ADR33 merged via vector72-io PR368 (sourceed750c2). Runtime changes remain entirely owned by anylist-mcp PR5/6/7 and exact release bundles. Owner-only GPT editor setup remains the only manual stable consumer setup step; no secret value is printed in receipts or documentation.

## Dedicated Gina read-only follow-up — preparation

Separate owner authorization via the Gina coordination task permits new confidential-client setup and READ-ONLY qualification, zero AnyList data writes. Branch codex/anylist-canary-readonly introduces profile gina_canary_readonly, only two fixed-list shopping reads, no existing Gina role change or mutation grant. New machine profile cannot bind browser OAuth redirects. Unknown bearer profiles fail closed. Older runtimes default unknown profiles to full: documented rollback therefore requires dedicated-client revocation, enforced by this release driver's pre-restore custom-profile check. No client provisioned before the new code is deployed/healthy. Baseline26392a0/imageedae35c2;138 Node tests and19 release tests pass locally. See CANARY-READONLY.md for exact scope, private delivery and revocation.

## Dedicated read-only provider PASS; local delivery awaiting explicit approval

Runtime `f085f2d29317fdc658be0b9a98a0dfead176d44d` / MCP1.9.2, image `sha256:b91d0cc271223425c5a5f97160c19ca39474f13c8eba72e46b0deea9d1b8d257`, healthy. Guarded deployment passed from26392a0 with six peers/protected files unchanged.138 Node/19release tests; hosted CI [35536188350](https://github.com/mathiticus3/anylist-mcp/actions/runs/35536188350) green20/24/26. Gina task independently reviewed the source before registration.

Exactly one `gina-canary-harness` confidential registration created with gina_canary_readonly/source gina/action-harness-readonly. Second provision returned created=false with the same SHA256(client_id). No client ID/secret/bearer printed. Own standard client_credentials grant → /mcp initialize/tools-list → two exact pinned-list reads passed at20:41:50Z, two items in both snapshots, equal observable state and fresh complete metadata. Provider writes0; real mutation-permission probes0; qualification bearer deleted. Sanitized receipt: canary-readonly-receipt.json.

Actual guard-only production check using the retained old image and read-only/network-disabled volume access refused legacy rollback BEFORE any restoration; no rollback performed. Existing punchlist-sync authenticated read again93 items/writes0. New client can read only target297966c79aa64357a5f765bb2214470c; no write tool or future canary approval implied.

Automatic approval review rejected production-to-local credential export to the agreed private local path because trusted user content did not explicitly authorize that destination. No copy occurred; no workaround was attempted. Explicit owner approval was requested. Credential remains mode600 box-side `/data/.env.gina-canary-harness`; independent local Gina qualification is pending delivery permission. This is a delivery approval boundary, not a provider implementation failure. Revocation and mandatory pre-rollback revocation are documented in CANARY-READONLY.md and current HANDOFF/ACTIONS pointers.

## Private credential delivery PASS — 2026-09-20

This supersedes the delivery block above. Matt explicitly approved the requested production-to-local export with “Full authorization”; the authorized copy succeeded at `/Users/matthewmaupin/.config/vector72/credentials/gina-canary-harness.env`. File mode0600 and directory mode0700 were verified, together with exact environment keys, fixed endpoints/list ID and the existing client identity digest. No credential value was printed or committed. No new registration or provider data write occurred.

The shared coordination status now records LOCAL_CREDENTIAL_DELIVERED=true and READY_FOR_GINA_READONLY=true. Gina was notified to execute its own independent READ-only qualifier. READY_FOR_GINA_CANARY=false and CANARY_WRITE_ENABLED=false remain unchanged. This is a delivery receipt only; deployed runtime f085f2d, permissions, rollback guard and source semantics are unchanged.
