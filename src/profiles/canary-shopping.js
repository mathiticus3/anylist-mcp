import {z} from 'zod';
import {CANARY_PROFILE,CANARY_LIST_ID} from './canary-policy.js';
import {executeClientCapability} from '../stable/client.js';
import {withClientLock,failure} from '../stable/errors.js';
export const canaryReadSchema=z.object({action:z.enum(['list_lists','list_items']),list_id:z.literal(CANARY_LIST_ID),response_format:z.literal('structured').optional(),include_checked:z.literal(true).optional(),include_notes:z.literal(true).optional()}).strict();
export function registerCanaryShopping(server,getClient){
 server.registerTool('shopping',{description:'Dedicated read-only canary profile. Only the pinned test list is accessible. Fresh complete item read includes checked items, notes and canonical IDs. No mutation tools or authority.',inputSchema:canaryReadSchema.shape,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async input=>{
  try{
   const p=canaryReadSchema.parse(input);const c=await getClient();
   return await withClientLock(c,async()=>{
    try{
     const snapshot=await executeClientCapability(c,'shopping','list_items',{list_id:CANARY_LIST_ID,include_checked:true,include_notes:true});
     const state=p.action==='list_items'?snapshot:{lists:[{identifier:snapshot.listId,name:snapshot.list,itemCount:snapshot.items.length,uncheckedCount:snapshot.items.filter(i=>!i.checked).length}]};
     const body={ok:true,...state,provider:{profile:CANARY_PROFILE,allowedListId:CANARY_LIST_ID,readOnly:true,mutationsEnabled:false},freshReadAt:c.lastSyncAt,complete:true};
     return {content:[{type:'text',text:JSON.stringify(body)}],structuredContent:body};
    }catch(e){return errorResult(e);}
   });
  }catch(e){return errorResult(e);}
 });
}
function errorResult(e){const body=failure(e);return {isError:true,content:[{type:'text',text:body.error.message}],structuredContent:body};}
