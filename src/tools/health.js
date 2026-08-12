import { z } from "zod";
import { textResponse, errorResponse } from "./helpers.js";

export function register(server, getClient, options = {}) {
  server.registerTool(options.name || "health_check", {
    title: options.title || "AnyList Connection Test",
    description: "Test connection to AnyList and access to target shopping list",
    annotations: options.annotations || {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      list_name: z.string().optional().describe("Name of the list to use (defaults to configured default list)")
    }
  }, async ({ list_name }) => {
    try {
      const client = await getClient();
      // Prove auth first so the health check isn't hostage to the default list.
      await client.ensureAuthenticated();

      // Resolve a list only when one is explicitly requested or configured;
      // otherwise report auth success without requiring a (possibly missing)
      // default list to exist.
      const wantsList = list_name || client.defaultListName || process.env.ANYLIST_LIST_NAME;
      if (wantsList) {
        await client.connect(list_name || null);
        return textResponse(`Successfully connected to AnyList and found list: "${client.targetList.name}"`);
      }

      const lists = client.getLists();
      return textResponse(
        `Successfully connected to AnyList (${lists.length} list${lists.length === 1 ? "" : "s"} available). ` +
        `No default list configured — pass list_name to target a specific list.`
      );
    } catch (error) {
      return errorResponse(`Failed to connect to AnyList: ${error.message}`);
    }
  });
}
