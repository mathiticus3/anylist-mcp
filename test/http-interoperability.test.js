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

test('Estate meal reader HTTP grant stays held until enabled and denies writes, wide windows, callback rebinding and revoked sessions', {timeout:30000}, async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'synthetic-estate-meal-http-'));
 const port=await reservePort(),base=`http://127.0.0.1:${port}`,allowed=path.join(dataDir,'allowed.txt');
 await writeFile(allowed,'fixture@example.invalid\n');
 const env={...process.env,DATA_DIR:dataDir,ALLOWED_EMAILS_FILE:allowed,PORT:String(port),BASE_URL:base,SERVER_SECRET_KEY:'0'.repeat(64),SESSION_SECRET:'synthetic'};
 const output=[],child=spawn(process.execPath,['src/http/index.js'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>output.push(x.toString()));child.stderr.on('data',x=>output.push(x.toString()));
 t.after(async()=>{await stopServer(child);await rm(dataDir,{recursive:true,force:true});});await waitForServer(base,child,output);
 const db=new Database(path.join(dataDir,'anylist-mcp.db'));t.after(()=>db.close());
 const user='00000000-0000-4000-8000-000000000002';
 db.prepare('INSERT INTO users(id,email)VALUES(?,?)').run(user,'fixture@example.invalid');
 db.prepare('INSERT INTO anylist_credentials(user_id,encrypted_user,encrypted_pass)VALUES(?,?,?)').run(user,'unused-test-only','unused-test-only');
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{readFile}=await import('node:fs/promises');const exec=promisify(execFile);
 const provision=(...args)=>exec(process.execPath,['scripts/provision-estate-hub-read.js',...args],{cwd:path.resolve(import.meta.dirname,'..'),env});
 const created=JSON.parse((await provision('--provision','--user-id',user)).stdout);
 const privateValue=JSON.parse(await readFile(path.join(dataDir,'estate-household-anylist-read.private.json'),'utf8'));
 const tokenRequest=()=>fetch(base+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:created.clientId,client_secret:privateValue.client_secret})});
 assert.equal((await tokenRequest()).status,401);
 await provision('--enable','--client-id',created.clientId);
 const issued=await tokenRequest();assert.equal(issued.status,200);const token=await issued.json();
 assert.equal(token.scope,'mcp');assert.equal(token.refresh_token,undefined);
 let session,sequence=1;
 const request=(method,params)=>fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token.access_token,Accept:'application/json, text/event-stream','Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:sequence++,method,params})});
 const rpc=async(method,params)=>{const r=await request(method,params);assert.equal(r.status,200);session=r.headers.get('mcp-session-id')||session;const text=await r.text();return r.headers.get('content-type').includes('text/event-stream')?JSON.parse(text.split('\n').filter(l=>l.startsWith('data:')).at(-1).slice(5)):JSON.parse(text);};
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'synthetic-reader',version:'1'}});
 const inventory=await rpc('tools/list',{});assert.deepEqual(inventory.result.tools.map(x=>x.name),['meal_plan_read']);
 assert.equal(inventory.result.tools[0].annotations.readOnlyHint,true);
 for(const args of [{action:'create_event',date:'2026-01-01',title:'synthetic denied'},
   {action:'list_events',start_date:'2026-01-01',end_date:'2026-02-01'}]){
  const denied=await rpc('tools/call',{name:'meal_plan_read',arguments:args});assert.ok(denied.error||denied.result?.isError);
 }
 const browser=await fetch(base+'/oauth/authorize?'+new URLSearchParams({client_id:created.clientId,redirect_uri:'https://claude.ai/api/mcp/auth_callback',response_type:'code'}),{redirect:'manual'});
 assert.equal(browser.status,403);
 await provision('--disable','--client-id',created.clientId);
 assert.equal((await request('tools/list',{})).status,401);assert.equal((await tokenRequest()).status,401);
 assert.ok(!output.join('').includes(privateValue.client_secret));
});

