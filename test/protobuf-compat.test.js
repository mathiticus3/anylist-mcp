import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import AnyList from '../src/anylist-legacy-client.cjs';

const require = createRequire(import.meta.url);

const LEGACY_FIXTURES = {
  listItem: 'CgZpdGVtLTEaBmxpc3QtMSIETWlsazAAogEJCgFhEgFnGgFjqgEDCgEyiAED',
  listOps: 'ClsKJwoEb3AtMRIfc2V0LWxpc3QtaXRlbS1jYXRlZ29yeS1tYXRjaC1pZBIGbGlzdC0xGgZpdGVtLTEiBnVyZ2VudDIYCgZpdGVtLTEaBmxpc3QtMSIETWlsazAA',
  recipe: 'CghyZWNpcGUtMRoEU291cEIpMgxpbmdyZWRpZW50LTEKCzEgY3VwIHdhdGVyEgV3YXRlchoFMSBjdXBKBUJvaWwueAA=',
  calendar: 'CkIKGgoEb3AtMhISYWRkLWNhbGVuZGFyLWV2ZW50EgVjYWwtMRodCgdldmVudC0xKgZEaW5uZXIiCjIwMjYtMDgtMTI=',
};

function protobuf() {
  return new AnyList({ email: 'test@example.invalid', password: 'not-used' }).protobuf;
}

describe('protobufjs v5 compatibility adapter', () => {
  it('decodes shopping data emitted by the previous protobufjs 5 runtime', () => {
    const pb = protobuf();
    const item = pb.ListItem.decode(Buffer.from(LEGACY_FIXTURES.listItem, 'base64'));

    assert.equal(item.identifier, 'item-1');
    assert.equal(item.listId, 'list-1');
    assert.equal(item.name, 'Milk');
    assert.equal(item.checked, false);
    assert.equal(item.manualSortIndex, 3);
    assert.equal(item.quantityPb.amount, '2');
    assert.deepEqual(
      item.categoryAssignments.map(({ identifier, categoryGroupId, categoryId }) => ({
        identifier,
        categoryGroupId,
        categoryId,
      })),
      [{ identifier: 'a', categoryGroupId: 'g', categoryId: 'c' }]
    );
  });

  it('decodes legacy list, recipe, and calendar operations', () => {
    const pb = protobuf();
    const listOps = pb.PBListOperationList.decode(Buffer.from(LEGACY_FIXTURES.listOps, 'base64'));
    const recipe = pb.PBRecipe.decode(Buffer.from(LEGACY_FIXTURES.recipe, 'base64'));
    const calendar = pb.PBCalendarOperationList.decode(Buffer.from(LEGACY_FIXTURES.calendar, 'base64'));

    assert.equal(listOps.operations[0].metadata.handlerId, 'set-list-item-category-match-id');
    assert.equal(listOps.operations[0].listItem.checked, false);
    assert.equal(recipe.identifier, 'recipe-1');
    assert.equal(recipe.ingredients[0].rawIngredient, '1 cup water');
    assert.equal(recipe.rating, 0);
    assert.equal(calendar.operations[0].updatedEvent.date, '2026-08-12');
  });

  it('retains constructors, static decode, and instance toBuffer', () => {
    const pb = protobuf();
    const message = new pb.PBListOperationList({
      operations: [{
        metadata: { operationId: 'op-3', handlerId: 'add-list-item' },
        listId: 'list-1',
        listItem: { identifier: 'item-2', listId: 'list-1', name: 'Bread', checked: false },
      }],
    });

    const encoded = message.toBuffer();
    const decoded = pb.PBListOperationList.decode(encoded);

    assert.ok(Buffer.isBuffer(encoded));
    assert.equal(decoded.operations[0].metadata.operationId, 'op-3');
    assert.equal(decoded.operations[0].listItem.name, 'Bread');
    assert.equal(decoded.operations[0].listItem.checked, false);
  });

  it('keeps enum namespaces compatible with the vendored client', () => {
    const pb = protobuf();
    assert.equal(pb.PBCalendarEventType.MealPlanCalendarEvent, 0);
    assert.equal(pb.PBOperationMetadata.OperationClass.StoreOperation, 1);
  });

  it('rejects any schema other than the fixed bundled definition', () => {
    const protobufjs = require('protobufjs');
    assert.throws(
      () => protobufjs.newBuilder().import({ package: 'attacker.schema', messages: [], enums: [] }),
      /Only the bundled AnyList protobuf schema is allowed/
    );
  });
});
