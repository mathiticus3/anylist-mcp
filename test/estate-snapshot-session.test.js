import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('snapshot custody never reuses a listener client; account eviction clears both modes',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'synthetic-snapshot-session-'));
 const oldDir=process.env.DATA_DIR,oldKey=process.env.SERVER_SECRET_KEY;
 process.env.DATA_DIR=dir;process.env.SERVER_SECRET_KEY='0'.repeat(64);
 const {getDb,upsertAnyListCredentials}=await import('../src/http/db.js');
 const {getOrCreateSession,evictSession}=await import('../src/http/session-manager.js');
 const db=getDb(),user='00000000-0000-4000-8000-000000000009';
 try{
  db.prepare('INSERT INTO users(id,email)VALUES(?,?)').run(user,'fixture@example.invalid');
  upsertAnyListCredentials(user,{username:'synthetic',password:'synthetic'});
  const legacy=await getOrCreateSession(user),snapshot=await getOrCreateSession(user,{snapshotOnly:true});
  assert.notEqual(legacy,snapshot);assert.equal(snapshot._snapshotOnly,true);assert.equal(legacy._snapshotOnly,false);
  assert.equal(await getOrCreateSession(user),legacy);assert.equal(await getOrCreateSession(user,{snapshotOnly:true}),snapshot);
  evictSession(user);
  assert.notEqual(await getOrCreateSession(user),legacy);assert.notEqual(await getOrCreateSession(user,{snapshotOnly:true}),snapshot);
 }finally{
  evictSession(user);db.close();
  if(oldDir===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=oldDir;
  if(oldKey===undefined)delete process.env.SERVER_SECRET_KEY;else process.env.SERVER_SECRET_KEY=oldKey;
  rmSync(dir,{recursive:true,force:true});
 }
});
