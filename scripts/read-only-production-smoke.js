#!/usr/bin/env node

// Release smoke test. Emit counts/booleans only: never account or AnyList content.
import Database from "better-sqlite3";
import { createDecipheriv } from "crypto";
import path from "path";
import AnyListClient from "../src/anylist-client.js";

const metadataOnly = process.argv.includes("--metadata-only");
const dbPath = path.join(process.env.DATA_DIR || "/data", "anylist-mcp.db");

function count(db, sql) { return Number(db.prepare(sql).get().count); }

function decrypt(ciphertext) {
  const keyHex = process.env.SERVER_SECRET_KEY || "";
  if (!/^[a-fA-F0-9]{64}$/.test(keyHex)) throw new Error("invalid_server_key");
  const parts = String(ciphertext).split(":");
  if (parts.length !== 3) throw new Error("invalid_ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(parts[0], "hex"));
  decipher.setAuthTag(Buffer.from(parts[1], "hex"));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], "hex")), decipher.final()]).toString("utf8");
}

let client;
try {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const metadata = {
    users: count(db, "SELECT COUNT(*) AS count FROM users"),
    credential_records: count(db, "SELECT COUNT(*) AS count FROM anylist_credentials"),
    oauth_clients: count(db, "SELECT COUNT(*) AS count FROM oauth_clients"),
    public_oauth_clients: count(db, "SELECT COUNT(*) AS count FROM oauth_clients WHERE client_secret_hash IS NULL"),
    confidential_oauth_clients: count(db, "SELECT COUNT(*) AS count FROM oauth_clients WHERE client_secret_hash IS NOT NULL"),
    oauth_tokens: count(db, "SELECT COUNT(*) AS count FROM oauth_tokens"),
  };
  if (metadataOnly) {
    db.close();
    process.stdout.write(`${JSON.stringify({ ok: true, metadata })}\n`);
    process.exit(0);
  }

  const credential = db.prepare(`SELECT encrypted_user, encrypted_pass, default_list
    FROM anylist_credentials ORDER BY user_id LIMIT 1`).get();
  db.close();
  if (!credential) throw new Error("no_stored_credential");

  // Normal client logs include account/list names, so silence them for this probe.
  const originalError = console.error;
  const originalInfo = console.info;
  console.error = () => {};
  console.info = () => {};
  try {
    client = new AnyListClient({
      username: decrypt(credential.encrypted_user),
      password: decrypt(credential.encrypted_pass),
      defaultListName: credential.default_list || null,
    });
    await client.ensureAuthenticated();
    const listCount = client.getLists().length;
    await client.disconnect();
    client = null;
    process.stdout.write(`${JSON.stringify({
      ok: true,
      metadata,
      protocol: { authenticated: true, credential_record_present: true, list_count: listCount },
    })}\n`);
  } finally {
    console.error = originalError;
    console.info = originalInfo;
  }
} catch (error) {
  console.error = () => {};
  console.info = () => {};
  try { if (client) await client.disconnect(); } catch { /* keep primary failure */ }
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.name : "Error" })}\n`);
  process.exit(1);
}
