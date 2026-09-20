import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {registerAllTools} from '../src/tools/index.js';
import {BOUNDED_READ,BOUNDED_ADD,MAX_ITEMS,MAX_RESULT_BYTES,loadBoundedBinding,boundedSource} from '../src/profiles/bounded-policy.js';
import {validateClientRedirectUri} from '../src/http/auth/policy.js';
const target='a'.repeat(32),other='b'.repeat(32),newId='c'.repeat(32);
function fixture(t,{items=[],profile=BOUNDED_READ,fail=false}={}){
 const dir=mkdtempSync(path.join(tmpdir(),'bounded-fixture-')),old=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 t.after(()=>{if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;rmSync(dir,{recursive:true,force:true});});
 const file=path.join(dir,'gina-bounded-shopping.json');let policy={schemaVersion:1,listId:target,readerEnabled:true,addEnabled:true};
 const setPolicy=patch=>{policy={...policy,...patch};writeFileSync(file,JSON.stringify(policy),{mode:0o600});};setPolicy({});
 const binding=loadBoundedBinding(),source=boundedSource(profile,binding);let acquired=0,reads=0,writes=0,created=0;
 const list={identifier:target,name:'Synthetic list',items:[...items],addItem:async item=>{writes++;if(fail)throw Error('private upstream error');list.items.push(item);}};
 const c={ensureAuthenticated:async()=>{},client:{lists:[list,{identifier:other,name:'Other',items:[]}],getLists:async fresh=>{assert.equal(fresh,true);reads++;},createItem:p=>{created++;return {...p,identifier:newId};}}};
 const tools={};const register=(actorSource=source)=>registerAllTools({registerTool(n,config,h){tools[n]={config,h};}},()=>{acquired++;return c;},{profile,actorSource});register();
 return {dir,file,binding,source,setPolicy,register,tools,list,c,counts:()=>({acquired,reads,writes,created}),call:async p=>(await tools.shopping.h(p)).structuredContent,raw:async p=>tools.shopping.h(p)};
}
const read={action:'list_items',list_id:target,include_checked:true,include_notes:true};
const add={action:'add_item',list_id:target,name:'Synthetic new item',quantity:1};
test('complete 2509-item snapshot includes all checked/unchecked items, exact notes, IDs and order',async t=>{
 const items=Array.from({length:2509},(_,i)=>({identifier:i.toString(16).padStart(32,'0'),name:`Fixture ${i}`,quantity:String(i+1),checked:i%2===0,details:`\"Unicode 🍎 note ${i}\"\n`+'x'.repeat(300),storeIds:['fixture-store'],categoryAssignments:[]}));
 const f=fixture(t,{items}),r=await f.raw(read),body=r.structuredContent;
 assert.equal(body.ok,true);assert.equal(body.complete,true);assert.equal(body.itemCount,2509);assert.equal(body.items.length,2509);assert.equal(body.provider.allowedListId,target);assert.equal(body.provider.readOnly,true);assert.equal(body.provider.bindingSha256,f.binding.bindingSha256);assert.ok(body.freshReadAt);assert.match(body.snapshotSha256,/^[a-f0-9]{64}$/);
 for(let i=0;i<items.length;i++){assert.equal(body.items[i].identifier,items[i].identifier);assert.equal(body.items[i].checked,items[i].checked);assert.equal(body.items[i].note,items[i].details);assert.equal(body.items[i].quantity,items[i].quantity);}
 const bytes=Buffer.byteLength(JSON.stringify(r));assert.ok(bytes<MAX_RESULT_BYTES);assert.ok(bytes>1000000);assert.equal(r.content.length,1);assert.ok(r.content[0].text.length<100);assert.deepEqual(f.counts(),{acquired:1,reads:1,writes:0,created:0});
});
test('read schema rejects filtering/paging/other target/mutations before client access',async t=>{
 const f=fixture(t);assert.deepEqual(Object.keys(f.tools),['shopping']);assert.equal(f.tools.shopping.config.inputSchema.action.value,'list_items');
 for(const p of [{...read,list_id:other},{...read,list_id:undefined},{...read,include_checked:false},{...read,include_notes:false},{...read,limit:10},{...read,offset:0},add])assert.equal((await f.call(p)).error.code,'INVALID_INPUT');
 assert.equal(f.counts().acquired,0);
});
test('oversized byte/count snapshots fail with no partial items or complete claim',async t=>{
 const f=fixture(t,{items:[{identifier:'1',name:'Synthetic',details:'🍎'.repeat(MAX_RESULT_BYTES/4)}]});
 let r=await f.call(read);assert.equal(r.error.code,'RESPONSE_TOO_LARGE');assert.equal(r.complete,false);assert.equal(r.items,undefined);
 f.list.items=Array.from({length:MAX_ITEMS+1},(_,i)=>({identifier:String(i),name:'Fixture'}));r=await f.call(read);assert.equal(r.error.code,'RESPONSE_TOO_LARGE');assert.equal(r.items,undefined);
});
test('duplicate/missing IDs fail complete snapshot rather than inventing identity',async t=>{
 const f=fixture(t,{items:[{identifier:'same',name:'One'},{identifier:'same',name:'Two'}]});assert.equal((await f.call(read)).error.code,'INVALID_SNAPSHOT');f.list.items=[{name:'Missing'}];assert.equal((await f.call(read)).error.code,'INVALID_SNAPSHOT');
});
test('add-only schema forbids model notes and all broader actions/fields before acquisition',async t=>{
 const f=fixture(t,{profile:BOUNDED_ADD});assert.deepEqual(Object.keys(f.tools),['shopping']);assert.equal(f.tools.shopping.config.inputSchema.action.value,'add_item');
 for(const field of ['notes','category','store','store_ids','manual_sort_index','item_id','expected_name'])assert.equal((await f.call({...add,[field]:'forbidden'})).error.code,'INVALID_INPUT');
 for(const action of ['delete_item','update_item','check_item','add_items','list_items'])assert.equal((await f.call({...add,action})).error.code,'INVALID_INPUT');
 for(const p of [{...add,quantity:2},{...add,quantity:undefined},{...add,name:' padded '},{...add,name:'\n'},{...add,name:'Bad\u0085control'},{...add,name:'Bad\u202eformat'},{...add,name:'x'.repeat(129)},{...add,list_id:other}])assert.equal((await f.call(p)).error.code,'INVALID_INPUT');
 assert.equal(f.counts().acquired,0);
});
test('new-item add encodes no notes, calls once, and normalized collision never upserts',async t=>{
 const f=fixture(t,{profile:BOUNDED_ADD});const first=await f.call(add);assert.equal(first.ok,true);assert.equal(first.item.identifier,newId);assert.equal(first.item.note,null);assert.equal(first.item.quantity,1);assert.equal(first.outcome,'ACKNOWLEDGED');assert.equal(first.independentReadRequired,true);assert.equal(f.counts().writes,1);
 assert.equal((await f.call({...add,name:'SYNTHETIC  NEW ITEM'})).error.code,'CONFLICT');assert.equal(f.counts().writes,1);
 f.list.items=[{identifier:'1',name:' ＳＹＮＴＨＥＴＩＣ new item ',checked:true,details:'Keep'}];assert.equal((await f.call(add)).error.code,'CONFLICT');assert.equal(f.list.items[0].details,'Keep');
});
test('add refuses any snapshot that cannot be completely read and preserves unknown outcome without retry',async t=>{
 const f=fixture(t,{profile:BOUNDED_ADD,fail:true});let r=await f.call(add);assert.equal(r.outcome,'UNKNOWN');assert.equal(r.attemptedItemId,newId);assert.equal(r.independentReadRequired,true);assert.equal(f.counts().writes,1);assert.ok(!JSON.stringify(r).includes('private upstream'));
 f.list.items=Array.from({length:MAX_ITEMS},(_,i)=>({identifier:String(i),name:`Existing ${i}`}));r=await f.call(add);assert.equal(r.error.code,'RESPONSE_TOO_LARGE');assert.equal(r.outcome,'NOT_DISPATCHED');assert.equal(f.counts().writes,1);
});
test('policy kill/retarget is checked for existing session and immediately before dispatch',async t=>{
 const f=fixture(t,{profile:BOUNDED_ADD});f.setPolicy({addEnabled:false});assert.equal((await f.call(add)).error.code,'POLICY_DISABLED');assert.equal(f.counts().acquired,0);
 f.setPolicy({addEnabled:true,readerEnabled:false});assert.equal((await f.call(add)).error.code,'POLICY_DISABLED');
 f.setPolicy({readerEnabled:true,listId:other});assert.equal((await f.call(add)).error.code,'POLICY_CHANGED');assert.throws(()=>f.register(),e=>e.code==='POLICY_CHANGED');
 f.setPolicy({listId:target});f.c.client.getLists=async()=>f.setPolicy({addEnabled:false});assert.equal((await f.call(add)).error.code,'POLICY_DISABLED');assert.equal(f.counts().writes,0);
});
test('missing/malformed/public/symlink binding and wrong client source fail closed',t=>{
 const f=fixture(t);assert.throws(()=>f.register('wrong'),e=>e.code==='POLICY_CHANGED');chmodSync(f.file,0o644);assert.throws(()=>loadBoundedBinding(),e=>e.code==='POLICY_UNAVAILABLE');chmodSync(f.file,0o600);writeFileSync(f.file,'{}');assert.throws(()=>loadBoundedBinding(),e=>e.code==='POLICY_UNAVAILABLE');rmSync(f.file);symlinkSync(path.join(f.dir,'absent'),f.file);assert.throws(()=>loadBoundedBinding(),e=>e.code==='POLICY_UNAVAILABLE');
});
test('both bounded clients deny browser rebinding',()=>{
 for(const profile of [BOUNDED_READ,BOUNDED_ADD])assert.throws(()=>validateClientRedirectUri({profile,redirect_uri:null},'https://claude.ai/api/mcp/auth_callback'),e=>e.status===403);
});

