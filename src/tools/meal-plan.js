import { z } from "zod";
import { textResponse, errorResponse } from "./helpers.js";
import { createElicitationHelpers } from "./elicitation.js";

const ACTION_DESCRIPTIONS = {
  list_events: "Show meal-plan events sorted by date",
  list_labels: "Show available meal labels with IDs",
  create_event: "Add one meal-plan event for a date",
  delete_event: "Delete a meal-plan event by ID",
};

const ALL_ACTIONS = Object.freeze(Object.keys(ACTION_DESCRIPTIONS));

export function register(server, getClient, options = {}) {
  const actions = options.actions || ALL_ACTIONS;
  const { elicitRequiredField } = createElicitationHelpers(server);

  const actionList = actions.map(action => `- ${action}: ${ACTION_DESCRIPTIONS[action]}`).join("\n");
  server.registerTool(options.name || "meal_plan", {
    title: options.title || "Meal Plan",
    description: `Manage AnyList meal planning calendar. Actions:\n${actionList}`,
    annotations: options.annotations || {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      action: z.enum(actions).describe("The meal plan action to perform"),
      date: z.string().optional().describe("Date in YYYY-MM-DD format (required for create_event)"),
      start_date: z.string().optional().describe("Filter events on or after this date, YYYY-MM-DD (list_events only)"),
      end_date: z.string().optional().describe("Filter events on or before this date, YYYY-MM-DD (list_events only)"),
      title: z.string().optional().describe("Event title (create_event; use this OR recipe_id)"),
      recipe_id: z.string().optional().describe("Recipe ID to link (create_event)"),
      label_id: z.string().optional().describe("Label ID for meal type (create_event)"),
      details: z.string().optional().describe("Additional notes (create_event)"),
      event_id: z.string().optional().describe("Event ID to delete (required for delete_event)"),
    }
  }, async (params) => {
    const { action, date, start_date, end_date, title, recipe_id, label_id, details, event_id } = params;
    try {
      if (!actions.includes(action)) {
        return errorResponse(`Meal-plan action "${action}" is not available to this client.`);
      }
      const client = await getClient();
      // Meal planning is account-level — authenticate only, never resolve a list.
      await client.ensureAuthenticated();
      switch (action) {
        case "list_events": {
          let events = await client.getMealPlanEvents();
          if (start_date) events = events.filter(e => e.date >= start_date);
          if (end_date) events = events.filter(e => e.date <= end_date);
          if (events.length === 0) return textResponse("No meal plan events found.");
          events.sort((a, b) => a.date.localeCompare(b.date));
          const list = events.map(e => {
            const parts = [`- **${e.date}**`];
            if (e.title) parts.push(e.title);
            if (e.recipeName) parts.push(`📖 ${e.recipeName}`);
            if (e.labelName) parts.push(`[${e.labelName}]`);
            if (e.details) parts.push(`— ${e.details}`);
            parts.push(`(id: ${e.identifier})`);
            return parts.join(' ');
          }).join('\n');
          return textResponse(`Meal Plan (${events.length} events):\n${list}`);
        }
        case "list_labels": {
          const labels = await client.getMealPlanLabels();
          if (labels.length === 0) return textResponse("No meal plan labels found.");
          const list = labels.map(l => `- **${l.name}** (${l.hexColor || 'no color'}) — id: ${l.identifier}`).join('\n');
          return textResponse(`Meal Plan Labels:\n${list}`);
        }
        case "create_event": {
          let eventDate = date;
          if (!eventDate) eventDate = await elicitRequiredField("date", "What date for the meal plan event? (YYYY-MM-DD)");
          const result = await client.createMealPlanEvent({
            date: eventDate,
            title: title || null,
            recipeId: recipe_id || null,
            labelId: label_id || null,
            details: details || null,
          });
          return textResponse(`Created meal plan event for ${result.date}`);
        }
        case "delete_event": {
          let eventId = event_id;
          if (!eventId) eventId = await elicitRequiredField("event_id", "Which event ID should be deleted?");
          await client.deleteMealPlanEvent(eventId);
          return textResponse(`Deleted meal plan event ${eventId}`);
        }
      }
    } catch (error) {
      return errorResponse(`Meal plan ${action} failed: ${error.message}`);
    }
  });
}
