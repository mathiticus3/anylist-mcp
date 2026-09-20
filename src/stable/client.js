// Explicit client/library operations only. No RPC names or endpoints come from callers.
import { normalizeRecipe } from '../recipe-normalizer.js';
import { capability, manifest } from './capabilities.js';
import { CapabilityError, resolve } from './errors.js';
const invalid = message => {throw new CapabilityError('INVALID_INPUT',message);};
const pick = (object,fields) => Object.fromEntries(fields.map(k=>[k,object[k] ?? null]));
export const recipeFields=['identifier','name','note','sourceName','sourceUrl','prepTime','cookTime','servings','rating','nutritionalInfo','scaleFactor','photoIds','photoUrls','creationTimestamp','timestamp','paprikaIdentifier','adCampaignId'];
export const recipeView = r => ({...pick(r,recipeFields),ingredients:(r.ingredients||[]).map(i=>i.toJSON ? i.toJSON() : i),preparationSteps:r.preparationSteps||[]});
export const itemView = i => ({identifier:i.identifier,name:i.name,quantity:i.quantity??1,checked:!!i.checked,note:i.details||null,category:i.categoryMatchId||'other',categoryAssignments:i.categoryAssignments||[],storeIds:i.storeIds||[],manualSortIndex:i.manualSortIndex??null});
const collectionView = c => ({identifier:c.identifier,name:c.name,recipeIds:[...(c.recipeIds||[])]});
// Library parses server YYYY-MM-DD as UTC; preserve the literal calendar date on updates.
const eventView = e => ({identifier:e.identifier,date:e.date instanceof Date?e.date.toISOString().slice(0,10):String(e.date).slice(0,10),title:e.title||null,details:e.details||null,recipeId:e.recipeId||null,labelId:e.labelId||null,recipeName:e.recipe?.name||null,labelName:e.label?.name||null,recipeScaleFactor:e.recipeScaleFactor??null,orderAddedSortIndex:e.orderAddedSortIndex??null});
const recipeMap={new_name:'name',steps:'preparationSteps',note:'note',source_name:'sourceName',source_url:'sourceUrl',prep_time:'prepTime',cook_time:'cookTime',servings:'servings',rating:'rating',nutritional_info:'nutritionalInfo',scale_factor:'scaleFactor',photo_ids:'photoIds',photo_urls:'photoUrls',paprika_identifier:'paprikaIdentifier',ingredients:'ingredients'};
function recipePatch(p) {const result={};for(const [input,output] of Object.entries(recipeMap)) if(p[input]!==undefined) result[output]=p[input];return result;}
async function recipes(c) {return c.client.getRecipes(true);}
async function collections(c) {await c.client.getRecipes(true);return (await c.client._getUserData(false)).recipeDataResponse.recipeCollections||[];}
async function selectList(c,p) {
  await c.client.getLists(true);
  c.lastSyncAt=new Date().toISOString();
  const name=p.list_name || (!p.list_id ? c.defaultListName || process.env.ANYLIST_LIST_NAME : undefined);
  c.targetList=resolve(c.client.lists,{id:p.list_id,name},'list');
  return c.targetList;
}
function validateStores(list,p) {
  if(p.store_ids!==undefined && p.store_name!==undefined) invalid('Use store_ids or store_name, not both.');
  if(p.store_ids!==undefined) {for(const id of p.store_ids) resolve(list.stores||[],{id},'store');return p.store_ids;}
  if(p.store_name!==undefined) return p.store_name ? [resolve(list.stores||[],{name:p.store_name},'store').identifier] : [];
}
function validateCategories(list,p) {
  const groups=list.categoryGroups||[];
  if(p.category_set)resolve(groups,{name:p.category_set},'category set');
  for(const [setName,category] of Object.entries(p.categories||{})) {
    const group=resolve(groups,{name:setName},'category set');resolve(group.categories,{name:category},'category');
  }
  if(p.category && p.category!=='other' && groups.length)resolve(groups.flatMap(g=>g.categories),{name:p.category},'category');
}
async function updateItem(c,list,item,p,isFavorite=false) {
  validateCategories(list,p);
  const stores=validateStores(list,p);
  if(p.new_name!==undefined)item.name=p.new_name;
  if(p.quantity!==undefined)item.quantity=p.quantity;
  if(p.notes!==undefined)item.details=p.notes;
  if(p.manual_sort_index!==undefined)item.manualSortIndex=p.manual_sort_index;
  if(p.category!==undefined || p.categories!==undefined) {
    const {pairs,legacyMatchId}=c._resolveCategories({category:p.category,categories:p.categories});
    if(legacyMatchId)item.categoryMatchId=legacyMatchId;
    if(pairs.length) await c._assignItemCategories(item,pairs);
  }
  await item.save(isFavorite);
  if(stores!==undefined) await item.setStores(stores,isFavorite);
  return itemView(item);
}
async function addItem(c,list,p,isFavorite=false) {
  const matches=list.items.filter(i=>i.name.toLowerCase()===p.name.toLowerCase());
  if(matches.length>1) resolve(list.items,{name:p.name},'item');
  validateStores(c.targetList,p);
  validateCategories(c.targetList,p);
  if(!isFavorite) c._resolveCategories({category:p.category,categories:p.categories});
  let item=matches[0];
  if(!item) {item=c.client.createItem({name:p.name,details:p.notes});await list.addItem(item,isFavorite);}
  item.checked=false;
  return updateItem(c,c.targetList,item,{...p,quantity:p.quantity??1},isFavorite);
}
export async function executeClientCapability(c,tool,action,input) {
  const def=capability(tool,action);
  if(!def) invalid('Unknown capability.');
  const p=def.schema.parse(input);
  if(tool==='service' && action==='capabilities') return manifest();
  await c.ensureAuthenticated();
  if(tool==='service') {
    await c.client.getLists(true);c.lastSyncAt=new Date().toISOString();c.targetList=null;
    return {ready:true,synchronizedAt:c.lastSyncAt,...manifest()};
  }
  if(tool==='shopping') {
    if(action==='list_lists') {await c.client.getLists(true);c.lastSyncAt=new Date().toISOString();return {lists:c.client.lists.map(l=>({identifier:l.identifier,name:l.name,itemCount:l.items.length,uncheckedCount:l.items.filter(i=>!i.checked).length}))};}
    const list=await selectList(c,p);
    const listRef={identifier:list.identifier,name:list.name};
    if(action==='list_items') {
      const legacy=await c.getItems(p.include_checked??false,p.include_notes??false,p.category_set||null);
      const raw=list.items.filter(i=>p.include_checked || !i.checked);
      return {list:list.name,listId:list.identifier,categorySet:p.category_set||null,items:legacy.map((i,n)=>({...i,identifier:raw[n].identifier,quantity:raw[n].quantity??i.quantity,storeIds:raw[n].storeIds||[]}))};
    }
    if(action==='list_categories')return {list:listRef,categorySets:c.getCategoryGroups()};
    if(action==='list_stores')return {list:listRef,stores:(list.stores||[]).map(s=>pick(s,['identifier','name']))};
    if(action==='get_recents')return {list:listRef,items:(c.client.getRecentItemsByListId(list.identifier)||[]).map(itemView)};
    if(action==='get_favorites')return {list:listRef,items:(c.client.getFavoriteItemsByListId(list.identifier)?.items||[]).map(itemView)};
    if(action==='add_item')return {list:listRef,item:await addItem(c,list,p)};
    if(action==='add_items') {
      const results=[];
      // The pinned library has no native bulk primitive. Keep one bounded MCP call.
      for(const item of p.items) {
        try{results.push({ok:true,item:await addItem(c,list,item)});}catch(e){
          const {failure}=await import('./errors.js');results.push({name:item.name,...failure(e)});
        }
      }
      return {list:listRef,complete:results.every(r=>r.ok),results};
    }
    if(['create_category','rename_category','delete_category'].includes(action)) {
      if(action==='create_category')return {list:listRef,category:await c.createCategory(p.name,p.category_set)};
      const groups=p.category_set?[resolve(list.categoryGroups,{name:p.category_set},'category set')]:list.categoryGroups;
      resolve(groups.flatMap(g=>g.categories),{name:p.name},'category');
      if(action==='rename_category')return {list:listRef,category:await c.renameCategory(p.name,p.new_name,p.category_set)};
      await c.deleteCategory(p.name,p.category_set);return {deleted:true,list:listRef,name:p.name};
    }
    const favorite=action.includes('favorite');
    const container=favorite ? c.client.getFavoriteItemsByListId(list.identifier) : list;
    if(!container)throw new CapabilityError('UNSUPPORTED','This list has no favorites container; initialize Favorites in AnyList first.');
    if(action==='add_favorite')return {list:listRef,item:await addItem(c,container,p,true)};
    const item=resolve(container.items,p,favorite?'favorite':'item');
    if(action==='delete_item'||action==='remove_favorite') {await container.removeItem(item,favorite);return {deleted:true,identifier:item.identifier,list:listRef};}
    if(action==='check_item'||action==='uncheck_item') {item.checked=action==='check_item';await item.save();return {list:listRef,item:itemView(item)};}
    if(action==='set_item_store') {const ids=validateStores(list,p)??[];await item.setStores(ids);return {list:listRef,item:itemView(item)};}
    if(action==='update_item'||action==='update_favorite')return {list:listRef,item:await updateItem(c,list,item,p,favorite)};
  }
  if(tool==='recipes') {
    if(action==='normalize'||action==='import_url') {
      if(!p.url && !p.text)invalid('Provide a public HTTPS URL or recipe text.');
      const normalized=await normalizeRecipe(p);
      if(p.save || action==='import_url') {
        const r=await c.client.createRecipe({...normalized,creationTimestamp:Date.now()/1000});await r.save();
        return {recipe:recipeView(r),saved:true};
      }
      return {recipe:normalized,saved:false};
    }
    const all=await recipes(c);
    if(action==='list') {
      const matches=all.filter(r=>!p.search || (r.name||'').toLowerCase().includes(p.search.toLowerCase()));
      return {total:matches.length,offset:p.offset||0,recipes:matches.slice(p.offset||0,(p.offset||0)+(p.limit||100)).map(r=>pick(r,['identifier','name','note','sourceName','prepTime','cookTime','servings','rating']))};
    }
    if(action==='create') {
      if(all.some(r=>(r.name||'').toLowerCase()===p.name.toLowerCase()))throw new CapabilityError('CONFLICT','Recipe name already exists; select and update it.');
      const r=await c.client.createRecipe({name:p.name,...recipePatch(p),creationTimestamp:Date.now()/1000});await r.save();return {recipe:recipeView(r)};
    }
    const r=resolve(all,p,'recipe');
    if(action==='get')return {recipe:recipeView(r)};
    if(action==='delete'){await r.delete();return {deleted:true,identifier:r.identifier};}
    if(action==='update') {
      // Reconstruct via the library so ingredients remain Ingredient instances. Unspecified metadata survives.
      const updated=await c.client.createRecipe({...recipeView(r),...recipePatch(p)});await updated.save();return {recipe:recipeView(updated)};
    }
  }
  if(tool==='recipe_collections') {
    const all=await collections(c);
    if(action==='list')return {collections:all.map(collectionView)};
    if(action==='create') {
      if(all.some(r=>r.name.toLowerCase()===p.name.toLowerCase()))throw new CapabilityError('CONFLICT','Collection name already exists.');
      const allRecipes=await recipes(c);
      const ids=(p.recipe_names||[]).map(name=>resolve(allRecipes,{name},'recipe').identifier);
      const collection=c.client.createRecipeCollection({name:p.name,recipeIds:ids});await collection.save();return {collection:collectionView(collection)};
    }
    const raw=resolve(all,p,'collection');
    const collection=c.client.createRecipeCollection(raw);
    if(action==='get')return {collection:collectionView(raw),recipes:(await recipes(c)).filter(r=>(raw.recipeIds||[]).includes(r.identifier)).map(r=>pick(r,['identifier','name']))};
    if(action==='delete'){await collection.delete();return {deleted:true,identifier:raw.identifier};}
    const r=resolve(await recipes(c),{id:p.recipe_id,name:p.recipe_name},'recipe');
    const ids=raw.recipeIds||[];
    if(action==='add_recipe' && !ids.includes(r.identifier)) {
      // Membership operations carry a delta, not the whole collection's recipeIds.
      const delta=c.client.createRecipeCollection({...raw,recipeIds:[]});await delta.addRecipe(r.identifier);
    }
    if(action==='remove_recipe' && ids.includes(r.identifier)) {
      const delta=c.client.createRecipeCollection({...raw,recipeIds:[r.identifier]});await delta.removeRecipe(r.identifier);
    }
    return {collection:{...collectionView(raw),recipeIds:action==='add_recipe'?[...new Set([...ids,r.identifier])]:ids.filter(id=>id!==r.identifier)},recipeId:r.identifier,present:action==='add_recipe'};
  }
  if(tool==='meal_plan') {
    const events=await c.client.getMealPlanningCalendarEvents(true);
    const labels=c.client.mealPlanningCalendarEventLabels||[];
    if(action==='list_labels')return {labels:labels.map(l=>pick(l,['identifier','name','hexColor','sortIndex']))};
    if(action==='list_events') {
      if(p.start_date && p.end_date && p.start_date>p.end_date)invalid('start_date must not follow end_date.');
      return {events:events.map(eventView).filter(e=>(!p.date||e.date===p.date)&&(!p.start_date||e.date>=p.start_date)&&(!p.end_date||e.date<=p.end_date)).sort((a,b)=>a.date.localeCompare(b.date))};
    }
    if(action==='delete_event') {const e=resolve(events,{id:p.event_id},'event');await e.delete();return {deleted:true,identifier:e.identifier};}
    const values={};
    for(const [a,b] of Object.entries({title:'title',details:'details',recipe_scale_factor:'recipeScaleFactor',order_added_sort_index:'orderAddedSortIndex'})) if(p[a]!==undefined)values[b]=p[a];
    if(p.recipe_id!==undefined||p.recipe_name)values.recipeId=p.recipe_id===''?'':resolve(await recipes(c),{id:p.recipe_id,name:p.recipe_name},'recipe').identifier;
    if(p.label_id!==undefined||p.label_name)values.labelId=p.label_id===''?'':resolve(labels,{id:p.label_id,name:p.label_name},'meal label').identifier;
    let e;
    if(action==='create_event') {
      if(!p.title && !values.recipeId)invalid('Provide title or recipe.');
      e=await c.client.createEvent({...values,date:new Date(`${p.date}T12:00:00`)});
    } else {
      e=resolve(events,{id:p.event_id},'event');
      const currentDate=eventView(e).date;
      Object.assign(e,values,{date:new Date(`${p.date||currentDate}T12:00:00`)});
    }
    await e.save();return {event:eventView(e)};
  }
  invalid('Unsupported capability.');
}
