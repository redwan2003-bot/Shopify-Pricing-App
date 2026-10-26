-- AlterTable
ALTER TABLE "OptionGroup" ADD COLUMN "categoryPriceAdjustmentCents" INTEGER;

-- AlterTable
ALTER TABLE "PricingProfile" ADD COLUMN "sku" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DecorationRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pricingProfileId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "chargeBasis" TEXT NOT NULL,
    "listPriceCents" INTEGER NOT NULL,
    "netPriceCents" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DecorationRule_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DecorationRule" ("createdAt", "id", "method", "name", "pricingProfileId", "updatedAt") SELECT "createdAt", "id", "method", "name", "pricingProfileId", "updatedAt" FROM "DecorationRule";
DROP TABLE "DecorationRule";
ALTER TABLE "new_DecorationRule" RENAME TO "DecorationRule";
CREATE INDEX "DecorationRule_pricingProfileId_idx" ON "DecorationRule"("pricingProfileId");
CREATE UNIQUE INDEX "DecorationRule_pricingProfileId_code_key" ON "DecorationRule"("pricingProfileId", "code");
CREATE TABLE "new_OptionValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "optionGroupId" TEXT NOT NULL,
    "code" TEXT,
    "label" TEXT NOT NULL,
    "priceAdjustmentCents" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OptionValue_optionGroupId_fkey" FOREIGN KEY ("optionGroupId") REFERENCES "OptionGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_OptionValue" ("createdAt", "id", "isDefault", "label", "optionGroupId", "priceAdjustmentCents", "sortOrder", "updatedAt") SELECT "createdAt", "id", "isDefault", "label", "optionGroupId", "priceAdjustmentCents", "sortOrder", "updatedAt" FROM "OptionValue";
DROP TABLE "OptionValue";
ALTER TABLE "new_OptionValue" RENAME TO "OptionValue";
CREATE INDEX "OptionValue_optionGroupId_idx" ON "OptionValue"("optionGroupId");
CREATE UNIQUE INDEX "OptionValue_optionGroupId_label_key" ON "OptionValue"("optionGroupId", "label");
CREATE TABLE "new_PackagingRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pricingProfileId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitsPerPackage" INTEGER,
    "cartonWeightLbs" REAL,
    "lengthIn" REAL,
    "widthIn" REAL,
    "heightIn" REAL,
    "feeCents" INTEGER,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PackagingRule_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PackagingRule" ("createdAt", "feeCents", "id", "name", "pricingProfileId", "unitsPerPackage", "updatedAt") SELECT "createdAt", "feeCents", "id", "name", "pricingProfileId", "unitsPerPackage", "updatedAt" FROM "PackagingRule";
DROP TABLE "PackagingRule";
ALTER TABLE "new_PackagingRule" RENAME TO "PackagingRule";
CREATE INDEX "PackagingRule_pricingProfileId_idx" ON "PackagingRule"("pricingProfileId");
CREATE UNIQUE INDEX "PackagingRule_pricingProfileId_code_key" ON "PackagingRule"("pricingProfileId", "code");
CREATE TABLE "new_ProductionRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pricingProfileId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isRush" BOOLEAN NOT NULL DEFAULT false,
    "minBusinessDays" INTEGER NOT NULL,
    "maxBusinessDays" INTEGER,
    "relatedSku" TEXT,
    "feeCents" INTEGER,
    "feeType" TEXT NOT NULL DEFAULT 'FLAT',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductionRule_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ProductionRule" ("createdAt", "feeCents", "feeType", "id", "name", "pricingProfileId", "updatedAt") SELECT "createdAt", "feeCents", "feeType", "id", "name", "pricingProfileId", "updatedAt" FROM "ProductionRule";
DROP TABLE "ProductionRule";
ALTER TABLE "new_ProductionRule" RENAME TO "ProductionRule";
CREATE INDEX "ProductionRule_pricingProfileId_idx" ON "ProductionRule"("pricingProfileId");
CREATE UNIQUE INDEX "ProductionRule_pricingProfileId_code_key" ON "ProductionRule"("pricingProfileId", "code");
CREATE TABLE "new_QuantityTier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pricingProfileId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL,
    "maxQuantity" INTEGER,
    "listPriceCents" INTEGER NOT NULL,
    "netPriceCents" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "QuantityTier_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_QuantityTier" ("createdAt", "id", "maxQuantity", "minQuantity", "pricingProfileId", "updatedAt") SELECT "createdAt", "id", "maxQuantity", "minQuantity", "pricingProfileId", "updatedAt" FROM "QuantityTier";
DROP TABLE "QuantityTier";
ALTER TABLE "new_QuantityTier" RENAME TO "QuantityTier";
CREATE INDEX "QuantityTier_pricingProfileId_idx" ON "QuantityTier"("pricingProfileId");
CREATE UNIQUE INDEX "QuantityTier_pricingProfileId_minQuantity_key" ON "QuantityTier"("pricingProfileId", "minQuantity");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PricingProfile_storeId_sku_key" ON "PricingProfile"("storeId", "sku");