test('Household shopping/recipe machine profiles enforce policy at token and existing-session boundaries', {timeout:30000}, async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'synthetic-household-http-'));
 const port=await reservePort(),base=`http://127.0.0.1:${port}`,allowed=path.join(dataDir,'allowed.txt');
 await writeFile(allowed,'fixture@example.invalid\n');
 const env={...process.env,DATA_DIR:dataDir,ALLOWED_EMAILS_FILE:allowed,PORT:String(port),BASE_URL:base,SERVER_SECRET_KEY:'0'.repeat(64),SESSION_SECRET:'synthetic'};
 const output=[],child=spawn(process.execPath,['src/http/index.js'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>output.push(x.toString()));child.stderr.on('data',x=>output.push(x.toString()));
 t.after(async()=>{await stopServer(child);await rm(dataDir,{recursive:true,force:true});});await waitForServer(base,child,output);
 const db=new Database(path.join(dataDir,'anylist-mcp.db'));t.after(()=>db.close());
 const user='00000000-0000-4000-8000-000000000002';db.prepare('INSERT INTO users(id,email)VALUES(?,?)').run(user,'fixture@example.invalid');
 const bcrypt=(await import('bcrypt')).default,secret='synthetic-machine-secret-not-production',hash=await bcrypt.hash(secret,4);
 const entries=[['shopping','00000000-0000-4000-8000-000000000003','shopping_read'],['recipes','00000000-0000-4000-8000-000000000004','recipes_read']];
 for(const [kind,id,tool] of entries){
  db.prepare('INSERT INTO oauth_clients(client_id,client_secret_hash,user_id,client_name,profile,source)VALUES(?,?,?,?,?,?)').run(id,hash,user,'fixture-'+kind,`estate_hub_${kind}_readonly`,`estate-household-${kind}-readonly`);
  const policy={schemaVersion:1,clientId:id,userId:user,enabled:false,revision:1,...(kind==='shopping'?{listId:'a'.repeat(32)}:{})};
  const save=()=>writeFile(path.join(dataDir,`estate-hub-${kind}-read-policy.json`),JSON.stringify(policy),{mode:0o600});await save();
  const requestToken=()=>fetch(base+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:id,client_secret:secret})});
  assert.equal((await requestToken()).status,401);policy.enabled=true;await save();
  db.prepare('UPDATE oauth_clients SET redirect_uri=? WHERE client_id=?').run('https://cdlms.tail767e55.ts.net:8443/oauth/clients/mcp:anylist/callback',id);
  assert.equal((await requestToken()).status,401);
  db.prepare('UPDATE oauth_clients SET redirect_uri=NULL WHERE client_id=?').run(id);
  const issued=await requestToken();assert.equal(issued.status,200);const token=await issued.json();assert.equal(token.refresh_token,undefined);
  let session,sequence=1;
  const request=(method,params)=>fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token.access_token,Accept:'application/json, text/event-stream','Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:sequence++,method,params})});
  const rpc=async(method,params)=>{const r=await request(method,params);assert.equal(r.status,200);session=r.headers.get('mcp-session-id')||session;const text=await r.text();return r.headers.get('content-type').includes('text/event-stream')?JSON.parse(text.split('\n').filter(l=>l.startsWith('data:')).at(-1).slice(5)):JSON.parse(text);};
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'synthetic-reader',version:'1'}});
  assert.deepEqual((await rpc('tools/list',{})).result.tools.map(x=>x.name),[tool]);
  db.prepare('UPDATE oauth_clients SET redirect_uri=? WHERE client_id=?').run('https://cdlms.tail767e55.ts.net:8443/oauth/clients/mcp:anylist/callback',id);
  assert.equal((await request('tools/list',{})).status,401);
  db.prepare('UPDATE oauth_clients SET redirect_uri=NULL WHERE client_id=?').run(id);
  for(const name of ['shopping','recipes','meal_plan_read']){const denied=await rpc('tools/call',{name,arguments:{action:'create',name:'denied'}});assert.ok(denied.error||denied.result?.isError);}
  const bad=await rpc('tools/call',{name:tool,arguments:{action:'create',name:'denied'}});assert.ok(bad.error||bad.result?.isError);
  const browser=await fetch(base+'/oauth/authorize?'+new URLSearchParams({client_id:id,redirect_uri:'https://claude.ai/api/mcp/auth_callback',response_type:'code'}),{redirect:'manual'});assert.equal(browser.status,403);
  assert.equal((await fetch(base+'/actions/getServiceStatus',{method:'POST',headers:{Authorization:'Bearer '+token.access_token,'Content-Type':'application/json'},body:'{}'})).status,401);
  policy.enabled=false;await save();assert.equal((await request('tools/list',{})).status,401);assert.equal((await requestToken()).status,401);
 }
 assert.ok(!output.join('').includes(secret));
});

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

