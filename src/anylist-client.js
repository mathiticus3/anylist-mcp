import FormData from 'form-data';
import AnyList from '../anylist-js/lib/index.js';
import uuid from '../anylist-js/lib/uuid.js';
import { normalizeRecipe } from './recipe-normalizer.js';

// NOTE: earlier versions monkey-patched Item._encode here to work around a
// protobuf 'quantity' field error. The vendored anylist-js now encodes
// quantityPb correctly AND includes categoryAssignments — the old patch
// silently dropped those assignments, breaking custom-category writes, so it
// must stay gone.

// AnyList's 18 stock category match-ids, used by grocery-style lists that
// have no custom category sets. Lists WITH category sets resolve category
// names against the sets themselves (see _resolveCategories).
export const STANDARD_CATEGORIES = ["baby","bakery","beverages","breakfast-and-cereal",
  "condiments-oils-and-salad-dressings","cooking-and-baking","dairy","frozen-foods",
  "grains-pasta-and-side-dishes","health-and-personal-care","household-and-cleaning",
  "meat","pet-supplies","produce","seafood","snacks-cookies-and-candy",
  "soups-and-canned-goods","wine-beer-spirits","other"];

// Slug used for an item's categoryMatchId when it's assigned to a custom
// category whose systemCategory is unset (mirrors the guidance on
// Item.assignToCustomCategory in anylist-js).
function categorySlug(name) {
  const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'other';
}

class AnyListClient {
  /**
   * @param {{ username?: string, password?: string, defaultListName?: string }} [credentials]
   *   Optional credentials. Falls back to ANYLIST_USERNAME / ANYLIST_PASSWORD / ANYLIST_LIST_NAME
   *   environment variables when not provided (stdio mode).
   */
  constructor({ username, password, defaultListName } = {}) {
    this.client = null;
    this.targetList = null;
    this._username = username || null;
    this._password = password || null;
    this.defaultListName = defaultListName || null;
  }

