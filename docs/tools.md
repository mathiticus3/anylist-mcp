# Tool Reference

Functionality is organized into **5 domain-grouped tools**. Every domain tool takes an `action` enum plus action-specific parameters.

Those five tools are the full legacy surface. OAuth clients using the exact
Gina/OpenWebUI callback receive a smaller set of separate read and additive
tools instead; see [gina-openwebui.md](gina-openwebui.md). The restriction is
enforced by the server rather than by a prompt or client-side filter.

```json
{ "name": "shopping", "arguments": { "action": "add_item", "name": "Milk", "quantity": 2 } }
```

---

## `health_check`

Tests the connection to AnyList and verifies access to the target list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `list_name` | string | No | List to test (defaults to configured default) |

---

## `shopping`

Manage shopping lists and items.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | See actions below |
| `list_name` | string | No | Target list (defaults to configured default) |
| `name` | string | For item/category actions | Item name, or category name for `*_category` actions |
| `new_name` | string | No | New name (`update_item`, `rename_category`) |
| `quantity` | number | No | Item quantity (`add_item`, `update_item`; default 1 on add) |
| `notes` | string | No | Item notes (`add_item`, `update_item`) |
| `include_checked` | boolean | No | Include checked-off items (list_items only) |
| `include_notes` | boolean | No | Include item notes in output (list_items only) |
| `store_name` | string | No | Store to assign (`add_item`, `set_item_store`; omit to clear) |
| `category` | string | No | Category name, matched case-insensitively against the list's category sets; or a standard grocery category on lists without sets |
| `categories` | object | No | Per-set assignment map, e.g. `{"Category Set": "Urgent", "Punchlist Areas": "Garage"}` |
| `category_set` | string | No | Category set: grouping for `list_items`, target set for `*_category` actions |
| `items` | array | For add_items | Bulk items: `{name, quantity?, notes?, category?, categories?, store_name?}` |

**Category sets.** AnyList lists can carry multiple category sets (e.g. a
punch list grouped by urgency AND by area). Items hold one assignment per
set; the app groups by whichever set is active. `list_categories` shows the
sets, `category`/`categories` assign on add or update, and `list_items`
accepts `category_set` to pick the grouping. Assigning in one set never
disturbs an item's assignment in another set.

**Actions:**

```json
// List all shopping lists with item counts
{ "name": "shopping", "arguments": { "action": "list_lists" } }

// List items on a list, grouped by category
{ "name": "shopping", "arguments": { "action": "list_items", "list_name": "Costco", "include_notes": true } }

// List items grouped by a specific category set
{ "name": "shopping", "arguments": { "action": "list_items", "list_name": "Punch List", "category_set": "Punchlist Areas" } }

// Show a list's category sets and their categories
{ "name": "shopping", "arguments": { "action": "list_categories", "list_name": "Punch List" } }

// Add an item
{ "name": "shopping", "arguments": { "action": "add_item", "name": "Eggs", "quantity": 2, "notes": "organic", "store_name": "Costco"} }

// Add an item with a category in each set
{ "name": "shopping", "arguments": { "action": "add_item", "name": "Fix handrail", "categories": { "Category Set": "Urgent", "Punchlist Areas": "Interior" } } }

// Add many items at once
{ "name": "shopping", "arguments": { "action": "add_items", "items": [ { "name": "Fix handrail", "categories": { "Category Set": "Urgent" } }, { "name": "Clean gutters", "notes": "before winter" } ] } }

// Rename / recategorize / annotate an existing item in place
{ "name": "shopping", "arguments": { "action": "update_item", "name": "1-Urgent: Fix handrail", "new_name": "Fix handrail", "categories": { "Category Set": "Urgent" } } }

// Check off an item (supports partial name matching)
{ "name": "shopping", "arguments": { "action": "check_item", "name": "Eggs" } }

// Uncheck (reactivate) a completed item
{ "name": "shopping", "arguments": { "action": "uncheck_item", "name": "Eggs" } }

// Delete an item permanently
{ "name": "shopping", "arguments": { "action": "delete_item", "name": "Eggs" } }

// Manage categories within a set
{ "name": "shopping", "arguments": { "action": "create_category", "name": "Basement", "category_set": "Punchlist Areas" } }
{ "name": "shopping", "arguments": { "action": "rename_category", "name": "Ideas", "new_name": "Someday" } }
{ "name": "shopping", "arguments": { "action": "delete_category", "name": "Someday", "category_set": "Category Set" } }

// Get favorite items for a list
{ "name": "shopping", "arguments": { "action": "get_favorites" } }

// Get recently added items for a list
{ "name": "shopping", "arguments": { "action": "get_recents" } }

// Set store for an item
{ "name": "shopping", "arguments": { "action": "set_item_store", "name": "Milk", "store_name": "Costco" } }
```

