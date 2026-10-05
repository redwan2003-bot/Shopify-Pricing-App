CREATE TABLE "OrderWorkflow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "currency" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrderWorkflow_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "OrderConfiguration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflowId" TEXT NOT NULL,
    "shopifyLineItemId" TEXT NOT NULL,
    "shopifyProductId" TEXT,
    "shopifyVariantId" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "configuration" TEXT,
    "pricingPayload" TEXT,
    "pricingSignature" TEXT,
    "pricingVersion" INTEGER,
    "configDigest" TEXT,
    "quoteEnvelopePresent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrderConfiguration_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "OrderWorkflow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OrderWorkflow_storeId_shopifyOrderId_key" ON "OrderWorkflow"("storeId", "shopifyOrderId");
CREATE INDEX "OrderWorkflow_storeId_status_createdAt_idx" ON "OrderWorkflow"("storeId", "status", "createdAt");
CREATE UNIQUE INDEX "OrderConfiguration_workflowId_shopifyLineItemId_key" ON "OrderConfiguration"("workflowId", "shopifyLineItemId");
CREATE INDEX "OrderConfiguration_shopifyProductId_idx" ON "OrderConfiguration"("shopifyProductId");

ALTER TABLE "OrderWorkflow" ADD COLUMN "poNumber" TEXT;
ALTER TABLE "OrderWorkflow" ADD COLUMN "eventDate" DATETIME;
ALTER TABLE "OrderWorkflow" ADD COLUMN "inHandsDate" DATETIME;
ALTER TABLE "OrderWorkflow" ADD COLUMN "shipToAddress" TEXT;
ALTER TABLE "OrderWorkflow" ADD COLUMN "imprintInstructions" TEXT;
ALTER TABLE "OrderWorkflow" ADD COLUMN "associationNumbers" TEXT;
ALTER TABLE "OrderWorkflow" ADD COLUMN "notes" TEXT;

CREATE TABLE "OrderArtwork" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflowId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksum" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    "reviewNote" TEXT,
    CONSTRAINT "OrderArtwork_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "OrderWorkflow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OrderArtwork_workflowId_status_idx" ON "OrderArtwork"("workflowId", "status");

CREATE TABLE "OrderProof" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "requestedChanges" TEXT,
    "tokenHash" TEXT,
    "tokenExpiresAt" DATETIME,
    "approvedAt" DATETIME,
    "approvedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderProof_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "OrderWorkflow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OrderProof_workflowId_version_key" ON "OrderProof"("workflowId", "version");
CREATE INDEX "OrderProof_workflowId_status_idx" ON "OrderProof"("workflowId", "status");

CREATE TABLE "OrderWorkflowEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflowId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderWorkflowEvent_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "OrderWorkflow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OrderWorkflowEvent_workflowId_createdAt_idx" ON "OrderWorkflowEvent"("workflowId", "createdAt");
