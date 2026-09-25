import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Prisma } from "@prisma/client";

import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { importPricingProfile, PricingImportValidationError } from "../pricing-import/import.ts";
import { applyLinkReport, buildLinkReport } from "../pricing-import/link-products.ts";
import { readShopPolicyContext } from "../catalog/admin-client.ts";
import { blankDraft, draftToImportInput, profileToDraft, type DraftError, type PricingDraft } from "./draft.ts";

/** Loaders/actions for the pricing profile list and editor pages (JSX-free so they can be exercised directly). */

const PAGE_SIZE = 100;

async function storeFor(shop: string) {
  return prisma.store.upsert({ where: { shopDomain: shop }, update: {}, create: { shopDomain: shop }, select: { id: true } });
}

// ---------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------

export const listLoader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await storeFor(session.shop);
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 100);
  const where: Prisma.PricingProfileWhereInput = {
    storeId: store.id,
    ...(q ? { OR: [{ sku: { contains: q } }, { name: { contains: q } }] } : {}),
  };
  const [total, profiles] = await Promise.all([
    prisma.pricingProfile.count({ where }),
    prisma.pricingProfile.findMany({
      where,
      orderBy: { sku: "asc" },
      take: PAGE_SIZE,
      select: {
        id: true,
        sku: true,
        name: true,
        currency: true,
        isActive: true,
        revision: true,
        updatedAt: true,
        _count: { select: { quantityTiers: true, optionGroups: true } },
        productOverrides: { where: { isActive: true }, select: { shopifyProductId: true } },
      },
    }),
  ]);
  return {
    q,
    total,
    pageSize: PAGE_SIZE,
    profiles: profiles.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      currency: p.currency,
      isActive: p.isActive,
      revision: p.revision,
      updatedAt: p.updatedAt.toISOString(),
      tiers: p._count.quantityTiers,
      optionGroups: p._count.optionGroups,
      linkedProducts: p.productOverrides.map((o) => o.shopifyProductId.replace("gid://shopify/Product/", "")),
    })),
  };
};

const SECTION_NAMES: Record<string, string> = {
  quantityTiers: "Quantity break",
  decorationRules: "Decoration charge",
  decorationColorCharges: "2nd colour charge",
  optionGroups: "Option group",
  values: "choice",
  productionRules: "Production option",
  packagingRules: "Packaging",
};
const FIELD_NAMES: Record<string, string> = { listPriceCents: "list price", netPriceCents: "net price", priceAdjustmentCents: "list price", netPriceAdjustmentCents: "net price" };

/** Turns an importer path like `quantityTiers[0].netPriceCents` into "Quantity break 1, net price". */
export function describeIssue(issue: { path: string; message: string }): string {
  const parts = issue.path.split(".").map((part) => {
    const m = /^(\w+)\[(\d+)\]$/.exec(part);
    if (m) return `${SECTION_NAMES[m[1]!] ?? m[1]} ${Number(m[2]) + 1}`;
    return FIELD_NAMES[part] ?? SECTION_NAMES[part] ?? part;
  });
  const message = issue.message.replace(/listPriceCents/g, "the list price").replace(/netPriceCents/g, "net price");
  return `${parts.join(", ")} ${message}`;
}

// ---------------------------------------------------------------------------------------
// Edit / create
// ---------------------------------------------------------------------------------------

const PROFILE_INCLUDE = {
  quantityTiers: true,
  decorationRules: true,
  decorationColorCharges: true,
  optionGroups: { include: { optionValues: true } },
  productionRules: true,
  packagingRules: true,
  productColors: true,
  productOverrides: { where: { isActive: true }, select: { shopifyProductId: true } },
} satisfies Prisma.PricingProfileInclude;

export const editLoader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const store = await storeFor(session.shop);
  const shop = await readShopPolicyContext(admin);
  const shopCurrency = shop.ok ? shop.shopCurrency : null;

  if (params.id === "new") {
    return { isNew: true as const, id: null, draft: blankDraft(shopCurrency ?? "USD"), linkedProducts: [] as string[], shopCurrency };
  }
  const profile = await prisma.pricingProfile.findFirst({ where: { id: params.id, storeId: store.id }, include: PROFILE_INCLUDE });
  if (!profile) throw new Response("Pricing profile not found", { status: 404 });
  return {
    isNew: false as const,
    id: profile.id,
    draft: profileToDraft(profile),
    linkedProducts: profile.productOverrides.map((o) => o.shopifyProductId.replace("gid://shopify/Product/", "")),
    shopCurrency,
  };
};

