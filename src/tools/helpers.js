export function errorResponse(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

export function textResponse(msg) {
  return { content: [{ type: "text", text: msg }] };
}

/**
 * A text response that also carries a machine-readable payload.
 *
 * The prose in `content` stays byte-identical to what `textResponse` would
 * produce, so conversational clients are unaffected. Programmatic callers can
 * read `structuredContent` instead of parsing the prose.
 *
 * Deliberately no `outputSchema` on the tool: `shopping` multiplexes sixteen
 * actions with different result shapes, so a single schema would be either
 * meaninglessly loose or a breaking change for every existing client. The MCP
 * spec makes `structuredContent` optional unless `outputSchema` is declared,
 * and the SDK only validates when it is — so this is additive and safe.
 */
export function structuredResponse(msg, structuredContent) {
  return { content: [{ type: "text", text: msg }], structuredContent };
}

export function requireParams(params, required, action) {
  for (const key of required) {
    if (params[key] === undefined || params[key] === null || params[key] === "") {
      throw new Error(`Action "${action}" requires parameter "${key}"`);
    }
  }
}
