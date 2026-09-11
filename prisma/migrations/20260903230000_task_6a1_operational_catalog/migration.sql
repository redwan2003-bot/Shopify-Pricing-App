-- Task 6A.1 — operational bulk catalog admin.
--
--   * CatalogVariant: exact, store-scoped variant/SKU catalog (replaces the hasAnySku
--     approximation as a search boundary).
--   * PricingProfile.contentDigest: deterministic digest of the full pricing-output
--     projection, so a child-table edit cannot slip past `revision`.
--   * CatalogProduct.policyDigest: last-observed Shopify compareDigest of the app-owned
--     pricing_policy metafield (feeds the strong catalog fingerprint).
--   * BulkAssignmentItem.prevPolicyPresent / prevPolicyDigest / prevPolicyMetafieldId /
--     postPolicyDigest: compare-and-set state for assignment and rollback.
--   * BulkAssignmentItem.leaseExpiresAt, BulkAssignmentJob.leaseExpiresAt,
--     CatalogSyncJob.leaseToken/leaseExpiresAt: expiring worker leases.
--   * CatalogSyncJob.bulkOperationStatus/bulkOperationObjects/resultUrl and the
--     [storeId, activeSentinel] unique index: exact bulk-operation ownership and at most
--     one active app-owned catalog synchronization per shop.
--   * BulkAssignmentJob.createdByEmail REMOVED (data minimization — staff email is not
--     needed for an internal pricing job; the opaque staff user id is retained).
--   * BulkAssignmentJob.profileDigest: pricing-content digest captured at dry-run time.

-- AlterTable
ALTER TABLE "BulkAssignmentItem" ADD COLUMN "leaseExpiresAt" DATETIME;
ALTER TABLE "BulkAssignmentItem" ADD COLUMN "postPolicyDigest" TEXT;
ALTER TABLE "BulkAssignmentItem" ADD COLUMN "prevPolicyDigest" TEXT;
ALTER TABLE "BulkAssignmentItem" ADD COLUMN "prevPolicyMetafieldId" TEXT;
ALTER TABLE "BulkAssignmentItem" ADD COLUMN "prevPolicyPresent" BOOLEAN;

-- AlterTable
ALTER TABLE "CatalogProduct" ADD COLUMN "policyDigest" TEXT;

-- AlterTable
ALTER TABLE "PricingProfile" ADD COLUMN "contentDigest" TEXT;

-- CreateTable
CREATE TABLE "CatalogVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "catalogProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "sku" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "shopifyUpdatedAt" DATETIME,
    "lastSeenSyncId" TEXT,
    "removedFromShopifyAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CatalogVariant_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CatalogVariant_catalogProductId_fkey" FOREIGN KEY ("catalogProductId") REFERENCES "CatalogProduct" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BulkAssignmentJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL DEFAULT 'assign',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "idempotencyKey" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "pricingProfileId" TEXT,
    "profileRevision" INTEGER,
    "profileDigest" TEXT,
    "profileCurrency" TEXT,
    "replaceExisting" BOOLEAN NOT NULL DEFAULT false,
    "selectionKind" TEXT NOT NULL,
    "selectionDescriptor" TEXT NOT NULL,
    "catalogFingerprint" TEXT,
    "dryRunFingerprint" TEXT,
    "dryRunIssuedAt" DATETIME,
    "dryRunExpiresAt" DATETIME,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "workerToken" TEXT,
    "workerClaimedAt" DATETIME,
    "leaseExpiresAt" DATETIME,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "rollbackOfJobId" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BulkAssignmentJob_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BulkAssignmentJob_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_BulkAssignmentJob" ("catalogFingerprint", "createdAt", "createdByUserId", "dryRunExpiresAt", "dryRunFingerprint", "dryRunIssuedAt", "errorCode", "errorMessage", "failed", "finishedAt", "id", "idempotencyKey", "jobType", "pricingProfileId", "profileCurrency", "profileRevision", "replaceExisting", "rollbackOfJobId", "selectionDescriptor", "selectionKind", "skipped", "startedAt", "status", "storeId", "succeeded", "totalItems", "unchanged", "updatedAt", "workerClaimedAt", "workerToken") SELECT "catalogFingerprint", "createdAt", "createdByUserId", "dryRunExpiresAt", "dryRunFingerprint", "dryRunIssuedAt", "errorCode", "errorMessage", "failed", "finishedAt", "id", "idempotencyKey", "jobType", "pricingProfileId", "profileCurrency", "profileRevision", "replaceExisting", "rollbackOfJobId", "selectionDescriptor", "selectionKind", "skipped", "startedAt", "status", "storeId", "succeeded", "totalItems", "unchanged", "updatedAt", "workerClaimedAt", "workerToken" FROM "BulkAssignmentJob";
