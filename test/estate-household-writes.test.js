import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import AnyList from '../src/anylist-legacy-client.cjs';
import { registerAllTools } from '../src/tools/index.js';
import { WRITE_PROFILES, WRITE_SOURCES, writePolicyFile, OPERATIONS } from '../src/profiles/estate-write-policy.js';
import { initializeJournal } from '../src/profiles/estate-write-journal.js';
import { journalFile } from '../src/profiles/estate-household-writes.js';
const listId = 'a'.repeat(32), calendarId = 'c'.repeat(32);
const today = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Denver',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function fixture(t, kind) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'synthetic-native-writer-')), old=process.env.DATA_DIR;
  process.env.DATA_DIR=dir; t.after(()=>{if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;rmSync(dir,{recursive:true,force:true});});
  mkdirSync(path.join(dir,'estate-write-journals'),{mode:0o700});
  const policy={schemaVersion:1,clientId:randomUUID(),userId:randomUUID(),upstreamUserId:'synthetic-upstream',
    journalId:randomUUID(),enabled:true,revision:1,operations:OPERATIONS[kind],
    ...(kind==='shopping'?{listId}:{timeZone:'America/Denver',maxPastDays:7,maxFutureDays:93,labelIds:[]})};
  const save=()=>writeFileSync(writePolicyFile(WRITE_PROFILES[kind]),JSON.stringify(policy),{mode:0o600});save();
  initializeJournal(journalFile(kind),policy.journalId);
  const raw=new AnyList({email:'synthetic@example.invalid',password:'synthetic',credentialsFile:null});
  raw.uid=policy.upstreamUserId;raw._refreshTokens=async()=>{};
  const data={shoppingListsResponse:{newLists:[{identifier:listId,name:'Synthetic list',items:[]}]},
    mealPlanningCalendarResponse:{calendarId,events:[],labels:[]}};
  let count=0, loseAck=false, acquisitionUnavailable=false, authorized=true, readHook=()=>{}, acquisitionHook=()=>{};
  raw._getUserData=async()=>{await readHook();return structuredClone(data);};
  raw.client={post:async(endpoint,{body})=>{
    count++;const buffer=body.getBuffer(),start=buffer.indexOf('\r\n\r\n')+4,end=buffer.lastIndexOf('\r\n--'+body.getBoundary());
    if(kind==='shopping'){
      const operations=raw.protobuf.PBListOperationList.decode(buffer.subarray(start,end)).operations;
      for(const op of operations){
        assert.equal(op.listId,listId);const items=data.shoppingListsResponse.newLists[0].items;
        if(op.metadata.handlerId==='add-shopping-list-item') items.push({identifier:op.listItem.identifier,listId,name:op.listItem.name,
          quantity:op.listItem.quantityPb?.amount??'',details:op.listItem.details??'',checked:op.listItem.checked??false});
        else if(op.metadata.handlerId==='remove-shopping-list-item') data.shoppingListsResponse.newLists[0].items=items.filter(item=>item.identifier!==op.listItemId);
        else {const item=items.find(item=>item.identifier===op.listItemId),field={'set-list-item-name':'name','set-list-item-quantity':'quantity','set-list-item-details':'details','set-list-item-checked':'checked'}[op.metadata.handlerId];assert.ok(field);item[field]=field==='checked'?op.updatedValue==='y':op.updatedValue;}
      }
    }else{
      const op=raw.protobuf.PBCalendarOperationList.decode(buffer.subarray(start,end)).operations[0];assert.equal(op.calendarId,calendarId);
      const event=op.updatedEvent,events=data.mealPlanningCalendarResponse.events;
      if(op.metadata.handlerId==='delete-event')data.mealPlanningCalendarResponse.events=events.filter(row=>row.identifier!==event.identifier);
      else {const value={identifier:event.identifier,date:event.date,title:event.title,details:event.details,labelId:event.labelId||null,recipeId:event.recipeId||null};const index=events.findIndex(row=>row.identifier===event.identifier);if(index<0)events.push(value);else events[index]=value;}
    }
    if(loseAck)throw Error('private upstream failure sentinel');
  }};
  const client={_oneShotWrites:true,ensureAuthenticated:async()=>{},client:raw},tools={};
  registerAllTools({registerTool(name,config,handler){tools[name]={config,handler};}},async()=>{if(acquisitionUnavailable)throw Error('synthetic upstream custody unavailable');await acquisitionHook();return client;},
    {profile:WRITE_PROFILES[kind],actorSource:WRITE_SOURCES[kind],clientId:policy.clientId,userId:policy.userId,currentAuthorization:()=>{if(!authorized)throw Error('revoked fixture authority');}});
  const invoke=async input=>{const result=await tools[kind==='shopping'?'shopping_write':'meal_plan_write'].handler(input);assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);return result;};
  return {tools,invoke,policy,save,data,revoke:()=>{authorized=false;},onRead:hook=>{readHook=hook;},onAcquire:hook=>{acquisitionHook=hook;},count:()=>count,loseAck:()=>{loseAck=true;},unavailable:()=>{acquisitionUnavailable=true;}};
}
for(const kind of ['shopping','meal'])test(`dedicated ${kind} profile confirms real native mutation/readback and persists replay receipts`,async t=>{
  const f=fixture(t,kind),operation=kind==='shopping'?'shopping.add':'meal.create';
  assert.deepEqual(Object.keys(f.tools),[kind==='shopping'?'shopping_write':'meal_plan_write']);
  const inspected=(await f.invoke({action:'inspect',operation})).structuredContent;assert.equal(inspected.ok,true);
  const command={action:'apply',operation,change_id:randomUUID(),expected_digest:inspected.expected_digest,
    fields:kind==='shopping'?{name:'Fixture',quantity:2}:{date:today,title:'Fixture'}};
  const first=await f.invoke(command);assert.equal(first.isError,undefined);assert.equal(first.structuredContent.outcome,'CONFIRMED');
  assert.equal(first.structuredContent.postcondition_observed,true);assert.equal(first.structuredContent.provider.upstream_user_id,f.policy.upstreamUserId);
  assert.equal((await f.invoke(command)).structuredContent.outcome,'CONFIRMED');assert.equal(f.count(),1);
  f.unavailable(); assert.equal((await f.invoke({action:'receipt',change_id:command.change_id})).structuredContent.outcome,'CONFIRMED');
  f.policy.enabled=false;f.save();assert.equal((await f.invoke({action:'receipt',change_id:command.change_id})).isError,true);assert.equal(f.count(),1);
});
test('native lost ACK remains UNKNOWN and durable receipt replay never repeats the POST',async t=>{
  const f=fixture(t,'shopping'),operation='shopping.add';const inspected=(await f.invoke({action:'inspect',operation})).structuredContent;
  f.loseAck();const command={action:'apply',operation,change_id:randomUUID(),expected_digest:inspected.expected_digest,fields:{name:'Fixture'}};
  const first=(await f.invoke(command)).structuredContent;assert.equal(first.outcome,'UNKNOWN');assert.equal(first.postcondition_observed,true);
  assert.ok(!JSON.stringify(first).includes('private upstream failure sentinel'));
  assert.equal((await f.invoke({action:'reconcile',change_id:command.change_id})).structuredContent.outcome,'UNKNOWN');
  assert.equal((await f.invoke(command)).structuredContent.outcome,'UNKNOWN');assert.equal(f.count(),1);
});

