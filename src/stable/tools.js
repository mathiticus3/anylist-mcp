import { z } from 'zod';
import { CAPABILITIES, capability } from './capabilities.js';
import { executeClientCapability } from './client.js';
import { failure, withClientLock } from './errors.js';
export async function invokeStable(client,tool,action,input) {
  try {const data=await executeClientCapability(client,tool,action,input);return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:{ok:true,...data}};}
  catch(error){const result=failure(error);return {isError:true,content:[{type:'text',text:result.error.message}],structuredContent:result};}
}
/** Decorate registration, preserving legacy handlers and the restricted profile. */
export function stableServer(server,getClient,{profile}={}) {
  return new Proxy(server,{get(target,key){
    if(key!=='registerTool')return Reflect.get(target,key,target);
    return (name,config,legacy)=>{
      const defs=profile==='gina'?[]:CAPABILITIES.filter(d=>d.tool===name);
      const oldActions=config.inputSchema.action?.options||[];
      if(defs.length) {
        const extra={};
        for(const d of defs)for(const [k,s] of Object.entries(d.schema.shape))extra[k]=s.optional();
        config={...config,description:config.description+'\nStructured interface: response_format="structured" returns canonical IDs and typed errors. Additional actions: '+defs.filter(d=>!oldActions.includes(d.action)).map(d=>`${d.action}: ${d.description}`).join('; '),inputSchema:{...config.inputSchema,...extra,action:z.enum([...new Set([...oldActions,...defs.map(d=>d.action)])]),response_format:z.enum(['text','structured']).optional()}};
      }
      return target.registerTool(name,config,async(params,...rest)=>{
        const client=await getClient();
        return withClientLock(client,async()=>{
          if(defs.length && (params.response_format==='structured'||!oldActions.includes(params.action))) {
            const {action,response_format,...input}=params;
            return invokeStable(client,name,action,input);
          }
          return legacy(params,...rest);
        });
      });
    };
  }});
}
export function registerService(server,getClient) {
  const defs=CAPABILITIES.filter(d=>d.tool==='service');
  server.registerTool('service',{description:'Read readiness, versions, capabilities or refresh from AnyList.',inputSchema:{action:z.enum(defs.map(d=>d.action))},annotations:{readOnlyHint:true,destructiveHint:false}},async({action})=>{
    const c=await getClient();return withClientLock(c,()=>invokeStable(c,'service',action,{}));
  });
}
