import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('estate provision is disabled by default, idempotent and revokes only its exact identity without printing secrets',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'synthetic-estate-provision-'));
 try{
  const db=new Database(path.join(dir,'anylist-mcp.db'));
  db.exec(`CREATE TABLE anylist_credentials(user_id TEXT);CREATE TABLE oauth_clients(client_id TEXT,client_secret_hash TEXT,user_id TEXT,client_name TEXT,profile TEXT,source TEXT,redirect_uri TEXT);
   CREATE TABLE oauth_tokens(client_id TEXT);CREATE TABLE oauth_codes(client_id TEXT);`);
  const user='00000000-0000-4000-8000-000000000002';db.prepare('INSERT INTO anylist_credentials VALUES (?)').run(user);
  db.prepare('INSERT INTO oauth_clients(client_id,profile,client_name) VALUES (?,?,?)').run('other','full','Existing');
  const cli=(...args)=>{const r=spawnSync(process.execPath,['scripts/provision-estate-hub-read.js',...args],{env:{...process.env,DATA_DIR:dir},encoding:'utf8'});
   assert.equal(r.status,0,r.stderr);return {value:JSON.parse(r.stdout),output:r.stdout+r.stderr};};
  assert.equal(cli('--status').value.registered,false);
  const first=cli('--provision','--user-id',user);assert.equal(first.value.created,true);assert.equal(first.value.enabled,false);
  const file=path.join(dir,'estate-household-anylist-read.private.json'),secret=JSON.parse(readFileSync(file,'utf8'));
  assert.equal(statSync(file).mode&0o777,0o600);assert.ok(!first.output.includes(secret.client_secret));
  const repeated=cli('--provision','--user-id',user);assert.equal(repeated.value.created,false);assert.equal(repeated.value.clientId,secret.client_id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM oauth_clients').get().n,2);
  assert.equal(cli('--enable','--client-id',secret.client_id).value.enabled,true);
  assert.equal(cli('--disable','--client-id',secret.client_id).value.enabled,false);
  const wrong=spawnSync(process.execPath,['scripts/provision-estate-hub-read.js','--enable','--client-id','other'],{env:{...process.env,DATA_DIR:dir},encoding:'utf8'});
  assert.equal(wrong.status,1);assert.ok(!wrong.stdout.includes(secret.client_secret));
  assert.equal(cli('--revoke','--client-id',secret.client_id).value.registered,false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM oauth_clients').get().n,1);
  assert.equal(db.prepare('SELECT client_id FROM oauth_clients').get().client_id,'other');db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