test('separate writer registration is idempotent, tightly scoped, browser-binding blocked and revocable', {timeout:30000}, async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'anylist-canary-auth-'));
 const port=await reservePort(),base=`http://127.0.0.1:${port}`,allowed=path.join(dataDir,'allowed.txt');await writeFile(allowed,'fixture@example.invalid\n');
 const env={...process.env,DATA_DIR:dataDir,ALLOWED_EMAILS_FILE:allowed,PORT:String(port),BASE_URL:base,SERVER_SECRET_KEY:'0'.repeat(64),SESSION_SECRET:'fixture'};
 const output=[],child=spawn(process.execPath,['src/http/index.js'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>output.push(x.toString()));child.stderr.on('data',x=>output.push(x.toString()));t.after(async()=>{await stopServer(child);await rm(dataDir,{recursive:true,force:true});});await waitForServer(base,child,output);
 const db=new Database(path.join(dataDir,'anylist-mcp.db'));t.after(()=>db.close());db.prepare('INSERT INTO users(id,email)VALUES(?,?)').run('owner','fixture@example.invalid');db.prepare('INSERT INTO anylist_credentials(user_id,encrypted_user,encrypted_pass)VALUES(?,?,?)').run('owner','unused-test-only','unused-test-only');
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{readFile,stat}=await import('node:fs/promises');const exec=promisify(execFile);
 const provision=async mode=>exec(process.execPath,['scripts/provision-canary-writer.js',mode],{cwd:path.resolve(import.meta.dirname,'..'),env});
 await exec(process.execPath,['scripts/provision-canary-client.js','--provision'],{cwd:path.resolve(import.meta.dirname,'..'),env});
 const verifierBefore=db.prepare("SELECT * FROM oauth_clients WHERE profile='gina_canary_readonly'").get();
 const first=await provision('--provision');assert.equal(JSON.parse(first.stdout).created,true);const second=await provision('--provision');assert.equal(JSON.parse(second.stdout).created,false);assert.equal(db.prepare('SELECT COUNT(*) n FROM oauth_clients').get().n,2);
 const file=path.join(dataDir,'.env.gina-canary-harness-write');assert.equal((await stat(file)).mode&0o077,0);const secret=Object.fromEntries((await readFile(file,'utf8')).trim().split('\n').map(l=>l.split('=')));
 assert.ok(!first.stdout.includes(secret.GINA_CANARY_WRITE_CLIENT_SECRET));assert.ok(!first.stdout.includes(secret.GINA_CANARY_WRITE_CLIENT_ID));
 const tokenRequest=()=>fetch(base+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:secret.GINA_CANARY_WRITE_CLIENT_ID,client_secret:secret.GINA_CANARY_WRITE_CLIENT_SECRET})});
 const issued=await tokenRequest();assert.equal(issued.status,200);const token=await issued.json();let session,sequence=1;
 async function rpc(method,params){const response=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token.access_token,Accept:'application/json, text/event-stream','Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:sequence++,method,params})});assert.equal(response.status,200);session=response.headers.get('mcp-session-id')||session;const text=await response.text();return response.headers.get('content-type').includes('text/event-stream')?JSON.parse(text.split('\n').filter(l=>l.startsWith('data:')).at(-1).slice(5)):JSON.parse(text);}
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}});const inventory=await rpc('tools/list',{});assert.deepEqual(inventory.result.tools.map(t=>t.name),['shopping']);assert.deepEqual(inventory.result.tools[0].inputSchema.properties.action.enum,['add_item','delete_item']);
 // Synthetic-only denial probes; no configured provider credentials or provider access.
 const denied=await rpc('tools/call',{name:'shopping',arguments:{action:'delete_item',list_id:secret.ANYLIST_LIST_ID,id:'fixture'}});assert.ok(denied.error||denied.result?.isError);
 const authorize=await fetch(base+'/authorize?'+new URLSearchParams({client_id:secret.GINA_CANARY_WRITE_CLIENT_ID,redirect_uri:'https://claude.ai/api/mcp/auth_callback'}),{redirect:'manual'});assert.equal(authorize.status,403);assert.equal(db.prepare("SELECT profile FROM oauth_clients WHERE client_name='gina-canary-harness-write'").get().profile,'gina_canary_write');
 db.prepare("UPDATE oauth_clients SET profile=? WHERE client_name='gina-canary-harness-write'").run('unknown-restricted');assert.equal((await fetch(base+'/mcp',{headers:{Authorization:'Bearer '+token.access_token}})).status,401);db.prepare("UPDATE oauth_clients SET profile=? WHERE client_name='gina-canary-harness-write'").run('gina_canary_write');
 await provision('--revoke');assert.equal(db.prepare('SELECT COUNT(*) n FROM oauth_clients').get().n,1);assert.equal((await tokenRequest()).status,401);assert.equal((await fetch(base+'/mcp',{headers:{Authorization:'Bearer '+token.access_token,'Mcp-Session-Id':session}})).status,401);
 assert.deepEqual(db.prepare("SELECT * FROM oauth_clients WHERE profile='gina_canary_readonly'").get(),verifierBefore);
 assert.ok(!output.join('').includes(secret.GINA_CANARY_WRITE_CLIENT_ID));assert.ok(!output.join('').includes(secret.GINA_CANARY_WRITE_CLIENT_SECRET));assert.ok(!output.join('').includes(token.access_token));
});

