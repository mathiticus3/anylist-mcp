import {z} from 'zod';
import {createHash} from 'node:crypto';
import {BOUNDED_READ,MAX_ITEMS,MAX_RESULT_BYTES,CONTRACT_VERSION,assertBoundedScope} from './bounded-policy.js';
import {CapabilityError,resolve,withClientLock,failure} from '../stable/errors.js';
import {itemView} from '../stable/client.js';
import {VERSION,CLIENT_VERSION,CLIENT_COMMIT} from '../stable/capabilities.js';
const exactName=z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u).refine(v=>v===v.trim()&&v.length>0&&!/\p{C}/u.test(v),'Use an exact trimmed name without Unicode control/format characters.');
export const collisionKey=name=>String(name).normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();
export function boundedSchema(profile,listId){
 const common={list_id:z.literal(listId),response_format:z.literal('structured').optional()};
 return profile===BOUNDED_READ
  ?z.object({...common,action:z.literal('list_items'),include_checked:z.literal(true).optional(),include_notes:z.literal(true).optional()}).strict()
  :z.object({...common,action:z.literal('add_item'),name:exactName,quantity:z.literal(1)}).strict();
}
function metadata(profile,binding){return {profile,allowedListId:binding.listId,bindingSha256:binding.bindingSha256,contractVersion:CONTRACT_VERSION,readOnly:profile===BOUNDED_READ,mutationsEnabled:profile!==BOUNDED_READ,executionApprovalIncluded:false,serverVersion:VERSION,clientVersion:CLIENT_VERSION,clientCommit:CLIENT_COMMIT};}
function result(body,isError=false){return {...(isError?{isError:true}:{}),content:[{type:'text',text:isError?body.error.message:`Structured ${body.outcome||'complete list snapshot'} result; use structuredContent.`}],structuredContent:body};}
function snapshot(list,provider,freshReadAt){
 if(!Array.isArray(list.items)||list.items.length>MAX_ITEMS)throw new CapabilityError('RESPONSE_TOO_LARGE','Complete list exceeds the supported item bound; no partial snapshot is returned.');
 const items=[],ids=new Set();let bytes=0;
 for(const raw of list.items){
  const item=itemView(raw);
  if(typeof item.identifier!=='string'||!item.identifier||ids.has(item.identifier)||typeof item.name!=='string')throw new CapabilityError('INVALID_SNAPSHOT','Provider item identity is absent, duplicate or malformed.');
  ids.add(item.identifier);bytes+=Buffer.byteLength(JSON.stringify(item),'utf8')+1;
  if(bytes>MAX_RESULT_BYTES)throw new CapabilityError('RESPONSE_TOO_LARGE','Complete list exceeds the byte bound; no partial snapshot is returned.');
  items.push(item);
 }
 const body={ok:true,listId:list.identifier,list:list.name,items,itemCount:items.length,complete:true,includesChecked:true,includesNotes:true,freshReadAt,provider,snapshotSha256:createHash('sha256').update(JSON.stringify(items)).digest('hex'),limits:{maxItems:MAX_ITEMS,maxResultBytes:MAX_RESULT_BYTES}};
 const response=result(body);
 if(Buffer.byteLength(JSON.stringify(response),'utf8')>MAX_RESULT_BYTES)throw new CapabilityError('RESPONSE_TOO_LARGE','Complete result exceeds the byte bound; no partial snapshot is returned.');
 return response;
}
export function registerBoundedShopping(server,getClient,{profile,actorSource}){
 const binding=assertBoundedScope(profile,actorSource),schema=boundedSchema(profile,binding.listId),provider=metadata(profile,binding),isRead=profile===BOUNDED_READ;
 const current=()=>assertBoundedScope(profile,actorSource,binding.bindingSha256);
 server.registerTool('shopping',{description:isRead?'Fresh complete fixed-list snapshot including every checked/unchecked item and its notes. Canonical IDs/order preserved. No pagination or truncation; over10000 items/8MiB fails closed. structuredContent is authoritative; text is a summary. No server revision/CAS guarantee.':'Add one NEW item to the fixed list: exact trimmed name<=128 and quantity1 only. No notes/category/store/sort/bulk/check/delete/update. Refuse observed normalized-name collisions, including checked items. ACKNOWLEDGED requires independent readback; UNKNOWN must never be blindly retried. No external CAS/exactly-once guarantee.',inputSchema:schema.shape,annotations:{readOnlyHint:isRead,destructiveHint:false,idempotentHint:isRead,openWorldHint:false}},async input=>{
  let dispatched=false,attemptedItemId;
  try{
   const p=schema.parse(input);current();const c=await getClient();
   return await withClientLock(c,async()=>{
    try{
     current();await c.ensureAuthenticated();await c.client.getLists(true);const freshReadAt=new Date().toISOString();c.lastSyncAt=freshReadAt;current();
     const list=resolve(c.client.lists,{id:binding.listId},'list');
     const read=snapshot(list,provider,freshReadAt);
     if(isRead)return read;
     if(list.items.some(i=>collisionKey(i.name)===collisionKey(p.name)))throw new CapabilityError('CONFLICT','An equivalent item name already exists; no upsert is permitted.');
     const item=c.client.createItem({name:p.name,quantity:1,details:'',checked:false});
     // Refuse a write whose projected complete read cannot fit the reader bounds.
     snapshot({...list,items:[...list.items,item]},provider,freshReadAt);current();
     attemptedItemId=item.identifier;dispatched=true;await list.addItem(item);
     return result({ok:true,action:'add_item',listId:binding.listId,item:itemView(item),provider,dispatchAttempted:true,outcome:'ACKNOWLEDGED',independentReadRequired:true});
    }catch(e){return failed(e);}
   });
  }catch(e){return failed(e);}
  function failed(e){return result({...failure(e),provider,complete:false,dispatchAttempted:dispatched,outcome:dispatched?'UNKNOWN':'NOT_DISPATCHED',...(attemptedItemId?{attemptedItemId}:{}),independentReadRequired:dispatched},true);}
 });
}
