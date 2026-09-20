# AnyList campaign baseline — 2026-09-20

Captured before runtime/source mutation. AnyList remains authoritative.

- Production: vector72-2, `/home/deploy/web-caddy/anylist-upstream`, clean detached commit `201e1faf2edcffe178031b84ce7f032d9c335215` (package 1.7.3).
- Client: bobby060/anylist-js 0.8.6, submodule `1d3c9816c4ecfc3b2d8c5c48dd35619b125381c3`; hardened protobuf compatibility layer in MCP repository. No npm `anylist` dependency at runtime.
- Image: `sha256:d9850f9de0c728f2964647930a92e0acf0f2e4e68e402a52a2018f70ef8740a1`, `io.vector72.release.commit=201e1faf2edcffe178031b84ce7f032d9c335215`.
- HTTPS `/health` 200; `/mcp` without credentials 401; Docker healthy. Read-only production credential smoke authenticated, 27 lists, 1 account/credential record, 8 OAuth clients (2 confidential), 14336 token rows at snapshot.
- Consumers: confidential Kiosk Snapshot (copperfield), punchlist-sync; two Make public registrations; four unnamed public registrations (cannot identify their applications from DB). Kiosk API/week-board consumes shopping operations. Preserve full and restricted Gina tool profiles.
- punchlist-sync timer active; last result success / exit 0. Contract: client_credentials at `/token`, stateful Streamable HTTP `/mcp`, protocol 2025-06-18; `shopping/list_items` with include_checked/include_notes must return `structuredContent.items`, preserving names, quantity, checked, category, note, store. No prose parsing.
- Proxy: entire anylist.vector72.io origin forwards to anylist-mcp:3000; no Authelia. Caddy SHA256 `e1adc21dfab03f01f49c1915005a1119ecd0e1cebc38c5a09838e346455c52a6`; compose SHA256 `98375bd56725daa4b62dc1e71c987024ca8bedd80a665596469b3cae052396a9`.
- Memory available 611 MiB; no additional resident service planned.
- Upstream heads inspected: MCP `563821e30bc8914605dbf7e27cf1022147b918b0`; bobby client `dc666c38393014b0bec4c5ce49e5c8ef443566a8`; codetheweb client `d69278a6a7ec04750dadfdf9c6f8b1b157b3a7e8`.
- Full baseline schema: [baseline-tools.json](baseline-tools.json). Source registration inventory matches deployed commit; authenticated transport inventory is a separate integration gate.

## Current MCP matrix

All entries below are deployed. Existing hermetic suite covers the legacy handlers; production acceptance must independently exercise actions (baseline read-only smoke is not a write receipt).

| Tool | Actions | R/W/Delete | Parameters | Tested baseline |
|---|---|---|---|---|
| health_check | — | R | list_name | authenticated read-only smoke; legacy tests |
| shopping | list_lists, list_items, list_categories, get_favorites, get_recents, list_stores | R | list_name, include_checked, include_notes, category_set | legacy tests; transport gate pending |
| shopping | add_item, add_items, update_item, set_item_store, check_item, uncheck_item | W | name/new_name, quantity, notes, category/categories, store_name, items | legacy tests; disposable write gate pending |
| shopping | create_category, rename_category, delete_category, delete_item | W/Delete | list_name, category_set, name/new_name | legacy tests; disposable write gate pending |
| recipes | list, get, normalize | R (normalize save=true writes) | name, search, url/text, save | legacy tests |
| recipes | create, delete, import_url | W/Delete | recipe fields, name, url | legacy tests |
| recipe_collections | list, create, delete | R/W/Delete | name, recipe_names | legacy tests |
| meal_plan | list_events, list_labels, create_event, delete_event | R/W/Delete | date/start_date/end_date, title, recipe_id, label_id, details, event_id | legacy tests |

## Client/library parity before changes

| Capability | Library method | MCP equivalent | Parity |
|---|---|---|---|
| List discovery/read | getLists/getListById/getListByName | list_lists/list_items | PARTIAL: IDs, ambiguity, freshness |
| Shopping list CRUD | absent | absent | UNKNOWN: unsupported by pinned client, beyond Phase 1 |
| Item CRUD/check/quantity/notes/category/store | createItem, List.addItem/removeItem, Item.save/setStores | shopping actions | PARTIAL: IDs, duplicate names, sort index |
| Bulk add | no native bulk method | add_items | FULL: one MCP call, library sequential writes |
| Category CRUD | List.createCategory/renameCategory/removeCategory | category actions | FULL |
| Store discovery/assignment | List.stores, Item.setStores | list_stores/set_item_store | FULL (multiple store IDs missing) |
| Store CRUD | absent; wrapper calls nonexistent methods | absent | NOT SAFE TO EXPOSE |
| Favorite read/add/update/remove | getFavoriteItemsByListId; List.addItem/removeItem(true); Item.save(true) | get_favorites | PARTIAL |
| Recent items | getRecentItemsByListId | get_recents | FULL |
| Refresh/sync | getLists(true), websocket updates | no explicit action | MISSING |
| Uncheck all | List.uncheckAll | absent | NOT SAFE TO EXPOSE: unbounded mutation; compose explicit uncheck_item calls |
| Recipe read/create/delete | getRecipes/createRecipe, Recipe.save/delete | list/get/create/delete | PARTIAL: complete fields/IDs |
| Recipe partial update | Recipe.save | absent | MISSING |
| Recipe URL/text normalization/import | MCP wrapper native import + normalizer | import_url/normalize | PARTIAL: unbounded URL fetch needs remediation |
| Collections read/create/delete | createRecipeCollection, save/delete | list/create/delete | FULL |
| Collection membership | addRecipe/removeRecipe | absent | MISSING; removal payload needs isolation to selected ID |
| Collection rename | save uses new-recipe-collection; no rename implementation | absent | NOT SAFE TO EXPOSE without verified semantics |
| Meal read/create/delete | getMealPlanningCalendarEvents/createEvent/save/delete | meal_plan | PARTIAL: fields, IDs, exact-date validation |
| Meal update | existing Event.save | absent | MISSING |
| Labels | mealPlanningCalendarEventLabels | list_labels | FULL (read-only library model) |
| Auth/tokens/transport internals | login, _fetchTokens, _getUserData, teardown | internal | NOT SAFE TO EXPOSE credentials/raw RPC |
| Versions/capability manifest | package/submodule metadata | absent | MISSING |

## Beyond-library candidates (evidence only, not qualification)

| Capability | Protobuf/API evidence | Endpoint known | Semantics verified | Value | Risk |
|---|---|---|---|---|---|
| Pricing | PBItemPrice | No price-specific endpoint established | No | High | currency/store/history meaning |
| List folders | PBListFolder, PBListFoldersResponse | user-data read candidate | No | High | hierarchy/ownership |
| Barcode lookup | No established callable method | No | No | High | external product data/account limits |
| Category rules | categorized-items/update historical notes | historical only | Not this campaign | High | global learned category writes |
| iCal controls | PBMealPlanSetICalendarEnabledRequest | No | No | Medium | export token disclosure |
| Smart recipe filters | PBSmartFilter | No | No | Medium | predicate semantics |
| Location reminders | protocol investigation pending | No | No | Medium | location privacy |

Phase 3 remains gated. A message name proves neither a callable endpoint nor supported semantics.
