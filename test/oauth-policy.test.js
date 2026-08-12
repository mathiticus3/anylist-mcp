import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GINA_OPENWEBUI_REDIRECT_URI,
  getAllowedRedirectUris,
  readPositiveInt,
  validateClientRedirectUri,
  validateDcrClientMetadata,
} from "../src/http/auth/policy.js";

describe("OAuth redirect policy", () => {
  it("always includes the exact Gina, Claude, and Home Assistant callbacks", () => {
    const allowed = getAllowedRedirectUris("[]");
    assert.ok(allowed.has(GINA_OPENWEBUI_REDIRECT_URI));
    assert.ok(allowed.has("https://claude.ai/api/mcp/auth_callback"));
    assert.ok(allowed.has("https://my.home-assistant.io/redirect/oauth"));
  });

  it("accepts only explicitly configured secure additional callbacks", () => {
    const callback = "https://connector.example.test/oauth/callback";
    assert.ok(getAllowedRedirectUris(JSON.stringify([callback])).has(callback));
    assert.throws(
      () => getAllowedRedirectUris(JSON.stringify(["https://connector.example.test/oauth/callback?next=evil"])),
      /query string/,
    );
    assert.throws(
      () => getAllowedRedirectUris(JSON.stringify(["http://connector.example.test/callback"])),
      /HTTPS/,
    );
  });

  it("rejects malformed allowlist configuration", () => {
    assert.throws(() => getAllowedRedirectUris("not-json"), /JSON array/);
    assert.throws(() => getAllowedRedirectUris('{"callback":"https://example.test"}'), /JSON array/);
  });

  it("assigns the Gina profile only to the exact OpenWebUI callback", () => {
    const metadata = validateDcrClientMetadata({
      redirect_uris: [GINA_OPENWEBUI_REDIRECT_URI],
      client_name: "OpenWebUI AnyList",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, getAllowedRedirectUris("[]"));

    assert.equal(metadata.profile, "gina");
    assert.equal(metadata.source, "gina/openwebui");
  });

  it("rejects unallowlisted, multiple, and confidential DCR metadata", () => {
    assert.throws(
      () => validateDcrClientMetadata({ redirect_uris: ["https://evil.example/callback"] }, getAllowedRedirectUris("[]")),
      /not allowlisted/,
    );
    assert.throws(
      () => validateDcrClientMetadata({ redirect_uris: [
        GINA_OPENWEBUI_REDIRECT_URI,
        "https://claude.ai/api/mcp/auth_callback",
      ] }, getAllowedRedirectUris("[]")),
      /Exactly one/,
    );
    assert.throws(
      () => validateDcrClientMetadata({
        redirect_uris: [GINA_OPENWEBUI_REDIRECT_URI],
        token_endpoint_auth_method: "client_secret_post",
      }, getAllowedRedirectUris("[]")),
      /public PKCE/,
    );
  });

  it("preserves an existing client's exact callback but blocks callback substitution", () => {
    const legacyCallback = "https://legacy.example.test/oauth/callback";
    assert.deepEqual(
      validateClientRedirectUri({ redirect_uri: legacyCallback }, legacyCallback, getAllowedRedirectUris("[]")),
      { redirectUri: legacyCallback, shouldBind: false },
    );
    assert.throws(
      () => validateClientRedirectUri(
        { redirect_uri: legacyCallback },
        "https://evil.example/callback",
        getAllowedRedirectUris("[]"),
      ),
      /does not match/,
    );
  });

  it("allows a legacy unbound client to bind once to an allowlisted callback", () => {
    assert.deepEqual(
      validateClientRedirectUri({ redirect_uri: null }, GINA_OPENWEBUI_REDIRECT_URI, getAllowedRedirectUris("[]")),
      { redirectUri: GINA_OPENWEBUI_REDIRECT_URI, shouldBind: true },
    );
  });

  it("validates DCR quota settings", () => {
    assert.equal(readPositiveInt("7", 5, "LIMIT"), 7);
    assert.equal(readPositiveInt("", 5, "LIMIT"), 5);
    assert.throws(() => readPositiveInt("0", 5, "LIMIT"), /positive integer/);
  });
});
