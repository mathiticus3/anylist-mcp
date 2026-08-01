import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register as registerRecipes } from '../../src/tools/recipes.js';
import { register as registerMealPlan } from '../../src/tools/meal-plan.js';
import { register as registerRecipeCollections } from '../../src/tools/recipe-collections.js';
import { register as registerHealth } from '../../src/tools/health.js';
import { register as registerShopping } from '../../src/tools/shopping.js';
import { MockAnyListClient, createMockServer } from './helpers.js';

// Regression: account-level endpoints (recipes, meal planning, recipe
// collections) must NOT be gated on shopping-list resolution. A missing or
// nonexistent default list used to throw on connect() during init for every
// tool, hard-blocking these endpoints even though they never touch a list.
//
// Each test wires the mock so that ANY attempt to resolve a list throws — the
// same failure a nonexistent "Groceries" default produced — and asserts the
// account-level action still succeeds. If a tool regresses to calling connect()
// again, connect() throws and the assertion fails.
describe('lazy list resolution — account-level tools do not resolve a list', () => {
  let client;
  let handlers;
  let savedEnvList;

  beforeEach(() => {
    savedEnvList = process.env.ANYLIST_LIST_NAME;
    delete process.env.ANYLIST_LIST_NAME;

    client = new MockAnyListClient();
    // Any list resolution blows up, exactly like a bad default list.
    client.connect = async () => {
      throw new Error('List "Groceries" not found. Available lists: Costco List');
    };

    const { server, handlers: h } = createMockServer();
    registerRecipes(server, () => Promise.resolve(client));
    registerMealPlan(server, () => Promise.resolve(client));
    registerRecipeCollections(server, () => Promise.resolve(client));
    registerHealth(server, () => Promise.resolve(client));
    registerShopping(server, () => Promise.resolve(client));
    handlers = h;
  });

  afterEach(() => {
    if (savedEnvList === undefined) delete process.env.ANYLIST_LIST_NAME;
    else process.env.ANYLIST_LIST_NAME = savedEnvList;
  });

  it('recipes list works when list resolution would fail', async () => {
    client._recipes.push({ identifier: 'r-1', name: 'Pasta' });
    const result = await handlers.recipes({ action: 'list' });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Pasta'));
  });

  it('meal_plan list_events works when list resolution would fail', async () => {
    const result = await handlers.meal_plan({ action: 'list_events' });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes('No meal plan events'));
  });

  it('recipe_collections list works when list resolution would fail', async () => {
    const result = await handlers.recipe_collections({ action: 'list' });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes('No recipe collections'));
  });

  it('health_check reports auth success with no default list configured', async () => {
    // No list_name, no default, no env — must not force a list to exist.
    const result = await handlers.health_check({});
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Successfully connected'));
    assert.ok(result.content[0].text.includes('No default list configured'));
  });

  it('shopping list_lists enumerates lists when list resolution would fail', async () => {
    client._lists = [{ name: 'Costco List', uncheckedCount: 3 }];
    const result = await handlers.shopping({ action: 'list_lists' });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Costco List'));
  });

  it('all account-level tools authenticate (client established)', async () => {
    await handlers.recipes({ action: 'list' });
    assert.ok(client.client, 'ensureAuthenticated() should have set client.client');
  });
});
