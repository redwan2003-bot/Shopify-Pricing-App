-- AlterTable
ALTER TABLE "Store" ADD COLUMN "shopCurrency" TEXT;

-- CreateTable
CREATE TABLE "CatalogProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "vendor" TEXT,
    "productType" TEXT,
    "tags" TEXT NOT NULL DEFAULT '',
    "variantCount" INTEGER NOT NULL DEFAULT 0,
    "hasAnySku" BOOLEAN NOT NULL DEFAULT false,
    "shopifyUpdatedAt" DATETIME,
    "assignedProfileId" TEXT,
    "assignmentSource" TEXT,
    "policySyncedAt" DATETIME,
    "coverageStatus" TEXT NOT NULL DEFAULT 'unassigned',
    "enforcementReady" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenSyncId" TEXT,
    "removedFromShopifyAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CatalogProduct_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CatalogProduct_assignedProfileId_fkey" FOREIGN KEY ("assignedProfileId") REFERENCES "PricingProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CatalogSyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "idempotencyKey" TEXT NOT NULL,
    "bulkOperationId" TEXT,
    "resumeByteOffset" INTEGER NOT NULL DEFAULT 0,
    "resumeLastObjectId" TEXT,
    "objectsSeen" INTEGER NOT NULL DEFAULT 0,
    "productsUpserted" INTEGER NOT NULL DEFAULT 0,
    "productsRemoved" INTEGER NOT NULL DEFAULT 0,
    "variantsSeen" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CatalogSyncJob_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BulkAssignmentJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL DEFAULT 'assign',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "idempotencyKey" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdByEmail" TEXT,
    "pricingProfileId" TEXT,
    "profileRevision" INTEGER,
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

-- CreateTable
CREATE TABLE "BulkAssignmentItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "catalogProductId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "claimedBy" TEXT,
    "claimedAt" DATETIME,
    "nextAttemptAt" DATETIME,
    "prevOverrideExisted" BOOLEAN NOT NULL DEFAULT false,
    "prevOverrideProfileId" TEXT,
    "prevOverrideBaseCents" INTEGER,
    "prevOverrideActive" BOOLEAN,
    "prevPolicyJson" TEXT,
    "newProfileId" TEXT NOT NULL,
    "newPolicyJson" TEXT NOT NULL,
    "overrideWritten" BOOLEAN NOT NULL DEFAULT false,
    "policyWritten" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BulkAssignmentItem_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BulkAssignmentItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BulkAssignmentJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BulkAssignmentItem_catalogProductId_fkey" FOREIGN KEY ("catalogProductId") REFERENCES "CatalogProduct" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BulkAssignmentAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '{}',
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BulkAssignmentAudit_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BulkAssignmentAudit_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BulkAssignmentJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookEvent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PricingProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "basePriceCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PricingProfile_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PricingProfile" ("basePriceCents", "createdAt", "currency", "description", "id", "isActive", "isDefault", "name", "sku", "storeId", "updatedAt") SELECT "basePriceCents", "createdAt", "currency", "description", "id", "isActive", "isDefault", "name", "sku", "storeId", "updatedAt" FROM "PricingProfile";
DROP TABLE "PricingProfile";
ALTER TABLE "new_PricingProfile" RENAME TO "PricingProfile";
CREATE INDEX "PricingProfile_storeId_idx" ON "PricingProfile"("storeId");
CREATE UNIQUE INDEX "PricingProfile_storeId_name_key" ON "PricingProfile"("storeId", "name");
CREATE UNIQUE INDEX "PricingProfile_storeId_sku_key" ON "PricingProfile"("storeId", "sku");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CatalogProduct_storeId_idx" ON "CatalogProduct"("storeId");

-- CreateIndex
CREATE INDEX "CatalogProduct_storeId_coverageStatus_idx" ON "CatalogProduct"("storeId", "coverageStatus");

-- CreateIndex
CREATE INDEX "CatalogProduct_storeId_assignedProfileId_idx" ON "CatalogProduct"("storeId", "assignedProfileId");

-- CreateIndex
CREATE INDEX "CatalogProduct_storeId_status_idx" ON "CatalogProduct"("storeId", "status");

-- CreateIndex
CREATE INDEX "CatalogProduct_storeId_vendor_idx" ON "CatalogProduct"("storeId", "vendor");

-- CreateIndex
CREATE INDEX "CatalogProduct_storeId_productType_idx" ON "CatalogProduct"("storeId", "productType");

-- CreateIndex
CREATE INDEX "CatalogProduct_assignedProfileId_idx" ON "CatalogProduct"("assignedProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogProduct_storeId_shopifyProductId_key" ON "CatalogProduct"("storeId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "CatalogSyncJob_storeId_idx" ON "CatalogSyncJob"("storeId");

-- CreateIndex
CREATE INDEX "CatalogSyncJob_storeId_status_idx" ON "CatalogSyncJob"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogSyncJob_storeId_idempotencyKey_key" ON "CatalogSyncJob"("storeId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "BulkAssignmentJob_storeId_idx" ON "BulkAssignmentJob"("storeId");

-- CreateIndex
CREATE INDEX "BulkAssignmentJob_storeId_status_idx" ON "BulkAssignmentJob"("storeId", "status");

-- CreateIndex
CREATE INDEX "BulkAssignmentJob_storeId_jobType_idx" ON "BulkAssignmentJob"("storeId", "jobType");

-- CreateIndex
CREATE UNIQUE INDEX "BulkAssignmentJob_storeId_idempotencyKey_key" ON "BulkAssignmentJob"("storeId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "BulkAssignmentItem_storeId_idx" ON "BulkAssignmentItem"("storeId");

-- CreateIndex
CREATE INDEX "BulkAssignmentItem_jobId_status_idx" ON "BulkAssignmentItem"("jobId", "status");

-- CreateIndex
CREATE INDEX "BulkAssignmentItem_jobId_status_nextAttemptAt_idx" ON "BulkAssignmentItem"("jobId", "status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "BulkAssignmentItem_jobId_shopifyProductId_key" ON "BulkAssignmentItem"("jobId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "BulkAssignmentAudit_storeId_idx" ON "BulkAssignmentAudit"("storeId");

-- CreateIndex
CREATE INDEX "BulkAssignmentAudit_jobId_idx" ON "BulkAssignmentAudit"("jobId");

-- CreateIndex
CREATE INDEX "WebhookEvent_storeId_idx" ON "WebhookEvent"("storeId");

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_idx" ON "WebhookEvent"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_storeId_webhookId_key" ON "WebhookEvent"("storeId", "webhookId");
