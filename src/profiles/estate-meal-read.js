import {z} from 'zod';
import {ESTATE_READ_PROFILE,ESTATE_READ_SOURCE,ESTATE_READ_CONTRACT,MAX_WINDOW_DAYS,assertEstateScope} from './estate-meal-policy.js';
import {CapabilityError,withClientLock,failure} from '../stable/errors.js';

const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const estateMealSchema=z.object({action:z.literal('list_events'),start_date:date,end_date:date}).strict();
export function mealWindow(input){
 const p=estateMealSchema.parse(input);
 const start=Date.parse(p.start_date+'T00:00:00Z'),end=Date.parse(p.end_date+'T00:00:00Z');
 if(!Number.isFinite(start)||!Number.isFinite(end)||new Date(start).toISOString().slice(0,10)!==p.start_date
    ||new Date(end).toISOString().slice(0,10)!==p.end_date||end<start||(end-start)/86400000>=MAX_WINDOW_DAYS)
  throw new CapabilityError('INVALID_INPUT','Choose an inclusive date window of at most 31 days.');
 return p;
}
export function registerEstateMealRead(server,getClient,{clientId,userId,actorSource}){
 server.registerTool('meal_plan_read',{title:'Read Meal Plan',description:'Read meal events in an explicit inclusive window of at most 31 days. No mutation, recipe, shopping or label tools.',
  inputSchema:estateMealSchema.shape,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async input=>{
  try{
   const p=mealWindow(input),before=assertEstateScope(clientId,userId,actorSource),c=await getClient();
   return await withClientLock(c,async()=>{
    await c.ensureAuthenticated();
    const all=await c.getMealPlanEvents();
    if(!Array.isArray(all)||all.some(e=>!e||typeof e.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(e.date)
       ||!Number.isFinite(Date.parse(e.date+'T00:00:00Z'))
       ||new Date(e.date+'T00:00:00Z').toISOString().slice(0,10)!==e.date
       ||typeof e.identifier!=='string'||!e.identifier
       ||['title','recipeName','labelName','details'].some(k=>e[k]!=null&&typeof e[k]!=='string')))
     throw new CapabilityError('UPSTREAM_FAILURE','Meal-plan response is invalid.');
    const events=all.filter(e=>typeof e.date==='string'&&e.date>=p.start_date&&e.date<=p.end_date)
     .sort((a,b)=>a.date.localeCompare(b.date));
    const lines=events.map(e=>[ `- **${e.date}**`,e.title,e.recipeName?`📖 ${e.recipeName}`:null,
      e.labelName?`[${e.labelName}]`:null,e.details?`— ${e.details}`:null,`(id: ${e.identifier})`].filter(Boolean).join(' '));
    const text=events.length?`Meal Plan (${events.length} events):\n${lines.join('\n')}`:'No meal plan events found.';
    if(text.length>60000)throw new CapabilityError('RESPONSE_LIMIT','Choose a smaller meal-plan window.');
    const after=assertEstateScope(clientId,userId,actorSource);
    if(after.policyDigest!==before.policyDigest)throw new CapabilityError('POLICY_CHANGED','Meal-plan policy changed during the read.');
    return {content:[{type:'text',text}],structuredContent:{provider:{contract:ESTATE_READ_CONTRACT,profile:ESTATE_READ_PROFILE,
     source:ESTATE_READ_SOURCE,client_id:clientId,user_id:userId,policy_digest:after.policyDigest,
     readOnly:true,mutationsEnabled:false,maxWindowDays:MAX_WINDOW_DAYS},window:{start_date:p.start_date,end_date:p.end_date},complete:true}};
   });
  }catch(error){const body=failure(error);return {isError:true,content:[{type:'text',text:body.error.message}],structuredContent:body};}
 });
}
