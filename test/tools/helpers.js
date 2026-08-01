/**
 * Shared test infrastructure for tool-level tests.
 *
 * createMockServer() — returns a minimal MCP server stub that captures
 *   registerTool() calls, plus the resulting handlers map.
 *
 * MockAnyListClient — in-memory client that owns its own state arrays.
 *   Call client.reset() (or create a fresh instance) in beforeEach.
 */

import { STANDARD_CATEGORIES } from '../../src/anylist-client.js';

export function createMockServer() {
  const handlers = {};
  const server = {
    registerTool: (name, _schema, handler) => {
      handlers[name] = handler;
      // Return a stub registeredTool so callers can call .update() without error.
      return { update: () => {} };
    },
    // elicitation.js calls server.server.getClientCapabilities() to detect support.
    // Returning null means elicitation is disabled; missing-param paths throw instead.
    server: { getClientCapabilities: () => null },
  };
  return { server, handlers };
}

export class MockAnyListClient {
  constructor() {
    this.client = null;
    this.targetList = null;
    this._connected = false;
    this.defaultListName = null;
    this._items = [];
    this._lists = [];
    this._favorites = [];
    this._recents = [];
    this._recipes = [];
    this._events = [];
    this._labels = [];
    this._collections = [];
    this._pendingImport = null;
    this._stores = [];
    // Category sets: [{ identifier, name, defaultCategoryId, categories: [{identifier, name}] }]
    this._categoryGroups = [];
  }

  reset() {
    this.client = null;
    this.targetList = null;
    this._connected = false;
    this._items = [];
    this._lists = [];
    this._favorites = [];
    this._recents = [];
    this._recipes = [];
    this._events = [];
    this._labels = [];
    this._collections = [];
    this._pendingImport = null;
    this._stores = [];
    this._categoryGroups = [];
  }

  async ensureAuthenticated() {
    this.client = this.client || {};
    return this.client;
  }

  async connect(listName = null) {
    const name = listName || process.env.ANYLIST_LIST_NAME || 'Groceries';
    this._connected = true;
    const items = this._items;
    this.targetList = {
      name,
      identifier: 'list-123',
      items,
      getItemByName: (n) => items.find(i => i.name.toLowerCase() === n.toLowerCase()) || null,
    };
    this.client = {};
    return true;
  }

  getLists() { return this._lists; }
  getStores() { return this._stores || []; }

  _findGroup(nameOrId) {
    const q = String(nameOrId || '').trim().toLowerCase();
    return this._categoryGroups.find(g => g.name.toLowerCase() === q || g.identifier === nameOrId) || null;
  }

  getCategoryGroups() {
    return this._categoryGroups.map(g => ({
      identifier: g.identifier,
      name: g.name,
      defaultCategory: (g.categories.find(c => c.identifier === g.defaultCategoryId) || {}).name || null,
      categories: g.categories.map(c => ({ identifier: c.identifier, name: c.name })),
    }));
  }

  // Mirrors AnyListClient._resolveCategories semantics closely enough for tool tests.
  _resolveCategories(category, categories) {
    const out = {};
    if (categories) {
      for (const [setName, catName] of Object.entries(categories)) {
        const g = this._findGroup(setName);
        if (!g) throw new Error(`Category set "${setName}" not found on list "${this.targetList.name}". Available sets: ${this._categoryGroups.map(x => x.name).join(', ') || '(none)'}`);
        const c = g.categories.find(c => c.name.toLowerCase() === String(catName).trim().toLowerCase());
        if (!c) throw new Error(`Category "${catName}" not found in set "${g.name}". Available: ${g.categories.map(x => x.name).join(', ')}`);
        out[g.name] = c.name;
      }
    }
    let legacy = null;
    if (category && category !== 'other') {
      let found = null;
      for (const g of this._categoryGroups) {
        const c = g.categories.find(c => c.name.toLowerCase() === category.trim().toLowerCase());
        if (c) { found = { g, c }; break; }
      }
      if (found) {
        if (!(found.g.name in out)) out[found.g.name] = found.c.name;
      } else if (this._categoryGroups.length === 0) {
        if (!STANDARD_CATEGORIES.includes(category)) {
          throw new Error(`Category "${category}" not found on list "${this.targetList.name}". Available categories: ${STANDARD_CATEGORIES.join(', ')}`);
        }
        legacy = category;
      } else {
        throw new Error(`Category "${category}" not found on list "${this.targetList.name}". Available categories: ${this._categoryGroups.flatMap(g => g.categories.map(c => c.name)).join(', ')}`);
      }
    }
    return { assignments: out, legacy };
  }

