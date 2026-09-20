import express from 'express';
import {createHash,timingSafeEqual} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {rateLimit} from 'express-rate-limit';
import {z} from 'zod';
import {registerAllTools} from '../tools/index.js';
import {capability} from '../stable/capabilities.js';
import {failure,CapabilityError} from '../stable/errors.js';
import {openapi,ADAPTER_VERSION} from './openapi.js';
import {PROJECTION} from './projection.js';
const credentialSchema=z.object({userId:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),enabled:z.boolean()}).strict();
export function loadCredential() {
 const file=path.join(process.env.DATA_DIR||'/data','gpt-actions.json');
 try {const stat=statSync(file);if(stat.size>4096||(stat.mode&0o077)!==0)return null;return credentialSchema.parse(JSON.parse(readFileSync(file,'utf8')));}catch{return null;}
}
export function authenticate(header,record) {
 if(!record?.enabled || !/^Bearer [A-Za-z0-9_-]{43,128}$/.test(header||''))return false;
 const hash=createHash('sha256').update(header.slice(7)).digest();
 return /^[a-f0-9]{64}$/.test(record.sha256)&&timingSafeEqual(hash,Buffer.from(record.sha256,'hex'));
}
const statuses={INVALID_INPUT:400,NOT_FOUND:404,AMBIGUOUS:409,CONFLICT:409,UNSUPPORTED:422,AUTH_FAILURE:502,UPSTREAM_FAILURE:502,RESPONSE_TOO_LARGE:413};
export function createActionsRouter({getClientForUser,credential=loadCredential,limiter=true}) {
 const router=express.Router();
 router.use((req,res,next)=>{res.set('Cache-Control','no-store');const record=credential();if(!authenticate(req.headers.authorization,record))return res.status(401).json({ok:false,error:{code:'UNAUTHORIZED',message:'A dedicated GPT Actions bearer credential is required.'}});req.actionsUserId=record.userId;next();});
 if(limiter)router.use(rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-7',legacyHeaders:false,message:{ok:false,error:{code:'RATE_LIMITED',message:'Retry later.'}}}));
 router.use(express.json({limit:'95kb'}));
 for(const entry of PROJECTION){const handle=async(req,res)=>{
  try {
   const parsed=entry.schema.parse(req.method==='GET'?{}:req.body??{});
   const {tool,action,input}=entry.select(parsed);
   capability(tool,action).schema.parse(input);
   const handlers={};
   registerAllTools({registerTool(name,_config,handler){handlers[name]=handler;return {update(){}};}},()=>getClientForUser(req.actionsUserId));
   const result=await handlers[tool]({action,...input,...(tool==='service'?{}:{response_format:'structured'})});
   const body=result.structuredContent||{ok:false,error:{code:'UPSTREAM_FAILURE',message:'Structured MCP result unavailable.'}};
   const encoded=JSON.stringify(body);
   if(encoded.length>95000)throw new CapabilityError('RESPONSE_TOO_LARGE','Narrow the date range/search or reduce the page limit.');
   res.status(body.ok?200:statuses[body.error?.code]||502).type('json').send(encoded);
  }catch(error){const body=failure(error);res.status(statuses[body.error.code]||502).json(body);}
 };router.post('/'+entry.operationId,handle);if(entry.operationId==='getServiceStatus')router.get('/readyz',handle);}
 router.use((_req,res)=>res.status(404).json({ok:false,error:{code:'NOT_FOUND',message:'Unknown Actions route.'}}));
 router.use((error,_req,res,_next)=>res.status(error.type==='entity.too.large'?413:400).json({ok:false,error:{code:'INVALID_INPUT',message:'Invalid or oversized JSON request.'}}));
 return router;
}

export function mountActions(app,options) {
 app.get('/healthz',(_req,res)=>res.json({ok:true,service:'anylist-mcp',adapterVersion:ADAPTER_VERSION}));
 app.get('/openapi.json',(_req,res)=>res.json(openapi()));
 app.get('/privacy',(_req,res)=>res.type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><title>Vector72 AnyList Privacy</title><h1>Vector72 AnyList Privacy</h1><p>This owner-only integration processes shopping lists, recipes and meal plans requested through ChatGPT. AnyList remains the source of truth. The adapter does not maintain a second household database. The existing MCP service stores encrypted AnyList credentials and OAuth session records; its operational logs may contain request metadata and upstream diagnostic messages.</p><p>A dedicated revocable GPT credential authenticates Actions. AnyList passwords are never sent to the GPT. Information returned through Actions is provided to ChatGPT under the owner’s ChatGPT account settings and OpenAI policies. Recipe URL import retrieves the requested public HTTPS page. This service is an unofficial AnyList integration operated by Vector72 LLC for private household use.</p><p>To revoke access, the owner can disable the GPT credential on the service host. Manage household content and its deletion in AnyList. Do not share this GPT or its credential.</p></html>'));
 const router=createActionsRouter(options);
 app.get('/readyz',(req,res,next)=>{req.url='/readyz';router(req,res,next);});
 app.use('/actions',router);
}
