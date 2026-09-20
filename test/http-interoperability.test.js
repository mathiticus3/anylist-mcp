import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OAuthClientInformationFullSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import Database from "better-sqlite3";

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(baseUrl, child, output) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP server exited during startup (${child.exitCode}):\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(250) });
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`HTTP server did not become ready:\n${output.join("")}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

test("HTTP OAuth and Streamable HTTP interoperability", { timeout: 30_000 }, async t => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "anylist-mcp-http-test-"));
  const dataDir = tempDir;
  const allowedEmailsFile = path.join(tempDir, "allowed-emails.txt");
  await writeFile(allowedEmailsFile, "user@example.com\n");

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["src/http/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      ALLOWED_EMAILS_FILE: allowedEmailsFile,
      BASE_URL: baseUrl,
      DATA_DIR: dataDir,
      PORT: String(port),
      SERVER_SECRET_KEY: "0".repeat(64),
      SESSION_SECRET: "test-session-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => output.push(chunk.toString()));
  child.stderr.on("data", chunk => output.push(chunk.toString()));
  t.after(async () => {
    await stopServer(child);
    await rm(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child, output);

  const rootUnauthorized = await fetch(`${baseUrl}/`);
  assert.equal(rootUnauthorized.status, 401);
  assert.match(
    rootUnauthorized.headers.get("www-authenticate"),
    new RegExp(`resource_metadata="${baseUrl}/\\.well-known/oauth-protected-resource"(?:,|$)`),
  );

  const mcpUnauthorized = await fetch(`${baseUrl}/mcp`);
  assert.equal(mcpUnauthorized.status, 401);
  assert.match(
    mcpUnauthorized.headers.get("www-authenticate"),
    new RegExp(`resource_metadata="${baseUrl}/\\.well-known/oauth-protected-resource/mcp"(?:,|$)`),
  );

  const mcpTrailingSlashUnauthorized = await fetch(`${baseUrl}/mcp/`);
  assert.equal(mcpTrailingSlashUnauthorized.status, 401);
  assert.match(
    mcpTrailingSlashUnauthorized.headers.get("www-authenticate"),
    new RegExp(`resource_metadata="${baseUrl}/\\.well-known/oauth-protected-resource/mcp"(?:,|$)`),
  );

  const registration = await fetch(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["https://www.make.com/oauth/cb/mcp"],
      client_name: "Make MCP Client",
    }),
  });
  assert.equal(registration.status, 201);
  const registrationBody = await registration.json();
  assert.equal(Object.hasOwn(registrationBody, "client_secret"), false);
  assert.equal(registrationBody.token_endpoint_auth_method, "none");
  assert.doesNotThrow(() => OAuthClientInformationFullSchema.parse(registrationBody));

  const codeVerifier = "make-pkce-verifier-".padEnd(64, "x");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    client_id: registrationBody.client_id,
    redirect_uri: "https://www.make.com/oauth/cb/mcp",
    response_type: "code",
    state: "make-state",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: "mcp",
  });
  const authorize = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorize.status, 302);
  assert.equal(authorize.headers.get("location"), "/login");
  assert.ok(authorize.headers.get("set-cookie"));

  const db = new Database(path.join(dataDir, "anylist-mcp.db"));
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("make-user", "user@example.com");
  db.prepare(`
    INSERT INTO oauth_codes
      (code, client_id, user_id, redirect_uri, code_challenge, challenge_method, scope, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "make-auth-code",
    registrationBody.client_id,
    "make-user",
    "https://www.make.com/oauth/cb/mcp",
    codeChallenge,
    "S256",
    "mcp",
    now + 300,
  );
  db.close();

  const token = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: "make-auth-code",
      redirect_uri: "https://www.make.com/oauth/cb/mcp",
      client_id: registrationBody.client_id,
      code_verifier: codeVerifier,
    }),
  });
  assert.equal(token.status, 200);
  const tokenBody = await token.json();
  assert.equal(tokenBody.token_type, "Bearer");
  assert.equal(tokenBody.expires_in, 3600);
  assert.equal(tokenBody.scope, "mcp");
  assert.match(tokenBody.access_token, /^[0-9a-f]{64}$/);
  assert.match(tokenBody.refresh_token, /^[0-9a-f]{64}$/);

  const authorizedHeaders = { Authorization: `Bearer ${tokenBody.access_token}` };
  const sessionlessGet = await fetch(`${baseUrl}/mcp`, {
    headers: { ...authorizedHeaders, Accept: "text/event-stream" },
  });
  assert.equal(sessionlessGet.status, 400);
  assert.match(await sessionlessGet.text(), /Mcp-Session-Id header is required/);

  const invalidSessionGet = await fetch(`${baseUrl}/mcp`, {
    headers: {
      ...authorizedHeaders,
      Accept: "text/event-stream",
      "Mcp-Session-Id": "not-a-session",
    },
  });
  assert.equal(invalidSessionGet.status, 404);

  const sessionlessPost = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...authorizedHeaders,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(sessionlessPost.status, 400);

  const initialize = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...authorizedHeaders,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "make-interoperability-test", version: "1" },
      },
    }),
  });
  assert.equal(initialize.status, 200);
  const sessionId = initialize.headers.get("mcp-session-id");
  assert.ok(sessionId);
  assert.match(await initialize.text(), /"protocolVersion":"2025-06-18"/);

  const terminate = await fetch(`${baseUrl}/mcp`, {
    method: "DELETE",
    headers: {
      ...authorizedHeaders,
      "Mcp-Protocol-Version": "2025-06-18",
      "Mcp-Session-Id": sessionId,
    },
  });
  assert.equal(terminate.status, 200);

  const rootInitialize = await fetch(`${baseUrl}/`, {
    method: "POST",
    headers: {
      ...authorizedHeaders,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "make-root-endpoint-test", version: "1" },
      },
    }),
  });
  assert.equal(rootInitialize.status, 200);
  const rootSessionId = rootInitialize.headers.get("mcp-session-id");
  assert.ok(rootSessionId);

  const rootTerminate = await fetch(`${baseUrl}/`, {
    method: "DELETE",
    headers: {
      ...authorizedHeaders,
      "Mcp-Protocol-Version": "2025-06-18",
      "Mcp-Session-Id": rootSessionId,
    },
  });
  assert.equal(rootTerminate.status, 200);

  const refresh = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokenBody.refresh_token,
      client_id: registrationBody.client_id,
    }),
  });
  assert.equal(refresh.status, 200);
  const refreshBody = await refresh.json();
  assert.equal(refreshBody.token_type, "Bearer");
  assert.match(refreshBody.access_token, /^[0-9a-f]{64}$/);
  assert.match(refreshBody.refresh_token, /^[0-9a-f]{64}$/);
  assert.notEqual(refreshBody.access_token, tokenBody.access_token);
  assert.notEqual(refreshBody.refresh_token, tokenBody.refresh_token);
});

