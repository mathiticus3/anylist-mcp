#!/usr/bin/env node
// Run inside the AnyList container. Credentials and household contents never leave it.
// Read-only provider qualification. Temporary flags and MCP bearer deleted in finally.
import {existsSync,writeFileSync,unlinkSync} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getDb, saveOAuthTokens } from '../src/http/db.js';
import assert from 'node:assert/strict';
const base=process.env.CAMPAIGN_BASE_URL||'http://127.0.0.1:3000';
const flagsPath=(process.env.DATA_DIR||'/data')+'/anylist-experimental.json';
if(existsSync(flagsPath))throw Error('Existing experimental settings require explicit review before qualification');
const token=randomBytes(32).toString('hex'), refresh=randomBytes(32).toString('hex');
const db=getDb();
const client=db.prepare("SELECT client_id,user_id FROM oauth_clients WHERE client_name='punchlist-sync' AND profile='full'").get();
if(!client)throw Error('campaign requires existing punchlist-sync client');
saveOAuthTokens({accessToken:token,refreshToken:refresh,userId:client.user_id,clientId:client.client_id,scope:'mcp'});
let session,id=1;
async function rpc(method,params) {
 const res=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(session?{'Mcp-Session-Id':session}:{}),'MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:id++,method,params}),signal:AbortSignal.timeout(60000)});
 assert.equal(res.status,200,`RPC HTTP ${res.status}`);session=res.headers.get('mcp-session-id')||session;
 const text=await res.text();const result=res.headers.get('content-type').includes('text/event-stream')?JSON.parse(text.split('\n').filter(x=>x.startsWith('data:')).at(-1).slice(5)):JSON.parse(text);
 assert.ok(!result.error,`RPC ${method} error ${result.error?.code}`);return result.result;
}

let failed;const checks=[];
try {
 writeFileSync(flagsPath,JSON.stringify({item_prices:true,list_folders:true}),{mode:0o600});
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'AnyList experimental read qualification',version:'1.0'}});
 const inventory=await rpc('tools/list',{});const tool=inventory.tools.find(t=>t.name==='anylist_experimental');assert.deepEqual(tool.inputSchema.properties.action.enum,['list_prices','list_folders']);checks.push('flagged discovery');
 const call=async(action,p={})=>{const result=await rpc('tools/call',{name:'anylist_experimental',arguments:{action,...p}});assert.ok(!result.isError,result.structuredContent?.error?.code);return result.structuredContent;};
 const folders=await call('list_folders');assert.equal(folders.sourceComplete,true);assert.ok(folders.folders.some(f=>f.identifier===folders.rootFolderId));checks.push('complete typed folder snapshot');
 const lists=await rpc('tools/call',{name:'shopping',arguments:{action:'list_lists',response_format:'structured'}});let totalPriced=0,priceRows=0;
 for(const list of lists.structuredContent.lists){const prices=await call('list_prices',{list_id:list.identifier,limit:100});assert.equal(prices.hasMore,false);totalPriced+=prices.total;for(const item of prices.items){priceRows+=item.prices.length;assert.ok(item.prices.every(p=>typeof p.amount==='number'&&Number.isFinite(p.amount)));}}
 assert.ok(totalPriced>0);checks.push('all-list current price schema and pagination');
 writeFileSync(flagsPath,JSON.stringify({item_prices:false,list_folders:true}),{mode:0o600});const disabled=await rpc('tools/call',{name:'anylist_experimental',arguments:{action:'list_prices',list_id:'irrelevant'}});assert.equal(disabled.structuredContent.error.code,'EXPERIMENTAL_DISABLED');await call('list_folders');checks.push('individual revocation in existing MCP session');
 unlinkSync(flagsPath);const status=await rpc('tools/call',{name:'service',arguments:{action:'status'}});assert.equal(status.structuredContent.ready,true);checks.push('stable readiness after disable');
 await fetch(base+'/mcp',{method:'DELETE',headers:{Authorization:`Bearer ${token}`,'Mcp-Session-Id':session}});session=undefined;
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'Experimental disabled discovery',version:'1.0'}});const disabledInventory=await rpc('tools/list',{});assert.ok(!disabledInventory.tools.some(t=>t.name==='anylist_experimental'));checks.push('absent from new sessions by default');
 console.log(JSON.stringify({ok:true,observedAt:new Date().toISOString(),providerWrites:0,checks,folderCount:folders.total,pricedItems:totalPriced,priceRows,enabledAfter:false,gptExposed:false}));
}catch(e){failed=e;console.log(JSON.stringify({ok:false,providerWrites:0,error:e.message,checks}));}
finally{
 if(existsSync(flagsPath))unlinkSync(flagsPath);
 if(session)await fetch(base+'/mcp',{method:'DELETE',headers:{Authorization:`Bearer ${token}`,'Mcp-Session-Id':session}}).catch(()=>{});
 db.prepare('DELETE FROM oauth_tokens WHERE access_token=?').run(token);
 if(failed)process.exitCode=1;
}
