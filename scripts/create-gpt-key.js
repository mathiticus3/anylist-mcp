#!/usr/bin/env node
// Run locally on the deployed host, inside the container. Never prints the secret.
import {getDb} from '../src/http/db.js';
import{randomBytes,createHash}from'node:crypto';
import{existsSync,writeFileSync,renameSync}from'node:fs';
import path from'node:path';
const root=process.env.DATA_DIR||'/data';const config=path.join(root,'gpt-actions.json');const secret=path.join(root,'.env.gpt-actions');
const args=process.argv.slice(2);
if(args.includes('--revoke')){writeFileSync(config,JSON.stringify({enabled:false,userId:'revoked',sha256:'0'.repeat(64)}),{mode:0o600});console.log('GPT Actions credential revoked.');process.exit(0);}
if((existsSync(config)||existsSync(secret))&&!args.includes('--rotate'))throw Error('Credential already exists; use --rotate explicitly.');
const users=getDb().prepare('SELECT user_id FROM anylist_credentials').all();
if(users.length!==1)throw Error('Exactly one configured AnyList account is required; select the owner explicitly before provisioning.');
const token=randomBytes(32).toString('base64url');
writeFileSync(secret+'.tmp',`ANYLIST_GPT_ACTIONS_KEY=${token}\n`,{mode:0o600,flag:'wx'});
writeFileSync(config+'.tmp',JSON.stringify({enabled:true,userId:users[0].user_id,sha256:createHash('sha256').update(token).digest('hex')}),{mode:0o600,flag:'wx'});
renameSync(secret+'.tmp',secret);renameSync(config+'.tmp',config);
console.log(JSON.stringify({configured:true,credentialFile:secret,verifierFile:config,secretPrinted:false}));