  async connect(listName = null) {
    const username = this._username || process.env.ANYLIST_USERNAME;
    const password = this._password || process.env.ANYLIST_PASSWORD;
    const targetListName = listName || this.defaultListName || process.env.ANYLIST_LIST_NAME;

    if (!username || !password) {
      const error = new Error('Missing AnyList credentials. Provide username and password.');
      console.error(error.message);
      throw error;
    }

    if (!targetListName) {
      const error = new Error('No list name provided and no default list configured');
      console.error(error.message);
      throw error;
    }

    // If already connected to the same list, skip reconnection
    if (this.client && this.targetList && this.targetList.name === targetListName) {
      return true;
    }

    try {
      // Create AnyList client if not already authenticated
      if (!this.client) {
        this.client = new AnyList({
          email: username,
          password: password
        });

        // Authenticate
        console.error(`Connecting to AnyList as ${username}...`);
        await this.client.login();
        console.error('Successfully authenticated with AnyList');

        await this.client.getLists();
      }

      // Find the target list
      console.error(`Looking for list: "${targetListName}"`);
      this.targetList = this.client.getListByName(targetListName);

      if (!this.targetList) {
        const error = new Error(`List "${targetListName}" not found. Available lists: ${this.getAvailableListNames().join(', ')}`);
        console.error(error.message);
        throw error;
      }

      console.error(`Connected to list: "${this.targetList.name}"`);

      return true;

    } catch (error) {
      const wrappedError = new Error(`Failed to connect to AnyList: ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  getAvailableListNames() {
    if (!this.client || !this.client.lists) return [];
    return this.client.lists.map(list => list.name);
  }

  getLists() {
    if (!this.client || !this.client.lists) return [];
    return this.client.lists.map(list => ({
      name: list.name,
      uncheckedCount: list.items ? list.items.filter(item => !item.checked).length : 0
    }));
  }

  _requireList() {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }
  }

  // ===== CATEGORY SETS =====

  /**
   * The target list's category sets (AnyList "category groups"), with each
   * set's categories and default category resolved to names.
   */
  getCategoryGroups() {
    this._requireList();
    return (this.targetList.categoryGroups || []).map(group => {
      const categories = (group.categories || [])
        .slice()
        .sort((a, b) => (a.sortIndex || 0) - (b.sortIndex || 0));
      const defaultCategory = categories.find(c => c.identifier === group.defaultCategoryId) || null;
      return {
        identifier: group.identifier,
        name: group.name,
        defaultCategory: defaultCategory ? defaultCategory.name : null,
        categories: categories.map(c => ({ identifier: c.identifier, name: c.name })),
      };
    });
  }

  _findCategoryGroup(setNameOrId) {
    const groups = this.targetList.categoryGroups || [];
    const q = String(setNameOrId || '').trim().toLowerCase();
    return groups.find(g =>
      (g.name || '').trim().toLowerCase() === q || g.identifier === setNameOrId
    ) || null;
  }

  /**
   * Resolve a category request into concrete {group, category} pairs.
   *
   * @param {object} spec
   * @param {string} [spec.category]     A category name matched case-insensitively
   *                                     across ALL of the list's category sets
   *                                     (first match wins), or a standard grocery
   *                                     match-id for lists without category sets.
   * @param {object} [spec.categories]   Explicit per-set map: { setName: categoryName }.
   * @return {{ pairs: Array<{group: object, category: object}>, legacyMatchId: string|null }}
   */
  _resolveCategories({ category = null, categories = null } = {}) {
    const groups = this.targetList.categoryGroups || [];
    const pairs = [];

    if (categories && typeof categories === 'object') {
      for (const [setName, catName] of Object.entries(categories)) {
        const group = this._findCategoryGroup(setName);
        if (!group) {
          throw new Error(`Category set "${setName}" not found on list "${this.targetList.name}". Available sets: ${groups.map(g => g.name).join(', ') || '(none)'}`);
        }
        const q = String(catName || '').trim().toLowerCase();
        const cat = (group.categories || []).find(c =>
          (c.name || '').trim().toLowerCase() === q || c.identifier === catName
        );
        if (!cat) {
          throw new Error(`Category "${catName}" not found in set "${group.name}". Available: ${(group.categories || []).map(c => c.name).join(', ')}`);
        }
        pairs.push({ group, category: cat });
      }
    }

    let legacyMatchId = null;
    if (category && category !== 'other') {
      const found = this.targetList.findCategoryByName
        ? this.targetList.findCategoryByName(category)
        : null;
      if (found) {
        if (!pairs.some(p => p.group.identifier === found.group.identifier)) {
          pairs.push({ group: found.group, category: found.category });
        }
      } else if (groups.length === 0 && STANDARD_CATEGORIES.includes(category)) {
        legacyMatchId = category;
      } else {
        const names = groups.length > 0
          ? groups.flatMap(g => (g.categories || []).map(c => c.name))
          : STANDARD_CATEGORIES;
        throw new Error(`Category "${category}" not found on list "${this.targetList.name}". Available categories: ${names.join(', ')}`);
      }
    }

    return { pairs, legacyMatchId };
  }

  /**
   * categoryMatchId for a set of assignments: prefer the assignment in the
   * list's primary (first) set since that's the default display grouping.
   */
  _matchIdForPairs(pairs) {
    if (pairs.length === 0) return null;
    const groups = this.targetList.categoryGroups || [];
    const primary = pairs.find(p => groups[0] && p.group.identifier === groups[0].identifier) || pairs[0];
    return primary.category.systemCategory || categorySlug(primary.category.name);
  }

  /**
   * Merge category assignments into an item — one per category set, replacing
   * only the sets being (re)assigned — and push a single full-item
   * `update-list-item` operation (per-field categoryMatchId ops create
   * "shadow" entries the apps don't treat as real set membership).
   */
  async _assignItemCategories(item, pairs) {
    if (pairs.length === 0) return;

    const replacedGroupIds = new Set(pairs.map(p => p.group.identifier));
    const kept = (item.categoryAssignments || []).filter(a => !replacedGroupIds.has(a.categoryGroupId));
    item._categoryAssignments = [
      ...kept,
      ...pairs.map(p => ({
        identifier: uuid(),
        categoryGroupId: p.group.identifier,
        categoryId: p.category.identifier,
      })),
    ];
    item._categoryMatchId = this._matchIdForPairs(pairs) || item._categoryMatchId;

    const op = new item._protobuf.PBListOperation();
    op.setMetadata({
      operationId: uuid(),
      handlerId: 'update-list-item',
      userId: item._uid,
    });
    op.setListId(item._listId);
    op.setListItemId(item._identifier);
    op.setListItem(item._encode());

    const opList = new item._protobuf.PBListOperationList();
    opList.setOperations([op]);
    const form = new FormData();
    form.append('operations', opList.toBuffer());
    await item._client.post('data/shopping-lists/update', { body: form });

    // Drop any pending field-level category update so a later save() doesn't
    // replay a stale single-field op over the full-item update.
    item._fieldsToUpdate = item._fieldsToUpdate.filter(f => f !== 'categoryMatchId');
  }

  /**
   * Create a category in one of the list's category sets (first set when
   * category_set is omitted).
   */
  async createCategory(name, categorySet = null) {
    this._requireList();
    const group = categorySet ? this._findCategoryGroup(categorySet) : (this.targetList.categoryGroups || [])[0];
    if (!group) {
      throw new Error(categorySet
        ? `Category set "${categorySet}" not found on list "${this.targetList.name}".`
        : `List "${this.targetList.name}" has no category sets.`);
    }
    const maxSort = Math.max(0, ...(group.categories || []).map(c => c.sortIndex || 0));
    return this.targetList.createCategory({ name, categoryGroupId: group.identifier, sortIndex: maxSort + 1 });
  }

  async renameCategory(name, newName, categorySet = null) {
    this._requireList();
    const { category } = this._resolveOneCategory(name, categorySet);
    return this.targetList.renameCategory(category.identifier, newName);
  }

  async deleteCategory(name, categorySet = null) {
    this._requireList();
    const { category } = this._resolveOneCategory(name, categorySet);
    return this.targetList.removeCategory(category.identifier);
  }

  _resolveOneCategory(name, categorySet = null) {
    if (categorySet) {
      const group = this._findCategoryGroup(categorySet);
      if (!group) {
        throw new Error(`Category set "${categorySet}" not found on list "${this.targetList.name}".`);
      }
      const q = String(name || '').trim().toLowerCase();
      const category = (group.categories || []).find(c => (c.name || '').trim().toLowerCase() === q);
      if (!category) {
        throw new Error(`Category "${name}" not found in set "${group.name}". Available: ${(group.categories || []).map(c => c.name).join(', ')}`);
      }
      return { group, category };
    }
    const found = this.targetList.findCategoryByName(name);
    if (!found) {
      throw new Error(`Category "${name}" not found on list "${this.targetList.name}".`);
    }
    return found;
  }

  // ===== ITEMS =====

  async addItem(itemName, quantity = 1, notes = null, category = "other", store = null, categories = null) {
    this._requireList();

    try {
      const { pairs, legacyMatchId } = this._resolveCategories({ category, categories });

      // First, check if item already exists
      const existingItem = this.targetList.getItemByName(itemName);

      if (existingItem) {
        // Item exists — uncheck if needed, update quantity/notes in place
        if (existingItem.checked) {
          existingItem.checked = false;
          console.error(`Unchecked existing item: ${existingItem.name}`);
        } else {
          console.error(`Item "${itemName}" already exists and is active`);
        }
        existingItem.quantity = quantity;
        if (notes !== null) {
          existingItem.details = notes;
        }
        if (legacyMatchId) {
          existingItem.categoryMatchId = legacyMatchId;
        }
        await existingItem.save();
        if (pairs.length > 0) {
          await this._assignItemCategories(existingItem, pairs);
        }
      } else {
        // Item doesn't exist, create new one
        const itemOptions = { name: itemName };
        if (notes !== null) {
          itemOptions.details = notes;
        }
        if (legacyMatchId) {
          itemOptions.categoryMatchId = legacyMatchId;
        }

        const newItem = this.client.createItem(itemOptions);
        await this.targetList.addItem(newItem);

        // Set quantity and notes after adding (can't be done via _encode)
        if (quantity !== 1 || notes !== null) {
          if (quantity !== 1) {
            newItem.quantity = quantity;
          }
          if (notes !== null) {
            newItem.details = notes;
          }
          await newItem.save();
        }

        if (pairs.length > 0) {
          await this._assignItemCategories(newItem, pairs);
        }

        console.error(`Added new item: ${newItem.name}`);
      }

      if (store) {
        await this.setItemStore(itemName, store);
      }

    } catch (error) {
      const wrappedError = new Error(`Failed to add item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  /**
   * Update an existing item in place: rename, quantity, notes, and/or
   * category assignment (per set via `categories`, or by bare category name).
   */
  async updateItem(itemName, { newName = null, quantity = null, notes = null, category = null, categories = null } = {}) {
    this._requireList();

    try {
      const existingItem = this.targetList.getItemByName(itemName);
      if (!existingItem) {
        throw new Error(`Item "${itemName}" not found in list, so can't update it`);
      }

      const { pairs, legacyMatchId } = this._resolveCategories({ category, categories });

      if (newName !== null && newName !== existingItem.name) {
        existingItem.name = newName;
      }
      if (quantity !== null) {
        existingItem.quantity = quantity;
      }
      if (notes !== null) {
        existingItem.details = notes;
      }
      if (legacyMatchId) {
        existingItem.categoryMatchId = legacyMatchId;
      }
      if (existingItem._fieldsToUpdate.length > 0) {
        await existingItem.save();
      }
      if (pairs.length > 0) {
        await this._assignItemCategories(existingItem, pairs);
      }

      console.error(`Updated item: ${existingItem.name}`);
      return { name: existingItem.name };

    } catch (error) {
      const wrappedError = new Error(`Failed to update item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  /** Uncheck (reactivate) a checked-off item without touching anything else. */
  async uncheckItem(itemName) {
    this._requireList();

    try {
      const existingItem = this.targetList.getItemByName(itemName);
      if (!existingItem) {
        throw new Error(`Item "${itemName}" not found in list, so can't uncheck it`);
      }
      if (existingItem.checked) {
        existingItem.checked = false;
        await existingItem.save();
        console.error(`Unchecked item: ${existingItem.name}`);
      } else {
        console.error(`Item "${itemName}" is already unchecked`);
      }
    } catch (error) {
      const wrappedError = new Error(`Failed to uncheck item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async deleteItem(itemName) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      const existingItem = this.targetList.getItemByName(itemName);

      if (!existingItem) {
        const error = new Error(`Item "${itemName}" not found in list, so can't delete it`);
        console.error(error.message);
        throw error;
      }

      await this.targetList.removeItem(existingItem);
      console.error(`Deleted item: ${existingItem.name}`);

    } catch (error) {
      const wrappedError = new Error(`Failed to delete item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  async removeItem(itemName) {
    if (!this.targetList) {
      const error = new Error('Not connected to any list. Call connect() first.');
      console.error(error.message);
      throw error;
    }

    try {
      // Find the item by name
      const existingItem = this.targetList.getItemByName(itemName);

      if (!existingItem) {
        const error = new Error(`Item "${itemName}" not found in list, so can't check it`);
        console.error(error.message);
        throw error;
      }

      // Check the item (mark as completed) instead of deleting
      if (!existingItem.checked) {
        existingItem.checked = true;
        await existingItem.save();
        console.error(`Checked off item: ${existingItem.name}`);
      } else {
        console.error(`Item "${itemName}" is already checked off`);
      }
    } catch (error) {
      const wrappedError = new Error(`Failed to remove item "${itemName}": ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  /**
   * Items in a clean format. On lists with category sets, `category` is the
   * item's category NAME in the chosen set (`categorySet` by name, defaulting
   * to the list's primary set); unassigned items fall into that set's default
   * category, exactly like the AnyList apps display them. Lists without
   * category sets keep the legacy categoryMatchId grouping.
   */
  async getItems(includeChecked = false, includeNotes = false, categorySet = null) {
    this._requireList();

    try {
      // Get all items from the list
      const items = this.targetList.items || [];

      // Filter based on checked status
      const filteredItems = includeChecked
        ? items
        : items.filter(item => !item.checked);

      // Pick the category set to group by
      const groups = this.targetList.categoryGroups || [];
      let group = null;
      if (categorySet) {
        group = this._findCategoryGroup(categorySet);
        if (!group) {
          throw new Error(`Category set "${categorySet}" not found on list "${this.targetList.name}". Available sets: ${groups.map(g => g.name).join(', ') || '(none)'}`);
        }
      } else if (groups.length > 0) {
        group = groups[0];
      }
      const categoryNameById = group
        ? Object.fromEntries((group.categories || []).map(c => [c.identifier, c.name]))
        : {};
      const defaultCategoryName = group
        ? (categoryNameById[group.defaultCategoryId] || 'Uncategorized')
        : null;

      // Map to a clean format
      return filteredItems.map(item => {
        let category;
        if (group) {
          const assignment = (item.categoryAssignments || []).find(a => a.categoryGroupId === group.identifier);
          category = (assignment && categoryNameById[assignment.categoryId]) || defaultCategoryName;
        } else {
          category = item.categoryMatchId || 'other';
        }
        const result = {
          name: item.name,
          quantity: typeof item.quantity === 'number' ? item.quantity : 1,
          checked: item.checked || false,
          category
        };
        if (includeNotes && item.details) {
          result.note = item.details;
        }
        const store = (this.targetList.stores || []).find(s => s.identifier === (item.storeIds || [])[0]);
        result.store = store ? store.name : null;

        return result;
      });
    } catch (error) {
      const wrappedError = new Error(`Failed to get items: ${error.message}`);
      console.error(wrappedError.message);
      throw wrappedError;
    }
  }

  // ===== STORES =====

  getStores() {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    return this.targetList.stores || [];
  }

  async setItemStore(itemName, storeName) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const item = this.targetList.getItemByName(itemName);
    if (!item) {
      throw new Error(`Item "${itemName}" not found in list`);
    }
    let storeIds = [];
    if (storeName) {
      const store = this.targetList.findStoreByName(storeName);
      if (!store) {
        const available = (this.targetList.stores || []).map(s => s.name).join(', ') || 'none';
        throw new Error(`Store "${storeName}" not found. Available stores: ${available}`);
      }
      storeIds = [store.identifier];
    }
    await item.setStores(storeIds);
  }

  async createStore(storeName) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    try {
      const store = await this.targetList.createStore(storeName);
      console.error(`Created store: ${store.name}`);
      return store;
    } catch (error) {
      throw new Error(`Failed to create store "${storeName}": ${error.message}`);
    }
  }

  async deleteStore(storeName) {
    if (!this.targetList) {
      throw new Error('Not connected to any list. Call connect() first.');
    }
    const store = this.targetList.findStoreByName(storeName);
    if (!store) {
      throw new Error(`Store "${storeName}" not found`);
    }
    try {
      await this.targetList.deleteStore(store.identifier);
      console.error(`Deleted store: ${storeName}`);
    } catch (error) {
      throw new Error(`Failed to delete store "${storeName}": ${error.message}`);
    }
  }

  // ===== RECIPES =====

  async getRecipes(searchQuery = null) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      let results = recipes.map(r => ({
        identifier: r.identifier,
        name: r.name,
        note: r.note || null,
        sourceName: r.sourceName || null,
        sourceUrl: r.sourceUrl || null,
        rating: r.rating || null,
        prepTime: r.prepTime || null,
        cookTime: r.cookTime || null,
        servings: r.servings || null,
        ingredientCount: r.ingredients ? r.ingredients.length : 0,
        stepCount: r.preparationSteps ? r.preparationSteps.length : 0,
      }));
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        results = results.filter(r => r.name && r.name.toLowerCase().includes(q));
      }
      return results;
    } catch (error) {
      throw new Error(`Failed to get recipes: ${error.message}`);
    }
  }

  async getRecipeDetails(recipeName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      const recipe = recipes.find(r => r.name && r.name.toLowerCase() === recipeName.toLowerCase());
      if (!recipe) {
        throw new Error(`Recipe "${recipeName}" not found`);
      }
      return {
        identifier: recipe.identifier,
        name: recipe.name,
        note: recipe.note || null,
        sourceName: recipe.sourceName || null,
        sourceUrl: recipe.sourceUrl || null,
        rating: recipe.rating || null,
        prepTime: recipe.prepTime || null,
        cookTime: recipe.cookTime || null,
        servings: recipe.servings || null,
        nutritionalInfo: recipe.nutritionalInfo || null,
        createdAt: recipe.creationTimestamp
          ? new Date(recipe.creationTimestamp * 1000).toISOString()
          : (recipe.timestamp ? new Date(recipe.timestamp * 1000).toISOString() : null),
        ingredients: recipe.ingredients ? recipe.ingredients.map(i => ({
          rawIngredient: i.rawIngredient || null,
          name: i.name || null,
          quantity: i.quantity || null,
          note: i.note || null,
        })) : [],
        preparationSteps: recipe.preparationSteps || [],
      };
    } catch (error) {
      throw new Error(`Failed to get recipe details: ${error.message}`);
    }
  }

  async importRecipeFromUrl(url) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }

    // Try AnyList's native web import first
    let nativeError = null;
    try {
      const result = await this.client.client.post('data/recipes/web-import?url=' + encodeURIComponent(url));
      const decoded = this.client.protobuf.PBRecipeWebImportResponse.decode(result.body);

      if (decoded.statusCode === 0 && decoded.recipe) {
        // Native import succeeded
        const recipe = await this.client.createRecipe({
          name: decoded.recipe.name,
          note: decoded.recipe.note || null,
          sourceName: decoded.recipe.sourceName || null,
          sourceUrl: decoded.recipe.sourceUrl || url,
          prepTime: decoded.recipe.prepTime || null,
          cookTime: decoded.recipe.cookTime || null,
          servings: decoded.recipe.servings || null,
          nutritionalInfo: decoded.recipe.nutritionalInfo || null,
          rating: decoded.recipe.rating || null,
          ingredients: decoded.recipe.ingredients || [],
          preparationSteps: decoded.recipe.preparationSteps || [],
        });
        recipe.isNewRecipeFromWebImport = true;
        recipe.creationTimestamp = Date.now() / 1000;
        await recipe.save();
        console.error(`Imported recipe from URL (native): ${recipe.name}`);

        return {
          name: recipe.name,
          identifier: recipe.identifier,
          ingredientCount: decoded.recipe.ingredients?.length || 0,
          stepCount: decoded.recipe.preparationSteps?.length || 0,
          source: decoded.recipe.sourceName || null,
          sourceUrl: decoded.recipe.sourceUrl || url,
          isPremiumUser: decoded.isPremiumUser,
          freeImportsRemaining: decoded.freeRecipeImportsRemainingCount,
          method: 'native',
        };
      }
      nativeError = decoded.siteSpecificHelpText || 'Native import returned no recipe';
    } catch (error) {
      nativeError = error.message;
    }

    // Fallback: use normalizer
    console.error(`Native import failed (${nativeError}), trying normalizer fallback...`);
    try {
      const normalized = await normalizeRecipe({ url });
      const created = await this.createRecipe({
        name: normalized.name,
        ingredients: normalized.ingredients,
        preparationSteps: normalized.preparationSteps,
        note: normalized.note,
        sourceName: normalized.sourceName,
        sourceUrl: normalized.sourceUrl || url,
        prepTime: normalized.prepTime,
        cookTime: normalized.cookTime,
        servings: normalized.servings,
      });
      console.error(`Imported recipe from URL (normalizer fallback): ${created.name}`);

      return {
        name: created.name,
        identifier: created.identifier,
        ingredientCount: normalized.ingredients.length,
        stepCount: normalized.preparationSteps.length,
        source: normalized.sourceName || null,
        sourceUrl: normalized.sourceUrl || url,
        method: 'normalizer',
      };
    } catch (fallbackError) {
      throw new Error(`Failed to import recipe from URL: native import failed (${nativeError}), normalizer also failed (${fallbackError.message})`);
    }
  }

  async createRecipe({ name, ingredients = [], preparationSteps = [], note = null, sourceName = null, sourceUrl = null, prepTime = null, cookTime = null, servings = null }) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const nowSecs = Date.now() / 1000;
      const recipeObj = { name, creationTimestamp: nowSecs };
      if (note) recipeObj.note = note;
      if (sourceName) recipeObj.sourceName = sourceName;
      if (sourceUrl) recipeObj.sourceUrl = sourceUrl;
      if (prepTime) recipeObj.prepTime = prepTime;
      if (cookTime) recipeObj.cookTime = cookTime;
      if (servings) recipeObj.servings = servings;
      if (preparationSteps.length > 0) recipeObj.preparationSteps = preparationSteps;
      if (ingredients.length > 0) {
        recipeObj.ingredients = ingredients.map(i => ({
          rawIngredient: typeof i === 'string' ? i : i.rawIngredient || `${i.quantity || ''} ${i.name || ''}`.trim(),
          name: typeof i === 'string' ? i : (i.name || i.rawIngredient || null),
          quantity: typeof i === 'string' ? null : i.quantity || null,
          note: typeof i === 'string' ? null : i.note || null,
        }));
      }
      const recipe = await this.client.createRecipe(recipeObj);
      await recipe.save();
      console.error(`Created recipe: ${recipe.name}`);
      return { identifier: recipe.identifier, name: recipe.name };
    } catch (error) {
      throw new Error(`Failed to create recipe: ${error.message}`);
    }
  }

  async deleteRecipe(recipeName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipes = await this.client.getRecipes();
      const recipe = recipes.find(r => r.name && r.name.toLowerCase() === recipeName.toLowerCase());
      if (!recipe) {
        throw new Error(`Recipe "${recipeName}" not found`);
      }
      await recipe.delete();
      console.error(`Deleted recipe: ${recipe.name}`);
    } catch (error) {
      throw new Error(`Failed to delete recipe: ${error.message}`);
    }
  }

  // ===== MEAL PLANNING =====

  async getMealPlanEvents() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const events = await this.client.getMealPlanningCalendarEvents();
      return events.map(e => ({
        identifier: e.identifier,
        date: e.date instanceof Date ? e.date.toISOString().slice(0, 10) : String(e.date),
        title: e.title || null,
        details: e.details || null,
        labelName: e.label ? e.label.name : null,
        labelColor: e.label ? e.label.hexColor : null,
        recipeName: e.recipe ? e.recipe.name : null,
        recipeId: e.recipeId || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get meal plan events: ${error.message}`);
    }
  }

  async getMealPlanLabels() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      await this.client.getMealPlanningCalendarEvents();
      return (this.client.mealPlanningCalendarEventLabels || []).map(l => ({
        identifier: l.identifier,
        name: l.name,
        hexColor: l.hexColor,
        sortIndex: l.sortIndex,
      }));
    } catch (error) {
      throw new Error(`Failed to get meal plan labels: ${error.message}`);
    }
  }

  async createMealPlanEvent({ date, title = null, recipeId = null, labelId = null, details = null }) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const eventObj = { date: new Date(`${date}T12:00:00`) };
      if (title) eventObj.title = title;
      if (recipeId) eventObj.recipeId = recipeId;
      if (labelId) eventObj.labelId = labelId;
      if (details) eventObj.details = details;
      const event = await this.client.createEvent(eventObj);
      await event.save();
      console.error(`Created meal plan event for ${date}`);
      return { identifier: event.identifier, date: date };
    } catch (error) {
      throw new Error(`Failed to create meal plan event: ${error.message}`);
    }
  }

  async deleteMealPlanEvent(eventId) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const events = await this.client.getMealPlanningCalendarEvents();
      const event = events.find(e => e.identifier === eventId);
      if (!event) {
        throw new Error(`Meal plan event "${eventId}" not found`);
      }
      await event.delete();
      console.error(`Deleted meal plan event: ${eventId}`);
    } catch (error) {
      throw new Error(`Failed to delete meal plan event: ${error.message}`);
    }
  }

  // ===== FAVORITES & RECENTS =====

  async getFavoriteItems(listName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      await this.connect(listName);
      const favList = this.client.getFavoriteItemsByListId(this.targetList.identifier);
      if (!favList || !favList.items) {
        return [];
      }
      return favList.items.map(i => ({
        name: i.name,
        details: i.details || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get favorite items: ${error.message}`);
    }
  }

  async getRecentItems(listName) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      await this.connect(listName);
      const items = this.client.getRecentItemsByListId(this.targetList.identifier);
      if (!items) {
        return [];
      }
      return items.map(i => ({
        name: i.name,
        details: i.details || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get recent items: ${error.message}`);
    }
  }

  // ===== RECIPE COLLECTIONS =====

  async getRecipeCollections() {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const userData = await this.client._getUserData(true);
      const collections = userData.recipeDataResponse.recipeCollections || [];
      const recipes = await this.client.getRecipes();
      return collections.map(c => ({
        identifier: c.identifier,
        name: c.name,
        recipeCount: c.recipeIds ? c.recipeIds.length : 0,
        recipeNames: (c.recipeIds || []).map(id => {
          const r = recipes.find(r => r.identifier === id);
          return r ? r.name : id;
        }),
      }));
    } catch (error) {
      throw new Error(`Failed to get recipe collections: ${error.message}`);
    }
  }

  async createRecipeCollection(name, recipeNames = []) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const recipeIds = [];
      if (recipeNames.length > 0) {
        const recipes = await this.client.getRecipes();
        for (const rName of recipeNames) {
          const r = recipes.find(r => r.name && r.name.toLowerCase() === rName.toLowerCase());
          if (r) recipeIds.push(r.identifier);
        }
      }
      const collection = this.client.createRecipeCollection({ name, recipeIds });
      await collection.save();
      console.error(`Created recipe collection: ${name}`);
      return { identifier: collection.identifier, name: collection.name };
    } catch (error) {
      throw new Error(`Failed to create recipe collection: ${error.message}`);
    }
  }

  async deleteRecipeCollection(name) {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const userData = await this.client._getUserData(true);
      const collections = userData.recipeDataResponse.recipeCollections || [];
      const raw = collections.find(c => c.name && c.name.toLowerCase() === name.toLowerCase());
      if (!raw) throw new Error(`Recipe collection "${name}" not found`);
      const collection = this.client.createRecipeCollection(raw);
      await collection.delete();
      console.error(`Deleted recipe collection: ${name}`);
    } catch (error) {
      throw new Error(`Failed to delete recipe collection: ${error.message}`);
    }
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.teardown();
        console.error('Disconnected from AnyList');
      } catch (error) {
        const wrappedError = new Error(`Error during disconnect: ${error.message}`);
        console.error(wrappedError.message);
        throw wrappedError;
      }
    }
    this.client = null;
    this.targetList = null;
  }
}

export default AnyListClient;