DROP TABLE "BulkAssignmentJob";
ALTER TABLE "new_BulkAssignmentJob" RENAME TO "BulkAssignmentJob";
CREATE INDEX "BulkAssignmentJob_storeId_idx" ON "BulkAssignmentJob"("storeId");
CREATE INDEX "BulkAssignmentJob_storeId_status_idx" ON "BulkAssignmentJob"("storeId", "status");
CREATE INDEX "BulkAssignmentJob_storeId_jobType_idx" ON "BulkAssignmentJob"("storeId", "jobType");
CREATE UNIQUE INDEX "BulkAssignmentJob_storeId_idempotencyKey_key" ON "BulkAssignmentJob"("storeId", "idempotencyKey");
CREATE TABLE "new_CatalogSyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "idempotencyKey" TEXT NOT NULL,
    "bulkOperationId" TEXT,
    "bulkOperationStatus" TEXT,
    "bulkOperationObjects" INTEGER NOT NULL DEFAULT 0,
    "resultUrl" TEXT,
    "resumeByteOffset" INTEGER NOT NULL DEFAULT 0,
    "resumeLastObjectId" TEXT,
    "objectsSeen" INTEGER NOT NULL DEFAULT 0,
    "productsUpserted" INTEGER NOT NULL DEFAULT 0,
    "productsRemoved" INTEGER NOT NULL DEFAULT 0,
    "variantsSeen" INTEGER NOT NULL DEFAULT 0,
    "variantsUpserted" INTEGER NOT NULL DEFAULT 0,
    "variantsRemoved" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseExpiresAt" DATETIME,
    "activeSentinel" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CatalogSyncJob_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_CatalogSyncJob" ("bulkOperationId", "createdAt", "errorCode", "errorMessage", "finishedAt", "id", "idempotencyKey", "objectsSeen", "productsRemoved", "productsUpserted", "resumeByteOffset", "resumeLastObjectId", "startedAt", "status", "storeId", "updatedAt", "variantsSeen") SELECT "bulkOperationId", "createdAt", "errorCode", "errorMessage", "finishedAt", "id", "idempotencyKey", "objectsSeen", "productsRemoved", "productsUpserted", "resumeByteOffset", "resumeLastObjectId", "startedAt", "status", "storeId", "updatedAt", "variantsSeen" FROM "CatalogSyncJob";
DROP TABLE "CatalogSyncJob";
ALTER TABLE "new_CatalogSyncJob" RENAME TO "CatalogSyncJob";
CREATE INDEX "CatalogSyncJob_storeId_idx" ON "CatalogSyncJob"("storeId");
CREATE INDEX "CatalogSyncJob_storeId_status_idx" ON "CatalogSyncJob"("storeId", "status");
CREATE INDEX "CatalogSyncJob_bulkOperationId_idx" ON "CatalogSyncJob"("bulkOperationId");
CREATE UNIQUE INDEX "CatalogSyncJob_storeId_idempotencyKey_key" ON "CatalogSyncJob"("storeId", "idempotencyKey");
CREATE UNIQUE INDEX "CatalogSyncJob_storeId_activeSentinel_key" ON "CatalogSyncJob"("storeId", "activeSentinel");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CatalogVariant_storeId_idx" ON "CatalogVariant"("storeId");

-- CreateIndex
CREATE INDEX "CatalogVariant_storeId_sku_idx" ON "CatalogVariant"("storeId", "sku");

-- CreateIndex
CREATE INDEX "CatalogVariant_catalogProductId_idx" ON "CatalogVariant"("catalogProductId");

-- CreateIndex
CREATE INDEX "CatalogVariant_storeId_shopifyProductId_idx" ON "CatalogVariant"("storeId", "shopifyProductId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogVariant_storeId_shopifyVariantId_key" ON "CatalogVariant"("storeId", "shopifyVariantId");

