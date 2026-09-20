import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAllTools} from '../src/tools/index.js';
import {CANARY_LIST_ID} from '../src/profiles/canary-policy.js';
import {CANARY_WRITE_PROFILE} from '../src/profiles/canary-write-policy.js';
import {validateClientRedirectUri} from '../src/http/auth/policy.js';
const id='1'.repeat(32),otherId='2'.repeat(32);
function fixture(items=[],options={}){
 let acquired=0,reads=0;const writes=[];
 const list={identifier:CANARY_LIST_ID,name:'Fixture',items:[...items],async addItem(item){writes.push(['add',item]);if(options.fail)throw Error('private transport body must not escape');this.items.push(item);},async removeItem(item){writes.push(['delete',item]);if(options.fail)throw Error('private transport body must not escape');this.items=this.items.filter(i=>i.identifier!==item.identifier);}};
 const c={ensureAuthenticated:async()=>{},client:{lists:[list,{identifier:'unrelated',name:'Other',items:[{identifier:otherId,name:'Other'}]}],getLists:async fresh=>{assert.equal(fresh,true);reads++;if(options.readFail)throw Error('transport');},createItem:p=>({...p,identifier:id})}};
 const tools={};registerAllTools({registerTool(n,config,h){tools[n]={config,h};}},()=>{acquired++;return c;},{profile:CANARY_WRITE_PROFILE});
 return {tools,list,writes,counts:()=>({acquired,reads}),call:async p=>(await tools.shopping.h(p)).structuredContent};
}
const add={action:'add_item',list_id:CANARY_LIST_ID,name:'Synthetic canary',quantity:1,notes:'fixture'};
const remove={action:'delete_item',list_id:CANARY_LIST_ID,item_id:id,expected_name:'Synthetic canary'};
test('writer registers only bounded shopping actions; malformed requests rejected before client access',async()=>{
 const f=fixture();assert.deepEqual(Object.keys(f.tools),['shopping']);assert.deepEqual(f.tools.shopping.config.inputSchema.action.options,['add_item','delete_item']);
 for(const p of [{...add,list_id:'other'},{...add,list_id:undefined},{...add,name:'x'.repeat(129)},{...add,name:' padded '},{...add,name:'\n'},{...add,quantity:2},{...add,quantity:undefined},{...add,notes:'x'.repeat(257)},{...add,item_id:id},{...add,category:'other'},{...add,action:'add_items'},{...add,action:'list_items'},{...remove,item_id:undefined},{...remove,item_id:'../bad'},{...remove,expected_name:undefined},{...remove,notes:'forbidden'},{...remove,quantity:1}]){
  const r=await f.call(p);assert.equal(r.error.code,'INVALID_INPUT');assert.equal(r.outcome,'NOT_DISPATCHED');
 }
 assert.deepEqual(f.counts(),{acquired:0,reads:0});assert.equal(f.writes.length,0);
});
test('single add uses one new-item write with bounded fields, never upsert/save/check',async()=>{
 const unrelated={identifier:otherId,name:'Unrelated',checked:true};const f=fixture([unrelated]);const r=await f.call(add);
 assert.equal(r.ok,true);assert.equal(r.item.identifier,id);assert.equal(r.item.quantity,1);assert.equal(r.item.note,'fixture');assert.equal(r.item.checked,false);assert.equal(r.outcome,'ACKNOWLEDGED');assert.equal(r.independentReadRequired,true);assert.deepEqual(f.counts(),{acquired:1,reads:1});assert.equal(f.writes.length,1);assert.equal(f.list.items[0],unrelated);
 const again=await f.call(add);assert.equal(again.error.code,'CONFLICT');assert.equal(again.dispatchAttempted,false);assert.equal(f.writes.length,1);
});
test('trim/case-insensitive existing name including checked items conflicts with no write',async()=>{
 const original={identifier:otherId,name:' SYNTHETIC CANARY ',checked:true,details:'unchanged'};const f=fixture([original]);const r=await f.call(add);assert.equal(r.error.code,'CONFLICT');assert.equal(f.writes.length,0);assert.deepEqual(f.list.items,[original]);
});
test('delete requires exact matching ID and name in fresh fixed list; no cross-list/name-only fallback',async()=>{
 const item={identifier:id,name:add.name},f=fixture([item]);
 for(const p of [{...remove,item_id:otherId},{...remove,expected_name:'synthetic canary'}]){const r=await f.call(p);assert.equal(r.dispatchAttempted,false);assert.equal(f.writes.length,0);}
 const r=await f.call(remove);assert.equal(r.ok,true);assert.equal(r.identifier,id);assert.equal(r.deleted,true);assert.equal(f.writes.length,1);
 assert.equal((await f.call(remove)).error.code,'NOT_FOUND');assert.equal(f.writes.length,1);
 const ambiguous=fixture([item,{...item}]);assert.equal((await ambiguous.call(remove)).error.code,'AMBIGUOUS');assert.equal(ambiguous.writes.length,0);
});
test('write failures are UNKNOWN without automatic retry or absence claims; read failure dispatches nothing',async()=>{
 for(const p of [add,remove]){const f=fixture([{identifier:id,name:add.name}].filter(()=>p.action==='delete_item'),{fail:true});const r=await f.call(p);assert.equal(r.ok,false);assert.equal(r.outcome,'UNKNOWN');assert.equal(r.attemptedItemId,id);assert.equal(r.independentReadRequired,true);assert.equal(f.writes.length,1);assert.ok(!JSON.stringify(r).includes('private transport'));}
 const f=fixture([],{readFail:true});const r=await f.call(add);assert.equal(r.outcome,'NOT_DISPATCHED');assert.equal(f.writes.length,0);
});
test('shared client serialization prevents concurrent same-process duplicate add',async()=>{
 const f=fixture();const results=await Promise.all([f.call(add),f.call(add)]);assert.deepEqual(results.map(r=>r.ok),[true,false]);assert.equal(f.writes.length,1);
});
test('writer client cannot bind browser redirect and acquire full-profile tools',()=>{
 assert.throws(()=>validateClientRedirectUri({profile:CANARY_WRITE_PROFILE,redirect_uri:null},'https://claude.ai/api/mcp/auth_callback'),e=>e.code==='unauthorized_client'&&e.status===403);
});

