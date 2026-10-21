import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,chmodSync,symlinkSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AnyListClient from '../src/anylist-client.js';
import AnyList from '../src/anylist-legacy-client.cjs';
import {registerAllTools} from '../src/tools/index.js';
import {validateClientRedirectUri} from '../src/http/auth/policy.js';
import {READ_PROFILES,READ_SOURCES,readPolicyFile,assertReadScope} from '../src/profiles/estate-household-policy.js';
const clientId='00000000-0000-4000-8000-000000000001',userId='00000000-0000-4000-8000-000000000002',listId='a'.repeat(32);
function setup(t,kind){
 const dir=mkdtempSync(path.join(os.tmpdir(),'synthetic-household-reads-')),old=process.env.DATA_DIR;process.env.DATA_DIR=dir;
 t.after(()=>{if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;rmSync(dir,{recursive:true,force:true});});
 const policy={schemaVersion:1,clientId,userId,enabled:true,revision:1,...(kind==='shopping'?{listId}:{})};
 const save=()=>writeFileSync(readPolicyFile(READ_PROFILES[kind]),JSON.stringify(policy),{mode:0o600});save();
 const tools={};let reads=0;
 const client={ensureAuthenticated:async()=>{},client:{getLists:async()=>{reads++;},lists:[{identifier:listId,name:'Fixture',items:[{identifier:'one',name:'Milk',checked:false,details:'private fixture note'},{identifier:'two',name:'Rice',checked:true}]}],getRecipes:async()=>{reads++;return [{identifier:'id-z',name:'Soup',prepTime:60,cookTime:120,ingredients:[{name:'salt'}],preparationSteps:['Mix']},{identifier:'id-a',name:'SOUP',note:'fixture detail'},{identifier:'id-b',name:'Other'}];}}};
 client.client._getUserData=async()=>{if(kind==='shopping'){await client.client.getLists(true);return {shoppingListsResponse:{newLists:client.client.lists}};}return {recipeDataResponse:{recipes:await client.client.getRecipes(true)}};};
 registerAllTools({registerTool(n,config,handler){tools[n]={config,handler};}},async()=>client,{profile:READ_PROFILES[kind],actorSource:READ_SOURCES[kind],clientId,userId});
 return {tools,client,policy,save,dir,reads:()=>reads};
}
function body(result){assert.equal(result.isError,undefined);assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);return result.structuredContent;}
test('shopping source identity has exactly one fixed-list complete read and no other tools',async t=>{
 const f=setup(t,'shopping');assert.deepEqual(Object.keys(f.tools),['shopping_read']);const invoke=f.tools.shopping_read.handler;
 const b=body(await invoke({action:'list_items',list_id:listId}));assert.equal(b.complete,true);assert.deepEqual(b.items.map(x=>x.identifier),['one','two']);assert.equal(b.items[0].note,'private fixture note');
 assert.equal(b.provider.readOnly,true);assert.equal(b.provider.mutationsEnabled,false);assert.equal(b.freshness,'retrieval_only');assert.equal(b.source_modified_at,null);
 for(const p of [{action:'add_item',name:'x'},{action:'list_lists'},{action:'list_items',list_id:'b'.repeat(32)},{action:'list_items',list_id:listId,include_checked:false}])assert.equal((await invoke(p)).isError,true);
 assert.equal(f.reads(),1);
 f.client.client.getLists=async()=>{f.policy.enabled=false;f.save();};assert.equal((await invoke({action:'list_items',list_id:listId})).isError,true);
});
test('recipe profile searches literal names with truthful caps and gets exact IDs only',async t=>{
 const f=setup(t,'recipes');assert.deepEqual(Object.keys(f.tools),['recipes_read']);const invoke=f.tools.recipes_read.handler;
 const capped=body(await invoke({action:'list',search:'soup',limit:1}));assert.equal(capped.complete,false);assert.equal(capped.recipes[0].identifier,'id-a');
 const complete=body(await invoke({action:'list',search:'soup',limit:2}));assert.equal(complete.complete,true);assert.equal(complete.recipes.length,2);
 const exact=body(await invoke({action:'get',recipe_id:'id-z'}));assert.deepEqual(exact.recipe.preparationSteps,['Mix']);assert.equal(exact.provider.client_id,clientId);
 assert.equal(body(await invoke({action:'list',search:'%',limit:20})).recipes.length,0);
 for(const p of [{action:'create',name:'x'},{action:'get',recipe_name:'Soup'},{action:'list',search:''},{action:'list',search:'soup',limit:21},{action:'list',search:'soup',limit:true},{action:'get',recipe_id:'id-z',save:true}])assert.equal((await invoke(p)).isError,true);
 const missing=body(await invoke({action:'get',recipe_id:'missing'}));assert.equal(missing.status,'not_found');
 f.client.client.getRecipes=async()=>[{identifier:'duplicate',name:'A'},{identifier:'duplicate',name:'B'}];assert.equal((await invoke({action:'get',recipe_id:'duplicate'})).isError,true);
});
test('policies are account/client/source bound, independently revocable and private regular files only',async t=>{
 const f=setup(t,'recipes'),profile=READ_PROFILES.recipes,source=READ_SOURCES.recipes;
 assert.throws(()=>assertReadScope(profile,userId,userId,source));assert.throws(()=>assertReadScope(profile,clientId,clientId,source));assert.throws(()=>assertReadScope(profile,clientId,userId,READ_SOURCES.shopping));
 assert.throws(()=>validateClientRedirectUri({profile,redirect_uri:null},'https://claude.ai/api/mcp/auth_callback'));
 f.policy.enabled=false;f.save();assert.throws(()=>assertReadScope(profile,clientId,userId,source));
 f.policy.enabled=true;f.save();chmodSync(readPolicyFile(profile),0o644);assert.throws(()=>assertReadScope(profile,clientId,userId,source));
 rmSync(readPolicyFile(profile));writeFileSync(path.join(f.dir,'elsewhere'),JSON.stringify(f.policy),{mode:0o600});symlinkSync(path.join(f.dir,'elsewhere'),readPolicyFile(profile));assert.throws(()=>assertReadScope(profile,clientId,userId,source));
});
test('oversized/malformed source values and changed policy fail closed without exception disclosure',async t=>{
 const f=setup(t,'recipes'),invoke=f.tools.recipes_read.handler;
 f.client.client.getRecipes=async()=>[{identifier:'one',name:'X',note:'x'.repeat(1048576)}];assert.equal((await invoke({action:'get',recipe_id:'one'})).isError,true);
 f.client.client.getRecipes=async()=>{f.policy.revision++;f.save();return [];};assert.equal((await invoke({action:'list',search:'Soup'})).isError,true);
 f.client.client.getRecipes=async()=>{throw Error('private-error-sentinel');};assert.ok(!JSON.stringify(await invoke({action:'list',search:'Soup'})).includes('private-error-sentinel'));
});