test('separate fixed-policy read/add grants pin source digest and preserve canary identities on revoke', {timeout:30000}, async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'anylist-bounded-auth-'));const port=await reservePort(),base=`http://127.0.0.1:${port}`,allowed=path.join(dataDir,'allowed.txt');await writeFile(allowed,'fixture@example.invalid\n');
 const env={...process.env,DATA_DIR:dataDir,ALLOWED_EMAILS_FILE:allowed,PORT:String(port),BASE_URL:base,SERVER_SECRET_KEY:'0'.repeat(64),SESSION_SECRET:'fixture'};
 const output=[],child=spawn(process.execPath,['src/http/index.js'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>output.push(x.toString()));child.stderr.on('data',x=>output.push(x.toString()));t.after(async()=>{await stopServer(child);await rm(dataDir,{recursive:true,force:true});});await waitForServer(base,child,output);
 const db=new Database(path.join(dataDir,'anylist-mcp.db'));t.after(()=>db.close());db.prepare('INSERT INTO users(id,email)VALUES(?,?)').run('owner','fixture@example.invalid');db.prepare('INSERT INTO anylist_credentials(user_id,encrypted_user,encrypted_pass)VALUES(?,?,?)').run('owner','unused-test-only','unused-test-only');
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{readFile,stat}=await import('node:fs/promises');const exec=promisify(execFile);
 const command=async(script,...args)=>exec(process.execPath,[script,...args],{cwd:path.resolve(import.meta.dirname,'..'),env});
 await command('scripts/provision-canary-client.js','--provision');await command('scripts/provision-canary-writer.js','--provision');const canaries=db.prepare('SELECT * FROM oauth_clients ORDER BY client_name').all();
 const policyPath=path.join(dataDir,'gina-bounded-shopping.json'),policy={schemaVersion:1,listId:'a'.repeat(32),readerEnabled:true,addEnabled:true};await writeFile(policyPath,JSON.stringify(policy),{mode:0o600});
 const tokens={};
 for(const role of ['read','add']){
  const first=JSON.parse((await command('scripts/provision-bounded-shopping.js',role,'--provision')).stdout);assert.equal(first.created,true);assert.equal(JSON.parse((await command('scripts/provision-bounded-shopping.js',role,'--provision')).stdout).created,false);
  const file=path.join(dataDir,`.env.gina-bounded-shopping-${role}`);assert.equal((await stat(file)).mode&0o077,0);const secret=Object.fromEntries((await readFile(file,'utf8')).trim().split('\n').map(l=>l.split('=')));
  const auth=await fetch(base+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:secret.GINA_BOUNDED_CLIENT_ID,client_secret:secret.GINA_BOUNDED_CLIENT_SECRET})});assert.equal(auth.status,200);const token=await auth.json();tokens[role]=token.access_token;let session,id=1;
  async function rpc(method,params){const r=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token.access_token,Accept:'application/json, text/event-stream','Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:id++,method,params})});assert.equal(r.status,200);session=r.headers.get('mcp-session-id')||session;const text=await r.text();return r.headers.get('content-type').includes('text/event-stream')?JSON.parse(text.split('\n').filter(l=>l.startsWith('data:')).at(-1).slice(5)):JSON.parse(text);}
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}});const inventory=(await rpc('tools/list',{})).result.tools;assert.deepEqual(inventory.map(x=>x.name),['shopping']);assert.equal(inventory[0].inputSchema.properties.contract_version.const,'bounded-shopping.v2');assert.ok(inventory[0].inputSchema.required.includes('contract_version'));assert.equal(inventory[0].inputSchema.properties.list_id.const,policy.listId);assert.equal(inventory[0].inputSchema.properties.action.const,role==='read'?'list_items':'add_item');assert.equal(inventory[0].inputSchema.additionalProperties,false);if(role==='add')assert.deepEqual(Object.keys(inventory[0].inputSchema.properties).sort(),['action','contract_version','list_id','name','quantity','response_format']);
  // A retained v1 credential/token must fail at auth, not inherit v2 semantics.
  const v2Source=db.prepare('SELECT source FROM oauth_clients WHERE client_id=?').get(secret.GINA_BOUNDED_CLIENT_ID).source;
  const v1Digest=createHash('sha256').update(JSON.stringify({contract:'bounded-shopping.v1',listId:policy.listId,maxItems:10000,maxResultBytes:8*1024*1024})).digest('hex');
  db.prepare('UPDATE oauth_clients SET source=? WHERE client_id=?').run(`gina/bounded-shopping-${role}:${v1Digest}`,secret.GINA_BOUNDED_CLIENT_ID);
  assert.equal((await fetch(base+'/mcp',{headers:{Authorization:'Bearer '+token.access_token,'Mcp-Session-Id':session}})).status,401);
  const staleGrant=await fetch(base+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:secret.GINA_BOUNDED_CLIENT_ID,client_secret:secret.GINA_BOUNDED_CLIENT_SECRET})});
  assert.equal(staleGrant.status,200); // Existing token endpoint verifies identity; MCP enforces current binding.
  const staleToken=(await staleGrant.json()).access_token;assert.equal((await fetch(base+'/mcp',{headers:{Authorization:'Bearer '+staleToken}})).status,401);
  await assert.rejects(()=>command('scripts/provision-bounded-shopping.js',role,'--provision'));
  db.prepare('UPDATE oauth_clients SET source=? WHERE client_id=?').run(v2Source,secret.GINA_BOUNDED_CLIENT_ID);
  const bad=await rpc('tools/call',{name:'shopping',arguments:{action:'delete_item',list_id:policy.listId,item_id:'1'}});assert.ok(bad.error||bad.result?.isError);
  assert.equal((await fetch(base+'/authorize?'+new URLSearchParams({client_id:secret.GINA_BOUNDED_CLIENT_ID,redirect_uri:'https://claude.ai/api/mcp/auth_callback'}),{redirect:'manual'})).status,403);
  assert.ok(!output.join('').includes(secret.GINA_BOUNDED_CLIENT_ID));assert.ok(!output.join('').includes(secret.GINA_BOUNDED_CLIENT_SECRET));
 }
 assert.equal(db.prepare('SELECT COUNT(*) n FROM oauth_clients').get().n,4);
 await writeFile(policyPath,JSON.stringify({...policy,addEnabled:false}));assert.equal((await fetch(base+'/mcp',{headers:{Authorization:'Bearer '+tokens.add}})).status,401);
 await writeFile(policyPath,JSON.stringify({...policy,listId:'b'.repeat(32)}));for(const token of Object.values(tokens))assert.equal((await fetch(base+'/mcp',{headers:{Authorization:'Bearer '+token}})).status,401);
 await assert.rejects(()=>command('scripts/provision-bounded-shopping.js','add','--provision'));
 await rm(policyPath);for(const role of ['add','read'])await command('scripts/provision-bounded-shopping.js',role,'--revoke');
 assert.deepEqual(db.prepare('SELECT * FROM oauth_clients ORDER BY client_name').all(),canaries);
 for(const token of Object.values(tokens))assert.equal((await fetch(base+'/mcp',{headers:{Authorization:'Bearer '+token}})).status,401);
});

