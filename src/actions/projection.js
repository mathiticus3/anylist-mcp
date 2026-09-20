import {z} from 'zod';
import {CAPABILITIES,capability} from '../stable/capabilities.js';
const grouped=new Set(['shopping/list_categories','shopping/list_stores','shopping/get_recents','shopping/create_category','shopping/rename_category','shopping/delete_category','shopping/set_item_store','shopping/add_favorite','shopping/update_favorite','recipe_collections/list','recipe_collections/get','recipe_collections/add_recipe','recipe_collections/remove_recipe','service/status','service/capabilities','service/refresh']);
export const PROJECTION=CAPABILITIES.filter(c=>!grouped.has(`${c.tool}/${c.action}`)).map(c=>({...c,targets:[`${c.tool}/${c.action}`],select:input=>({tool:c.tool,action:c.action,input})}));
function groupedOperation(operationId,description,tool,choices,defaultChoice) {
 const defs=Object.values(choices).map(action=>capability(tool,action));
 const fields={};for(const d of defs)for(const [k,s] of Object.entries(d.schema.shape))fields[k]=s.optional();
 const mode=z.enum(Object.keys(choices));fields.mode=defaultChoice?mode.optional():mode;
 PROJECTION.push({operationId,description,effect:defs.some(c=>c.effect==='delete')?'delete':defs.some(c=>c.effect==='write')?'write':'read',schema:z.object(fields).strict(),targets:defs.map(c=>`${c.tool}/${c.action}`),select:p=>{const {mode,...input}=p;return {tool,action:choices[mode||defaultChoice],input};}});
}
groupedOperation('getShoppingReferenceData','Read categories, stores or recently used items for a list.','shopping',{categories:'list_categories',stores:'list_stores',recents:'get_recents'});
groupedOperation('manageCategory','Create, rename or delete one explicit category. Rename needs new_name.','shopping',{create:'create_category',rename:'rename_category',delete:'delete_category'});
groupedOperation('saveFavorite','Add a favorite or update supplied fields of an existing favorite.','shopping',{add:'add_favorite',update:'update_favorite'},'add');
groupedOperation('listRecipeCollections','List collections or get one collection and its recipes.','recipe_collections',{list:'list',get:'get'},'list');
groupedOperation('setRecipeCollectionMembership','Add or remove one explicit recipe membership.','recipe_collections',{add:'add_recipe',remove:'remove_recipe'});
groupedOperation('getServiceStatus','Get authenticated readiness, versions, capabilities, or refresh synchronization.','service',{status:'status',capabilities:'capabilities',refresh:'refresh'},'status');
// The item update operation already supports the complete store assignment schema.
PROJECTION.find(p=>p.operationId==='updateShoppingItem').targets.push('shopping/set_item_store');
export function projectionFor(tool,action,input) {
 const key=`${tool}/${action}`;const entry=PROJECTION.find(p=>p.targets.includes(key));
 if(!entry)throw Error('Unmapped capability');
 if(key==='shopping/set_item_store')return {entry,input};
 if(entry.targets.length===1)return {entry,input};
 for(const mode of entry.schema.shape.mode?.unwrap?.().options||entry.schema.shape.mode?.options||[]) {
   if(entry.select({...input,mode}).action===action)return {entry,input:{...input,mode}};
 }
 return {entry,input};
}
