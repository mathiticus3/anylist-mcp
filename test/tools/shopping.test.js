import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../src/tools/shopping.js';
import { MockAnyListClient, createMockServer } from './helpers.js';

describe('shopping tool', () => {
  let client;
  let handlers;

  beforeEach(() => {
    client = new MockAnyListClient();
    const { server, handlers: h } = createMockServer();
    register(server, () => Promise.resolve(client));
    handlers = h;
  });

  describe('add_item', () => {
    it('adds an item', async () => {
      const result = await handlers.shopping({ action: 'add_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully added "Milk"'));
      assert.equal(client._items.length, 1);
      assert.equal(client._items[0].name, 'Milk');
    });

    it('adds item with quantity and notes', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Eggs', quantity: 2, notes: 'organic' });
      assert.equal(client._items[0].quantity, 2);
      assert.equal(client._items[0].notes, 'organic');
    });


    it ('should default to "other" category if not provided', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Bread' });
      assert.equal(client._items[0].category, 'other');
    });

    it('should set category when provided', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Bananas', category: 'produce' });
      assert.equal(client._items[0].category, 'produce');
    });

    it('should return error for invalid category', async () => {
      const result = await handlers.shopping({ action: 'add_item', name: 'Soda', category: 'invalid-category' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });
  });

  describe('check_item', () => {
    it('checks off an existing item', async () => {
      client._items.push({ name: 'Milk', checked: false });
      const result = await handlers.shopping({ action: 'check_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully checked off'));
      assert.equal(client._items[0].checked, true);
    });

    it('returns error for non-existent item', async () => {
      const result = await handlers.shopping({ action: 'check_item', name: 'Nonexistent' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });
  });

  describe('delete_item', () => {
    it('deletes an existing item', async () => {
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'delete_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully deleted'));
      assert.equal(client._items.length, 0);
    });

    it('returns error for non-existent item', async () => {
      const result = await handlers.shopping({ action: 'delete_item', name: 'Ghost' });
      assert.equal(result.isError, true);
    });
  });

  describe('list_items', () => {
    it('returns empty message when no items', async () => {
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('No unchecked items'));
    });

    it('lists items grouped by category', async () => {
      client._items.push({ name: 'Milk', category: 'Dairy' }, { name: 'Bread', category: 'Bakery' });
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('Milk'));
      assert.ok(result.content[0].text.includes('Bread'));
      assert.ok(result.content[0].text.includes('Dairy'));
      assert.ok(result.content[0].text.includes('Bakery'));
    });

    it('excludes checked items by default', async () => {
      client._items.push({ name: 'Milk', checked: false }, { name: 'Done', checked: true });
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('Milk'));
      assert.ok(!result.content[0].text.includes('Done'));
    });

    it('includes checked items when requested', async () => {
      client._items.push({ name: 'Milk', checked: false }, { name: 'Done', checked: true });
      const result = await handlers.shopping({ action: 'list_items', include_checked: true });
      assert.ok(result.content[0].text.includes('Done'));
    });

    it('returns structured content alongside the prose', async () => {
      client._items.push({ name: 'Milk', category: 'Dairy' }, { name: 'Bread', category: 'Bakery' });
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.structuredContent, 'list_items must carry structuredContent');
      assert.equal(result.structuredContent.items.length, 2);
      assert.deepEqual(
        result.structuredContent.items.map(i => i.name).sort(),
        ['Bread', 'Milk'],
      );
      // The prose is what conversational clients read; it must not change shape.
      assert.ok(result.content[0].text.includes('Milk'));
    });

    it('reports checked state and notes in structured content', async () => {
      client._items.push(
        { name: 'Milk', checked: false, notes: '[APP-1] buy the standard size' },
        { name: 'Done', checked: true, notes: '[PLB-3] already handled' },
      );
      const result = await handlers.shopping({
        action: 'list_items', include_checked: true, include_notes: true,
      });
      const byName = Object.fromEntries(result.structuredContent.items.map(i => [i.name, i]));
      assert.equal(byName.Milk.checked, false);
      assert.equal(byName.Done.checked, true);
      // Notes carry sync keys for downstream integrations; they must survive verbatim.
      assert.equal(byName.Done.note, '[PLB-3] already handled');
    });

    it('returns an empty structured item list rather than nothing', async () => {
      const result = await handlers.shopping({ action: 'list_items' });
      assert.deepEqual(result.structuredContent.items, []);
    });

    it('includes notes when requested', async () => {
      client._items.push({ name: 'Milk', notes: 'whole milk' });
      const result = await handlers.shopping({ action: 'list_items', include_notes: true });
      assert.ok(result.content[0].text.includes('whole milk'));
    });
  });

  describe('list_lists', () => {
    it('returns empty message when no lists', async () => {
      const result = await handlers.shopping({ action: 'list_lists' });
      assert.ok(result.content[0].text.includes('No lists found'));
    });

    it('returns list names with counts', async () => {
      client._lists = [
        { name: 'Groceries', uncheckedCount: 5 },
        { name: 'Costco', uncheckedCount: 2 },
      ];
      const result = await handlers.shopping({ action: 'list_lists' });
      assert.ok(result.content[0].text.includes('Groceries'));
      assert.ok(result.content[0].text.includes('5 unchecked'));
    });
  });

  describe('get_favorites', () => {
    it('returns empty message when no favorites', async () => {
      const result = await handlers.shopping({ action: 'get_favorites' });
      assert.ok(result.content[0].text.includes('No favorite items'));
    });

    it('returns favorite items', async () => {
      client._favorites = [{ name: 'Bananas', details: 'organic' }];
      const result = await handlers.shopping({ action: 'get_favorites' });
      assert.ok(result.content[0].text.includes('Bananas'));
      assert.ok(result.content[0].text.includes('organic'));
    });
  });

  describe('get_recents', () => {
    it('returns empty message when no recents', async () => {
      const result = await handlers.shopping({ action: 'get_recents' });
      assert.ok(result.content[0].text.includes('No recent items'));
    });

    it('returns recent items', async () => {
      client._recents = [{ name: 'Avocado' }];
      const result = await handlers.shopping({ action: 'get_recents' });
      assert.ok(result.content[0].text.includes('Avocado'));
    });
  });

  // ── Category sets ──────────────────────────────────────────────────────────

  function punchListGroups() {
    return [
      { identifier: 'g-urgency', name: 'Category Set', defaultCategoryId: 'c-urgent',
        categories: [
          { identifier: 'c-urgent', name: 'Urgent' },
          { identifier: 'c-soon', name: 'Soon' },
          { identifier: 'c-later', name: 'Later' },
          { identifier: 'c-ideas', name: 'Ideas' },
        ] },
      { identifier: 'g-areas', name: 'Punchlist Areas', defaultCategoryId: 'c-interior',
        categories: [
          { identifier: 'c-ext', name: 'Exterior' },
          { identifier: 'c-gar', name: 'Garage' },
          { identifier: 'c-interior', name: 'Interior' },
          { identifier: 'c-plb', name: 'Plumbing' },
          { identifier: 'c-hvac', name: 'HVAC' },
          { identifier: 'c-lot', name: 'Lot Landscaping' },
          { identifier: 'c-win', name: 'Windows' },
        ] },
    ];
  }

  describe('list_categories', () => {
    it('reports when the list has no category sets', async () => {
      const result = await handlers.shopping({ action: 'list_categories' });
      assert.ok(result.content[0].text.includes('no custom category sets'));
    });

    it('lists all sets with categories and defaults', async () => {
      client._categoryGroups = punchListGroups();
      const result = await handlers.shopping({ action: 'list_categories' });
      const text = result.content[0].text;
      assert.ok(text.includes('Category Set'));
      assert.ok(text.includes('Punchlist Areas'));
      assert.ok(text.includes('Urgent'));
      assert.ok(text.includes('Lot Landscaping'));
      assert.ok(text.includes('unassigned items appear in: Urgent'));
    });
  });

  describe('add_item with category sets', () => {
    beforeEach(() => { client._categoryGroups = punchListGroups(); });

    it('resolves a bare category name against the list sets (case-insensitive)', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Fix handrail', category: 'urgent' });
      assert.deepEqual(client._items[0].categories, { 'Category Set': 'Urgent' });
    });

    it('assigns one category per set via the categories map', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Fix handrail',
        categories: { 'Category Set': 'Urgent', 'Punchlist Areas': 'Interior' } });
      assert.deepEqual(client._items[0].categories, { 'Category Set': 'Urgent', 'Punchlist Areas': 'Interior' });
    });

    it('errors on an unknown category set', async () => {
      const result = await handlers.shopping({ action: 'add_item', name: 'X',
        categories: { 'Nope': 'Urgent' } });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('Category set "Nope" not found'));
    });

    it('errors on an unknown category within a set, listing options', async () => {
      const result = await handlers.shopping({ action: 'add_item', name: 'X',
        categories: { 'Category Set': 'Whenever' } });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found in set "Category Set"'));
      assert.ok(result.content[0].text.includes('Urgent'));
    });
  });

  describe('update_item', () => {
    beforeEach(() => { client._categoryGroups = punchListGroups(); });

    it('renames an item', async () => {
      client._items.push({ name: '1-Urgent: Fix handrail' });
      const result = await handlers.shopping({ action: 'update_item', name: '1-Urgent: Fix handrail', new_name: 'Fix handrail' });
      assert.ok(result.content[0].text.includes('renamed to "Fix handrail"'));
      assert.equal(client._items[0].name, 'Fix handrail');
    });

    it('recategorizes without touching other sets', async () => {
      client._items.push({ name: 'Fix handrail', categories: { 'Punchlist Areas': 'Interior' } });
      await handlers.shopping({ action: 'update_item', name: 'Fix handrail', categories: { 'Category Set': 'Soon' } });
      assert.deepEqual(client._items[0].categories, { 'Punchlist Areas': 'Interior', 'Category Set': 'Soon' });
    });

    it('updates notes and quantity in place', async () => {
      client._items.push({ name: 'Fix handrail', notes: 'old', quantity: 1 });
      await handlers.shopping({ action: 'update_item', name: 'Fix handrail', notes: 'new note', quantity: 2 });
      assert.equal(client._items[0].notes, 'new note');
      assert.equal(client._items[0].quantity, 2);
    });

    it('returns error for a missing item', async () => {
      const result = await handlers.shopping({ action: 'update_item', name: 'Ghost', new_name: 'Spirit' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });
  });

  describe('uncheck_item', () => {
    it('unchecks a checked item', async () => {
      client._items.push({ name: 'Milk', checked: true });
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully unchecked'));
      assert.equal(client._items[0].checked, false);
    });

    it('returns error for non-existent item', async () => {
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'Ghost' });
      assert.equal(result.isError, true);
    });
  });

  describe('add_items (bulk)', () => {
    beforeEach(() => { client._categoryGroups = punchListGroups(); });

    it('adds multiple items with per-set categories', async () => {
      const result = await handlers.shopping({ action: 'add_items', items: [
        { name: 'Fix handrail', categories: { 'Category Set': 'Urgent', 'Punchlist Areas': 'Interior' } },
        { name: 'Clean gutters', notes: 'before winter', categories: { 'Category Set': 'Soon', 'Punchlist Areas': 'Exterior' } },
      ] });
      assert.ok(result.content[0].text.includes('Added 2/2'));
      assert.equal(client._items.length, 2);
      assert.equal(client._items[1].notes, 'before winter');
    });

    it('continues past individual failures and reports them', async () => {
      const result = await handlers.shopping({ action: 'add_items', items: [
        { name: 'Good item', categories: { 'Category Set': 'Later' } },
        { name: 'Bad item', categories: { 'Nope': 'Urgent' } },
      ] });
      assert.ok(result.content[0].text.includes('Added 1/2'));
      assert.ok(result.content[0].text.includes('Bad item'));
      assert.equal(client._items.length, 1);
    });

    it('errors on an empty items array', async () => {
      const result = await handlers.shopping({ action: 'add_items', items: [] });
      assert.equal(result.isError, true);
    });
  });

  describe('category management', () => {
    beforeEach(() => { client._categoryGroups = punchListGroups(); });

    it('creates a category in a named set', async () => {
      await handlers.shopping({ action: 'create_category', name: 'Basement', category_set: 'Punchlist Areas' });
      const areas = client._categoryGroups[1].categories.map(c => c.name);
      assert.ok(areas.includes('Basement'));
    });

    it('renames a category', async () => {
      await handlers.shopping({ action: 'rename_category', name: 'Ideas', new_name: 'Someday' });
      const names = client._categoryGroups[0].categories.map(c => c.name);
      assert.ok(names.includes('Someday'));
      assert.ok(!names.includes('Ideas'));
    });

    it('deletes a category', async () => {
      await handlers.shopping({ action: 'delete_category', name: 'Ideas', category_set: 'Category Set' });
      const names = client._categoryGroups[0].categories.map(c => c.name);
      assert.ok(!names.includes('Ideas'));
    });
  });

  describe('list_items with category sets', () => {
    beforeEach(() => {
      client._categoryGroups = punchListGroups();
      client._items.push(
        { name: 'Fix handrail', categories: { 'Category Set': 'Urgent', 'Punchlist Areas': 'Interior' } },
        { name: 'Clean gutters', categories: { 'Category Set': 'Soon', 'Punchlist Areas': 'Exterior' } },
        { name: 'Unassigned thing', categories: {} },
      );
    });

    it('groups by the primary set by default and mentions other sets', async () => {
      const result = await handlers.shopping({ action: 'list_items' });
      const text = result.content[0].text;
      assert.ok(text.includes('**Urgent**'));
      assert.ok(text.includes('**Soon**'));
      assert.ok(text.includes('other sets: Punchlist Areas'));
    });

    it('groups by a chosen set via category_set', async () => {
      const result = await handlers.shopping({ action: 'list_items', category_set: 'Punchlist Areas' });
      const text = result.content[0].text;
      assert.ok(text.includes('**Exterior**'));
      assert.ok(text.includes('**Interior**'));
    });

    it('puts unassigned items in the set default category', async () => {
      const result = await handlers.shopping({ action: 'list_items' });
      const urgentBlock = result.content[0].text.split('**Urgent**')[1].split('**')[0];
      assert.ok(urgentBlock.includes('Unassigned thing'));
    });

    it('errors on an unknown category set', async () => {
      const result = await handlers.shopping({ action: 'list_items', category_set: 'Nope' });
      assert.equal(result.isError, true);
    });
  });

  describe('set_item_store', () => {
    it('assigns a store to an item', async () => {
      client._stores = [{ name: 'Costco' }];
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'set_item_store', name: 'Milk', store_name: 'Costco' });
      assert.ok(result.content[0].text.includes('Successfully assigned'));
      assert.equal(client._items[0].store, 'Costco');
    });

    it('errors on an unknown store', async () => {
      client._stores = [{ name: 'Costco' }];
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'set_item_store', name: 'Milk', store_name: 'Nope' });
      assert.equal(result.isError, true);
    });
  });
});
