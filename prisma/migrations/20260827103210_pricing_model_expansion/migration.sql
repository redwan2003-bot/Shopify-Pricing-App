-- AlterTable
ALTER TABLE "DecorationRule" ADD COLUMN "priceCode" TEXT;

-- AlterTable
ALTER TABLE "OptionValue" ADD COLUMN "priceCode" TEXT;

-- AlterTable
ALTER TABLE "QuantityTier" ADD COLUMN "priceCode" TEXT;

-- CreateTable
CREATE TABLE "DecorationColorCharge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pricingProfileId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "colorNumber" INTEGER NOT NULL,
    "chargeBasis" TEXT NOT NULL,
    "priceCode" TEXT,
    "listPriceCents" INTEGER NOT NULL,
    "netPriceCents" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DecorationColorCharge_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductColor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pricingProfileId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCode" TEXT,
    "priceAdjustmentCents" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductColor_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OptionGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pricingProfileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'GENERIC',
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "categoryPriceAdjustmentCents" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OptionGroup_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_OptionGroup" ("categoryPriceAdjustmentCents", "createdAt", "id", "isRequired", "name", "pricingProfileId", "sortOrder", "updatedAt") SELECT "categoryPriceAdjustmentCents", "createdAt", "id", "isRequired", "name", "pricingProfileId", "sortOrder", "updatedAt" FROM "OptionGroup";
DROP TABLE "OptionGroup";
ALTER TABLE "new_OptionGroup" RENAME TO "OptionGroup";
CREATE INDEX "OptionGroup_pricingProfileId_idx" ON "OptionGroup"("pricingProfileId");
CREATE UNIQUE INDEX "OptionGroup_pricingProfileId_name_key" ON "OptionGroup"("pricingProfileId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "DecorationColorCharge_pricingProfileId_idx" ON "DecorationColorCharge"("pricingProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "DecorationColorCharge_pricingProfileId_method_colorNumber_chargeBasis_key" ON "DecorationColorCharge"("pricingProfileId", "method", "colorNumber", "chargeBasis");

-- CreateIndex
CREATE INDEX "ProductColor_pricingProfileId_idx" ON "ProductColor"("pricingProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductColor_pricingProfileId_code_key" ON "ProductColor"("pricingProfileId", "code");

