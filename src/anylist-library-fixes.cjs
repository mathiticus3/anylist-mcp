'use strict';
// Repair an existing pinned-library operation, without adding API endpoints or handlers.
// removeCategory used originalValue (a string) instead of the typed originalCategory
// consumed by its already implemented remove-category operation.
const List = require('../anylist-js/lib/list');
const originalPost = List.prototype._postCategoryOps;
List.prototype._postCategoryOps = async function(operations) {
  for (const op of operations) {
    if (op.metadata?.handlerId !== 'remove-category') continue;
    const found = this.findCategory(op.originalValue);
    if (!found) throw new Error('Category removal target no longer exists');
    op.setOriginalCategory(new this.protobuf.PBListCategory({
      ...found.category, categoryGroupId:found.group.identifier, listId:this.identifier,
    }));
  }
  return originalPost.call(this, operations);
};