test('pinned real library encodes exactly one add/delete operation with intended fields',async()=>{
 const {default:AnyList}=await import('../src/anylist-legacy-client.cjs');
 const {default:List}=await import('../anylist-js/lib/list.js');
 const lib=new AnyList({email:'fixture@example.invalid',password:'unused'});
 lib.uid='fixture-owner';
 const operations=[];lib.client={post:async(endpoint,{body})=>{
  assert.equal(endpoint,'data/shopping-lists/update');
  const binary=body._streams.find(Buffer.isBuffer);assert.ok(binary);
  const decoded=lib.protobuf.PBListOperationList.decode(binary);assert.equal(decoded.operations.length,1);operations.push(decoded.operations[0]);
 }};
 const list=new List({identifier:CANARY_LIST_ID,name:'Fixture',items:[]},lib);lib.lists=[list];lib.getLists=async()=>lib.lists;
 const c={client:lib,ensureAuthenticated:async()=>{}};let handler;registerAllTools({registerTool(n,config,h){handler=h;}},()=>c,{profile:CANARY_WRITE_PROFILE});
 const added=(await handler(add)).structuredContent;assert.equal(added.ok,true);assert.match(added.item.identifier,/^[a-f0-9]{32}$/);
 assert.equal(operations[0].metadata.handlerId,'add-shopping-list-item');assert.equal(operations[0].listId,CANARY_LIST_ID);assert.equal(operations[0].listItem.name,add.name);assert.equal(operations[0].listItem.quantityPb.amount,'1');assert.equal(operations[0].listItem.details,'fixture');assert.equal(operations[0].listItem.checked,false);
 const removed=(await handler({...remove,item_id:added.item.identifier})).structuredContent;assert.equal(removed.ok,true);assert.equal(operations.length,2);assert.equal(operations[1].metadata.handlerId,'remove-shopping-list-item');assert.equal(operations[1].listItemId,added.item.identifier);assert.equal(operations[1].listId,CANARY_LIST_ID);
});
