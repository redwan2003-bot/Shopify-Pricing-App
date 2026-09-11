-- Task 6A follow-up: index the `catalogProductId` back-reference on BulkAssignmentItem.
-- The `catalogProduct` relation is `onDelete: SetNull`; without this index every
-- CatalogProduct deletion scans the whole BulkAssignmentItem table to null the FK,
-- which is quadratic on a large store teardown / uninstall cascade.
CREATE INDEX "BulkAssignmentItem_catalogProductId_idx" ON "BulkAssignmentItem"("catalogProductId");
