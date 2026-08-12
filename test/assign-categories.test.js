// Regression tests for _assignItemCategories: the ops it posts must be the
// official clients' categorize ops. `update-list-item` is not a real backend
// handler — it accepts but silently drops ListItem.categoryAssignments
// (v1.7.0 bug: assignments never persisted).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import AnyListClient from '../src/anylist-client.js';
import AnyList from '../src/anylist-legacy-client.cjs';

const require = createRequire(import.meta.url);
const Item = require('../anylist-js/lib/item.js');

// AnyList derives an item's per-set assignment id as
// uuid5(categoryGroupId, 08e5c5bd…) — verified against an app-written
// assignment on a real list.
const GROUP_A = '1063c8a695c05ace9c5f4be28830f6c2';
const GROUP_A_ASSIGNMENT_ID = '792ec7feef6f5daea1376f9b7b83a33c';
const GROUP_B = '792195b70dfe41f9b23f7ca361076612';

const pb = new AnyList({ email: 'x', password: 'x' }).protobuf;

function makeHarness({ existingAssignments = [] } = {}) {
  const posts = [];
  const fakeHttp = {
    post: async (endpoint, { body }) => {
      posts.push({ endpoint, ops: pb.PBListOperationList.decode(readFormBuffer(body)).operations });
    },
  };
  const item = new Item(
    { listId: 'list-1', identifier: 'item-1', name: 'widget', categoryAssignments: existingAssignments },
    { client: fakeHttp, protobuf: pb, uid: 'uid-1' }
  );
  const groups = [
    {
      identifier: GROUP_A, name: 'Category Set',
      categories: [{ identifier: 'cat-urgent', name: 'Urgent', systemCategory: null }],
    },
    {
      identifier: GROUP_B, name: 'Punchlist Areas',
      categories: [{ identifier: 'cat-garage', name: 'Garage', systemCategory: null }],
    },
  ];
  const client = new AnyListClient({ username: 'x', password: 'x' });
  client.targetList = { name: 'Test', categoryGroups: groups };
  return { client, item, groups, posts };
}

// form-data buffers the appended value; recover the protobuf bytes between the
// multipart headers and the trailing boundary.
function readFormBuffer(form) {
  const whole = Buffer.concat(form._streams.map(s => (Buffer.isBuffer(s) ? s : typeof s === 'string' ? Buffer.from(s) : Buffer.alloc(0))));
  const start = whole.indexOf(Buffer.from('\r\n\r\n')) + 4;
  return whole.subarray(start);
}

describe('_assignItemCategories', () => {
  it('posts one update-list-item-category-assignment op per set plus a match-id op', async () => {
    const { client, item, groups, posts } = makeHarness();
    await client._assignItemCategories(item, [
      { group: groups[0], category: groups[0].categories[0] },
      { group: groups[1], category: groups[1].categories[0] },
    ]);

    assert.equal(posts.length, 1);
    assert.equal(posts[0].endpoint, 'data/shopping-lists/update');
    const handlers = posts[0].ops.map(o => o.metadata.handlerId);
    assert.deepEqual(handlers, [
      'update-list-item-category-assignment',
      'update-list-item-category-assignment',
      'set-list-item-category-match-id',
    ]);
    for (const op of posts[0].ops) {
      assert.equal(op.listId, 'list-1');
      assert.equal(op.listItemId, 'item-1');
      assert.ok(op.listItem, 'ops must carry the full item payload');
    }
  });

  it('derives the assignment identifier as uuid5(groupId, AnyList namespace)', async () => {
    const { client, item, groups } = makeHarness();
    await client._assignItemCategories(item, [{ group: groups[0], category: groups[0].categories[0] }]);
    const a = item.categoryAssignments.find(x => x.categoryGroupId === GROUP_A);
    assert.equal(a.identifier, GROUP_A_ASSIGNMENT_ID);
    assert.equal(a.categoryId, 'cat-urgent');
  });

  it('replaces only the reassigned set and keeps other sets', async () => {
    const { client, item, groups } = makeHarness({
      existingAssignments: [
        { identifier: 'keep-me', categoryGroupId: GROUP_B, categoryId: 'cat-garage' },
        { identifier: GROUP_A_ASSIGNMENT_ID, categoryGroupId: GROUP_A, categoryId: 'cat-old' },
      ],
    });
    await client._assignItemCategories(item, [{ group: groups[0], category: groups[0].categories[0] }]);
    assert.deepEqual(
      item.categoryAssignments.map(a => [a.categoryGroupId, a.categoryId]).sort(),
      [[GROUP_A, 'cat-urgent'], [GROUP_B, 'cat-garage']].sort()
    );
    assert.equal(item.categoryAssignments.length, 2);
  });

  it('never uses the fake update-list-item handler', async () => {
    const { client, item, groups, posts } = makeHarness();
    await client._assignItemCategories(item, [{ group: groups[0], category: groups[0].categories[0] }]);
    assert.ok(posts[0].ops.every(o => o.metadata.handlerId !== 'update-list-item'));
  });

  it('sets categoryMatchId from the primary-set category and stock category to other', async () => {
    const { client, item, groups } = makeHarness();
    await client._assignItemCategories(item, [{ group: groups[0], category: groups[0].categories[0] }]);
    assert.equal(item.categoryMatchId, 'urgent');
    assert.equal(item._category, 'other');
  });
});
