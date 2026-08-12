import { register as registerHealth } from "./health.js";
import { register as registerShopping } from "./shopping.js";
import { register as registerRecipes } from "./recipes.js";
import { register as registerMealPlan } from "./meal-plan.js";
import { register as registerRecipeCollections } from "./recipe-collections.js";

/**
 * Register all AnyList MCP tools on the given server.
 *
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {() => Promise<import("../anylist-client.js").default>} getClient
 *   Async factory that returns the AnyListClient for the current request/session.
 *   For stdio: always returns the same singleton client.
 *   For HTTP: returns the per-user client from the session manager.
 * @param {{profile?: string}} options OAuth-client tool profile.
 */
export function registerAllTools(server, getClient, options = {}) {
  if (options.profile === "gina") {
    const readOnly = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
    const additive = {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    };

    registerHealth(server, getClient, { annotations: readOnly });
    registerShopping(server, getClient, {
      name: "shopping_read",
      title: "Read Shopping Lists",
      actions: [
        "list_lists",
        "list_items",
        "list_categories",
        "get_favorites",
        "get_recents",
        "list_stores",
      ],
      annotations: readOnly,
    });
    registerShopping(server, getClient, {
      name: "shopping_add_item",
      title: "Add One Shopping Item",
      actions: ["add_item"],
      annotations: additive,
      rejectExisting: true,
    });
    registerRecipes(server, getClient, {
      name: "recipes_read",
      title: "Read Recipes",
      actions: ["list", "get"],
      annotations: readOnly,
    });
    registerRecipes(server, getClient, {
      name: "recipes_create",
      title: "Create One Recipe",
      actions: ["create"],
      annotations: additive,
      rejectExisting: true,
    });
    registerMealPlan(server, getClient, {
      name: "meal_plan_read",
      title: "Read Meal Plan",
      actions: ["list_events", "list_labels"],
      annotations: readOnly,
    });
    registerMealPlan(server, getClient, {
      name: "meal_plan_create",
      title: "Create One Meal Event",
      actions: ["create_event"],
      annotations: additive,
    });
    registerRecipeCollections(server, getClient, {
      name: "recipe_collections_read",
      title: "Read Recipe Collections",
      actions: ["list"],
      annotations: readOnly,
    });
    registerRecipeCollections(server, getClient, {
      name: "recipe_collections_create",
      title: "Create One Recipe Collection",
      actions: ["create"],
      annotations: additive,
      rejectExisting: true,
    });
    return;
  }

  registerHealth(server, getClient);
  registerShopping(server, getClient);
  registerRecipes(server, getClient);
  registerMealPlan(server, getClient);
  registerRecipeCollections(server, getClient);
}
