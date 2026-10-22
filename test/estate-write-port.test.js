import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import AnyList from '../src/anylist-legacy-client.cjs';
import { WritePort } from '../src/profiles/estate-write-port.js';
import { OPERATIONS } from '../src/profiles/estate-write-policy.js';
const listId = 'a'.repeat(32), itemId = 'b'.repeat(32), calendarId = 'c'.repeat(32), labelId = 'd'.repeat(32);
const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Denver',year: 'numeric',month: '2-digit',day: '2-digit'}).format(new Date());
function fixture(kind) {
  const raw = new AnyList({email: 'synthetic@example.invalid', password: 'synthetic', credentialsFile: null});
  raw.uid = 'synthetic-user'; raw._refreshTokens = async () => {};
  const initial = { identifier: itemId, name: 'Fixture', quantity: '1', details: '', checked: false };
  const data = { shoppingListsResponse: { newLists: [{ identifier: listId, name: 'Synthetic list', items: [initial] }] },
    mealPlanningCalendarResponse: { calendarId, events: [{ identifier: itemId, date: today, title: 'Fixture', details: '', labelId }], labels: [{identifier: labelId}] } };
  raw._getUserData = async () => structuredClone(data);
  let posts = [];
  raw.client = { post: async (endpoint, {body}) => {
    const buffer = body.getBuffer(), start = buffer.indexOf('\r\n\r\n') + 4;
    const end = buffer.lastIndexOf('\r\n--' + body.getBoundary());
    const payload = kind === 'shopping' ? raw.protobuf.PBListOperationList.decode(buffer.subarray(start,end))
      : raw.protobuf.PBCalendarOperationList.decode(buffer.subarray(start,end));
    posts.push({endpoint, operations: payload.operations});
  } };
  const client = {_oneShotWrites: true, ensureAuthenticated: async () => {}, client: raw};
  const policy = { kind, upstreamUserId: 'synthetic-user', clientId: randomUUID(), userId: randomUUID(), listId, operations: OPERATIONS[kind],
    timeZone: 'America/Denver', maxPastDays: 7, maxFutureDays: 93, labelIds: [labelId] };
  return { port: new WritePort(client), policy, data, posts, client };
}
for (const operation of OPERATIONS.shopping) test(`native shopping wire ${operation} is exact and has one POST`, async () => {
  const f = fixture('shopping');
  const fields = operation === 'shopping.add' ? {name: 'New fixture', quantity: 2, note: 'Fixture note'}
    : operation === 'shopping.update' ? {name: 'Updated fixture', quantity: 3, note: 'Changed'} : {};
  const command = f.port.validate({action: 'apply', operation, fields,
    ...(operation === 'shopping.add' ? {} : {record_id: itemId})}, f.policy);
  const evidence = await f.port.prepare(f.policy, command);
  await f.port.dispatch(f.policy, command, evidence);
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].endpoint, 'data/shopping-lists/update');
  for (const op of f.posts[0].operations) {
    assert.equal(op.listId, listId); assert.equal(op.listItemId, evidence.record_id);
    assert.ok(['add-shopping-list-item','remove-shopping-list-item','set-list-item-name','set-list-item-quantity','set-list-item-details','set-list-item-checked'].includes(op.metadata.handlerId));
  }
});
for (const operation of OPERATIONS.meal) test(`native meal wire ${operation} preserves exact event/date/label and one POST`, async () => {
  const f = fixture('meal'), fields = operation === 'meal.create' ? {date: today, title: 'New fixture', label_id: labelId}
    : operation === 'meal.update' ? {title: 'Changed fixture'} : {};
  const command = f.port.validate({action: 'apply', operation, fields,
    ...(operation === 'meal.create' ? {} : {record_id: itemId})}, f.policy);
  const evidence = await f.port.prepare(f.policy, command); await f.port.dispatch(f.policy, command, evidence);
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].endpoint, 'data/meal-planning-calendar/update');
  const op = f.posts[0].operations[0]; assert.equal(op.calendarId, calendarId);
  assert.equal(op.updatedEvent.identifier, evidence.record_id); assert.equal(op.updatedEvent.date, today);
  assert.equal(op.updatedEvent.labelId, labelId);
  assert.equal(op.metadata.handlerId, operation === 'meal.create' ? 'new-event' : operation === 'meal.delete' ? 'delete-event' : 'set-event-details');
});
test('scope, date, label, identity and malformed snapshots refuse before native POST', async () => {
  const f = fixture('meal');
  for (const fields of [{date: '2026-02-30',title: 'Fixture'}, {date: '2000-01-01',title: 'Fixture'},
    {date: today,title: 'Fixture',label_id: 'e'.repeat(32)}, {date: today,title: 'Fixture',recipe_id: 'e'.repeat(32)}]) {
    await assert.rejects(async () => { const value=f.port.validate({action: 'apply',operation: 'meal.create',fields},f.policy); await f.port.prepare(f.policy,value); });
  }
  f.data.mealPlanningCalendarResponse.events[0].identifier = undefined;
  await assert.rejects(f.port.inspect(f.policy,{operation:'meal.update',record_id:itemId}));
  assert.equal(f.posts.length,0);
});
test('raw missing shopping IDs cannot be invented by native constructors; active collisions are refused', async () => {
  const f=fixture('shopping');
  await assert.rejects(async () => f.port.prepare(f.policy,f.port.validate({action:'apply',operation:'shopping.add',fields:{name:'  Fixture'}},f.policy)));
  await assert.rejects(f.port.prepare(f.policy,f.port.validate({action:'apply',operation:'shopping.add',fields:{name:'FIXTURE'}},f.policy)));
  f.data.shoppingListsResponse.newLists[0].items[0].identifier = undefined;
  await assert.rejects(f.port.inspect(f.policy,{operation:'shopping.check',record_id:itemId})); assert.equal(f.posts.length,0);
});