---

## `recipes`

Manage AnyList recipes, including URL import and text parsing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | See actions below |
| `name` | string | For most actions | Recipe name |
| `search` | string | No | Filter recipes by name (list only) |
| `ingredients` | array | No | `[{ name, quantity }]` (create only) |
| `steps` | string[] | No | Preparation steps (create only) |
| `note` | string | No | Recipe notes (create only) |
| `source_name` | string | No | Source attribution (create only) |
| `source_url` | string | No | Source URL (create only) |
| `prep_time` | number | No | Prep time in minutes (create only) |
| `cook_time` | number | No | Cook time in minutes (create only) |
| `servings` | string | No | e.g. `"4"` or `"4-6"` (create only) |
| `url` | string | For import/normalize | URL to fetch recipe from |
| `text` | string | For normalize | Raw recipe text to parse |
| `save` | boolean | No | Save normalized result to AnyList (normalize only) |

**Actions:**

```json
// Browse all recipes (summaries: name, rating, times, servings)
{ "name": "recipes", "arguments": { "action": "list" } }

// Search recipes
{ "name": "recipes", "arguments": { "action": "list", "search": "chicken" } }

// Get full details — ingredients and steps
{ "name": "recipes", "arguments": { "action": "get", "name": "Chicken Tikka Masala" } }

// Create a recipe
{ "name": "recipes", "arguments": {
    "action": "create",
    "name": "Simple Pasta",
    "ingredients": [
      { "name": "spaghetti", "quantity": "1 lb" },
      { "name": "garlic cloves", "quantity": "2" },
      { "name": "olive oil", "quantity": "1/4 cup" }
    ],
    "steps": ["Boil pasta", "Sauté garlic in oil", "Toss together"],
    "servings": "4"
} }

// Delete a recipe
{ "name": "recipes", "arguments": { "action": "delete", "name": "Simple Pasta" } }

// Import a recipe from a website URL
{ "name": "recipes", "arguments": { "action": "import_url", "url": "https://..." } }

// Parse and preview a recipe without saving (set save=true to also save)
{ "name": "recipes", "arguments": { "action": "normalize", "url": "https://..." } }
{ "name": "recipes", "arguments": { "action": "normalize", "text": "Pasta\n\n1 lb spaghetti\n\n1. Boil pasta", "save": true } }
```

---

## `meal_plan`

Manage the AnyList meal planning calendar.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | See actions below |
| `date` | string | For create | Date in `YYYY-MM-DD` format |
| `title` | string | No | Event title (use this or `recipe_id`) |
| `recipe_id` | string | No | Link an existing recipe by ID |
| `label_id` | string | No | Meal type label ID (get from `list_labels`) |
| `details` | string | No | Additional notes |
| `event_id` | string | For delete | Event ID to delete |

**Actions:**

```json
// View all meal plan events, sorted by date
{ "name": "meal_plan", "arguments": { "action": "list_events" } }

// Get available labels (Breakfast, Lunch, Dinner, etc.) with their IDs
{ "name": "meal_plan", "arguments": { "action": "list_labels" } }

// Schedule a meal
{ "name": "meal_plan", "arguments": {
    "action": "create_event",
    "date": "2025-02-15",
    "title": "Pizza Night",
    "label_id": "<id from list_labels>"
} }

// Delete an event
{ "name": "meal_plan", "arguments": { "action": "delete_event", "event_id": "<id>" } }
```

---

## `recipe_collections`

Organize recipes into named collections.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | `list` or `create` |
| `name` | string | For create | Collection name |
| `recipe_names` | string[] | No | Recipes to include on creation |

**Actions:**

```json
// List all collections
{ "name": "recipe_collections", "arguments": { "action": "list" } }

// Create a collection
{ "name": "recipe_collections", "arguments": {
    "action": "create",
    "name": "Weeknight Dinners",
    "recipe_names": ["Simple Pasta", "Chicken Tikka Masala"]
} }
```

---

## Typical multi-step interaction

1. **Browse recipes** — `recipes` → `list`
2. **Get details** — `recipes` → `get` with `name`
3. **Plan the meal** — `meal_plan` → `create_event` with date and title
4. **Add ingredients** — `shopping` → `add_item` for each ingredient
