import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { analyzeCatalogCsv, importAnalyzedProfiles, type HoldBack } from "./catalog-csv.ts";
import { applyLinkReport, buildLinkReport } from "./link-products.ts";
import { readShopPolicyContext } from "../catalog/admin-client.ts";

/** Loader and action for app/routes/app.pricing-import.tsx (kept free of JSX so they can be exercised directly). */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const LIST_LIMIT = 300;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({ where: { shopDomain: session.shop }, select: { id: true } });
  if (!store) return { profiles: 0, linked: 0 };
  const [profiles, linked] = await Promise.all([
    prisma.pricingProfile.count({ where: { storeId: store.id } }),
    prisma.productPricingOverride.count({ where: { storeId: store.id, isActive: true } }),
  ]);
  return { profiles, linked };
};

export type ImportActionResult =
  | { ok: false; message: string }
  | {
      ok: true;
      intent: "preview" | "import";
      productsWithProfile: number;
      ready: number;
      heldBack: HoldBack[];
      heldBackTotal: number;
      currencyWarning: string | null;
      imported?: number;
      changed?: number;
      linked?: number;
      policiesWritten?: number;
      notLinked?: { sku: string | null; reason: string }[];
      errors?: string[];
    };

export const action = async ({ request }: ActionFunctionArgs): Promise<ImportActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent: "preview" | "import" = form.get("intent") === "import" ? "import" : "preview";
  const file = form.get("catalog");

  if (!file || typeof file === "string" || file.size === 0) return { ok: false, message: "Choose your catalog CSV file first." };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, message: "That file is larger than 10 MB. Split it or remove unused columns." };
  if (!/\.csv$/i.test(file.name)) return { ok: false, message: "Upload a .csv file (your Shopify product export with the ImprintID pricing columns)." };

  const analysis = analyzeCatalogCsv(await file.text(), session.shop);
  if (analysis.missingColumns) {
    return {
      ok: false,
      message: "This file doesn't have the ImprintID pricing columns. Use the catalog export that includes “ImprintID Pricing Profile”.",
    };
  }

  // Quotes are only signed when the profile currency matches the store currency.
  let currencyWarning: string | null = null;
  const shop = await readShopPolicyContext(admin);
  if (shop.ok && shop.shopCurrency && analysis.currencies.some((c) => c !== shop.shopCurrency)) {
    currencyWarning = `Your store sells in ${shop.shopCurrency}, but this file is priced in ${analysis.currencies.join(", ")}. Products priced in a different currency can't be bought with dynamic pricing turned on.`;
  }

  const base = {
    ok: true as const,
    intent,
    productsWithProfile: analysis.productsWithProfile,
    ready: analysis.toImport.length,
    heldBack: analysis.holdBacks.slice(0, LIST_LIMIT),
    heldBackTotal: analysis.holdBacks.length,
    currencyWarning,
  };
  if (intent === "preview") return base;

  const imported = await importAnalyzedProfiles(prisma, analysis.toImport);
  const store = await prisma.store.upsert({ where: { shopDomain: session.shop }, update: {}, create: { shopDomain: session.shop }, select: { id: true } });
  const report = await buildLinkReport(prisma, admin, store.id);
  const applied = await applyLinkReport(prisma, admin, store.id, report);

  return {
    ...base,
    heldBack: [...analysis.holdBacks, ...imported.failures].slice(0, LIST_LIMIT),
    heldBackTotal: analysis.holdBacks.length + imported.failures.length,
    imported: imported.imported,
    changed: imported.changed,
    linked: report.matched.length,
    policiesWritten: applied.written,
    notLinked: report.heldBack.slice(0, LIST_LIMIT),
    errors: applied.errors,
  };
};
