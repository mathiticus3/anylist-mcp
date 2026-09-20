#!/usr/bin/env node
// Dedicated writer grant and DISCOVERY ONLY. No tools/call request or mutation probes.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {getDb} from '../src/http/db.js';
import {CANARY_LIST_ID,CANARY_TOKEN_URL,CANARY_MCP_URL} from '../src/profiles/canary-policy.js';
import {CANARY_WRITE_PROFILE as CANARY_PROFILE,CANARY_WRITE_CLIENT_NAME as CANARY_CLIENT_NAME,CANARY_WRITE_SOURCE as CANARY_SOURCE} from '../src/profiles/canary-write-policy.js';
import {canaryWriteInput} from '../src/profiles/canary-write-shopping.js';
import {zodToJsonSchema} from 'zod-to-json-schema';
import assert from 'node:assert/strict';
const file=(process.env.DATA_DIR||'/data')+'/.env.gina-canary-harness-write';
const env=Object.fromEntries(readFileSync(file,'utf8').trim().split('\n').map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));
assert.equal(env.ANYLIST_LIST_ID,CANARY_LIST_ID);assert.equal(env.ANYLIST_TOKEN_URL,CANARY_TOKEN_URL);assert.equal(env.ANYLIST_MCP_URL,CANARY_MCP_URL);
const db=getDb(),record=db.prepare('SELECT client_name,profile,source,redirect_uri FROM oauth_clients WHERE client_id=?').get(env.GINA_CANARY_WRITE_CLIENT_ID);
assert.equal(record?.client_name,CANARY_CLIENT_NAME);assert.equal(record.profile,CANARY_PROFILE);assert.equal(record.source,CANARY_SOURCE);assert.equal(record.redirect_uri,null);
let token,session,id=1;
try{
 const auth=await fetch(CANARY_TOKEN_URL,{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:env.GINA_CANARY_WRITE_CLIENT_ID,client_secret:env.GINA_CANARY_WRITE_CLIENT_SECRET}),signal:AbortSignal.timeout(15000)});assert.equal(auth.status,200);const issued=await auth.json();token=issued.access_token;assert.ok(token);assert.equal(issued.token_type,'Bearer');
 const rpc=async(method,params)=>{const response=await fetch(CANARY_MCP_URL,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${token}`,Accept:'application/json, text/event-stream','Content-Type':'application/json','MCP-Protocol-Version':'2025-06-18',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:id++,method,params}),signal:AbortSignal.timeout(45000)});assert.equal(response.status,200);session=response.headers.get('mcp-session-id')||session;const text=await response.text();const body=response.headers.get('content-type').includes('text/event-stream')?JSON.parse(text.split('\n').filter(l=>l.startsWith('data:')).at(-1).slice(5)):JSON.parse(text);assert.ok(!body.error);assert.ok(!body.result.isError);return body.result;};
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'Dedicated writer discovery only',version:'1'}});
 const inventory=await rpc('tools/list',{});assert.deepEqual(inventory.tools.map(t=>t.name),['shopping']);assert.deepEqual(inventory.tools[0].inputSchema.properties.action.enum,['add_item','delete_item']);
 assert.deepEqual(inventory.tools[0].inputSchema,zodToJsonSchema(canaryWriteInput));
 console.log(JSON.stringify({ok:true,observedAt:new Date().toISOString(),clientIdSha256:createHash('sha256').update(env.GINA_CANARY_WRITE_CLIENT_ID).digest('hex'),clientName:record.client_name,profile:record.profile,source:record.source,grant:'client_credentials',tokenEndpoint:CANARY_TOKEN_URL,mcpEndpoint:CANARY_MCP_URL,allowedListId:CANARY_LIST_ID,boundedWriter:true,executionApprovalIncluded:false,providerWrites:0,permissionMutationProbes:0,toolCalls:0,shoppingSchema:inventory.tools[0].inputSchema,credentialFile:file,secretPrinted:false}));
}finally{
 if(session&&token)await fetch(CANARY_MCP_URL,{method:'DELETE',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Mcp-Session-Id':session},signal:AbortSignal.timeout(15000)}).catch(()=>{});
 // Remove only this test grant's tokens; registration and delivery credential remain.
 if(token)db.prepare('DELETE FROM oauth_tokens WHERE access_token=? AND client_id=?').run(token,env.GINA_CANARY_WRITE_CLIENT_ID);
}