  async addItem(name, qty, notes, category, store = null, categories = null) {
    const { assignments, legacy } = this._resolveCategories(category, categories);
    const existing = this._items.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.checked = false;
      existing.quantity = qty;
      if (notes !== null && notes !== undefined) existing.notes = notes;
      existing.categories = { ...(existing.categories || {}), ...assignments };
      if (legacy) existing.category = legacy;
      return;
    }
    this._items.push({ name, quantity: qty, notes, category: legacy || category, store, categories: assignments });
  }

  async updateItem(name, { newName = null, quantity = null, notes = null, category = null, categories = null } = {}) {
    const item = this._items.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (!item) throw new Error(`Item "${name}" not found in list, so can't update it`);
    const { assignments, legacy } = this._resolveCategories(category, categories);
    if (newName !== null) item.name = newName;
    if (quantity !== null) item.quantity = quantity;
    if (notes !== null) item.notes = notes;
    if (legacy) item.category = legacy;
    item.categories = { ...(item.categories || {}), ...assignments };
    return { name: item.name };
  }

  async uncheckItem(name) {
    const item = this._items.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (!item) throw new Error(`Item "${name}" not found in list, so can't uncheck it`);
    item.checked = false;
  }

  async createCategory(name, categorySet = null) {
    const group = categorySet ? this._findGroup(categorySet) : this._categoryGroups[0];
    if (!group) throw new Error(categorySet
      ? `Category set "${categorySet}" not found on list "${this.targetList.name}".`
      : `List "${this.targetList.name}" has no category sets.`);
    const created = { identifier: `cat-${group.categories.length + 1}`, name };
    group.categories.push(created);
    return created;
  }

  async renameCategory(name, newName, categorySet = null) {
    const groups = categorySet ? [this._findGroup(categorySet)].filter(Boolean) : this._categoryGroups;
    for (const g of groups) {
      const c = g.categories.find(c => c.name.toLowerCase() === name.trim().toLowerCase());
      if (c) { c.name = newName; return c; }
    }
    throw new Error(`Category "${name}" not found on list "${this.targetList.name}".`);
  }

  async deleteCategory(name, categorySet = null) {
    const groups = categorySet ? [this._findGroup(categorySet)].filter(Boolean) : this._categoryGroups;
    for (const g of groups) {
      const idx = g.categories.findIndex(c => c.name.toLowerCase() === name.trim().toLowerCase());
      if (idx !== -1) { g.categories.splice(idx, 1); return; }
    }
    throw new Error(`Category "${name}" not found on list "${this.targetList.name}".`);
  }

  async removeItem(name) {
    const idx = this._items.findIndex(i => i.name === name);
    if (idx === -1) throw new Error(`Item "${name}" not found in list, so can't check it`);
    this._items[idx].checked = true;
  }

  async deleteItem(name) {
    const idx = this._items.findIndex(i => i.name === name);
    if (idx === -1) throw new Error(`Item "${name}" not found in list, so can't delete it`);
    this._items.splice(idx, 1);
  }

  async getItems(includeChecked = false, includeNotes = false, categorySet = null) {
    let items = [...this._items];
    if (!includeChecked) items = items.filter(i => !i.checked);
    let group = null;
    if (categorySet) {
      group = this._findGroup(categorySet);
      if (!group) throw new Error(`Category set "${categorySet}" not found on list "${this.targetList.name}". Available sets: ${this._categoryGroups.map(g => g.name).join(', ') || '(none)'}`);
    } else if (this._categoryGroups.length > 0) {
      group = this._categoryGroups[0];
    }
    const defaultName = group
      ? ((group.categories.find(c => c.identifier === group.defaultCategoryId) || {}).name || 'Uncategorized')
      : null;
    return items.map(i => ({
      name: i.name,
      quantity: i.quantity || 1,
      checked: i.checked || false,
      category: group
        ? ((i.categories || {})[group.name] || defaultName)
        : (i.category || 'other'),
      ...(includeNotes && i.notes ? { note: i.notes } : {}),
      store: i.store || null,
    }));
  }

  async setItemStore(name, store) {
    const item = this._items.find(i => i.name === name);
    if (!item) throw new Error(`Item "${name}" not found in list`);
    item.store = store || null;
  }

  async getFavoriteItems() { return this._favorites; }
  async getRecentItems() { return this._recents; }

  async getRecipes(search = null) {
    let r = [...this._recipes];
    if (search) r = r.filter(x => x.name.toLowerCase().includes(search.toLowerCase()));
    return r;
  }

  async getRecipeDetails(name) {
    const r = this._recipes.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!r) throw new Error(`Recipe "${name}" not found`);
    return { ...r, ingredients: r.ingredients || [], preparationSteps: r.preparationSteps || [] };
  }

  async createRecipe(opts) {
    this._recipes.push(opts);
    return { identifier: 'r-1', name: opts.name };
  }

  async deleteRecipe(name) {
    const idx = this._recipes.findIndex(r => r.name.toLowerCase() === name.toLowerCase());
    if (idx === -1) throw new Error(`Recipe "${name}" not found`);
    this._recipes.splice(idx, 1);
  }

  async importRecipeFromUrl(url) {
    if (!this._pendingImport) throw new Error('Could not parse recipe from URL. The site may not be supported.');
    const imp = this._pendingImport;
    this._recipes.push({ identifier: 'r-imported', name: imp.name, ...imp });
    return {
      name: imp.name,
      identifier: 'r-imported',
      ingredientCount: imp.ingredientCount || 0,
      stepCount: imp.stepCount || 0,
      source: imp.source || null,
      sourceUrl: imp.sourceUrl || url,
    };
  }

  async getMealPlanEvents() { return [...this._events]; }
  async getMealPlanLabels() { return [...this._labels]; }

  async createMealPlanEvent(opts) {
    this._events.push(opts);
    return { identifier: 'e-1', date: opts.date };
  }

  async deleteMealPlanEvent(id) {
    const idx = this._events.findIndex(e => e.identifier === id);
    if (idx === -1) throw new Error(`Meal plan event "${id}" not found`);
    this._events.splice(idx, 1);
  }

  async getRecipeCollections() { return [...this._collections]; }

  async createRecipeCollection(name, recipeNames = []) {
    const c = { identifier: 'c-1', name, recipeCount: recipeNames.length, recipeNames };
    this._collections.push(c);
    return c;
  }

  async deleteRecipeCollection(name) {
    const idx = this._collections.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
    if (idx === -1) throw new Error(`Recipe collection "${name}" not found`);
    this._collections.splice(idx, 1);
  }
}
