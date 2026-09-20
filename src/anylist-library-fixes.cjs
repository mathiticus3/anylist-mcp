'use strict';
// Repair the pinned library's already advertised removeCategory operation.
// Official web client (2026-09-20): remove-category-ids is a category-group
// operation carrying ONLY the selected categories in updatedCategoryGroup.
// remove-category belongs to user-level categories and is a no-op here.
const List = require('../anylist-js/lib/list');
const originalPost = List.prototype._postCategoryOps;
List.prototype._postCategoryOps = async function(operations) {
  for (const op of operations) {
    if (op.metadata?.handlerId !== 'remove-category') continue;
    const found = this.findCategory(op.originalValue);
    if (!found) throw new Error('Category removal target no longer exists');
    op.metadata.handlerId = 'remove-category-ids';
    op.metadata.operationClass = 4;
    op.setUpdatedCategoryGroup(new this.protobuf.PBListCategoryGroup({
      ...found.group, listId:this.identifier,
      categories:[new this.protobuf.PBListCategory({...found.category,categoryGroupId:found.group.identifier,listId:this.identifier})],
    }));
  }
  return originalPost.call(this, operations);
};