for (const boundary of ['read', 'acquire']) test(`current authority revocation during ${boundary} refuses before native dispatch`, async t => {
  const f = fixture(t, 'shopping'), operation = 'shopping.add';
  const inspected = (await f.invoke({action:'inspect', operation})).structuredContent;
  (boundary === 'read' ? f.onRead : f.onAcquire)(f.revoke);
  const value = await f.invoke({action:'apply', operation, change_id:randomUUID(), expected_digest:inspected.expected_digest, fields:{name:'Must remain absent'}});
  assert.equal(value.isError, true); assert.equal(f.count(), 0);
  assert.ok(!JSON.stringify(value).includes('Must remain absent'));
});
test('current authority revocation during post-write readback withholds receipt and never redispatches', async t => {
  const f = fixture(t, 'shopping'), operation = 'shopping.add';
  const inspected = (await f.invoke({action:'inspect', operation})).structuredContent;
  let reads = 0; f.onRead(() => { if (++reads === 2) f.revoke(); });
  const command = {action:'apply', operation, change_id:randomUUID(), expected_digest:inspected.expected_digest, fields:{name:'Fixture'}};
  const value = await f.invoke(command);
  assert.equal(value.isError, true); assert.equal(value.structuredContent.outcome, 'UNKNOWN'); assert.equal(f.count(), 1);
  assert.equal((await f.invoke({action:'receipt', change_id:command.change_id})).isError, true); assert.equal(f.count(), 1);
});
