import {readFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {AnyListExperimentalClient} from './client.js';
import {CapabilityError,failure,withClientLock} from '../stable/errors.js';
const flagsSchema=z.object({item_prices:z.boolean().optional(),list_folders:z.boolean().optional()}).strict();
export function experimentalFlags(){try{return flagsSchema.parse(JSON.parse(readFileSync(path.join(process.env.DATA_DIR||'/data','anylist-experimental.json'),'utf8')));}catch{return {};}}
const id=z.string().min(1).max(128).optional(),name=z.string().trim().min(1).max(512).optional();
const paging={limit:z.number().int().min(1).max(100).optional(),offset:z.number().int().min(0).max(100000).optional()};
export const EXPERIMENTAL_SCHEMAS={list_prices:z.object({list_id:id,list_name:name,id,name,...paging}).strict(),list_folders:z.object({id,name,...paging}).strict()};
const flagFor={list_prices:'item_prices',list_folders:'list_folders'};
export function registerExperimental(server,getClient,readFlags=experimentalFlags){
 const enabled=Object.keys(flagFor).filter(a=>readFlags()[flagFor[a]]===true);if(!enabled.length)return;
 server.registerTool('anylist_experimental',{description:'EXPERIMENTAL read-only current item pricing and list folders. Individually disableable. Never use as stable availability contract.',inputSchema:{action:z.enum(enabled),list_id:id,list_name:name,id,name,...paging},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async({action,...p})=>{
  try{
   if(!enabled.includes(action)||readFlags()[flagFor[action]]!==true)throw new CapabilityError('EXPERIMENTAL_DISABLED','This experimental capability is disabled.');
   const parsed=EXPERIMENTAL_SCHEMAS[action].parse(p);const c=await getClient();
   return await withClientLock(c,async()=>{try{await c.ensureAuthenticated();const e=new AnyListExperimentalClient(c.client);const data=action==='list_prices'?await e.listItemPrices(parsed):await e.listFolders(parsed);return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:{ok:true,...data}};}catch(error){return errorResult(error);}});
  }catch(error){return errorResult(error);}
 });
}
function errorResult(error){const body=failure(error);return {isError:true,content:[{type:'text',text:body.error.message}],structuredContent:body};}
