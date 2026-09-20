import {readFileSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CapabilityError} from '../stable/errors.js';
export const BOUNDED_READ='gina_bounded_read';
export const BOUNDED_ADD='gina_bounded_add';
export const BOUNDED_PROFILES=Object.freeze([BOUNDED_READ,BOUNDED_ADD]);
export const MAX_ITEMS=10000;
export const MAX_RESULT_BYTES=8*1024*1024;
export const CONTRACT_VERSION='bounded-shopping.v2';
const bindingSchema=z.object({schemaVersion:z.literal(1),listId:z.string().regex(/^[a-f0-9]{32}$/),readerEnabled:z.boolean(),addEnabled:z.boolean()}).strict();
export function bindingFile(){return path.join(process.env.DATA_DIR||'/data','gina-bounded-shopping.json');}
export function loadBoundedBinding(){
 try{
  const file=bindingFile(),stat=lstatSync(file);
  if(!stat.isFile()||(stat.mode&0o077)||stat.size>4096)throw Error('private policy required');
  const p=bindingSchema.parse(JSON.parse(readFileSync(file,'utf8')));
  // Operational kill flags do not change identity; the target and contract do.
  const bindingSha256=createHash('sha256').update(JSON.stringify({contract:CONTRACT_VERSION,listId:p.listId,maxItems:MAX_ITEMS,maxResultBytes:MAX_RESULT_BYTES})).digest('hex');
  return {...p,bindingSha256};
 }catch{throw new CapabilityError('POLICY_UNAVAILABLE','Private bounded-shopping policy is missing, malformed or insecure.');}
}
export function boundedSource(profile,binding){
 if(!BOUNDED_PROFILES.includes(profile))throw new CapabilityError('POLICY_UNAVAILABLE','Unknown bounded profile.');
 return `gina/bounded-shopping-${profile===BOUNDED_READ?'read':'add'}:${binding.bindingSha256}`;
}
export function assertBoundedScope(profile,source,expectedDigest){
 const p=loadBoundedBinding();
 if(source!==boundedSource(profile,p)||(expectedDigest&&p.bindingSha256!==expectedDigest))throw new CapabilityError('POLICY_CHANGED','Client/session does not match the pinned target binding; requalification required.');
 if(!(profile===BOUNDED_READ?p.readerEnabled:(p.addEnabled&&p.readerEnabled)))throw new CapabilityError('POLICY_DISABLED','This bounded capability is disabled.');
 return p;
}
