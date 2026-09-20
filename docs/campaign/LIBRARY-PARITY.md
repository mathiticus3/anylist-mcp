# Final client/library → MCP parity

Pinned client: bobby060/anylist-js0.8.6 at1d3c9816c4ecfc3b2d8c5c48dd35619b125381c3. The MCP package owns narrow compatibility repairs and safe composition. FULL means the qualified useful implemented method is exposed and tested; it does not assert capabilities absent from this client. All rows below have a disposition; no unexplained gap. Exact inputs/GPT projection are in CAPABILITIES.md, and original pre-change classifications remain historical in BASELINE.md.

| Library capability | Method / implementation | Final MCP equivalent | Parity / qualification |
|---|---|---|---|
| List discovery and read | getLists(true), getListById/getListByName models | shopping/list_lists, list_items | FULL: fresh reads, canonical IDs, duplicate-name errors, checked/notes switches |
| Shopping-list create/rename/delete | No implementation in pinned client | none | UNKNOWN/unsupported: no safe client primitive; no invented endpoints |
| Create/update/delete item | createItem, List.addItem/removeItem, Item.save | add_item, update_item, delete_item | FULL: explicit IDs scoped to list; add retains upsert semantics; unspecified updates preserved |
| Item check/uncheck | Item.checked + save | check_item, uncheck_item | FULL: fresh cloud persistence verified |
| Item quantity | Item.quantity + save | add_item/add_items/update_item | FULL for qualified positive numeric quantities. Raw free-text quantity is NOT SAFE TO EXPOSE in this pin: newer upstream fixes its encoding; deliberately not claimed as qualified. Fractions represented numerically where possible. |
| Item notes and manual order | Item.details/manualSortIndex + save | add_item/update_item | FULL; empty note clears; manual index schema bounded to finite numbers |
| Category assignments | wrapper _resolveCategories/_assignItemCategories, library protobuf helpers | add_item/update_item category/categories | FULL for shopping items; favorite per-set assignment unqualified and omitted |
| Category CRUD | List.createCategory/renameCategory/removeCategory | create_category/rename_category/delete_category | FULL after isolated official-handler repair; fresh cloud delete absence verified |
| Store read and multi-assignment | List.stores, Item.setStores | list_stores/set_item_store, update_item | FULL: canonical store IDs/names, multiple stores, explicit clearing |
| Store CRUD | Wrapper references absent library methods | none | NOT SAFE TO EXPOSE; no implemented primitive |
| Bulk item add | No native client batch primitive | add_items | FULL as one bounded100-item MCP action; sequential library requests, per-item outcomes and partial-write reporting |
| Favorite read/add/update/remove | getFavoriteItemsByListId, List.addItem/removeItem(true), Item.save(true) | get_favorites/add_favorite/update_favorite/remove_favorite | FULL for qualified fields; requires existing provider favorites container |
| Recent items | getRecentItemsByListId | get_recents | FULL read |
| Synchronization | getLists(true), existing websocket updates | service/refresh/status | FULL explicit source refresh; no credentials or arbitrary websocket control |
| Uncheck entire list | List.uncheckAll | none | NOT SAFE TO EXPOSE: deliberate unbounded-mutation omission; compose explicit item IDs |
| Recipe discovery/search/read | getRecipes(true), Recipe model | recipes/list/get | FULL: name search, paging, complete implemented metadata/ingredients/steps |
| Recipe create/update/delete | createRecipe, Recipe.save/delete | recipes/create/update/delete | FULL: updates reconstruct full existing model plus supplied fields; preserves unspecified metadata |
| Recipe URL import | wrapper importRecipeFromUrl | recipes/import_url | FULL: public HTTPS validation plus native import/fallback, saved canonical ID verified |
| URL/text normalization and optional save | wrapper normalizeRecipe | recipes/normalize | FULL: bounded public HTTPS fetch and raw text; save optional |
| Collection list/read/create/delete | user-data recipe collections, createRecipeCollection, save/delete | recipe_collections/list/get/create/delete | FULL |
| Collection membership | RecipeCollection.addRecipe/removeRecipe | add_recipe/remove_recipe | FULL with one-member delta; preserves unrelated memberships |
| Collection rename | save emits new-recipe-collection, no rename method | none | NOT SAFE TO EXPOSE without qualified semantics |
| Meal event discovery/date filters | getMealPlanningCalendarEvents(true) | meal_plan/list_events | FULL: exact-date and inclusive range filters, canonical event IDs |
| Meal create/delete/link | createEvent, Event.save/delete | create_event/delete_event | FULL for supported create fields including recipe/label/details/scale/order |
| Meal update | Existing Event.save emits set-event-details only | update_event | FULL for details; title/date/recipe/label changes are NOT SAFE TO EXPOSE because cloud readback disproved persistence. Schema rejects them. |
| Meal labels | mealPlanningCalendarEventLabels | list_labels | FULL read; no label write primitive |
| Versions/readiness/capability metadata | package/submodule and stable registry | service/status/capabilities | FULL, no secrets |
| Authentication/transport/lifecycle | login, token refresh, _getUserData, teardown | internal only | NOT SAFE TO EXPOSE as raw RPC/auth actions; used internally by explicit operations |
| Experimental current prices/folders | New isolated AnyListExperimentalClient methods over authenticated user-data | anylist_experimental/list_prices/list_folders | Separately qualified experimental reads; not part of pinned-library stable parity, default OFF and omitted from GPT |

Validation:135 Node tests,18 guarded-release tests, hosted CI on Node20/24/26. Phase1 real MCP acceptance67 calls; Phase2 real HTTPS acceptance78 checks; actual unchanged punchlist-sync read at each release. See DEPLOYMENT.md and sanitized receipt JSON. No cloud writes were used for experimental qualification.
