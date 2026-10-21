// Two independent source-owned read profiles; never widen the meal reader.
import {openSync,closeSync,readFileSync,fstatSync,constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CapabilityError} from '../stable/errors.js';
export const READ_PROFILES=Object.freeze({shopping:'estate_hub_shopping_readonly',recipes:'estate_hub_recipes_readonly'});
export const READ_SOURCES=Object.freeze({shopping:'estate-household-shopping-readonly',recipes:'estate-household-recipes-readonly'});
export const HOUSEHOLD_READ_PROFILES=Object.freeze(Object.values(READ_PROFILES));
export const READ_CONTRACT='estate-household-read.v1';
export const MAX_ITEMS=10000,MAX_RESPONSE_BYTES=1024*1024;
const common={schemaVersion:z.literal(1),clientId:z.string().uuid(),userId:z.string().uuid(),enabled:z.boolean(),revision:z.number().int().min(1)};
const schemas={shopping:z.object({...common,listId:z.string().regex(/^[a-f0-9]{32}$/)}).strict(),recipes:z.object(common).strict()};
export function readKind(profile){
 const kind=Object.keys(READ_PROFILES).find(k=>READ_PROFILES[k]===profile);
 if(!kind)throw new CapabilityError('POLICY_UNAVAILABLE','Dedicated household read policy is unavailable.');
 return kind;
}
export function readPolicyFile(profile){return path.join(process.env.DATA_DIR||'/data',`estate-hub-${readKind(profile)}-read-policy.json`);}
export function assertReadScope(profile,clientId,userId,source){
 let fd;
 try{
  const kind=readKind(profile);fd=openSync(readPolicyFile(profile),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const info=fstatSync(fd);
  if(!info.isFile()||(info.mode&0o077)||info.size>4096||![0,process.getuid?.()].includes(info.uid))throw Error();
  const policy=schemas[kind].parse(JSON.parse(readFileSync(fd,'utf8')));
  if(!policy.enabled||policy.clientId!==clientId||policy.userId!==userId||source!==READ_SOURCES[kind])throw Error();
  const policyDigest=createHash('sha256').update(JSON.stringify({contract:READ_CONTRACT,profile,source,...policy})).digest('hex');
  return {...policy,policyDigest};
 }catch{throw new CapabilityError('POLICY_UNAVAILABLE','Dedicated household read policy is unavailable.');}
 finally{if(fd!==undefined)closeSync(fd);}
}
