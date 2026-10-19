import {openSync,closeSync,readFileSync,fstatSync,constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CapabilityError} from '../stable/errors.js';

export const ESTATE_READ_PROFILE='estate_hub_mealplan_readonly';
export const ESTATE_READ_CLIENT='estate-household-anylist-read';
export const ESTATE_READ_SOURCE='estate-household-mealplan-readonly';
export const ESTATE_READ_CONTRACT='estate-mealplan-read.v1';
export const MAX_WINDOW_DAYS=31;
const uuid=z.string().uuid();
export const estatePolicySchema=z.object({schemaVersion:z.literal(1),clientId:uuid,userId:uuid,
 enabled:z.boolean(),revision:z.number().int().min(1)}).strict();
export function estatePolicyFile(){return path.join(process.env.DATA_DIR||'/data','estate-hub-mealplan-read-policy.json');}
export function loadEstatePolicy(){
 let fd;
 try{
  fd=openSync(estatePolicyFile(),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const info=fstatSync(fd);
  if(!info.isFile()||(info.mode&0o077)||info.size>4096||![0,process.getuid?.()].includes(info.uid))throw Error();
  const value=estatePolicySchema.parse(JSON.parse(readFileSync(fd,'utf8')));
  const policyDigest=createHash('sha256').update(JSON.stringify({contract:ESTATE_READ_CONTRACT,...value})).digest('hex');
  return {...value,policyDigest};
 }catch{throw new CapabilityError('POLICY_UNAVAILABLE','Dedicated meal-plan policy is unavailable.');}
 finally{if(fd!==undefined)closeSync(fd);}
}
export function assertEstateScope(clientId,userId,source){
 const policy=loadEstatePolicy();
 if(!policy.enabled||policy.clientId!==clientId||policy.userId!==userId||source!==ESTATE_READ_SOURCE)
  throw new CapabilityError('POLICY_DISABLED','Dedicated meal-plan identity is unavailable.');
 return policy;
}
