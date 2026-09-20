import test from 'node:test';
import assert from 'node:assert/strict';
import {AnyListExperimentalClient} from '../src/experimental/client.js';
import {registerExperimental} from '../src/experimental/tools.js';
import {PROJECTION} from '../src/actions/projection.js';
const snapshot=()=>({shoppingListsResponse:{newLists:[{identifier:'l1',name:'Test',items:[{identifier:'i1',name:'Milk',prices:[{amount:3.25,storeId:'s1',details:'per package',date:'2026-09-20'}]},{identifier:'i2',name:'Bread',prices:[]}]}],listResponses:[{listId:'l1',stores:[{identifier:'s1',name:'Store'}]}]},listFoldersResponse:{includesAllFolders:true,rootFolderId:'root',listFolders:[{identifier:'root',name:'Root',items:[{identifier:'l1',itemType:0},{identifier:'f1',itemType:1}]},{identifier:'f1',name:'Folder',items:[]}]}});
test('experimental client reads current per-store price records and complete typed folders without writes',async()=>{
 let reads=0;const e=new AnyListExperimentalClient({_getUserData:async fresh=>{assert.equal(fresh,true);reads++;return snapshot();}});
 const prices=await e.listItemPrices({list_id:'l1'});assert.equal(prices.total,1);assert.equal(prices.items[0].prices[0].amount,3.25);assert.equal(prices.items[0].prices[0].storeName,'Store');assert.equal(prices.hasMore,false);
 const none=await e.listItemPrices({list_id:'l1',id:'i2'});assert.equal(none.items[0].prices.length,0);
 await assert.rejects(e.listItemPrices({list_id:'l1',id:'other-list-item'}),err=>err.code==='NOT_FOUND');
 const folders=await e.listFolders({limit:1});assert.equal(folders.sourceComplete,true);assert.equal(folders.hasMore,true);assert.deepEqual(folders.folders[0].items.map(i=>i.type),['list','folder']);assert.equal(reads,4);
});
test('experimental schema changes and incomplete snapshots fail locally, without changing raw library snapshot',async()=>{
 const d=snapshot(),before=JSON.stringify(d);const e=new AnyListExperimentalClient({_getUserData:async()=>d});await e.listFolders({});await e.listItemPrices({list_id:'l1'});assert.equal(JSON.stringify(d),before);
 d.listFoldersResponse.includesAllFolders=false;await assert.rejects(e.listFolders({}),e=>e.code==='EXPERIMENTAL_INCOMPLETE');
 d.shoppingListsResponse.newLists[0].items[0].prices[0].amount='bad';await assert.rejects(e.listItemPrices({list_id:'l1'}),e=>e.code==='EXPERIMENTAL_SCHEMA_CHANGED');
});
test('experiments are absent by default, individually gated, revocable in an existing session and never GPT projected',async()=>{
 const handlers={};const server={registerTool(n,c,h){handlers[n]={c,h};}};const c={ensureAuthenticated:async()=>{},client:{_getUserData:async()=>snapshot()}};let flags={};
 registerExperimental(server,async()=>c,()=>flags);assert.deepEqual(handlers,{});
 flags={item_prices:true};registerExperimental(server,async()=>c,()=>flags);const h=handlers.anylist_experimental;assert.deepEqual(h.c.inputSchema.action.options,['list_prices']);
 assert.equal((await h.h({action:'list_prices',list_id:'l1'})).structuredContent.ok,true);
 assert.equal((await h.h({action:'list_folders'})).structuredContent.error.code,'EXPERIMENTAL_DISABLED');
 assert.equal((await h.h({action:'list_prices',list_id:'l1',rpc:'anything'})).structuredContent.error.code,'INVALID_INPUT');
 flags={};assert.equal((await h.h({action:'list_prices',list_id:'l1'})).structuredContent.error.code,'EXPERIMENTAL_DISABLED');
 assert.ok(!PROJECTION.some(p=>p.targets.some(t=>t.startsWith('anylist_experimental/'))));
});
