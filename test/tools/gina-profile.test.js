import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerAllTools } from "../../src/tools/index.js";
import { MockAnyListClient, createMockServer } from "./helpers.js";

const GINA_TOOLS = [
  "health_check",
  "shopping_read",
  "shopping_add_item",
  "recipes_read",
  "recipes_create",
  "meal_plan_read",
  "meal_plan_create",
  "recipe_collections_read",
  "recipe_collections_create",
];

describe("Gina AnyList tool profile", () => {
  let client;
  let handlers;
  let toolConfigs;

  beforeEach(() => {
    client = new MockAnyListClient();
    const mock = createMockServer();
    registerAllTools(mock.server, () => Promise.resolve(client), { profile: "gina" });
    handlers = mock.handlers;
    toolConfigs = mock.toolConfigs;
  });

  it("registers only read and single-record additive tools", () => {
    assert.deepEqual(Object.keys(handlers), GINA_TOOLS);
    assert.deepEqual(toolConfigs.shopping_read.inputSchema.action.options, [
      "list_lists",
      "list_items",
      "list_categories",
      "get_favorites",
      "get_recents",
      "list_stores",
    ]);
    assert.deepEqual(toolConfigs.shopping_add_item.inputSchema.action.options, ["add_item"]);
    assert.deepEqual(toolConfigs.recipes_read.inputSchema.action.options, ["list", "get"]);
    assert.deepEqual(toolConfigs.recipes_create.inputSchema.action.options, ["create"]);
    assert.deepEqual(toolConfigs.meal_plan_read.inputSchema.action.options, ["list_events", "list_labels"]);
    assert.deepEqual(toolConfigs.meal_plan_create.inputSchema.action.options, ["create_event"]);
    assert.deepEqual(toolConfigs.recipe_collections_read.inputSchema.action.options, ["list"]);
    assert.deepEqual(toolConfigs.recipe_collections_create.inputSchema.action.options, ["create"]);
  });

  it("publishes accurate MCP safety annotations", () => {
    for (const name of ["health_check", "shopping_read", "recipes_read", "meal_plan_read", "recipe_collections_read"]) {
      assert.deepEqual(toolConfigs[name].annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    for (const name of ["shopping_add_item", "recipes_create", "meal_plan_create", "recipe_collections_create"]) {
      assert.deepEqual(toolConfigs[name].annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
  });

  it("defends the profile in handlers even when schema validation is bypassed", async () => {
    client._items.push({ name: "Milk" });
    const result = await handlers.shopping_add_item({ action: "delete_item", name: "Milk" });
    assert.equal(result.isError, true);
    assert.equal(client._items.length, 1);
  });

  it("adds a new item but refuses the implicit update behavior of duplicate adds", async () => {
    let result = await handlers.shopping_add_item({ action: "add_item", name: "Milk" });
    assert.equal(result.isError, undefined);
    assert.equal(client._items.length, 1);

    result = await handlers.shopping_add_item({ action: "add_item", name: "milk", quantity: 4 });
    assert.equal(result.isError, true);
    assert.equal(client._items[0].quantity, 1);
  });

  it("creates new recipes and collections but refuses name collisions", async () => {
    await handlers.recipes_create({ action: "create", name: "Soup" });
    const recipeCollision = await handlers.recipes_create({ action: "create", name: "soup" });
    assert.equal(recipeCollision.isError, true);
    assert.equal(client._recipes.length, 1);

    await handlers.recipe_collections_create({ action: "create", name: "Weeknight" });
    const collectionCollision = await handlers.recipe_collections_create({ action: "create", name: "weeknight" });
    assert.equal(collectionCollision.isError, true);
    assert.equal(client._collections.length, 1);
  });

  it("does not alter the legacy full tool surface", () => {
    const legacy = createMockServer();
    registerAllTools(legacy.server, () => Promise.resolve(client));
    assert.deepEqual(Object.keys(legacy.handlers), [
      "health_check",
      "shopping",
      "recipes",
      "meal_plan",
      "recipe_collections",
    ]);
    assert.equal(legacy.toolConfigs.shopping.annotations.destructiveHint, true);
    assert.equal(legacy.toolConfigs.recipes.annotations.openWorldHint, true);
  });
});
