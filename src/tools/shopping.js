import { z } from "zod";
import { textResponse, errorResponse, structuredResponse } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";
import { STANDARD_CATEGORIES } from "../anylist-client.js";

const ACTION_DESCRIPTIONS = {
  list_lists: "Show all lists with item counts",
  list_items: "Show items on a list, grouped by category (category_set picks which set to group by)",
  list_categories: "Show the list's category sets and their categories",
  add_item: "Add an item to a list (also updates an existing item)",
  add_items: "Add many items at once (pass the items array)",
  update_item: "Update an existing item in place",
  set_item_store: "Assign or clear an item's store",
  check_item: "Check off (complete) an item",
  uncheck_item: "Uncheck (reactivate) a completed item",
  delete_item: "Permanently remove an item from a list",
  create_category: "Create a category in a category set",
  rename_category: "Rename a category",
  delete_category: "Delete a category",
  get_favorites: "Get favorite items for a list",
  get_recents: "Get recently added items for a list",
  list_stores: "List stores available for the list",
};

const ALL_ACTIONS = Object.freeze(Object.keys(ACTION_DESCRIPTIONS));

function buildDescription(stores, actions = ALL_ACTIONS, options = {}) {
  const actionList = actions.map(action => {
    const description = action === "add_item" && options.rejectExisting
      ? "Add one previously absent item to a list"
      : ACTION_DESCRIPTIONS[action];
    return `- ${action}: ${description}`;
  }).join("\n");
  const base = `Manage AnyList shopping lists and items. Actions:\n${actionList}

Categories: "category" takes a category name, matched case-insensitively against the
list's own category sets (e.g. a punch list's "Urgent"), or one of AnyList's standard
grocery categories (${STANDARD_CATEGORIES.join(", ")}) on lists without custom sets.
"categories" assigns one category per set explicitly, e.g. {"Category Set": "Urgent", "Punchlist Areas": "Garage"}.`;
  if (!stores || stores.length === 0) return base;
  const storeList = stores.map(s => s.name).join(', ');
  return `${base}\n\nAvailable stores: ${storeList}`;
}

async function validateStoreName(client, storeName) {
  if (!storeName) return { valid: true, message: null };
  const stores = client.getStores();
  const storeNames = stores.map(s => s.name.toLowerCase());
  if (!storeNames.includes(storeName.toLowerCase())) {
    return { valid: false, message: `Store "${storeName}" not found in list "${client.targetList.name}". Available stores: ${storeNames.join(", ")}.
    Create a new store from the web application or mobile app, then try again.` };
  }
  return { valid: true, message: null };
}

const bulkItemSchema = z.object({
  name: z.string().describe("Item name"),
  quantity: z.number().min(1).optional(),
  notes: z.string().optional(),
  category: z.string().optional().describe("Category name (resolved against the list's category sets)"),
  categories: z.record(z.string()).optional().describe("Per-set assignment: { setName: categoryName }"),
  store_name: z.string().optional(),
});

