import { PrismaClient } from "@prisma/client";
import { overrideProductKey } from "../app/lib/catalog/gid.ts";

const prisma = new PrismaClient();

async function main() {
  console.log("Synchronizing product overrides and catalog coverage...");

  const devStore = await prisma.store.findUnique({
    where: { shopDomain: "imprintid-pricing-dev.myshopify.com" },
  });
  if (!devStore) {
    throw new Error("Dev store imprintid-pricing-dev.myshopify.com not found!");
  }

  // 1. Find all overrides on devStore
  const overrides = await prisma.productPricingOverride.findMany({
    where: { storeId: devStore.id },
  });
  console.log(`Found ${overrides.length} existing overrides on devStore.`);

  let createdBareOverrides = 0;
  for (const ov of overrides) {
    const bareKey = overrideProductKey(ov.shopifyProductId);
    if (bareKey && bareKey !== ov.shopifyProductId) {
      await prisma.productPricingOverride.upsert({
        where: {
          storeId_shopifyProductId: {
            storeId: devStore.id,
            shopifyProductId: bareKey,
          },
        },
        update: {
          pricingProfileId: ov.pricingProfileId,
          isActive: ov.isActive,
          basePriceCents: ov.basePriceCents,
        },
        create: {
          storeId: devStore.id,
          shopifyProductId: bareKey,
          pricingProfileId: ov.pricingProfileId,
          isActive: ov.isActive,
          basePriceCents: ov.basePriceCents,
        },
      });
      createdBareOverrides++;
    }
  }
  console.log(`Created or updated ${createdBareOverrides} bare-keyed overrides.`);

  // 2. Link CatalogProduct for devStore products that have an override
  const allDevOverrides = await prisma.productPricingOverride.findMany({
    where: { storeId: devStore.id, isActive: true },
  });

  let catalogProductsUpdated = 0;
  for (const ov of allDevOverrides) {
    if (!ov.pricingProfileId) continue;
    const bareKey = overrideProductKey(ov.shopifyProductId);
    const gidKey = `gid://shopify/Product/${bareKey}`;

    const catProd = await prisma.catalogProduct.findFirst({
      where: {
        storeId: devStore.id,
        shopifyProductId: { in: [gidKey, bareKey ?? ""] },
      },
    });

    if (catProd && (!catProd.assignedProfileId || catProd.coverageStatus !== "assigned")) {
      await prisma.catalogProduct.update({
        where: { id: catProd.id },
        data: {
          assignedProfileId: ov.pricingProfileId,
          assignmentSource: "override",
          coverageStatus: "assigned",
          enforcementReady: true,
        },
      });
      catalogProductsUpdated++;
    }
  }
  console.log(`Updated ${catalogProductsUpdated} CatalogProduct coverage records.`);

  // 3. Verify LNY01 specifically
  const lnyOverrideBare = await prisma.productPricingOverride.findUnique({
    where: {
      storeId_shopifyProductId: {
        storeId: devStore.id,
        shopifyProductId: "8438071820427",
      },
    },
    include: { pricingProfile: true },
  });
  console.log("LNY01 bare override:", {
    shopifyProductId: lnyOverrideBare?.shopifyProductId,
    profileSku: lnyOverrideBare?.pricingProfile?.sku,
    profileName: lnyOverrideBare?.pricingProfile?.name,
    isActive: lnyOverrideBare?.isActive,
  });

  const lnyCatalogProduct = await prisma.catalogProduct.findFirst({
    where: {
      storeId: devStore.id,
      shopifyProductId: { in: ["gid://shopify/Product/8438071820427", "8438071820427"] },
    },
  });
  console.log("LNY01 CatalogProduct:", {
    title: lnyCatalogProduct?.title,
    coverageStatus: lnyCatalogProduct?.coverageStatus,
    assignedProfileId: lnyCatalogProduct?.assignedProfileId,
    enforcementReady: lnyCatalogProduct?.enforcementReady,
  });

  console.log("Synchronization complete!");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
