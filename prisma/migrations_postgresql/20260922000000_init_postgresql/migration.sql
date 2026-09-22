-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DecorationMethod" AS ENUM ('SCREEN_PRINT', 'EMBROIDERY', 'DTF', 'DTG', 'VINYL', 'SUBLIMATION', 'WOVEN', 'OTHER');

-- CreateEnum
CREATE TYPE "DecorationChargeBasis" AS ENUM ('ONE_TIME', 'PER_UNIT');

-- CreateEnum
CREATE TYPE "OptionGroupKind" AS ENUM ('GENERIC', 'ATTACHMENT', 'FEATURE');

-- CreateEnum
CREATE TYPE "ProductionFeeType" AS ENUM ('FLAT', 'PERCENTAGE', 'PER_UNIT');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopCurrency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingProfile" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "basePriceCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "contentDigest" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuantityTier" (
    "id" TEXT NOT NULL,
    "pricingProfileId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL,
    "maxQuantity" INTEGER,
    "priceCode" TEXT,
    "listPriceCents" INTEGER NOT NULL,
    "netPriceCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuantityTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecorationRule" (
    "id" TEXT NOT NULL,
    "pricingProfileId" TEXT NOT NULL,
    "method" "DecorationMethod" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "chargeBasis" "DecorationChargeBasis" NOT NULL,
    "priceCode" TEXT,
    "listPriceCents" INTEGER NOT NULL,
    "netPriceCents" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DecorationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecorationColorCharge" (
    "id" TEXT NOT NULL,
    "pricingProfileId" TEXT NOT NULL,
    "method" "DecorationMethod" NOT NULL,
    "colorNumber" INTEGER NOT NULL,
    "chargeBasis" "DecorationChargeBasis" NOT NULL,
    "priceCode" TEXT,
    "listPriceCents" INTEGER NOT NULL,
    "netPriceCents" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DecorationColorCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionGroup" (
    "id" TEXT NOT NULL,
    "pricingProfileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "OptionGroupKind" NOT NULL DEFAULT 'GENERIC',
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "categoryPriceAdjustmentCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionValue" (
    "id" TEXT NOT NULL,
    "optionGroupId" TEXT NOT NULL,
    "code" TEXT,
    "label" TEXT NOT NULL,
    "priceCode" TEXT,
    "priceAdjustmentCents" INTEGER,
    "netPriceAdjustmentCents" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptionValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductColor" (
    "id" TEXT NOT NULL,
    "pricingProfileId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCode" TEXT,
    "priceAdjustmentCents" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductColor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionRule" (
    "id" TEXT NOT NULL,
    "pricingProfileId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isRush" BOOLEAN NOT NULL DEFAULT false,
    "minBusinessDays" INTEGER NOT NULL,
    "maxBusinessDays" INTEGER,
    "relatedSku" TEXT,
    "feeCents" INTEGER,
    "feeType" "ProductionFeeType" NOT NULL DEFAULT 'FLAT',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackagingRule" (
    "id" TEXT NOT NULL,
    "pricingProfileId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitsPerPackage" INTEGER,
    "cartonWeightLbs" DOUBLE PRECISION,
    "lengthIn" DOUBLE PRECISION,
    "widthIn" DOUBLE PRECISION,
    "heightIn" DOUBLE PRECISION,
    "feeCents" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackagingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPricingOverride" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "pricingProfileId" TEXT,
    "basePriceCents" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPricingOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogProduct" (
    "id" TEXT NOT NULL,
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
    "shopifyUpdatedAt" TIMESTAMP(3),
    "assignedProfileId" TEXT,
    "assignmentSource" TEXT,
    "policySyncedAt" TIMESTAMP(3),
    "policyDigest" TEXT,
    "coverageStatus" TEXT NOT NULL DEFAULT 'unassigned',
    "enforcementReady" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenSyncId" TEXT,
    "removedFromShopifyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogVariant" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "catalogProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "sku" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "shopifyUpdatedAt" TIMESTAMP(3),
    "lastSeenSyncId" TEXT,
    "removedFromShopifyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogSyncJob" (
    "id" TEXT NOT NULL,
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
    "leaseExpiresAt" TIMESTAMP(3),
    "activeSentinel" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogSyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkAssignmentJob" (
    "id" TEXT NOT NULL,
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
    "dryRunIssuedAt" TIMESTAMP(3),
    "dryRunExpiresAt" TIMESTAMP(3),
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "workerToken" TEXT,
    "workerClaimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "rollbackOfJobId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkAssignmentJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkAssignmentItem" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "catalogProductId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "prevOverrideExisted" BOOLEAN NOT NULL DEFAULT false,
    "prevOverrideProfileId" TEXT,
    "prevOverrideBaseCents" INTEGER,
    "prevOverrideActive" BOOLEAN,
    "prevPolicyJson" TEXT,
    "prevPolicyPresent" BOOLEAN,
    "prevPolicyDigest" TEXT,
    "prevPolicyMetafieldId" TEXT,
    "postPolicyDigest" TEXT,
    "newProfileId" TEXT NOT NULL,
    "newPolicyJson" TEXT NOT NULL,
    "overrideWritten" BOOLEAN NOT NULL DEFAULT false,
    "policyWritten" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkAssignmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkAssignmentAudit" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BulkAssignmentAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Store_shopDomain_key" ON "Store"("shopDomain");

-- CreateIndex
CREATE INDEX "PricingProfile_storeId_idx" ON "PricingProfile"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingProfile_storeId_name_key" ON "PricingProfile"("storeId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PricingProfile_storeId_sku_key" ON "PricingProfile"("storeId", "sku");

-- CreateIndex
CREATE INDEX "QuantityTier_pricingProfileId_idx" ON "QuantityTier"("pricingProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "QuantityTier_pricingProfileId_minQuantity_key" ON "QuantityTier"("pricingProfileId", "minQuantity");

-- CreateIndex
CREATE INDEX "DecorationRule_pricingProfileId_idx" ON "DecorationRule"("pricingProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "DecorationRule_pricingProfileId_code_key" ON "DecorationRule"("pricingProfileId", "code");

-- CreateIndex
CREATE INDEX "DecorationColorCharge_pricingProfileId_idx" ON "DecorationColorCharge"("pricingProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "DecorationColorCharge_pricingProfileId_method_colorNumber_c_key" ON "DecorationColorCharge"("pricingProfileId", "method", "colorNumber", "chargeBasis");

-- CreateIndex
CREATE INDEX "OptionGroup_pricingProfileId_idx" ON "OptionGroup"("pricingProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "OptionGroup_pricingProfileId_name_key" ON "OptionGroup"("pricingProfileId", "name");

-- CreateIndex
CREATE INDEX "OptionValue_optionGroupId_idx" ON "OptionValue"("optionGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "OptionValue_optionGroupId_label_key" ON "OptionValue"("optionGroupId", "label");

-- CreateIndex
CREATE INDEX "ProductColor_pricingProfileId_idx" ON "ProductColor"("pricingProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductColor_pricingProfileId_code_key" ON "ProductColor"("pricingProfileId", "code");

-- CreateIndex
CREATE INDEX "ProductionRule_pricingProfileId_idx" ON "ProductionRule"("pricingProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionRule_pricingProfileId_code_key" ON "ProductionRule"("pricingProfileId", "code");

-- CreateIndex
CREATE INDEX "PackagingRule_pricingProfileId_idx" ON "PackagingRule"("pricingProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "PackagingRule_pricingProfileId_code_key" ON "PackagingRule"("pricingProfileId", "code");

-- CreateIndex
CREATE INDEX "ProductPricingOverride_storeId_idx" ON "ProductPricingOverride"("storeId");

-- CreateIndex
CREATE INDEX "ProductPricingOverride_pricingProfileId_idx" ON "ProductPricingOverride"("pricingProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPricingOverride_storeId_shopifyProductId_key" ON "ProductPricingOverride"("storeId", "shopifyProductId");

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
CREATE INDEX "CatalogVariant_storeId_idx" ON "CatalogVariant"("storeId");

-- CreateIndex
CREATE INDEX "CatalogVariant_storeId_sku_idx" ON "CatalogVariant"("storeId", "sku");

-- CreateIndex
CREATE INDEX "CatalogVariant_catalogProductId_idx" ON "CatalogVariant"("catalogProductId");

-- CreateIndex
CREATE INDEX "CatalogVariant_storeId_shopifyProductId_idx" ON "CatalogVariant"("storeId", "shopifyProductId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogVariant_storeId_shopifyVariantId_key" ON "CatalogVariant"("storeId", "shopifyVariantId");

-- CreateIndex
CREATE INDEX "CatalogSyncJob_storeId_idx" ON "CatalogSyncJob"("storeId");

-- CreateIndex
CREATE INDEX "CatalogSyncJob_storeId_status_idx" ON "CatalogSyncJob"("storeId", "status");

-- CreateIndex
CREATE INDEX "CatalogSyncJob_bulkOperationId_idx" ON "CatalogSyncJob"("bulkOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogSyncJob_storeId_idempotencyKey_key" ON "CatalogSyncJob"("storeId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogSyncJob_storeId_activeSentinel_key" ON "CatalogSyncJob"("storeId", "activeSentinel");

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
CREATE INDEX "BulkAssignmentItem_catalogProductId_idx" ON "BulkAssignmentItem"("catalogProductId");

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

-- AddForeignKey
ALTER TABLE "PricingProfile" ADD CONSTRAINT "PricingProfile_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuantityTier" ADD CONSTRAINT "QuantityTier_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecorationRule" ADD CONSTRAINT "DecorationRule_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecorationColorCharge" ADD CONSTRAINT "DecorationColorCharge_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionGroup" ADD CONSTRAINT "OptionGroup_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionValue" ADD CONSTRAINT "OptionValue_optionGroupId_fkey" FOREIGN KEY ("optionGroupId") REFERENCES "OptionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductColor" ADD CONSTRAINT "ProductColor_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionRule" ADD CONSTRAINT "ProductionRule_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackagingRule" ADD CONSTRAINT "PackagingRule_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPricingOverride" ADD CONSTRAINT "ProductPricingOverride_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPricingOverride" ADD CONSTRAINT "ProductPricingOverride_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProduct" ADD CONSTRAINT "CatalogProduct_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProduct" ADD CONSTRAINT "CatalogProduct_assignedProfileId_fkey" FOREIGN KEY ("assignedProfileId") REFERENCES "PricingProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogVariant" ADD CONSTRAINT "CatalogVariant_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogVariant" ADD CONSTRAINT "CatalogVariant_catalogProductId_fkey" FOREIGN KEY ("catalogProductId") REFERENCES "CatalogProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogSyncJob" ADD CONSTRAINT "CatalogSyncJob_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkAssignmentJob" ADD CONSTRAINT "BulkAssignmentJob_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkAssignmentJob" ADD CONSTRAINT "BulkAssignmentJob_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkAssignmentItem" ADD CONSTRAINT "BulkAssignmentItem_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkAssignmentItem" ADD CONSTRAINT "BulkAssignmentItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BulkAssignmentJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkAssignmentItem" ADD CONSTRAINT "BulkAssignmentItem_catalogProductId_fkey" FOREIGN KEY ("catalogProductId") REFERENCES "CatalogProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkAssignmentAudit" ADD CONSTRAINT "BulkAssignmentAudit_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkAssignmentAudit" ADD CONSTRAINT "BulkAssignmentAudit_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BulkAssignmentJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

