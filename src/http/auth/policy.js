export const GINA_OPENWEBUI_REDIRECT_URI =
  "https://cdlms.tail767e55.ts.net:8443/oauth/clients/mcp:anylist/callback";

const BUILTIN_REDIRECT_URIS = Object.freeze([
  GINA_OPENWEBUI_REDIRECT_URI,
  "https://claude.ai/api/mcp/auth_callback",
  "https://my.home-assistant.io/redirect/oauth",
]);

export class OAuthPolicyError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "OAuthPolicyError";
    this.code = code;
    this.status = status;
  }
}

function validateRedirectUriSyntax(value) {
  if (typeof value !== "string" || !value) {
    throw new OAuthPolicyError("invalid_redirect_uri", "A redirect URI is required.");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new OAuthPolicyError("invalid_redirect_uri", "Redirect URI is not a valid URL.");
  }

  const isLoopback = parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new OAuthPolicyError(
      "invalid_redirect_uri",
      "Redirect URI must use HTTPS, except for an explicitly allowlisted loopback callback.",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new OAuthPolicyError(
      "invalid_redirect_uri",
      "Redirect URI must not contain credentials, a query string, or a fragment.",
    );
  }
  if (parsed.hostname.endsWith(".")) {
    throw new OAuthPolicyError("invalid_redirect_uri", "Redirect URI host must be canonical.");
  }

  return value;
}

export function getAllowedRedirectUris(raw = process.env.OAUTH_ALLOWED_REDIRECT_URIS) {
  const allowed = new Set(BUILTIN_REDIRECT_URIS);
  if (!raw) return allowed;

  let configured;
  try {
    configured = JSON.parse(raw);
  } catch {
    throw new Error("OAUTH_ALLOWED_REDIRECT_URIS must be a JSON array of exact callback URLs.");
  }
  if (!Array.isArray(configured) || configured.some(value => typeof value !== "string")) {
    throw new Error("OAUTH_ALLOWED_REDIRECT_URIS must be a JSON array of exact callback URLs.");
  }
  for (const value of configured) {
    allowed.add(validateRedirectUriSyntax(value));
  }
  return allowed;
}

export function policyForRedirectUri(redirectUri) {
  if (redirectUri === GINA_OPENWEBUI_REDIRECT_URI) {
    return { profile: "gina", source: "gina/openwebui" };
  }
  return { profile: "full", source: "oauth" };
}

export function validateDcrClientMetadata(body, allowedRedirectUris = getAllowedRedirectUris()) {
  const redirectUris = body?.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length !== 1) {
    throw new OAuthPolicyError(
      "invalid_client_metadata",
      "Exactly one redirect_uris entry is required.",
    );
  }

  const redirectUri = validateRedirectUriSyntax(redirectUris[0]);
  if (!allowedRedirectUris.has(redirectUri)) {
    throw new OAuthPolicyError("invalid_redirect_uri", "Redirect URI is not allowlisted.");
  }

  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
    throw new OAuthPolicyError(
      "invalid_client_metadata",
      "Dynamic registration supports public PKCE clients only.",
    );
  }
  if (body.grant_types && (
    !Array.isArray(body.grant_types) ||
    !body.grant_types.includes("authorization_code") ||
    body.grant_types.some(value => !["authorization_code", "refresh_token"].includes(value))
  )) {
    throw new OAuthPolicyError("invalid_client_metadata", "Unsupported grant_types.");
  }
  if (body.response_types && (
    !Array.isArray(body.response_types) ||
    body.response_types.length !== 1 ||
    body.response_types[0] !== "code"
  )) {
    throw new OAuthPolicyError("invalid_client_metadata", "Only response_type=code is supported.");
  }

  const rawName = typeof body.client_name === "string" ? body.client_name.trim() : "MCP Client";
  const clientName = (rawName || "MCP Client").slice(0, 128);
  return {
    redirectUri,
    clientName,
    ...policyForRedirectUri(redirectUri),
  };
}

export function validateClientRedirectUri(client, redirectUri, allowedRedirectUris = getAllowedRedirectUris()) {
  if (!client) {
    throw new OAuthPolicyError("invalid_client", "Unknown OAuth client.", 401);
  }
  validateRedirectUriSyntax(redirectUri);

  if (client.redirect_uri) {
    if (redirectUri !== client.redirect_uri) {
      throw new OAuthPolicyError("invalid_redirect_uri", "Redirect URI does not match the registered client.");
    }
    // Existing registrations remain valid even if an operator later removes
    // their URI from the new-registration allowlist.
    return { redirectUri, shouldBind: false };
  }

  if (!allowedRedirectUris.has(redirectUri)) {
    throw new OAuthPolicyError("invalid_redirect_uri", "Redirect URI is not allowlisted.");
  }
  return { redirectUri, shouldBind: true };
}

export function readPositiveInt(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}
