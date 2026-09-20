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
