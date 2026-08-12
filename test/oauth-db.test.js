import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("OAuth client persistence", () => {
  let db;

  before(async () => {
    process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "anylist-oauth-test-"));
    process.env.SERVER_SECRET_KEY = "00".repeat(32);
    db = await import("../src/http/db.js");
    db.getDb();
  });

  it("persists the Gina profile and provenance source", () => {
    db.registerOAuthClient({
      clientId: "gina-client",
      redirectUri: "https://example.test/gina",
      clientName: "Gina",
      profile: "gina",
      source: "gina/openwebui",
    });

    const record = db.getOAuthClient("gina-client");
    assert.equal(record.profile, "gina");
    assert.equal(record.source, "gina/openwebui");
    assert.equal(record.client_name, "Gina");
    assert.equal(db.countPublicOAuthClients(), 1);
  });

  it("binds a legacy client redirect only once", () => {
    db.registerOAuthClient({ clientId: "legacy-client", redirectUri: null });
    db.bindOAuthClientRedirectUri(
      "legacy-client",
      "https://example.test/callback",
      "full",
      "oauth",
    );
    assert.equal(db.getOAuthClient("legacy-client").redirect_uri, "https://example.test/callback");
    assert.throws(
      () => db.bindOAuthClientRedirectUri("legacy-client", "https://evil.example/callback"),
      /could not be bound/,
    );
  });
});