test('dedicated machine canary registration is idempotent, read-only, browser-binding blocked and revocable', {timeout:30000}, async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'anylist-canary-auth-'));
 const port=await reservePort(),base=`http://127.0.0.1:${port}`,allowed=path.join(dataDir,'allowed.txt');await writeFile(allowed,'fixture@example.invalid\n');
 const env={...process.env,DATA_DIR:dataDir,ALLOWED_EMAILS_FILE:allowed,PORT:String(port),BASE_URL:base,SERVER_SECRET_KEY:'0'.repeat(64),SESSION_SECRET:'fixture'};
 const output=[],child=spawn(process.execPath,['src/http/index.js'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>output.push(x.toString()));child.stderr.on('data',x=>output.push(x.toString()));t.after(async()=>{await stopServer(child);await rm(dataDir,{recursive:true,force:true});});await waitForServer(base,child,output);
 const db=new Database(path.join(dataDir,'anylist-mcp.db'));t.after(()=>db.close());db.prepare('INSERT INTO users(id,email)VALUES(?,?)').run('owner','fixture@example.invalid');db.prepare('INSERT INTO anylist_credentials(user_id,encrypted_user,encrypted_pass)VALUES(?,?,?)').run('owner','unused-test-only','unused-test-only');
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{readFile,stat}=await import('node:fs/promises');const exec=promisify(execFile);
 const provision=async mode=>exec(process.execPath,['scripts/provision-canary-client.js',mode],{cwd:path.resolve(import.meta.dirname,'..'),env});
 const first=await provision('--provision');assert.equal(JSON.parse(first.stdout).created,true);const second=await provision('--provision');assert.equal(JSON.parse(second.stdout).created,false);assert.equal(db.prepare('SELECT COUNT(*) n FROM oauth_clients').get().n,1);
 const file=path.join(dataDir,'.env.gina-canary-harness');assert.equal((await stat(file)).mode&0o077,0);const secret=Object.fromEntries((await readFile(file,'utf8')).trim().split('\n').map(l=>l.split('=')));
 assert.ok(!first.stdout.includes(secret.GINA_CANARY_CLIENT_SECRET));assert.ok(!first.stdout.includes(secret.GINA_CANARY_CLIENT_ID));
 const tokenRequest=()=>fetch(base+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:secret.GINA_CANARY_CLIENT_ID,client_secret:secret.GINA_CANARY_CLIENT_SECRET})});
 const issued=await tokenRequest();assert.equal(issued.status,200);const token=await issued.json();let session,sequence=1;
 async function rpc(method,params){const response=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token.access_token,Accept:'application/json, text/event-stream','Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:sequence++,method,params})});assert.equal(response.status,200);session=response.headers.get('mcp-session-id')||session;const text=await response.text();return response.headers.get('content-type').includes('text/event-stream')?JSON.parse(text.split('\n').filter(l=>l.startsWith('data:')).at(-1).slice(5)):JSON.parse(text);}
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}});const inventory=await rpc('tools/list',{});assert.deepEqual(inventory.result.tools.map(t=>t.name),['shopping']);assert.deepEqual(inventory.result.tools[0].inputSchema.properties.action.enum,['list_lists','list_items']);
 // Synthetic-only denial probes; no configured provider credentials or provider access.
 const denied=await rpc('tools/call',{name:'shopping',arguments:{action:'delete_item',list_id:secret.ANYLIST_LIST_ID,id:'fixture'}});assert.ok(denied.error||denied.result?.isError);
 const authorize=await fetch(base+'/authorize?'+new URLSearchParams({client_id:secret.GINA_CANARY_CLIENT_ID,redirect_uri:'https://claude.ai/api/mcp/auth_callback'}),{redirect:'manual'});assert.equal(authorize.status,403);assert.equal(db.prepare('SELECT profile FROM oauth_clients').get().profile,'gina_canary_readonly');
 db.prepare('UPDATE oauth_clients SET profile=?').run('unknown-restricted');assert.equal((await fetch(base+'/mcp',{headers:{Authorization:'Bearer '+token.access_token}})).status,401);db.prepare('UPDATE oauth_clients SET profile=?').run('gina_canary_readonly');
 await provision('--revoke');assert.equal(db.prepare('SELECT COUNT(*) n FROM oauth_clients').get().n,0);assert.equal((await tokenRequest()).status,401);assert.equal((await fetch(base+'/mcp',{headers:{Authorization:'Bearer '+token.access_token,'Mcp-Session-Id':session}})).status,401);
 assert.ok(!output.join('').includes(secret.GINA_CANARY_CLIENT_SECRET));assert.ok(!output.join('').includes(token.access_token));
});