export function register(server, getClient, options = {}) {
  const actions = options.actions || ALL_ACTIONS;
  const { elicitListName, elicitItemChoice, elicitRequiredField } = createElicitationHelpers(server);

  function findPartialMatches(client, itemName, includeChecked = false) {
    const items = client.targetList.items || [];
    const lower = itemName.toLowerCase();
    return items
      .filter(i => (includeChecked || !i.checked) && i.name.toLowerCase().includes(lower))
      .map(i => i.name);
  }

  async function resolveItemName(client, itemName, includeChecked = false) {
    const exact = client.targetList.getItemByName(itemName);
    if (exact) return itemName;
    const matches = findPartialMatches(client, itemName, includeChecked);
    if (matches.length === 0) throw new Error(`Item "${itemName}" not found in list`);
    if (matches.length === 1) return matches[0];
    return await elicitItemChoice(itemName, matches);
  }

  let lastStoreSignature = '';

  const registeredTool = server.registerTool(options.name || "shopping", {
    title: options.title || "Shopping Lists & Items",
    description: buildDescription([], actions, options),
    annotations: options.annotations || {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      action: z.enum(actions).describe("The shopping action to perform"),
      list_name: z.string().optional().describe("Name of the list (defaults to configured default list)"),
      name: z.string().optional().describe("Item name (required for add_item, update_item, set_item_store, check_item, uncheck_item, delete_item) or category name (create_category, rename_category, delete_category)"),
      new_name: z.string().optional().describe("New name (update_item and rename_category only)"),
      quantity: z.number().min(1).optional().describe("Item quantity (add_item and update_item, defaults to 1 on add)"),
      notes: z.string().optional().describe("Notes for the item (add_item and update_item)"),
      include_checked: z.boolean().optional().describe("Include checked-off items (list_items only, default false)"),
      include_notes: z.boolean().optional().describe("Include notes for each item (list_items only, default false)"),
      category: z.string().optional().describe("Category name for the item, matched case-insensitively against the list's category sets; or a standard grocery category on lists without sets (add_item and update_item)"),
      categories: z.record(z.string()).optional().describe('Per-set category assignment, e.g. {"Category Set": "Urgent", "Punchlist Areas": "Garage"} (add_item and update_item)'),
      category_set: z.string().optional().describe("Category set name: grouping for list_items, or the target set for create_category/rename_category/delete_category (defaults to the list's primary set)"),
      items: z.array(bulkItemSchema).optional().describe("Items to add (add_items only)"),
      store_name: z.string().optional().describe("Store to assign to this item (add_item and set_item_store only; omit or leave blank to clear)"),
    }
  }, async (params) => {
    const { action, list_name, name, quantity, notes, include_checked, include_notes, category, categories, category_set } = params;
    try {
      if (!actions.includes(action)) {
        return errorResponse(`Shopping action "${action}" is not available to this client.`);
      }
      const client = await getClient();
      switch (action) {
        case "list_lists": {
          // Enumerating lists needs auth only, never a specific target list,
          // so it must not be gated on the (optional) default list existing.
          await client.ensureAuthenticated();
          const lists = client.getLists();
          if (lists.length === 0) return textResponse("No lists found in the account.");
          const output = lists.map(l => `- ${l.name} (${l.uncheckedCount} unchecked items)`).join("\n");
          return textResponse(`Available lists (${lists.length}):\n${output}`);
        }
        case "list_items": {
          let resolvedListName = list_name;
          if (!resolvedListName && !client.defaultListName) {
            await client.connect(null);
            const lists = client.getLists();
            if (lists.length > 1) {
              resolvedListName = await elicitListName(lists);
            }
          }
          await client.connect(resolvedListName);
          const stores = client.getStores();
          const sig = stores.map(s => s.name).join(',');
          if (sig !== lastStoreSignature) {
            lastStoreSignature = sig;
            registeredTool.update({ description: buildDescription(stores, actions, options) });
          }
          const items = await client.getItems(include_checked || false, include_notes || false, category_set || null);
          if (items.length === 0) {
            return structuredResponse(
              include_checked
                ? `List "${client.targetList.name}" is empty.`
                : `No unchecked items on list "${client.targetList.name}".`,
              { list: client.targetList.name, categorySet: null, items: [] },
            );
          }
          const itemsByCategory = {};
          items.forEach(item => {
            const cat = item.category || 'other';
            if (!itemsByCategory[cat]) itemsByCategory[cat] = [];
            itemsByCategory[cat].push(item);
          });
          const itemList = Object.keys(itemsByCategory).sort().map(category => {
            const categoryItems = itemsByCategory[category].map(item => {
              const qty = item.quantity > 1 ? ` (x${item.quantity})` : "";
              const status = item.checked ? " ✓" : "";
              const note = item.note ? ` [${item.note}]` : "";
              const store = item.store ? ` @${item.store}` : "";
              return `  - ${item.name}${qty}${status}${note}${store}`;
            }).join("\n");
            return `**${category}**\n${categoryItems}`;
          }).join("\n\n");
          const groups = typeof client.getCategoryGroups === 'function' ? client.getCategoryGroups() : [];
          const setNote = groups.length > 1
            ? `\n(grouped by "${category_set || groups[0].name}"; other sets: ${groups.filter(g => (g.name || '') !== (category_set || groups[0].name)).map(g => g.name).join(', ')})`
            : '';
          return structuredResponse(
            `Shopping list "${client.targetList.name}" (${items.length} items):\n${itemList}${setNote}`,
            {
              list: client.targetList.name,
              categorySet: groups.length > 0 ? (category_set || groups[0].name) : null,
              // Exactly what getItems returned: { name, quantity, checked,
              // category, note?, store }. Grouping is presentation and stays in
              // the prose; callers that need it can group by `category`.
              items,
            },
          );
        }
        case "list_categories": {
          await client.connect(list_name || null);
          const groups = client.getCategoryGroups();
          if (groups.length === 0) {
            return textResponse(`List "${client.targetList.name}" has no custom category sets. Standard categories: ${STANDARD_CATEGORIES.join(", ")}`);
          }
          const output = groups.map(g => {
            const cats = g.categories.map(c => `  - ${c.name}`).join("\n");
            const def = g.defaultCategory ? ` (unassigned items appear in: ${g.defaultCategory})` : '';
            return `**${g.name}**${def}\n${cats}`;
          }).join("\n\n");
          return textResponse(`Category sets for "${client.targetList.name}" (${groups.length}):\n${output}`);
        }
        case "add_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to add?");
          await client.connect(list_name);

          const itemAlreadyExists = (client.targetList.items || []).some(
            item => item.name.toLowerCase() === itemName.toLowerCase(),
          );
          if (options.rejectExisting && itemAlreadyExists) {
            return errorResponse(`Item "${itemName}" already exists; this client may add new items but may not update existing ones.`);
          }

          const {valid, message} = await validateStoreName(client, params.store_name);
          if (!valid)
            return errorResponse(message);

          await client.addItem(itemName, quantity || 1, notes || null, category || "other", params.store_name || null, categories || null);
          return textResponse(`Successfully added "${itemName}" to list "${client.targetList.name}"`);
        }
        case "add_items": {
          if (!params.items || params.items.length === 0) {
            return errorResponse('add_items requires a non-empty "items" array');
          }
          await client.connect(list_name);
          const added = [];
          const failed = [];
          for (const item of params.items) {
            try {
              const {valid, message} = await validateStoreName(client, item.store_name);
              if (!valid) throw new Error(message);
              await client.addItem(item.name, item.quantity || 1, item.notes || null, item.category || "other", item.store_name || null, item.categories || null);
              added.push(item.name);
            } catch (e) {
              failed.push(`${item.name}: ${e.message}`);
            }
          }
          const failText = failed.length > 0 ? `\nFailed (${failed.length}):\n${failed.map(f => `  - ${f}`).join("\n")}` : '';
          return textResponse(`Added ${added.length}/${params.items.length} items to list "${client.targetList.name}"${failText}`);
        }
        case "update_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "Which item would you like to update?");
          await client.connect(list_name);
          const resolvedUpdate = await resolveItemName(client, itemName, true);
          const result = await client.updateItem(resolvedUpdate, {
            newName: params.new_name ?? null,
            quantity: quantity ?? null,
            notes: notes ?? null,
            category: category ?? null,
            categories: categories ?? null,
          });
          const finalName = (result && result.name) || params.new_name || resolvedUpdate;
          return textResponse(`Successfully updated "${resolvedUpdate}"${params.new_name ? ` (renamed to "${finalName}")` : ''} on list "${client.targetList.name}"`);
        }
        case "set_item_store": {
          // Upstream v1.6.0 listed this action in the enum but had no case
          // for it, so calls silently returned nothing.
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "Which item's store would you like to set?");
          await client.connect(list_name);
          const {valid, message} = await validateStoreName(client, params.store_name);
          if (!valid) return errorResponse(message);
          const resolvedStore = await resolveItemName(client, itemName, true);
          await client.setItemStore(resolvedStore, params.store_name || null);
          return textResponse(params.store_name
            ? `Successfully assigned "${resolvedStore}" to store "${params.store_name}" on list "${client.targetList.name}"`
            : `Successfully cleared the store assignment for "${resolvedStore}" on list "${client.targetList.name}"`);
        }
        case "check_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to check off?");
          await client.connect(list_name);
          const resolvedCheck = await resolveItemName(client, itemName);
          await client.removeItem(resolvedCheck);
          return textResponse(`Successfully checked off "${resolvedCheck}" from list "${client.targetList.name}"`);
        }
        case "uncheck_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to uncheck?");
          await client.connect(list_name);
          const resolvedUncheck = await resolveItemName(client, itemName, true);
          await client.uncheckItem(resolvedUncheck);
          return textResponse(`Successfully unchecked "${resolvedUncheck}" on list "${client.targetList.name}"`);
        }
        case "delete_item": {
          let itemName = name;
          if (!itemName) itemName = await elicitRequiredField("name", "What item would you like to delete?");
          await client.connect(list_name);
          const resolvedDelete = await resolveItemName(client, itemName, true);
          await client.deleteItem(resolvedDelete);
          return textResponse(`Successfully deleted "${resolvedDelete}" from list "${client.targetList.name}"`);
        }
        case "create_category": {
          if (!name) return errorResponse('create_category requires "name" (the category name)');
          await client.connect(list_name);
          const created = await client.createCategory(name, category_set || null);
          return textResponse(`Successfully created category "${created.name}" on list "${client.targetList.name}"`);
        }
        case "rename_category": {
          if (!name || !params.new_name) return errorResponse('rename_category requires "name" and "new_name"');
          await client.connect(list_name);
          await client.renameCategory(name, params.new_name, category_set || null);
          return textResponse(`Successfully renamed category "${name}" to "${params.new_name}" on list "${client.targetList.name}"`);
        }
        case "delete_category": {
          if (!name) return errorResponse('delete_category requires "name" (the category name)');
          await client.connect(list_name);
          await client.deleteCategory(name, category_set || null);
          return textResponse(`Successfully deleted category "${name}" from list "${client.targetList.name}"`);
        }
        case "get_favorites": {
          await client.connect(list_name || null);
          const items = await client.getFavoriteItems(list_name);
          if (items.length === 0) return textResponse(`No favorite items for list "${client.targetList.name}".`);
          const list = items.map(i => `- ${i.name}${i.details ? ` [${i.details}]` : ''}`).join('\n');
          return textResponse(`Favorite items for "${client.targetList.name}" (${items.length}):\n${list}`);
        }
        case "get_recents": {
          await client.connect(list_name || null);
          const items = await client.getRecentItems(list_name);
          if (items.length === 0) return textResponse(`No recent items for list "${client.targetList.name}".`);
          const list = items.map(i => `- ${i.name}${i.details ? ` [${i.details}]` : ''}`).join('\n');
          return textResponse(`Recent items for "${client.targetList.name}" (${items.length}):\n${list}`);
        }
        case "list_stores": {
          await client.connect(list_name || null);
          const stores = client.getStores();
          if (stores.length === 0) return textResponse(`No stores found for list "${client.targetList.name}".`);
          const list = stores.map(s => `- ${s.name}`).join('\n');
          return textResponse(`Stores for "${client.targetList.name}" (${stores.length}):\n${list}`);
        }
      }
    } catch (error) {
      return errorResponse(`Shopping ${action} failed: ${error.message}`);
    }
  });
}