test('readers reject absent raw source IDs before library constructors invent identities',async t=>{
 const f=setup(t,'recipes');
 f.client.client._getUserData=async()=>({recipeDataResponse:{recipes:[{name:'Soup'}]}});
 assert.equal((await f.tools.recipes_read.handler({action:'list',search:'Soup'})).isError,true);
});
test('cold authentication of a dedicated reader emits only fixed diagnostics',async t=>{
 const f=setup(t,'recipes'),original=AnyList.prototype.login,log=console.error,logs=[];
 AnyList.prototype.login=async()=>{throw Error('private-auth-error-sentinel');};console.error=(...x)=>logs.push(x.join(' '));
 try{
  const c=new AnyListClient({username:'private-account-sentinel',password:'synthetic'}),tools={};
  registerAllTools({registerTool(n,config,handler){tools[n]=handler;}},async()=>c,{profile:READ_PROFILES.recipes,actorSource:READ_SOURCES.recipes,clientId,userId});
  const result=await tools.recipes_read({action:'list',search:'Soup'});
  assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes('private-auth-error-sentinel'));
  assert.ok(!logs.join(' ').includes('private-auth-error-sentinel'));assert.ok(!logs.join(' ').includes('private-account-sentinel'));
 }finally{AnyList.prototype.login=original;console.error=log;}
});

test('snapshot authentication never starts the upstream background listener',async()=>{
 const originalLogin=AnyList.prototype.login,originalLists=AnyList.prototype.getLists;
 let listenerRequested;
 AnyList.prototype.login=async function(connectWebSocket=true){listenerRequested=connectWebSocket;};
 AnyList.prototype.getLists=async()=>[];
 try{
  const c=new AnyListClient({username:'synthetic',password:'synthetic'});
  await c.ensureAuthenticated({safeDiagnostics:true});
  assert.equal(listenerRequested,false);
 }finally{AnyList.prototype.login=originalLogin;AnyList.prototype.getLists=originalLists;}
});
