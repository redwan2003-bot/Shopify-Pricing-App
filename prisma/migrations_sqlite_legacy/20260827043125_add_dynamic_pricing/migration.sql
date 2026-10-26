-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PricingProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "basePriceCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PricingProfile_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QuantityTier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pricingProfileId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL,
    "maxQuantity" INTEGER,
    "unitPriceCents" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "QuantityTier_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DecorationRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pricingProfileId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "setupFeeCents" INTEGER NOT NULL DEFAULT 0,
    "perUnitCents" INTEGER NOT NULL DEFAULT 0,
    "perColorCents" INTEGER NOT NULL DEFAULT 0,
    "maxColors" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DecorationRule_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OptionGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pricingProfileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OptionGroup_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OptionValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "optionGroupId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "priceAdjustmentCents" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OptionValue_optionGroupId_fkey" FOREIGN KEY ("optionGroupId") REFERENCES "OptionGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductionRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pricingProfileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "turnaroundDays" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "feeType" TEXT NOT NULL DEFAULT 'FLAT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductionRule_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PackagingRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pricingProfileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitsPerPackage" INTEGER,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PackagingRule_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductPricingOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "pricingProfileId" TEXT,
    "basePriceCents" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductPricingOverride_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProductPricingOverride_pricingProfileId_fkey" FOREIGN KEY ("pricingProfileId") REFERENCES "PricingProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Store_shopDomain_key" ON "Store"("shopDomain");

-- CreateIndex
CREATE INDEX "PricingProfile_storeId_idx" ON "PricingProfile"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingProfile_storeId_name_key" ON "PricingProfile"("storeId", "name");

-- CreateIndex
CREATE INDEX "QuantityTier_pricingProfileId_idx" ON "QuantityTier"("pricingProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "QuantityTier_pricingProfileId_minQuantity_key" ON "QuantityTier"("pricingProfileId", "minQuantity");

-- CreateIndex
CREATE INDEX "DecorationRule_pricingProfileId_idx" ON "DecorationRule"("pricingProfileId");

-- CreateIndex
CREATE INDEX "OptionGroup_pricingProfileId_idx" ON "OptionGroup"("pricingProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "OptionGroup_pricingProfileId_name_key" ON "OptionGroup"("pricingProfileId", "name");

-- CreateIndex
CREATE INDEX "OptionValue_optionGroupId_idx" ON "OptionValue"("optionGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "OptionValue_optionGroupId_label_key" ON "OptionValue"("optionGroupId", "label");

-- CreateIndex
CREATE INDEX "ProductionRule_pricingProfileId_idx" ON "ProductionRule"("pricingProfileId");

-- CreateIndex
CREATE INDEX "PackagingRule_pricingProfileId_idx" ON "PackagingRule"("pricingProfileId");

-- CreateIndex
CREATE INDEX "ProductPricingOverride_storeId_idx" ON "ProductPricingOverride"("storeId");

-- CreateIndex
CREATE INDEX "ProductPricingOverride_pricingProfileId_idx" ON "ProductPricingOverride"("pricingProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPricingOverride_storeId_shopifyProductId_key" ON "ProductPricingOverride"("storeId", "shopifyProductId");
