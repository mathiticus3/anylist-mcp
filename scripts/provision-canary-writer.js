#!/usr/bin/env node
// Supported confidential-client registration; writes a private env file, never credentials to stdout.
import {getDb,createConfidentialClient} from '../src/http/db.js';
import {CANARY_LIST_ID,CANARY_TOKEN_URL,CANARY_MCP_URL} from '../src/profiles/canary-policy.js';
import {CANARY_WRITE_PROFILE as CANARY_PROFILE,CANARY_WRITE_CLIENT_NAME as CANARY_CLIENT_NAME,CANARY_WRITE_SOURCE as CANARY_SOURCE} from '../src/profiles/canary-write-policy.js';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import bcrypt from 'bcrypt';
import {existsSync,readFileSync,writeFileSync,renameSync,unlinkSync,lstatSync} from 'node:fs';
import path from 'node:path';
const command=process.argv[2]||'--status';
const db=getDb(),file=path.join(process.env.DATA_DIR||'/data','.env.gina-canary-harness-write');
const rows=db.prepare('SELECT * FROM oauth_clients WHERE client_name=?').all(CANARY_CLIENT_NAME);
if(rows.length>1)throw Error('Duplicate named clients; stop for review.');
const row=rows[0];
if(row&&(row.profile!==CANARY_PROFILE||row.source!==CANARY_SOURCE||row.redirect_uri||!row.client_secret_hash))throw Error('Existing identity does not match dedicated bounded-write contract; stop for review.');
const summary=(clientId=row?.client_id)=>({clientIdSha256:clientId?createHash('sha256').update(clientId).digest('hex'):null,clientName:CANARY_CLIENT_NAME,profile:CANARY_PROFILE,source:CANARY_SOURCE,allowedListId:CANARY_LIST_ID,readOnly:false,boundedWriter:true,executionApprovalIncluded:false,credentialFile:file,secretPrinted:false});
if(command==='--status'){console.log(JSON.stringify({...summary(),registered:!!row,privateCredentialPresent:existsSync(file)}));}
else if(command==='--revoke'){
 db.transaction(()=>{if(row){db.prepare('DELETE FROM oauth_tokens WHERE client_id=?').run(row.client_id);db.prepare('DELETE FROM oauth_codes WHERE client_id=?').run(row.client_id);db.prepare('DELETE FROM oauth_clients WHERE client_id=?').run(row.client_id);}})();
 if(existsSync(file))unlinkSync(file);console.log(JSON.stringify({...summary(),revoked:true,registered:false}));
}else if(command==='--provision'){
 if(row){
  if(!existsSync(file)||!lstatSync(file).isFile()||(lstatSync(file).mode&0o077))throw Error('Existing client private delivery file missing or insecure; revoke/reprovision explicitly.');
  const env=Object.fromEntries(readFileSync(file,'utf8').trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  if(env.GINA_CANARY_WRITE_CLIENT_ID!==row.client_id||!await bcrypt.compare(env.GINA_CANARY_WRITE_CLIENT_SECRET||'',row.client_secret_hash))throw Error('Existing credential file mismatch; stop for review.');
  console.log(JSON.stringify({...summary(),registered:true,created:false}));
 }else{
  if(existsSync(file)||existsSync(file+'.tmp'))throw Error('Unmatched credential file exists; stop for review.');
  const users=db.prepare('SELECT user_id FROM anylist_credentials').all();if(users.length!==1)throw Error('Expected exactly one configured owner; stop for explicit account selection.');
  const clientId=randomUUID(),secret=randomBytes(32).toString('base64url'),hash=await bcrypt.hash(secret,12);
  const env=`ANYLIST_TOKEN_URL=${CANARY_TOKEN_URL}\nANYLIST_MCP_URL=${CANARY_MCP_URL}\nGINA_CANARY_WRITE_CLIENT_ID=${clientId}\nGINA_CANARY_WRITE_CLIENT_SECRET=${secret}\nANYLIST_LIST_ID=${CANARY_LIST_ID}\n`;
  writeFileSync(file+'.tmp',env,{mode:0o600,flag:'wx'});
  try{db.transaction(()=>{createConfidentialClient({clientId,clientSecretHash:hash,userId:users[0].user_id,clientName:CANARY_CLIENT_NAME,profile:CANARY_PROFILE,source:CANARY_SOURCE});renameSync(file+'.tmp',file);})();}
  catch(e){if(existsSync(file+'.tmp'))unlinkSync(file+'.tmp');if(existsSync(file))unlinkSync(file);throw Error('Dedicated client registration failed; no credential was printed.');}
  console.log(JSON.stringify({...summary(clientId),registered:true,created:true}));
 }
}else throw Error('Use --status, --provision or --revoke.');