test('dedicated household writers remain separate and revocable across token and MCP sessions', { timeout: 30000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'synthetic-household-writer-http-'));
  const port = await reservePort(), base = `http://127.0.0.1:${port}`, allowed = path.join(dataDir, 'allowed.txt');
  await writeFile(allowed, 'fixture@example.invalid\n');
  const env = { ...process.env, DATA_DIR: dataDir, ALLOWED_EMAILS_FILE: allowed, PORT: String(port), BASE_URL: base,
    SERVER_SECRET_KEY: '0'.repeat(64), SESSION_SECRET: 'synthetic' };
  const output = [], child = spawn(process.execPath, ['src/http/index.js'], { cwd: path.resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', value => output.push(value.toString())); child.stderr.on('data', value => output.push(value.toString()));
  t.after(async () => { await stopServer(child); await rm(dataDir, { recursive: true, force: true }); });
  await waitForServer(base, child, output);
  const db = new Database(path.join(dataDir, 'anylist-mcp.db')); t.after(() => db.close());
  const user = '00000000-0000-4000-8000-000000000002', otherUser = '00000000-0000-4000-8000-000000000009';
  db.prepare('INSERT INTO users(id,email) VALUES (?,?)').run(user, 'fixture@example.invalid');
  db.prepare('INSERT INTO users(id,email) VALUES (?,?)').run(otherUser, 'other@example.invalid');
  const bcrypt = (await import('bcrypt')).default, secret = 'synthetic-writer-secret-not-production', hash = await bcrypt.hash(secret, 4);
  const entries = [['shopping', '00000000-0000-4000-8000-000000000005', 'shopping_write'], ['meal', '00000000-0000-4000-8000-000000000006', 'meal_plan_write']];
  for (const [kind, id, tool] of entries) {
    const profile = kind === 'meal' ? 'estate_hub_mealplan_writer' : 'estate_hub_shopping_writer';
    const source = kind === 'meal' ? 'estate-household-mealplan-writer' : 'estate-household-shopping-writer';
    db.prepare('INSERT INTO oauth_clients(client_id,client_secret_hash,user_id,client_name,profile,source) VALUES (?,?,?,?,?,?)')
      .run(id, hash, user, 'fixture-' + kind, profile, source);
    const policy = { schemaVersion: 1, clientId: id, userId: user, upstreamUserId: 'synthetic-upstream-user',
      journalId: '00000000-0000-4000-8000-000000000007', enabled: false, revision: 1,
      operations: [kind === 'shopping' ? 'shopping.add' : 'meal.create'],
      ...(kind === 'shopping' ? { listId: 'a'.repeat(32) } : { timeZone: 'America/Denver', maxPastDays: 7, maxFutureDays: 93, labelIds: [] }) };
    const save = () => writeFile(path.join(dataDir, `estate-hub-${kind === 'meal' ? 'mealplan' : 'shopping'}-write-policy.json`), JSON.stringify(policy), { mode: 0o600 });
    await save();
    const requestToken = () => fetch(base + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
    assert.equal((await requestToken()).status, 401); policy.enabled = true; await save();
    const issued = await requestToken(); assert.equal(issued.status, 200); const token = await issued.json(); assert.equal(token.refresh_token, undefined);
    let session, sequence = 1;
    const request = (method, params) => fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token.access_token,
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: sequence++, method, params }) });
    const rpc = async (method, params) => { const response = await request(method, params); assert.equal(response.status, 200);
      session = response.headers.get('mcp-session-id') || session; const text = await response.text();
      return response.headers.get('content-type').includes('text/event-stream') ? JSON.parse(text.split('\n').filter(line => line.startsWith('data:')).at(-1).slice(5)) : JSON.parse(text); };
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic-writer', version: '1' } });
    assert.deepEqual((await rpc('tools/list', {})).result.tools.map(value => value.name), [tool]);
    for (const name of ['shopping', 'meal_plan', 'recipes', kind === 'shopping' ? 'meal_plan_write' : 'shopping_write']) {
      const denied = await rpc('tools/call', { name, arguments: { action: 'create' } }); assert.ok(denied.error || denied.result?.isError);
    }
    // A native receipt proves the SDK carries THIS request's headers into the
    // tool handler. No upstream client or business effect is involved.
    const { mkdir } = await import('node:fs/promises');
    const { initializeJournal, openJournal } = await import('../src/profiles/estate-write-journal.js');
    const { digest, WRITE_CONTRACT } = await import('../src/profiles/estate-write-policy.js');
    await mkdir(path.join(dataDir,'estate-write-journals'),{mode:0o700,recursive:true});
    const journalPath=path.join(dataDir,'estate-write-journals',kind+'.sqlite3');
    initializeJournal(journalPath,policy.journalId);
    const journal=openJournal(journalPath,policy.journalId), changeId='00000000-0000-4000-8000-000000000008';
    const command={action:'apply',operation:policy.operations[0],fields:{},change_id:changeId,expected_digest:'0'.repeat(64)};
    journal.reserve({clientId:id,changeId,policyDigest:digest({contract:WRITE_CONTRACT,profile,source,...policy}),commandHash:digest(command),domain:kind,command});
    journal.close();
    const receipt=await rpc('tools/call',{name:tool,arguments:{action:'receipt',change_id:changeId}});
    assert.equal(receipt.result.structuredContent.outcome,'PREPARED');
    assert.equal(receipt.result.isError,undefined);
    const browser = await fetch(base + '/oauth/authorize?' + new URLSearchParams({ client_id: id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code' }), { redirect: 'manual' }); assert.equal(browser.status, 403);
    const writerSession = session;
    db.prepare('UPDATE oauth_clients SET profile = ?, source = ? WHERE client_id = ?').run('full', 'oauth', id);
    session = undefined;
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic-general', version: '1' } });
    assert.ok((await rpc('tools/list', {})).result.tools.some(value => value.name === 'shopping'));
    db.prepare('UPDATE oauth_clients SET profile = ?, source = ? WHERE client_id = ?').run(profile, source, id);
    assert.equal((await request('tools/list', {})).status, 403);
    session = writerSession;
    db.prepare('UPDATE oauth_clients SET user_id = ? WHERE client_id = ?').run(otherUser, id);
    assert.equal((await request('tools/list', {})).status, 401);
    db.prepare('UPDATE oauth_clients SET user_id = ? WHERE client_id = ?').run(user, id);
    policy.enabled = false; await save(); assert.equal((await request('tools/list', {})).status, 401); assert.equal((await requestToken()).status, 401);
  }
  assert.ok(!output.join('').includes(secret));
});
