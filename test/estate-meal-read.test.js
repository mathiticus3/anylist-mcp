import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync,chmodSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {registerAllTools} from '../src/tools/index.js';
import {validateClientRedirectUri} from '../src/http/auth/policy.js';
import {ESTATE_READ_PROFILE,ESTATE_READ_SOURCE,estatePolicyFile,assertEstateScope} from '../src/profiles/estate-meal-policy.js';

const clientId='00000000-0000-4000-8000-000000000001',userId='00000000-0000-4000-8000-000000000002';
test('estate meal profile is bounded, identity-bound, read-only and immediately revocable',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'synthetic-estate-meal-')),old=process.env.DATA_DIR;
 process.env.DATA_DIR=dir;
 try{
  const policy={schemaVersion:1,clientId,userId,enabled:true,revision:1};
  const save=()=>writeFileSync(estatePolicyFile(),JSON.stringify(policy),{mode:0o600});save();
  let auth=0,reads=0;const client={ensureAuthenticated:async()=>{auth++;},getMealPlanEvents:async()=>{reads++;return [
   {date:'2026-01-31',title:'Synthetic end',identifier:'end'},
   {date:'2025-12-31',title:'Outside',identifier:'outside'},
   {date:'2026-01-01',title:'Synthetic start',identifier:'start'}];}};
  const tools={};registerAllTools({registerTool(n,config,handler){tools[n]={config,handler};}},()=>client,
   {profile:ESTATE_READ_PROFILE,actorSource:ESTATE_READ_SOURCE,clientId,userId});
  assert.deepEqual(Object.keys(tools),['meal_plan_read']);assert.equal(tools.meal_plan_read.config.annotations.readOnlyHint,true);
  const invoke=tools.meal_plan_read.handler,valid={action:'list_events',start_date:'2026-01-01',end_date:'2026-01-31'};
  const result=await invoke(valid);assert.equal(result.isError,undefined);assert.equal(reads,1);
  assert.ok(result.content[0].text.startsWith('Meal Plan (2 events):'));assert.ok(!result.content[0].text.includes('Outside'));
  assert.equal(result.structuredContent.provider.client_id,clientId);assert.equal(result.structuredContent.provider.user_id,userId);
  assert.equal(result.structuredContent.provider.mutationsEnabled,false);assert.equal(result.structuredContent.complete,true);
  for(const args of [{...valid,action:'create_event'}, {...valid,title:'write'}, {...valid,start_date:'2026-02-30'},
    {...valid,end_date:'2026-02-01'}, {...valid,end_date:'2025-12-31'}, {action:'list_events'}]){
   assert.equal((await invoke(args)).isError,true);
  }
  assert.equal(reads,1);assert.equal(auth,1);
  policy.enabled=false;save();assert.equal((await invoke(valid)).isError,true);assert.equal(reads,1);
  policy.enabled=true;save();assert.throws(()=>assertEstateScope(userId,userId,ESTATE_READ_SOURCE));
  assert.throws(()=>assertEstateScope(clientId,clientId,ESTATE_READ_SOURCE));
  assert.throws(()=>assertEstateScope(clientId,userId,'untrusted'));
  client.getMealPlanEvents=async()=>{policy.enabled=false;save();return [];};
  assert.equal((await invoke(valid)).isError,true);
  policy.enabled=true;save();chmodSync(estatePolicyFile(),0o644);assert.throws(()=>assertEstateScope(clientId,userId,ESTATE_READ_SOURCE));
  rmSync(estatePolicyFile());const outside=path.join(dir,'other.json');writeFileSync(outside,JSON.stringify(policy),{mode:0o600});
  symlinkSync(outside,estatePolicyFile());assert.throws(()=>assertEstateScope(clientId,userId,ESTATE_READ_SOURCE));
 }finally{if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;rmSync(dir,{recursive:true,force:true});}
});
test('estate machine client cannot bind a browser callback',()=>{
 assert.throws(()=>validateClientRedirectUri({profile:ESTATE_READ_PROFILE,redirect_uri:null},'https://claude.ai/api/mcp/auth_callback'),
  e=>e.code==='unauthorized_client'&&e.status===403);
});
