# Stable capability matrix

Generated from the bounded capability registry. Existing MCP tools retain their legacy defaults; use `response_format: structured` for these schemas. New actions always use them.

| MCP tool | Action | Effect | Parameters | GPT operation ID (planned) |
|---|---|---|---|---|
| shopping | list_lists | read | none | listShoppingLists |
| shopping | list_items | read | list_name, list_id, include_checked, include_notes, category_set | getShoppingList |
| shopping | list_categories | read | list_name, list_id | listCategories |
| shopping | list_stores | read | list_name, list_id | listStores |
| shopping | get_recents | read | list_name, list_id | listRecentItems |
| shopping | get_favorites | read | list_name, list_id | listFavorites |
| shopping | add_item | write | list_name, list_id, name, quantity, notes, category, categories, store_name, store_ids, manual_sort_index | addShoppingItem |
| shopping | add_items | write | list_name, list_id, items | addShoppingItems |
| shopping | update_item | write | list_name, list_id, name, id, new_name, quantity, notes, category, categories, store_name, store_ids, manual_sort_index | updateShoppingItem |
| shopping | set_item_store | write | list_name, list_id, name, id, store_name, store_ids | setShoppingItemStore |
| shopping | check_item | write | list_name, list_id, name, id | checkShoppingItem |
| shopping | uncheck_item | write | list_name, list_id, name, id | uncheckShoppingItem |
| shopping | delete_item | delete | list_name, list_id, name, id | deleteShoppingItem |
| shopping | create_category | write | list_name, list_id, name, category_set | createCategory |
| shopping | rename_category | write | list_name, list_id, name, new_name, category_set | renameCategory |
| shopping | delete_category | delete | list_name, list_id, name, category_set | deleteCategory |
| shopping | add_favorite | write | list_name, list_id, name, quantity, notes, store_name, store_ids, manual_sort_index | addFavorite |
| shopping | update_favorite | write | list_name, list_id, name, id, new_name, quantity, notes, store_name, store_ids, manual_sort_index | updateFavorite |
| shopping | remove_favorite | delete | list_name, list_id, name, id | removeFavorite |
| recipes | list | read | search, limit, offset | listRecipes |
| recipes | get | read | name, id | getRecipe |
| recipes | create | write | name, new_name, ingredients, steps, note, source_name, source_url, prep_time, cook_time, servings, rating, nutritional_info, scale_factor, photo_ids, photo_urls, paprika_identifier | createRecipe |
| recipes | update | write | name, id, new_name, ingredients, steps, note, source_name, source_url, prep_time, cook_time, servings, rating, nutritional_info, scale_factor, photo_ids, photo_urls, paprika_identifier | updateRecipe |
| recipes | delete | delete | name, id | deleteRecipe |
| recipes | normalize | write | url, text, save | normalizeRecipe |
| recipes | import_url | write | url | importRecipe |
| recipe_collections | list | read | none | listRecipeCollections |
| recipe_collections | get | read | name, id | getRecipeCollection |
| recipe_collections | create | write | name, recipe_names | createRecipeCollection |
| recipe_collections | delete | delete | name, id | deleteRecipeCollection |
| recipe_collections | add_recipe | write | name, id, recipe_id, recipe_name | addRecipeToCollection |
| recipe_collections | remove_recipe | write | name, id, recipe_id, recipe_name | removeRecipeFromCollection |
| meal_plan | list_events | read | date, start_date, end_date | getMealPlan |
| meal_plan | list_labels | read | none | listMealLabels |
| meal_plan | create_event | write | date, title, details, recipe_id, recipe_name, label_id, label_name, recipe_scale_factor, order_added_sort_index | addMealPlanEvent |
| meal_plan | update_event | write | date, title, details, recipe_id, recipe_name, label_id, label_name, recipe_scale_factor, order_added_sort_index, event_id | updateMealPlanEvent |
| meal_plan | delete_event | delete | event_id | deleteMealPlanEvent |
| service | status | read | none | getServiceStatus |
| service | capabilities | read | none | getCapabilities |
| service | refresh | read | none | refreshAnyList |

Legacy health_check is retained; service/status supersedes its account readiness function in the structured surface. Capability availability is not a live acceptance receipt.