test('actual pinned protobuf add contains only new name, quantity1 and empty notes',async t=>{
 const f=fixture(t,{profile:BOUNDED_ADD});const {default:AnyList}=await import('../src/anylist-legacy-client.cjs');const {default:List}=await import('../anylist-js/lib/list.js');
 const lib=new AnyList({email:'fixture@example.invalid',password:'unused'});lib.uid='fixture-owner';const operations=[];
 lib.client={post:async(endpoint,{body})=>{assert.equal(endpoint,'data/shopping-lists/update');const ops=lib.protobuf.PBListOperationList.decode(body._streams.find(Buffer.isBuffer));assert.equal(ops.operations.length,1);operations.push(ops.operations[0]);}};
 const list=new List({identifier:target,name:'Synthetic',items:[]},lib);lib.lists=[list];lib.getLists=async()=>lib.lists;f.c.client=lib;
 const r=await f.call(add);assert.equal(r.ok,true);assert.equal(operations.length,1);const op=operations[0];assert.equal(op.metadata.handlerId,'add-shopping-list-item');assert.equal(op.listId,target);assert.equal(op.listItem.name,add.name);assert.equal(op.listItem.quantityPb.amount,'1');assert.equal(op.listItem.details,'');assert.equal(op.listItem.checked,false);
});