test('shopping writes cannot inherit a different item list ID from a malformed source snapshot', async () => {
  const f = fixture('shopping');
  f.data.shoppingListsResponse.newLists[0].items[0].listId = 'e'.repeat(32);
  await assert.rejects(f.port.prepare(f.policy, f.port.validate({action:'apply',operation:'shopping.check',record_id:itemId,fields:{}},f.policy)));
  assert.equal(f.posts.length,0);
});

test('writer pins the actual upstream account and existing meal labels before effects', async () => {
  const f=fixture('meal');
  f.policy.upstreamUserId='different-account';
  await assert.rejects(f.port.inspect(f.policy,{operation:'meal.update',record_id:itemId}));
  f.policy.upstreamUserId='synthetic-user'; f.policy.labelIds=[];
  await assert.rejects(f.port.prepare(f.policy,f.port.validate({action:'apply',operation:'meal.update',record_id:itemId,fields:{title:'No'}},f.policy)));
  assert.equal(f.posts.length,0);
});

test('account identity is rechecked after authentication refresh before reading source data', async () => {
  const f=fixture('shopping');
  f.client.client._refreshTokens=async()=>{f.client.client.uid='different-source-account';};
  f.client.client._getUserData=async()=>{throw Error('source read must not occur');};
  await assert.rejects(f.port.inspect(f.policy,{operation:'shopping.add'}), error=>error.code==='SOURCE_IDENTITY_CHANGED');
  assert.equal(f.posts.length,0);
});

test('title-only meal update preserves native ordering and detects readback ordering loss', async () => {
  const f=fixture('meal'), original=f.data.mealPlanningCalendarResponse.events[0];
  original.labelSortIndex=29; original.orderAddedSortIndex=8;
  const command=f.port.validate({action:'apply',operation:'meal.update',record_id:itemId,fields:{title:'New title'}},f.policy);
  const evidence=await f.port.prepare(f.policy,command); await f.port.dispatch(f.policy,command,evidence);
  assert.equal(f.posts[0].operations[0].updatedEvent.labelSortIndex,29);
  assert.equal(f.posts[0].operations[0].updatedEvent.orderAddedSortIndex,8);
  original.title='New title';
  assert.deepEqual(await f.port.observe(f.policy,command,evidence),evidence.after);
  delete original.labelSortIndex;
  assert.notDeepEqual(await f.port.observe(f.policy,command,evidence),evidence.after);
});
