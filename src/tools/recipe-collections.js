import { z } from "zod";
import { textResponse, errorResponse } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";

const ACTION_DESCRIPTIONS = {
  list: "Show all collections with recipe counts and names",
  create: "Create one new collection, optionally with recipes",
  delete: "Delete a collection by name",
};

const ALL_ACTIONS = Object.freeze(Object.keys(ACTION_DESCRIPTIONS));

export function register(server, getClient, options = {}) {
  const actions = options.actions || ALL_ACTIONS;
  const { elicitRequiredField } = createElicitationHelpers(server);

  const actionList = actions.map(action => `- ${action}: ${ACTION_DESCRIPTIONS[action]}`).join("\n");
  server.registerTool(options.name || "recipe_collections", {
    title: options.title || "Recipe Collections",
    description: `Manage AnyList recipe collections. Actions:\n${actionList}`,
    annotations: options.annotations || {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      action: z.enum(actions).describe("The collection action to perform"),
      name: z.string().optional().describe("Collection name (required for create, delete)"),
      recipe_names: z.array(z.string()).optional().describe("Recipe names to include (create only)"),
    }
  }, async (params) => {
    const { action, name, recipe_names } = params;
    try {
      if (!actions.includes(action)) {
        return errorResponse(`Recipe-collection action "${action}" is not available to this client.`);
      }
      const client = await getClient();
      // Recipe collections are account-level — authenticate only, no list.
      await client.ensureAuthenticated();
      switch (action) {
        case "list": {
          const collections = await client.getRecipeCollections();
          if (collections.length === 0) return textResponse("No recipe collections found.");
          const list = collections.map(c => `- **${c.name}** (${c.recipeCount} recipes)${c.recipeCount > 0 ? ': ' + c.recipeNames.join(', ') : ''}`).join('\n');
          return textResponse(`Recipe Collections (${collections.length}):\n${list}`);
        }
        case "create": {
          let collectionName = name;
          if (!collectionName) collectionName = await elicitRequiredField("name", "What should the collection be called?");
          if (options.rejectExisting) {
            const collections = await client.getRecipeCollections();
            const existing = collections.find(
              collection => collection.name.toLowerCase() === collectionName.toLowerCase(),
            );
            if (existing) {
              return errorResponse(`Recipe collection "${existing.name}" already exists; this client may create new collections but may not replace existing ones.`);
            }
          }
          const result = await client.createRecipeCollection(collectionName, recipe_names || []);
          return textResponse(`Created recipe collection "${result.name}"`);
        }
        case "delete": {
          let deleteCollectionName = name;
          if (!deleteCollectionName) deleteCollectionName = await elicitRequiredField("name", "Which collection would you like to delete?");
          await client.deleteRecipeCollection(deleteCollectionName);
          return textResponse(`Deleted recipe collection "${deleteCollectionName}"`);
        }
      }
    } catch (error) {
      return errorResponse(`Recipe collections ${action} failed: ${error.message}`);
    }
  });
}
