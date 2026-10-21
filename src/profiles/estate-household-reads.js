import {z} from 'zod';
import {READ_PROFILES,READ_SOURCES,READ_CONTRACT,MAX_ITEMS,MAX_RESPONSE_BYTES,readKind,assertReadScope} from './estate-household-policy.js';
import {CapabilityError,withClientLock,failure} from '../stable/errors.js';
const id=z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u);
const text=z.string().max(100000),optionalText=text.nullish().transform(v=>v??null);
const search=z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/u).refine(v=>v.trim()===v);
const recipeSummary=z.object({identifier:id,name:text,note:optionalText,sourceName:optionalText,sourceUrl:optionalText,prepTime:z.number().finite().nonnegative().nullish().transform(v=>v??null),cookTime:z.number().finite().nonnegative().nullish().transform(v=>v??null),servings:optionalText});
const ingredient=z.object({identifier:id.nullish().transform(v=>v??null),rawIngredient:optionalText,name:optionalText,quantity:optionalText,note:optionalText,isHeading:z.boolean().nullish().transform(v=>v??null)});
const item=z.object({identifier:id,name:text,quantity:z.union([z.string().max(1000),z.number().finite()]).nullish().transform(v=>v??null),checked:z.boolean(),note:optionalText});
const unavailable=()=>{throw new CapabilityError('INVALID_SNAPSHOT','Provider snapshot is malformed or exceeds its bounds.');};
function uniqueRows(rows){
 if(!Array.isArray(rows)||rows.length>MAX_ITEMS)unavailable();
 const ids=new Set();
 for(const row of rows){if(!id.safeParse(row?.identifier).success||ids.has(row.identifier))unavailable();ids.add(row.identifier);}
}
function response(body){
 const encoded=JSON.stringify(body),result={content:[{type:'text',text:encoded}],structuredContent:body};
 if(Buffer.byteLength(JSON.stringify(result),'utf8')>MAX_RESPONSE_BYTES)throw new CapabilityError('RESPONSE_LIMIT','Choose a smaller recipe result; complete shopping snapshots cannot be truncated.');
 return result;
}
export function registerHouseholdReads(server,getClient,{profile,actorSource,clientId,userId}){
 const kind=readKind(profile),isShopping=profile===READ_PROFILES.shopping;
 const schema=isShopping?z.object({action:z.literal('list_items'),list_id:z.string().regex(/^[a-f0-9]{32}$/)}).strict()
  :z.object({action:z.enum(['list','get']),search:search.optional(),limit:z.number().int().min(1).max(20).optional(),recipe_id:id.optional()}).strict();
 server.registerTool(isShopping?'shopping_read':'recipes_read',{title:isShopping?'Read Fixed Shopping List':'Read Recipes',
  description:isShopping?'Complete fixed-list read including checked items and notes; fails closed above10000items/1MiB. No writes or list discovery.':'Literal recipe name search (limit1..20) or exact source-ID read. Capped results are incomplete. No writes, imports or URL fetches.',
  inputSchema:schema.shape,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async input=>{
  try{
   const p=schema.parse(input);
   if(!isShopping&&!(p.action==='list'?p.search!==undefined&&p.recipe_id===undefined:p.recipe_id!==undefined&&p.search===undefined&&p.limit===undefined))throw new CapabilityError('INVALID_INPUT','Choose literal search or one exact recipe ID.');
   const before=assertReadScope(profile,clientId,userId,actorSource);
   if(isShopping&&p.list_id!==before.listId)throw new CapabilityError('SCOPE_DENIED','Only the bound list is readable.');
   const c=await getClient();
   return await withClientLock(c,async()=>{
    assertReadScope(profile,clientId,userId,actorSource);await c.ensureAuthenticated({safeDiagnostics:true});
    // Read the pinned decoded snapshot before Item/Recipe constructors can
    // invent identifiers for malformed source rows. No caller-selected RPC.
    const snapshot=await c.client._getUserData(true);
    let payload;
    if(isShopping){
     const lists=snapshot?.shoppingListsResponse?.newLists;
     if(!Array.isArray(lists)||lists.length>MAX_ITEMS)unavailable();
     const matches=lists.filter(l=>l.identifier===before.listId);if(matches.length!==1)unavailable();
     const list=matches[0];uniqueRows(list.items);
     const items=list.items.map(i=>item.parse({identifier:i.identifier,name:i.name,quantity:i.quantityPb?.amount??i.deprecatedQuantity??i.quantity,checked:i.checked,note:i.details}));
     payload={status:'found',list_id:before.listId,list_name:text.parse(list.name),items,complete:true,includes_checked:true,includes_notes:true};
    }else{
     const all=snapshot?.recipeDataResponse?.recipes;uniqueRows(all);
     const rows=all.map(r=>({...recipeSummary.parse(r),_raw:r}));
     if(p.action==='list'){
      const matches=rows.filter(r=>r.name.toLowerCase().includes(p.search.toLowerCase())).sort((a,b)=>a.identifier<b.identifier?-1:a.identifier>b.identifier?1:0);
      const limit=p.limit??10;payload={recipes:matches.slice(0,limit).map(({_raw,...r})=>r),complete:matches.length<=limit};
     }else{
      const r=rows.find(r=>r.identifier===p.recipe_id);
      if(!r)payload={status:'not_found',recipe:null,complete:true};
      else{
       const raw=r._raw,ingredients=raw.ingredients??[],steps=raw.preparationSteps??[];
       if(!Array.isArray(ingredients)||ingredients.length>1000||!Array.isArray(steps)||steps.length>1000)unavailable();
       const {_raw,...summary}=r;
       payload={status:'found',recipe:{...summary,ingredients:ingredients.map(i=>ingredient.parse(typeof i?.toJSON==='function'?i.toJSON():i)),preparationSteps:steps.map(s=>text.parse(s))},complete:true};
      }
     }
    }
    const after=assertReadScope(profile,clientId,userId,actorSource);
    if(after.policyDigest!==before.policyDigest)throw new CapabilityError('POLICY_CHANGED','Read policy changed during the read.');
    return response({ok:true,...payload,provider:{contract:READ_CONTRACT,profile,source:READ_SOURCES[kind],client_id:clientId,user_id:userId,policy_digest:after.policyDigest,readOnly:true,mutationsEnabled:false},
     retrieved_at:new Date().toISOString(),freshness:'retrieval_only',source_modified_at:null,writes_performed:false});
   });
  }catch(error){const body=failure(error);return {isError:true,content:[{type:'text',text:JSON.stringify(body)}],structuredContent:body};}
 });
}
