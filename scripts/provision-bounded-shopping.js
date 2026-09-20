#!/usr/bin/env node
// Offline preparation only until owner setup approval. Never print credentials.
import {getDb,createConfidentialClient} from '../src/http/db.js';
import {BOUNDED_READ,BOUNDED_ADD,loadBoundedBinding,boundedSource,assertBoundedScope} from '../src/profiles/bounded-policy.js';
import {CANARY_TOKEN_URL,CANARY_MCP_URL} from '../src/profiles/canary-policy.js';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import bcrypt from 'bcrypt';
import {existsSync,readFileSync,writeFileSync,renameSync,unlinkSync,lstatSync} from 'node:fs';
import path from 'node:path';
const [role,command='--status']=process.argv.slice(2);
if(!['read','add'].includes(role)||!['--status','--provision','--revoke'].includes(command))throw Error('Use read|add --status|--provision|--revoke.');
const profile=role==='read'?BOUNDED_READ:BOUNDED_ADD,clientName=`gina-bounded-shopping-${role}`,sourcePrefix=`gina/bounded-shopping-${role}:`;
const db=getDb(),file=path.join(process.env.DATA_DIR||'/data',`.env.${clientName}`);
const rows=db.prepare('SELECT * FROM oauth_clients WHERE client_name=?').all(clientName);
if(rows.length>1)throw Error('Duplicate named registrations; stop for review.');
const row=rows[0];
if(row&&(row.profile!==profile||!row.source?.startsWith(sourcePrefix)||row.redirect_uri||!row.client_secret_hash))throw Error('Named identity conflicts with bounded contract.');
const summary=(clientId=row?.client_id)=>({clientName,profile,clientIdSha256:clientId?createHash('sha256').update(clientId).digest('hex'):null,credentialFile:file,secretPrinted:false,executionApprovalIncluded:false});
if(command==='--status')console.log(JSON.stringify({...summary(),registered:!!row,privateCredentialPresent:existsSync(file)}));
else if(command==='--revoke'){
 // Revocation still works after policy loss/change; only this exact named role is removed.
 db.transaction(()=>{if(row){db.prepare('DELETE FROM oauth_tokens WHERE client_id=?').run(row.client_id);db.prepare('DELETE FROM oauth_codes WHERE client_id=?').run(row.client_id);db.prepare('DELETE FROM oauth_clients WHERE client_id=?').run(row.client_id);}})();
 if(existsSync(file))unlinkSync(file);console.log(JSON.stringify({...summary(),revoked:true,registered:false}));
}else{
 const policy=loadBoundedBinding(),source=boundedSource(profile,policy);assertBoundedScope(profile,source);
 if(row){
  if(row.source!==source)throw Error('Existing identity target binding differs; never silently rebind.');
  if(!existsSync(file)||!lstatSync(file).isFile()||(lstatSync(file).mode&0o077))throw Error('Private credential missing or insecure.');
  const env=Object.fromEntries(readFileSync(file,'utf8').trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  if(env.GINA_BOUNDED_CLIENT_ID!==row.client_id||env.ANYLIST_LIST_ID!==policy.listId||env.ANYLIST_BINDING_SHA256!==policy.bindingSha256||!await bcrypt.compare(env.GINA_BOUNDED_CLIENT_SECRET||'',row.client_secret_hash))throw Error('Private credential does not match pinned identity.');
  console.log(JSON.stringify({...summary(),bindingSha256:policy.bindingSha256,registered:true,created:false}));
 }else{
  if(existsSync(file)||existsSync(file+'.tmp'))throw Error('Unmatched credential file exists.');
  const users=db.prepare('SELECT user_id FROM anylist_credentials').all();if(users.length!==1)throw Error('Expected one configured owner.');
  const clientId=randomUUID(),secret=randomBytes(32).toString('base64url'),hash=await bcrypt.hash(secret,12);
  const env=`ANYLIST_TOKEN_URL=${CANARY_TOKEN_URL}\nANYLIST_MCP_URL=${CANARY_MCP_URL}\nGINA_BOUNDED_CLIENT_ID=${clientId}\nGINA_BOUNDED_CLIENT_SECRET=${secret}\nANYLIST_LIST_ID=${policy.listId}\nANYLIST_BINDING_SHA256=${policy.bindingSha256}\n`;
  writeFileSync(file+'.tmp',env,{mode:0o600,flag:'wx'});
  try{db.transaction(()=>{createConfidentialClient({clientId,clientSecretHash:hash,userId:users[0].user_id,clientName,profile,source});renameSync(file+'.tmp',file);})();}
  catch{if(existsSync(file+'.tmp'))unlinkSync(file+'.tmp');if(existsSync(file))unlinkSync(file);throw Error('Bounded registration failed; credential not printed.');}
  console.log(JSON.stringify({...summary(clientId),bindingSha256:policy.bindingSha256,registered:true,created:true}));
 }
}
