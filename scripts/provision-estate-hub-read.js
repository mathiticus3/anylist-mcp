#!/usr/bin/env node
// Box-local provisioning only. Secret values never enter stdout or argv.
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {openSync,closeSync,writeFileSync,renameSync,unlinkSync,existsSync,lstatSync,fsyncSync,constants} from 'node:fs';
import path from 'node:path';
import {ESTATE_READ_PROFILE,ESTATE_READ_CLIENT,ESTATE_READ_SOURCE,estatePolicyFile,loadEstatePolicy} from '../src/profiles/estate-meal-policy.js';

const args=process.argv.slice(2),command=args.shift()||'--status';
const get=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const root=process.env.DATA_DIR||'/data';
const credential=path.join(root,'estate-household-anylist-read.private.json');
const policyFile=estatePolicyFile(),lock=path.join(root,'.estate-hub-mealplan-read.provision.lock');
let descriptor,db;
function require(ok){if(!ok)throw Error('Dedicated identity state refused; reconcile privately.');}
function secureFile(file){const s=lstatSync(file);return s.isFile()&&!(s.mode&0o077)&&[0,process.getuid?.()].includes(s.uid);}
function writePending(file,value){
 const fd=openSync(file+'.pending',constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
}
function syncRoot(){const fd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(fd);}finally{closeSync(fd);}}
try{
 require(['--status','--provision','--enable','--disable','--revoke'].includes(command));
 require(args.length===0||(args.length===2&&['--user-id','--client-id'].includes(args[0])));
 if(command!=='--status')descriptor=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 db=new Database(path.join(root,'anylist-mcp.db'),{readonly:command==='--status',fileMustExist:true});
 db.pragma('foreign_keys = ON');
 const rows=db.prepare('SELECT * FROM oauth_clients WHERE client_name=?').all(ESTATE_READ_CLIENT);
 require(rows.length<=1);let row=rows[0];
 if(row)require(row.profile===ESTATE_READ_PROFILE&&row.source===ESTATE_READ_SOURCE&&!row.redirect_uri&&!!row.client_secret_hash);
 let created=false;
 if(command==='--provision'){
  const userId=get('--user-id');require(typeof userId==='string'&&/^[a-f0-9-]{36}$/.test(userId));
  require(!!db.prepare('SELECT user_id FROM anylist_credentials WHERE user_id=?').get(userId));
  if(row){
   require(row.user_id===userId&&secureFile(credential));
   const policy=loadEstatePolicy();require(policy.clientId===row.client_id&&policy.userId===userId);
  }else{
   require(!existsSync(credential)&&!existsSync(policyFile)&&!existsSync(credential+'.pending')&&!existsSync(policyFile+'.pending'));
   const clientId=randomUUID(),secret=randomBytes(32).toString('hex'),hash=await bcrypt.hash(secret,12);
   writePending(credential,{client_id:clientId,client_secret:secret});
   writePending(policyFile,{schemaVersion:1,clientId,userId,enabled:false,revision:1});
   db.transaction(()=>{
    db.prepare('INSERT INTO oauth_clients (client_id,client_secret_hash,user_id,client_name,profile,source) VALUES (?,?,?,?,?,?)')
     .run(clientId,hash,userId,ESTATE_READ_CLIENT,ESTATE_READ_PROFILE,ESTATE_READ_SOURCE);
    renameSync(credential+'.pending',credential);renameSync(policyFile+'.pending',policyFile);syncRoot();
   })();
   row=db.prepare('SELECT * FROM oauth_clients WHERE client_id=?').get(clientId);created=true;
  }
 }
 if(['--enable','--disable','--revoke'].includes(command)){
  require(row&&get('--client-id')===row.client_id);
  const policy=loadEstatePolicy();require(policy.clientId===row.client_id&&policy.userId===row.user_id);
  const enabled=command==='--enable';
  if(policy.enabled!==enabled){
   const next={schemaVersion:1,clientId:policy.clientId,userId:policy.userId,enabled,revision:policy.revision+1};
   writePending(policyFile,next);renameSync(policyFile+'.pending',policyFile);syncRoot();
  }
  if(command==='--revoke'){
   db.transaction(()=>{
    db.prepare('DELETE FROM oauth_tokens WHERE client_id=?').run(row.client_id);
    db.prepare('DELETE FROM oauth_codes WHERE client_id=?').run(row.client_id);
    db.prepare('DELETE FROM oauth_clients WHERE client_id=?').run(row.client_id);
   })();row=null;
  }
 }
 const policy=row?loadEstatePolicy():null;
 console.log(JSON.stringify({registered:!!row,created,enabled:policy?.enabled??false,clientName:ESTATE_READ_CLIENT,
  clientId:row?.client_id??null,userId:row?.user_id??null,clientIdSha256:row?createHash('sha256').update(row.client_id).digest('hex'):null,
  profile:ESTATE_READ_PROFILE,source:ESTATE_READ_SOURCE,readOnly:true,mutationsEnabled:false,maxWindowDays:31,
  policyDigest:policy?.policyDigest??null,privateCredentialPresent:existsSync(credential),
  credentialFile:credential,secretPrinted:false,ownerHandoffRequired:true}));
}catch{
 console.error('Dedicated client operation stopped; reconcile private state before retry. No secret printed.');process.exitCode=1;
}finally{
 db?.close();if(descriptor!==undefined){closeSync(descriptor);unlinkSync(lock);}
}
