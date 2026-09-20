#!/usr/bin/env node
// Run inside the AnyList container. Credentials and household contents never leave it.
// Disposable names only. Temporary MCP bearer deleted in finally. No Trilium writes.
import {readFileSync} from 'node:fs';
import {projectionFor} from '../src/actions/projection.js';
import { randomBytes } from 'node:crypto';
import { getDb, saveOAuthTokens } from '../src/http/db.js';
import assert from 'node:assert/strict';
const base=process.env.CAMPAIGN_BASE_URL||'http://127.0.0.1:3000';
const actions=process.env.CAMPAIGN_ACTIONS==='1';
const actionsToken=actions?readFileSync((process.env.DATA_DIR||'/data')+'/.env.gpt-actions','utf8').trim().split('=')[1]:null;
const prefix=`V72-CAMPAIGN-${Date.now()}-`;
const token=randomBytes(32).toString('hex'), refresh=randomBytes(32).toString('hex');
const db=getDb();
const client=db.prepare("SELECT client_id,user_id FROM oauth_clients WHERE client_name='punchlist-sync' AND profile='full'").get();
if(!client)throw Error('campaign requires existing punchlist-sync client');
saveOAuthTokens({accessToken:token,refreshToken:refresh,userId:client.user_id,clientId:client.client_id,scope:'mcp'});
let session,id=1,listName,listId;const receipts=[];const importedIds=[];
async function rpc(method,params) {
 const res=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(session?{'Mcp-Session-Id':session}:{}),'MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:id++,method,params}),signal:AbortSignal.timeout(60000)});
 assert.equal(res.status,200,`RPC HTTP ${res.status}`);session=res.headers.get('mcp-session-id')||session;
 const text=await res.text();const result=res.headers.get('content-type').includes('text/event-stream')?JSON.parse(text.split('\n').filter(x=>x.startsWith('data:')).at(-1).slice(5)):JSON.parse(text);
 assert.ok(!result.error,`RPC ${method} error ${result.error?.code}`);return result.result;
}
async function call(tool,action,params={},legacy=false) {
 let result;
 if(actions&&!legacy){const p=projectionFor(tool,action,params);const res=await fetch(base+'/actions/'+p.entry.operationId,{method:'POST',headers:{Authorization:`Bearer ${actionsToken}`,'Content-Type':'application/json'},body:JSON.stringify(p.input),signal:AbortSignal.timeout(45000)});const body=await res.json();result={isError:!res.ok||!body.ok,structuredContent:body};}
 else result=await rpc('tools/call',{name:tool,arguments:{...(action?{action}:{}),...params,...(!legacy&&tool!=='service'?{response_format:'structured'}:{})}});
 if(result.isError){const e=Error(`${tool}/${action}: ${result.structuredContent?.error?.code||'legacy_error'}`);e.result=result.structuredContent;throw e;}
 receipts.push({tool,action:action||'health',legacy,transport:actions&&!legacy?'https-actions':'mcp',ok:true});return legacy?result:result.structuredContent;
}
const shop=(a,p={})=>call('shopping',a,{list_id:listId,...p});
const assertFresh=async(check)=>{await call('service','refresh');await check();};
async function cleanup() {
 const errors=[];
 for(const id of importedIds)try{await call('recipes','delete',{id});}catch(e){errors.push('import cleanup:'+e.message);}
 if(listId) {
   for(const [read,del] of [['list_items','delete_item'],['get_favorites','remove_favorite']])try{
    const result=await shop(read,read==='list_items'?{include_checked:true}:{});
    for(const i of result.items.filter(i=>i.name.startsWith(prefix)))await shop(del,{id:i.identifier});
   }catch(e){errors.push(`${read}:${e.message}`);}
   try{const result=await shop('list_categories');for(const g of result.categorySets)for(const cat of g.categories||[])if(cat.name.startsWith(prefix))await shop('delete_category',{name:cat.name,category_set:g.name});}catch(e){errors.push('categories:'+e.message);}
 }
 for(const [tool,read,del,key] of [['recipe_collections','list','delete','collections'],['recipes','list','delete','recipes'],['meal_plan','list_events','delete_event','events']])try{
   const result=await call(tool,read,tool==='recipes'?{search:prefix}:tool==='meal_plan'?{date:'2099-01-01'}:{});
   for(const obj of result[key].filter(r=>(r.name||r.title||'').startsWith(prefix)))await call(tool,del,tool==='meal_plan'?{event_id:obj.identifier}:{id:obj.identifier});
 }catch(e){errors.push(tool+':'+e.message);}
 if(listId)try{
   const items=await shop('list_items',{include_checked:true});const favorites=await shop('get_favorites');const categories=await shop('list_categories');
   if([...items.items,...favorites.items,...categories.categorySets.flatMap(g=>g.categories)].some(i=>i.name.startsWith(prefix)))errors.push('shopping residue after delete');
 }catch(e){errors.push('cleanup verification failed');}
 return errors;
}
let failed;
try {
 if(actions){assert.equal((await fetch(base+'/actions/listShoppingLists',{method:'POST'})).status,401);assert.equal((await fetch(base+'/readyz')).status,401);assert.equal((await fetch(base+'/readyz',{headers:{Authorization:`Bearer ${actionsToken}`}})).status,200);const spec=await (await fetch(base+'/openapi.json')).json();assert.equal(spec.openapi,'3.1.0');assert.equal(Object.keys(spec.paths).length,30);assert.equal((await fetch(base+'/privacy')).status,200);receipts.push({httpAuth:true,readiness:true,openapi:true,privacy:true,ok:true});}
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'Vector72 capability acceptance',version:'1.0'}});
 const inventory=await rpc('tools/list',{});assert.ok(inventory.tools.some(t=>t.name==='shopping'));receipts.push({inventory:inventory.tools.map(t=>({name:t.name,actions:t.inputSchema.properties.action?.enum})),ok:true});
 await call('health_check',null,{},true);
 await call('shopping','list_lists',{},true);
 const lists=await call('shopping','list_lists');
 // Prefer the pre-existing scratch list; never create/delete a household list.
 const list=lists.lists.find(l=>l.name==='MCP Category Test')||lists.lists.find(l=>l.name==='Costco List');
 assert.ok(list,'No recognized safe test list available');listId=list.identifier;listName=list.name;
 await call('shopping','list_items',{list_name:listName,include_checked:true,include_notes:true},true);
 for(const action of ['list_categories','list_stores','get_recents','get_favorites'])await shop(action);
 const first=(await shop('add_item',{name:prefix+'Milk',quantity:2,notes:'disposable test'})).item;
 await shop('add_items',{items:[{name:prefix+'Bananas'},{name:prefix+'Bread'}]});
 await shop('update_item',{id:first.identifier,quantity:3,notes:'updated test note'});
 const freshItem=(await shop('list_items',{include_checked:true,include_notes:true})).items.find(i=>i.identifier===first.identifier);assert.equal(String(freshItem.quantity),'3');assert.equal(freshItem.note,'updated test note');
 await shop('check_item',{id:first.identifier});
 await assertFresh(async()=>assert.equal((await shop('list_items',{include_checked:true})).items.find(i=>i.identifier===first.identifier).checked,true));
 await shop('uncheck_item',{id:first.identifier});
 await assertFresh(async()=>assert.equal((await shop('list_items')).items.find(i=>i.identifier===first.identifier).checked,false));
 await shop('set_item_store',{id:first.identifier,store_name:''});
 const fav=(await shop('add_favorite',{name:prefix+'Favorite',notes:'test'})).item;
 await shop('update_favorite',{id:fav.identifier,notes:'updated'});
 await assertFresh(async()=>assert.equal((await shop('get_favorites')).items.find(i=>i.identifier===fav.identifier)?.note,'updated'));
 await shop('remove_favorite',{id:fav.identifier});
 const groups=(await shop('list_categories')).categorySets;
 if(groups.length){const name=prefix+'Category';await shop('create_category',{name,category_set:groups[0].name});await shop('rename_category',{name,new_name:name+'2',category_set:groups[0].name});await shop('delete_category',{name:name+'2',category_set:groups[0].name});}
 const r=(await call('recipes','create',{name:prefix+'Recipe',note:'preserve',ingredients:[{name:'Water',quantity:'1 cup'}],steps:['Boil'],servings:'2',rating:4})).recipe;
 await call('recipes','update',{id:r.identifier,new_name:prefix+'Recipe updated',prep_time:5});
 const freshRecipe=(await call('recipes','get',{id:r.identifier})).recipe;assert.equal(freshRecipe.note,'preserve');assert.equal(freshRecipe.prepTime,5);assert.equal(freshRecipe.rating,4);
 await call('recipes','list',{search:prefix});
 const fixtureUrl='https://raw.githubusercontent.com/mathiticus3/anylist-mcp/codex/anylist-stable-parity/test/fixtures/campaign-recipe.html';
 await call('recipes','normalize',{url:fixtureUrl});
 const imported=await call('recipes','import_url',{url:fixtureUrl});importedIds.push(imported.recipe.identifier);
 await call('recipes','normalize',{text:prefix+'Normalized\nIngredients\n1 cup water\nInstructions\nBoil water.'});
 const col=(await call('recipe_collections','create',{name:prefix+'Collection'})).collection;
 await call('recipe_collections','add_recipe',{id:col.identifier,recipe_id:r.identifier});
 assert.ok((await call('recipe_collections','get',{id:col.identifier})).collection.recipeIds.includes(r.identifier));
 await call('recipe_collections','remove_recipe',{id:col.identifier,recipe_id:r.identifier});
 assert.ok(!(await call('recipe_collections','get',{id:col.identifier})).collection.recipeIds.includes(r.identifier));
 await call('meal_plan','list_labels');
 const meal=(await call('meal_plan','create_event',{date:'2099-01-01',title:prefix+'Meal',details:'preserve',recipe_id:r.identifier})).event;
 await call('meal_plan','update_event',{event_id:meal.identifier,details:'updated details'});
 const events=(await call('meal_plan','list_events',{date:'2099-01-01'})).events;
 assert.equal(events.find(e=>e.identifier===meal.identifier).title,prefix+'Meal');
 assert.equal(events.find(e=>e.identifier===meal.identifier).details,'updated details');
 await call('meal_plan','delete_event',{event_id:meal.identifier});
 await call('recipe_collections','delete',{id:col.identifier});await call('recipes','delete',{id:r.identifier});await shop('delete_item',{id:first.identifier});
 for(const [tool,action] of [['recipes','list'],['recipe_collections','list'],['meal_plan','list_events'],['meal_plan','list_labels']])await call(tool,action,tool==='meal_plan'&&action==='list_events'?{date:'2099-01-01'}:{},true);
 if(actions){
 const duplicate=(await call('recipes','create',{name:prefix+'Duplicate'})).recipe;
 await call('recipes','update',{id:duplicate.identifier,new_name:prefix+'Collision'});
 const second=(await call('recipes','create',{name:prefix+'Second'})).recipe;await call('recipes','update',{id:second.identifier,new_name:prefix+'Collision'});
 const res=await fetch(base+'/actions/getRecipe',{method:'POST',headers:{Authorization:`Bearer ${actionsToken}`,'Content-Type':'application/json'},body:JSON.stringify({name:prefix+'Collision'})});assert.equal(res.status,409);const ambiguity=await res.json();assert.equal(ambiguity.error.code,'AMBIGUOUS');assert.equal(ambiguity.error.candidates.length,2);
 await call('recipes','delete',{id:duplicate.identifier});await call('recipes','delete',{id:second.identifier});
 const bad=await fetch(base+'/actions/addShoppingItems',{method:'POST',headers:{Authorization:`Bearer ${actionsToken}`,'Content-Type':'application/json'},body:JSON.stringify({list_id:listId,items:[]})});assert.equal(bad.status,400);receipts.push({httpAmbiguity:true,httpMalformed:true,ok:true});
 }
 const malformed=await rpc('tools/call',{name:'shopping',arguments:{action:'add_items',response_format:'structured',list_id:listId,items:[]}});assert.equal(malformed.isError,true);
 const missing=await rpc('tools/call',{name:'shopping',arguments:{action:'delete_item',response_format:'structured',list_id:listId,id:'nonexistent-campaign-item'}});assert.equal(missing.structuredContent.error.code,'NOT_FOUND');
 await call('service','status');await call('service','capabilities');
} catch(e){failed={message:e.message,error:e.result?.error};}
finally {
 const cleanupErrors=await cleanup();
 for(const [tool,action,key,params] of [['recipes','list','recipes',{search:prefix}],['recipe_collections','list','collections',{}],['meal_plan','list_events','events',{date:'2099-01-01'}]])try{const fresh=await call(tool,action,params);if(fresh[key].some(o=>(o.name||o.title||'').startsWith(prefix)))cleanupErrors.push(tool+' residue');}catch{cleanupErrors.push(tool+' absence unverified');}
 if(session)await fetch(base+'/mcp',{method:'DELETE',headers:{Authorization:`Bearer ${token}`,'Mcp-Session-Id':session}}).catch(()=>{});
 db.prepare('DELETE FROM oauth_tokens WHERE access_token=?').run(token);
 console.log(JSON.stringify({ok:!failed&&!cleanupErrors.length,transport:actions?'https-actions':'mcp',prefix,receipts,failed,cleanupErrors,temporaryBearerDeleted:true}));
 if(failed||cleanupErrors.length)process.exitCode=1;
}
