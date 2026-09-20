import test from 'node:test';
import assert from 'node:assert/strict';
import AnyListClient from '../src/anylist-client.js';
import AnyList from '../src/anylist-legacy-client.cjs';
import {CAPABILITIES,capability} from '../src/stable/capabilities.js';
import {executeClientCapability,recipeView} from '../src/stable/client.js';
import {invokeStable} from '../src/stable/tools.js';
import {resolve,withClientLock} from '../src/stable/errors.js';
import {publicIPv4,validateRecipeUrl} from '../src/safe-recipe-fetch.js';
import {registerAllTools} from '../src/tools/index.js';
function fixture() {
  const raw=new AnyList({email:'test@example.com',password:'unused',credentialsFile:null});
  raw.uid='user';raw.recipeDataId='recipes';raw.calendarId='calendar';
  const posts=[];raw.client={post:async(path,{body})=>{posts.push({path,body});return {};}};
  const c=new AnyListClient();c.client=raw;
  const items=[];const list={identifier:'list1',name:'Test',items,stores:[],categoryGroups:[],addItem:async i=>{i.listId='list1';items.push(i);},removeItem:async i=>items.splice(items.indexOf(i),1)};
  const favorites={...list,identifier:'favorites',items:[]};favorites.addItem=async(i,f)=>{assert.equal(f,true);i.listId='favorites';favorites.items.push(i);};favorites.removeItem=async(i,f)=>{assert.equal(f,true);favorites.items.splice(favorites.items.indexOf(i),1);};
  raw.lists=[list];raw.getLists=async()=>raw.lists;raw.getFavoriteItemsByListId=()=>favorites;raw.getRecentItemsByListId=()=>[];
  let rs=[];raw.getRecipes=async()=>rs;
  const makeRecipe=raw.createRecipe.bind(raw);raw.createRecipe=async p=>{const r=await makeRecipe(p);r.save=async()=>{rs=rs.filter(x=>x.identifier!==r.identifier);rs.push(r);};r.delete=async()=>{rs=rs.filter(x=>x!==r);};return r;};
  raw.mealPlanningCalendarEventLabels=[{identifier:'dinner',name:'Dinner'}];let events=[];raw.getMealPlanningCalendarEvents=async()=>events;
  const makeEvent=raw.createEvent.bind(raw);raw.createEvent=async p=>{const e=await makeEvent(p);e.save=async()=>{events=events.filter(x=>x.identifier!==e.identifier);events.push(e);};e.delete=async()=>{events=events.filter(x=>x!==e);};return e;};
  raw._getUserData=async()=>({recipeDataResponse:{recipeCollections:[]}});
  return {c,raw,list,posts,favorites};
}
test('bounded schemas, action uniqueness and registration coverage',()=>{
  assert.equal(new Set(CAPABILITIES.map(c=>c.operationId)).size,CAPABILITIES.length);
  const configs={};registerAllTools({registerTool(n,c){configs[n]=c;return {update(){}};}},()=>{});
  for(const d of CAPABILITIES)assert.ok(configs[d.tool].inputSchema.action.options.includes(d.action));
  assert.equal(capability('shopping','add_items').schema.safeParse({items:[]}).success,false);
  assert.equal(capability('shopping','add_item').schema.safeParse({name:'x',quantity:-1}).success,false);
  assert.equal(capability('meal_plan','create_event').schema.safeParse({date:'2026-02-30',title:'x'}).success,false);
});
test('exact names, ID disambiguation, missing and conflicting selectors',()=>{
  const rows=[{identifier:'1',name:'Milk'},{identifier:'2',name:'Milk'}];
  assert.throws(()=>resolve(rows,{name:'milk'},'item'),e=>e.code==='AMBIGUOUS'&&e.candidates.length===2);
  assert.equal(resolve(rows,{id:'2'},'item').identifier,'2');
  assert.throws(()=>resolve(rows,{id:'none'},'item'),e=>e.code==='NOT_FOUND');
  assert.throws(()=>resolve(rows,{id:'1',name:'Eggs'},'item'),e=>e.code==='INVALID_INPUT');
});
test('shopping lifecycle including IDs, bulk, store validation and favorite writes',async()=>{
  const {c,list,favorites,posts}=fixture();
  const call=(a,p={})=>executeClientCapability(c,'shopping',a,{list_name:'Test',...p});
  const {item}=await call('add_item',{name:'Milk',quantity:2,notes:'note'});
  assert.ok(item.identifier);assert.equal(String(item.quantity),"2");
  assert.equal((await call('update_item',{id:item.identifier,notes:''})).item.note,null);
  assert.equal((await call('check_item',{id:item.identifier})).item.checked,true);
  assert.equal((await call('uncheck_item',{id:item.identifier})).item.checked,false);
  assert.equal((await call('add_items',{items:[{name:'Eggs'},{name:'Bread'}]})).complete,true);
  assert.equal((await call('list_items',{include_checked:true})).items.length,3);
  await assert.rejects(call('set_item_store',{id:item.identifier,store_ids:['absent']}),e=>e.code==='NOT_FOUND');
  const fav=await call('add_favorite',{name:'Favorite',quantity:3});assert.equal(favorites.items.length,1);
  await call('update_favorite',{id:fav.item.identifier,notes:'favorite note'});
  assert.ok(posts.some(x=>x.path==='data/starter-lists/update'));
  await call('remove_favorite',{id:fav.item.identifier});assert.equal(favorites.items.length,0);
  await call('delete_item',{id:item.identifier});assert.equal(list.items.length,2);
});
test('recipe CRUD preserves unspecified metadata and ingredient models',async()=>{
  const {c}=fixture();const call=(a,p={})=>executeClientCapability(c,'recipes',a,p);
  const r=(await call('create',{name:'Soup',note:'keep',rating:4,ingredients:[{name:'water',quantity:'1 cup',isHeading:false}],steps:['Boil'],photo_ids:['photo']})).recipe;
  const updated=(await call('update',{id:r.identifier,new_name:'Soup II',servings:'2'})).recipe;
  assert.equal(updated.note,'keep');assert.equal(updated.rating,4);assert.deepEqual(updated.photoIds,['photo']);assert.deepEqual(updated.preparationSteps,['Boil']);assert.equal(updated.ingredients[0].name,'water');
  assert.equal((await call('list',{search:'soup'})).total,1);
  assert.equal((await call('get',{name:'soup ii'})).recipe.identifier,r.identifier);
  await call('delete',{id:r.identifier});assert.equal((await call('list')).total,0);
});
test('meal CRUD, date and range filtering, names, partial update',async()=>{
  const {c}=fixture();const call=(a,p={})=>executeClientCapability(c,'meal_plan',a,p);
  const e=(await call('create_event',{date:'2026-09-22',title:'Tacos',details:'keep',label_name:'Dinner'})).event;
  assert.equal(e.labelId,'dinner');
  assert.equal((await call('update_event',{event_id:e.identifier,date:'2026-09-23'})).event.details,'keep');
  assert.equal((await call('list_events',{date:'2026-09-22'})).events.length,0);
  assert.equal((await call('list_events',{start_date:'2026-09-23',end_date:'2026-09-23'})).events.length,1);
  await assert.rejects(call('list_events',{start_date:'2026-09-24',end_date:'2026-09-23'}));
  await call('delete_event',{event_id:e.identifier});assert.equal((await call('list_events')).events.length,0);
});
test('collection membership sends only the selected delta',async()=>{
  const {c,raw}=fixture();const a=await raw.createRecipe({name:'A'});await a.save();const b=await raw.createRecipe({name:'B'});await b.save();
  raw._getUserData=async()=>({recipeDataResponse:{recipeCollections:[{identifier:'collection',name:'Test',recipeIds:[a.identifier,b.identifier]}]}});
  let sent;raw.createRecipeCollection=p=>({...p,removeRecipe:async id=>{sent={...p,id};}});
  await executeClientCapability(c,'recipe_collections','remove_recipe',{name:'Test',recipe_name:'A'});
  assert.deepEqual(sent.recipeIds,[a.identifier]);assert.equal(sent.id,a.identifier);
});
test('errors are structured and never disclose upstream credential-bearing messages',async()=>{
  const {c}=fixture();c.ensureAuthenticated=async()=>{throw Object.assign(new Error('password=secret'),{response:{statusCode:401}});};
  const res=await invokeStable(c,'service','status',{});assert.equal(res.structuredContent.error.code,'AUTH_FAILURE');assert.ok(!JSON.stringify(res).includes('secret'));
  const malformed=await invokeStable(c,'shopping','add_item',{quantity:-1});assert.equal(malformed.structuredContent.error.code,'INVALID_INPUT');
});
test('per-account execution is serialized and recovers after failure',async()=>{
  const c={},order=[];
  await Promise.allSettled([withClientLock(c,async()=>{order.push(1);await new Promise(r=>setTimeout(r,10));throw Error();}),withClientLock(c,async()=>order.push(2))]);assert.deepEqual(order,[1,2]);
});
test('recipe URL boundary rejects private IP, redirects destinations and credentials',async()=>{
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.168.1.1','::1','::ffff:127.0.0.1'])assert.equal(publicIPv4(address),false);
  for(const url of ['http://example.com','https://user:pass@example.com','https://example.com:444','https://localhost'])await assert.rejects(validateRecipeUrl(url,async()=>[{address:'8.8.8.8'}]));
  await assert.rejects(validateRecipeUrl('https://example.com',async()=>[{address:'127.0.0.1'}]));
  assert.equal((await validateRecipeUrl('https://example.com',async()=>[{address:'8.8.8.8'}])).address,'8.8.8.8');
});
test('normalization and version manifest require no secrets',async()=>{
  const {c}=fixture();const res=await executeClientCapability(c,'recipes','normalize',{text:'Test Soup\nIngredients\n1 cup water\nInstructions\nBoil water.'});assert.ok(res.recipe.name);assert.equal(res.saved,false);
  const manifest=await executeClientCapability(c,'service','capabilities',{});assert.ok(manifest.clientCommit);assert.equal(manifest.capabilities.length,CAPABILITIES.length);
});
