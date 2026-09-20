import {z} from 'zod';
import {CANARY_LIST_ID} from './canary-policy.js';
import {CANARY_WRITE_PROFILE} from './canary-write-policy.js';
import {CapabilityError,resolve,withClientLock,failure} from '../stable/errors.js';
import {itemView} from '../stable/client.js';
const name=z.string().min(1).max(128).refine(v=>v===v.trim()&&!/[\u0000-\u001f\u007f]/u.test(v),'Use an exact nonblank name without padding or control characters.');
const common={list_id:z.literal(CANARY_LIST_ID),response_format:z.literal('structured').optional()};
const add=z.object({...common,action:z.literal('add_item'),name,quantity:z.literal(1),notes:z.string().max(256).optional()}).strict();
const remove=z.object({...common,action:z.literal('delete_item'),expected_name:name,item_id:z.string().regex(/^[a-f0-9]{32}$/)}).strict();
export const canaryWriteSchema=z.discriminatedUnion('action',[add,remove]);
// MCP's object schema bounds all fields; action-specific required/forbidden fields
// are additionally enforced by the discriminated union before client acquisition.
export const canaryWriteInput=z.object({...common,action:z.enum(['add_item','delete_item']),name:name.optional().describe('Required exact new name for add_item; forbidden for delete_item.'),expected_name:name.optional().describe('Required exact name for delete_item; forbidden for add_item.'),quantity:z.literal(1).optional().describe('Required for add_item; forbidden for delete_item.'),notes:z.string().max(256).optional().describe('Optional for add_item; forbidden for delete_item.'),item_id:z.string().regex(/^[a-f0-9]{32}$/).optional().describe('Required exact ID for delete_item; forbidden for add_item.')}).strict();
const provider={profile:CANARY_WRITE_PROFILE,allowedListId:CANARY_LIST_ID,readOnly:false,boundedWriter:true,mutationsEnabled:true,executionApprovalIncluded:false};
export function registerCanaryWriter(server,getClient){
 server.registerTool('shopping',{description:'Dedicated fixed-list writer for an independently approved harness. add_item requires name, quantity=1, optional notes; rejects existing trimmed/case-insensitive names and never upserts. delete_item requires item_id plus exact expected_name; deletes only that refreshed-list item. Action-specific other fields are forbidden. No read/bulk/update/check/category tools. Setup is not execution approval. No exactly-once/CAS guarantee; independently read after any dispatch, never automatically retry an unknown outcome.',inputSchema:canaryWriteInput.shape,annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}},async input=>{
  let dispatched=false,attemptedItemId;
  try{
   const p=canaryWriteSchema.parse(input),c=await getClient();
   return await withClientLock(c,async()=>{
    try{
     await c.ensureAuthenticated();await c.client.getLists(true);c.lastSyncAt=new Date().toISOString();
     const list=resolve(c.client.lists,{id:CANARY_LIST_ID},'list');
     if(p.action==='add_item'){
      if(list.items.some(i=>(i.name||'').trim().toLowerCase()===p.name.toLowerCase()))throw new CapabilityError('CONFLICT','Item name already exists in the fixed list; no upsert is permitted.');
      const item=c.client.createItem({name:p.name,quantity:1,details:p.notes??'',checked:false});
      attemptedItemId=item.identifier;dispatched=true;
      await list.addItem(item);
      return result({ok:true,action:p.action,listId:CANARY_LIST_ID,item:itemView(item),provider,dispatchAttempted:true,outcome:'ACKNOWLEDGED',independentReadRequired:true});
     }
     const item=resolve(list.items,{id:p.item_id},'item');
     if(item.name!==p.expected_name)throw new CapabilityError('CONFLICT','Exact item ID and name do not match; removal refused.');
     attemptedItemId=item.identifier;dispatched=true;
     await list.removeItem(item);
     return result({ok:true,action:p.action,listId:CANARY_LIST_ID,identifier:item.identifier,name:item.name,deleted:true,provider,dispatchAttempted:true,outcome:'ACKNOWLEDGED',independentReadRequired:true});
    }catch(e){return failed(e);}
   });
  }catch(e){return failed(e);}
  function failed(e){return result({...failure(e),provider,dispatchAttempted:dispatched,outcome:dispatched?'UNKNOWN':'NOT_DISPATCHED',...(attemptedItemId?{attemptedItemId}:{}),independentReadRequired:dispatched},true);}
 });
}
function result(body,isError=false){return {...(isError?{isError:true}:{}),content:[{type:'text',text:JSON.stringify(body)}],structuredContent:body};}
