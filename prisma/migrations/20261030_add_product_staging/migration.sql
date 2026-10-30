-- CreateEnum
CREATE TYPE "ProductStagingRunStatus" AS ENUM ('PLANNED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ProductStagingSource" AS ENUM ('SHOPIFY', 'IMPRINTID_WEB', 'GOOGLE_DRIVE', 'GMAIL', 'MANUAL');

-- CreateEnum
CREATE TYPE "ProductStagingMediaRole" AS ENUM ('COVER', 'GALLERY', 'DETAIL', 'SPECIFICATION', 'UNCLASSIFIED');

-- CreateEnum
CREATE TYPE "ProductStagingVerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'CONFLICTED', 'MISSING');

-- CreateTable
CREATE TABLE "ProductStagingRun" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "status" "ProductStagingRunStatus" NOT NULL DEFAULT 'PLANNED',
    "sourceSummary" JSONB,
    "sourceFingerprint" TEXT,
    "normalizationVersion" TEXT,
    "recordsRead" INTEGER NOT NULL DEFAULT 0,
    "recordsCreated" INTEGER NOT NULL DEFAULT 0,
    "recordsConflicted" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductStagingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductStagingRecord" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "catalogProductId" TEXT,
    "sourceProductKey" TEXT NOT NULL,
    "shopifyProductId" TEXT,
    "primarySku" TEXT,
    "vendorCode" TEXT,
    "title" TEXT,
    "handle" TEXT,
    "vendor" TEXT,
    "productType" TEXT,
    "status" TEXT,
    "productUrl" TEXT,
    "description" TEXT,
    "summary" TEXT,
    "brand" TEXT,
    "material" TEXT,
    "dimensions" TEXT,
    "colors" TEXT,
    "primaryCoverImageUrl" TEXT,
    "verificationStatus" "ProductStagingVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductStagingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductStagingVariant" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "catalogVariantId" TEXT,
    "sourceVariantKey" TEXT NOT NULL,
    "shopifyVariantId" TEXT,
    "sku" TEXT,
    "title" TEXT,
    "optionValues" JSONB,
    "position" INTEGER,
    "priceCents" INTEGER,
    "compareAtPriceCents" INTEGER,
    "currency" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductStagingVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductStagingMedia" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "source" "ProductStagingSource" NOT NULL,
    "role" "ProductStagingMediaRole" NOT NULL DEFAULT 'UNCLASSIFIED',
    "assetKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "altText" TEXT,
    "mimeType" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductStagingMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductStagingEvidence" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "source" "ProductStagingSource" NOT NULL,
    "externalId" TEXT,
    "locator" TEXT,
    "fieldPath" TEXT,
    "excerpt" TEXT,
    "contentHash" TEXT,
    "confidence" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawReference" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductStagingEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductStagingAttribute" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "evidenceId" TEXT,
    "key" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "valueText" TEXT,
    "valueJson" JSONB,
    "unit" TEXT,
    "source" "ProductStagingSource" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductStagingAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductStagingConflict" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "candidates" JSONB NOT NULL,
    "status" "ProductStagingVerificationStatus" NOT NULL DEFAULT 'CONFLICTED',
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductStagingConflict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductStagingRun_storeId_createdAt_idx" ON "ProductStagingRun"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductStagingRun_storeId_status_idx" ON "ProductStagingRun"("storeId", "status");

-- CreateIndex
CREATE INDEX "ProductStagingRecord_storeId_primarySku_idx" ON "ProductStagingRecord"("storeId", "primarySku");

-- CreateIndex
CREATE INDEX "ProductStagingRecord_storeId_catalogProductId_idx" ON "ProductStagingRecord"("storeId", "catalogProductId");

-- CreateIndex
CREATE INDEX "ProductStagingRecord_storeId_shopifyProductId_idx" ON "ProductStagingRecord"("storeId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "ProductStagingRecord_runId_idx" ON "ProductStagingRecord"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductStagingRecord_runId_sourceProductKey_key" ON "ProductStagingRecord"("runId", "sourceProductKey");

-- CreateIndex
CREATE INDEX "ProductStagingVariant_catalogVariantId_idx" ON "ProductStagingVariant"("catalogVariantId");

-- CreateIndex
CREATE INDEX "ProductStagingVariant_sku_idx" ON "ProductStagingVariant"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "ProductStagingVariant_recordId_sourceVariantKey_key" ON "ProductStagingVariant"("recordId", "sourceVariantKey");

-- CreateIndex
CREATE INDEX "ProductStagingMedia_recordId_role_idx" ON "ProductStagingMedia"("recordId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "ProductStagingMedia_recordId_assetKey_key" ON "ProductStagingMedia"("recordId", "assetKey");

-- CreateIndex
CREATE INDEX "ProductStagingEvidence_recordId_source_idx" ON "ProductStagingEvidence"("recordId", "source");

-- CreateIndex
CREATE INDEX "ProductStagingEvidence_externalId_idx" ON "ProductStagingEvidence"("externalId");

-- CreateIndex
CREATE INDEX "ProductStagingAttribute_recordId_key_idx" ON "ProductStagingAttribute"("recordId", "key");

-- CreateIndex
CREATE INDEX "ProductStagingAttribute_evidenceId_idx" ON "ProductStagingAttribute"("evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductStagingAttribute_recordId_key_ordinal_key" ON "ProductStagingAttribute"("recordId", "key", "ordinal");

-- CreateIndex
CREATE INDEX "ProductStagingConflict_recordId_status_idx" ON "ProductStagingConflict"("recordId", "status");

-- CreateIndex
CREATE INDEX "ProductStagingConflict_fieldName_idx" ON "ProductStagingConflict"("fieldName");

-- AddForeignKey
ALTER TABLE "ProductStagingRun" ADD CONSTRAINT "ProductStagingRun_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStagingRecord" ADD CONSTRAINT "ProductStagingRecord_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStagingRecord" ADD CONSTRAINT "ProductStagingRecord_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ProductStagingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStagingRecord" ADD CONSTRAINT "ProductStagingRecord_catalogProductId_fkey" FOREIGN KEY ("catalogProductId") REFERENCES "CatalogProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStagingVariant" ADD CONSTRAINT "ProductStagingVariant_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "ProductStagingRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStagingVariant" ADD CONSTRAINT "ProductStagingVariant_catalogVariantId_fkey" FOREIGN KEY ("catalogVariantId") REFERENCES "CatalogVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStagingMedia" ADD CONSTRAINT "ProductStagingMedia_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "ProductStagingRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStagingEvidence" ADD CONSTRAINT "ProductStagingEvidence_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "ProductStagingRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStagingAttribute" ADD CONSTRAINT "ProductStagingAttribute_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "ProductStagingRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStagingAttribute" ADD CONSTRAINT "ProductStagingAttribute_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "ProductStagingEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStagingConflict" ADD CONSTRAINT "ProductStagingConflict_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "ProductStagingRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