test('actual MCP HTTP transport returns one complete 2509-item structured result without text duplication',async t=>{
 const items=Array.from({length:2509},(_,i)=>({identifier:String(i),name:`Synthetic ${i}`,checked:i%2===0,quantity:'1',details:'🍎 note '+i+'x'.repeat(512)}));const f=fixture(t,{items});
 const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js');const {StreamableHTTPServerTransport}=await import('@modelcontextprotocol/sdk/server/streamableHttp.js');const {default:express}=await import('express');
 const server=new McpServer({name:'fixture',version:'1'});registerAllTools(server,()=>f.c,{profile:BOUNDED_READ,actorSource:f.source});
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=> 'fixture-session',enableJsonResponse:true});await server.connect(transport);
 const app=express();app.use(express.json());app.post('/mcp',(req,res)=>transport.handleRequest(req,res,req.body));
 const http=await new Promise(resolve=>{const h=app.listen(0,'127.0.0.1',()=>resolve(h));});t.after(async()=>{await transport.close();await server.close();await new Promise(resolve=>http.close(resolve));});
 const url=`http://127.0.0.1:${http.address().port}/mcp`;let session;
 const rpc=async(id,method,params)=>{const r=await fetch(url,{method:'POST',headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});assert.equal(r.status,200);session=r.headers.get('mcp-session-id')||session;const text=await r.text();return {body:JSON.parse(text),bytes:Buffer.byteLength(text)};};
 await rpc(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
 const r=await rpc(2,'tools/call',{name:'shopping',arguments:read});assert.equal(r.body.result.structuredContent.items.length,2509);assert.equal(r.body.result.structuredContent.complete,true);assert.ok(r.bytes>1500000);assert.ok(r.bytes<MAX_RESULT_BYTES+1024);t.diagnostic(`Synthetic2509 complete MCP response bytes=${r.bytes}; no real provider calls.`);
});
