// Isolated extension of the pinned client: only the already-authenticated user-data read.
// No protocol endpoint or operation name is supplied by callers.
import {z} from 'zod';
import {CapabilityError,resolve} from '../stable/errors.js';
const id=z.string().min(1).max(128),name=z.string().max(12000);
const identity=z.object({identifier:id,name:name.optional()}).passthrough();
const price=z.object({amount:z.number().finite(),details:z.string().max(12000).optional(),storeId:z.string().max(128).optional(),date:z.string().max(128).optional()}).passthrough();
const item=identity.extend({prices:z.array(price).max(1000).optional()});
const list=identity.extend({items:z.array(item).max(50000)});
const folderItem=z.object({identifier:id,itemType:z.union([z.literal(0),z.literal(1)])});
const folder=identity.extend({items:z.array(folderItem).max(50000)});
function parse(schema,value){const result=schema.safeParse(value);if(!result.success)throw new CapabilityError('EXPERIMENTAL_SCHEMA_CHANGED','Experimental provider response changed; stable capabilities are unaffected.');return result.data;}
export class AnyListExperimentalClient {
 constructor(library){this.library=library;}
 async snapshot(){return this.library._getUserData(true);}
 async listItemPrices(p){
  const d=await this.snapshot();
  const lists=parse(z.array(list).max(10000),d.shoppingListsResponse?.newLists);
  const selected=resolve(lists,{id:p.list_id,name:p.list_name},'list');
  const all=p.id||p.name?[resolve(selected.items,p,'item')]:selected.items.filter(i=>i.prices?.length);
  const offset=p.offset||0,limit=p.limit||50;
  const lr=(d.shoppingListsResponse.listResponses||[]).find(r=>r.listId===selected.identifier);
  const stores=lr?.stores||[];
  return {experimental:true,capability:'item_prices',freshReadAt:new Date().toISOString(),list:{identifier:selected.identifier,name:selected.name||''},total:all.length,offset,hasMore:offset+limit<all.length,priceSemantics:'current stored price per store; not historical series; no currency or unit-price inference',items:all.slice(offset,offset+limit).map(i=>({identifier:i.identifier,name:i.name||'',prices:(i.prices||[]).map(p=>({amount:p.amount,details:p.details||null,date:p.date||null,storeId:p.storeId||null,storeName:stores.find(s=>s.identifier===p.storeId)?.name||null}))}))};
 }
 async listFolders(p){
  const d=await this.snapshot();const response=d.listFoldersResponse;
  if(response?.includesAllFolders!==true)throw new CapabilityError('EXPERIMENTAL_INCOMPLETE','Provider did not return a complete folder snapshot.');
  const folders=parse(z.array(folder).max(10000),response.listFolders);
  const rootFolderId=parse(id,response.rootFolderId);
  if(!folders.some(f=>f.identifier===rootFolderId))throw new CapabilityError('EXPERIMENTAL_INCOMPLETE','Root folder missing from snapshot.');
  const lists=parse(z.array(identity).max(10000),d.shoppingListsResponse?.newLists);
  const selected=p.id||p.name?[resolve(folders,p,'folder')]:folders;
  const offset=p.offset||0,limit=p.limit||50;
  return {experimental:true,capability:'list_folders',freshReadAt:new Date().toISOString(),rootFolderId,sourceComplete:true,total:selected.length,offset,hasMore:offset+limit<selected.length,folders:selected.slice(offset,offset+limit).map(f=>({identifier:f.identifier,name:f.name||'',items:f.items.map(i=>({identifier:i.identifier,type:i.itemType===0?'list':'folder',name:(i.itemType===0?lists:folders).find(r=>r.identifier===i.identifier)?.name||null}))}))};
 }
}