export type SaveResult =
  | { ok: false; message: string; errors?: DraftError[] }
  | { ok: true; message: string; linked: boolean };

export const editAction = async ({ request, params }: ActionFunctionArgs): Promise<SaveResult | Response> => {
  const { session, admin, redirect } = await authenticate.admin(request);
  const store = await storeFor(session.shop);
  const form = await request.formData();

  let draft: PricingDraft;
  try {
    draft = JSON.parse(String(form.get("draft") ?? "")) as PricingDraft;
  } catch {
    return { ok: false, message: "The form could not be read. Reload the page and try again." };
  }

  const isNew = params.id === "new";
  const existing = isNew
    ? null
    : await prisma.pricingProfile.findFirst({ where: { id: params.id, storeId: store.id }, include: { packagingRules: true, productColors: true } });
  if (!isNew && !existing) return { ok: false, message: "This pricing profile no longer exists." };

  // The SKU is the profile's key: saving under another SKU would create or overwrite a different profile.
  if (existing && draft.sku.trim() !== (existing.sku ?? "")) {
    return { ok: false, message: "The SKU of an existing profile can't be changed. Create a new profile instead.", errors: [{ field: "sku", message: "Can't be changed" }] };
  }
  if (isNew && (await prisma.pricingProfile.findFirst({ where: { storeId: store.id, sku: draft.sku.trim() }, select: { id: true } }))) {
    return { ok: false, message: `A profile for SKU ${draft.sku.trim()} already exists. Open it from the list to edit it.`, errors: [{ field: "sku", message: "Already exists" }] };
  }

  const converted = draftToImportInput(draft, session.shop, {
    packagingRules: (existing?.packagingRules ?? []).map((r) => ({
      code: r.code,
      name: r.name,
      unitsPerPackage: r.unitsPerPackage,
      cartonWeightLbs: r.cartonWeightLbs,
      lengthIn: r.lengthIn,
      widthIn: r.widthIn,
      heightIn: r.heightIn,
      feeCents: r.feeCents,
      notes: r.notes,
    })),
    productColors: (existing?.productColors ?? []).map((c) => ({
      code: c.code,
      name: c.name,
      priceCode: c.priceCode,
      priceAdjustmentCents: c.priceAdjustmentCents,
      sortOrder: c.sortOrder,
      isActive: c.isActive,
    })),
  });
  if (!converted.ok) return { ok: false, message: "Fix the highlighted fields and save again.", errors: converted.errors };

  let result;
  try {
    result = await importPricingProfile(prisma, converted.input);
  } catch (e) {
    if (e instanceof PricingImportValidationError) {
      return { ok: false, message: `Not saved: ${e.issues.slice(0, 5).map(describeIssue).join("; ")}.` };
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, message: "Another profile already uses this name. Choose a different name.", errors: [{ field: "name", message: "Already used" }] };
    }
    throw e;
  }

  // Keep the product's pricing policy in step with the new revision (the Functions compare quotes to it).
  let linked = false;
  try {
    const report = await buildLinkReport(prisma, admin, store.id);
    await applyLinkReport(prisma, admin, store.id, report);
    linked = report.matched.some((m) => m.profile.id === result.pricingProfileId);
  } catch (e) {
    console.error("[pricing-editor] relink after save failed:", e);
    return { ok: true, message: "Saved, but the product link couldn't be refreshed. Open Import pricing and run it again, or retry saving.", linked: false };
  }

  if (isNew) return redirect(`/app/pricing-profiles/${result.pricingProfileId}?saved=1`);
  if (!linked) return { ok: true, message: "Saved. No product with this SKU was found, so it isn't linked to a product yet.", linked };
  const message = result.revisionChanged ? "Saved. Shoppers with this product already in their cart will need to reconfigure it." : "Saved (no price changes).";
  return { ok: true, message, linked };
};
