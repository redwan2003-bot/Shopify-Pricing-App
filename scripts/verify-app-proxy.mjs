// Manually-run verification script proving a genuinely Shopify-signed App Proxy
// request reaches: signature verification -> session resolution -> the real route
// module -> handleStorefrontPricingRequest -> calculatePrice -> Prisma -> the real
// LNY01 seed data (imported into a disposable store for isolation). Not part of the
// permanent `npm test` suite: it needs a custom module resolution loader (see
// resolve-ts-loader.mjs) to import app/shopify.server.ts and app/db.server.ts, which
// use extensionless relative imports that only Vite (not plain `node --test`)
// resolves — the same constraint noted in Phase 2.4's final report. Run with:
//   npm run verify:app-proxy
import crypto from "node:crypto";

process.env.SHOPIFY_API_KEY ??= "verify_api_key";
process.env.SHOPIFY_API_SECRET ??= "verify_shared_secret_value";
process.env.SCOPES ??= "write_products";
process.env.SHOPIFY_APP_URL ??= "https://example.com";

const { PrismaClient } = await import("@prisma/client");
const { importPricingProfile } = await import("../app/lib/pricing-import/import.ts");
const { buildLny01PricingInput } = await import("../prisma/seed-data/lny01.ts");

const prisma = new PrismaClient();
const SHOP = `app-proxy-verify-${process.pid}.myshopify.com`;

function signAppProxyQuery(params) {
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const message = entries.reduce((acc, [k, v]) => `${acc}${k}=${v}`, "");
  const signature = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");
  return signature;
}

function buildProxyUrl(pathname, extraParams = {}) {
  const params = { shop: SHOP, timestamp: String(Math.trunc(Date.now() / 1000)), ...extraParams };
  const signature = signAppProxyQuery(params);
  const qs = new URLSearchParams({ ...params, signature }).toString();
  return `https://example.com${pathname}?${qs}`;
}

let passCount = 0;
let failCount = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS - ${label}`);
    passCount++;
  } else {
    console.log(`FAIL - ${label}${detail ? ` (${detail})` : ""}`);
    failCount++;
  }
}

try {
  // 1. Seed the real LNY01 pricing package into a disposable store, so this proves
  // the route reaches genuine seeded data, not fabricated numbers.
  await importPricingProfile(prisma, buildLny01PricingInput(SHOP));

  // 2. A real offline session row, exactly as Shopify's OAuth flow would create one,
  // so ensureValidOfflineSession finds it without any network call to Shopify.
  await prisma.session.create({
    data: {
      id: `offline_${SHOP}`,
      shop: SHOP,
      state: "verify",
      isOnline: false,
      accessToken: "verify-fake-offline-token",
      expires: null,
    },
  });

  const { action, loader } = await import("../app/routes/apps.imprintid-pricing.pricing.tsx");

  // --- Case A: minimal valid request, genuinely HMAC-signed -----------------------
  {
    const url = buildProxyUrl("/apps/imprintid-pricing/pricing");
    const request = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: "LNY01", quantity: 1000 }),
    });
    const response = await action({ request, params: {}, context: {} });
    const body = await response.json();
    console.log("\n[Case A] minimal LNY01 request -> status", response.status);
    console.log(JSON.stringify(body, null, 2));
    check("Case A status is 200", response.status === 200);
    check("Case A ok:true", body.ok === true);
    check("Case A no `source` field (storefront trimming)", body.ok === true && !("source" in body.data));
    // quantity 1000 selects the 1000-tier (164 list / 98 net), per the real seeded
    // LNY01 quantity tiers in prisma/seed-data/lny01.ts.
    check(
      "Case A list unit price matches real seeded LNY01 at qty 1000 (164 cents)",
      body.ok === true && body.data.base.listUnitPriceCents === 164,
    );
    check(
      "Case A net unit price matches real seeded LNY01 at qty 1000 (98 cents)",
      body.ok === true && body.data.base.netUnitPriceCents === 98,
    );
  }

  // --- Case E: GET catalog — the same request the storefront JS makes on page load,
  // to render real option/production choices before any price is calculated -------
  let cellPhoneLoopId;
  {
    const url = buildProxyUrl("/apps/imprintid-pricing/pricing", { sku: "LNY01" });
    const request = new Request(url, { method: "GET" });
    const response = await loader({ request, params: {}, context: {} });
    const body = await response.json();
    console.log("\n[Case E] GET catalog for LNY01 -> status", response.status);
    check("Case E status is 200", response.status === 200);
    check("Case E sku matches", body.ok === true && body.data.sku === "LNY01");
    check(
      "Case E has all 6 real quantity tiers",
      body.ok === true && body.data.quantityTiers.length === 6,
    );
    check(
      "Case E has all 6 real option groups (not hardcoded)",
      body.ok === true && body.data.optionGroups.length === 6,
    );
    check(
      "Case E has both real production rules (STANDARD, RUSH)",
      body.ok === true &&
        body.data.productionRules.map((r) => r.code).sort().join(",") === "RUSH,STANDARD",
    );

    const featuresGroup = body.ok
      ? body.data.optionGroups.find((g) => g.name === "Optional Features")
      : undefined;
    const cellPhoneLoop = featuresGroup?.values.find((v) => v.label === "Cell Phone Loop");
    check(
      "Case E exposes a real OptionValue.id for Cell Phone Loop, with its real price",
      !!cellPhoneLoop && cellPhoneLoop.priceAdjustmentCents === 25,
    );
    cellPhoneLoopId = cellPhoneLoop?.id;

    // Phase 2.7 catalog fields.
    const attachmentGroup = body.ok
      ? body.data.optionGroups.find((g) => g.name === "Attachment — Standard")
      : undefined;
    check(
      "Case E: OptionGroup.kind distinguishes Attachment from Feature groups",
      attachmentGroup?.kind === "ATTACHMENT" && featuresGroup?.kind === "FEATURE",
    );
    check(
      "Case E: LNY01 exposes its three stock colors (Black/Red/Blue), each Included ($0)",
      body.ok === true &&
        Array.isArray(body.data.productColors) &&
        body.data.productColors.length === 3 &&
        body.data.productColors.every((c) => c.priceAdjustmentCents === 0),
    );
    check(
      "Case E: decorationColorCharges exposes the real color-2 setup/run pricing",
      body.ok === true &&
        body.data.decorationColorCharges.length === 2 &&
        body.data.decorationColorCharges.every((c) => c.colorNumber === 2),
    );
  }

  // --- Case B: full worked example, using the id Case E just discovered from the
  // catalog — exactly how the storefront JS chains GET catalog -> POST calculate ---
  {
    const url = buildProxyUrl("/apps/imprintid-pricing/pricing");
    const request = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sku: "LNY01",
        quantity: 1000,
        decoration: {
          method: "SCREEN_PRINT",
          colors: 2,
          locations: 2,
          reverseSide: true,
          differentReverseArtwork: true,
          repeatOrder: true,
        },
        options: [{ groupName: "Optional Features", optionValueId: cellPhoneLoopId }],
        production: { code: "RUSH" },
      }),
    });
    const response = await action({ request, params: {}, context: {} });
    const body = await response.json();
    console.log("\n[Case B] full worked example -> status", response.status);
    console.log(JSON.stringify(body.ok ? body.data.totals : body, null, 2));
    check("Case B status is 200", response.status === 200);
    check(
      "Case B listTotalCents === 258500 (matches Phase 2.3/2.4 verified figure)",
      body.ok === true && body.data.totals.listTotalCents === 258500,
    );
    check(
      "Case B netTotalCents === 178600 (matches Phase 2.3/2.4 verified figure)",
      body.ok === true && body.data.totals.netTotalCents === 178600,
    );
    check(
      "Case B response includes availableQuantityTiers for the quantity-break table",
      body.ok === true && body.data.availableQuantityTiers?.length === 6,
    );
  }

  // --- Case C: an invalid/forged signature must be rejected -----------------------
  {
    const badUrl = `https://example.com/apps/imprintid-pricing/pricing?shop=${encodeURIComponent(SHOP)}&timestamp=${Math.trunc(Date.now() / 1000)}&signature=deadbeef0000000000000000000000000000000000000000000000000000`;
    const request = new Request(badUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: "LNY01", quantity: 1000 }),
    });
    let rejected = false;
    let status;
    try {
      const response = await action({ request, params: {}, context: {} });
      status = response.status;
    } catch (err) {
      if (err instanceof Response) {
        rejected = true;
        status = err.status;
      } else {
        throw err;
      }
    }
    console.log("\n[Case C] forged signature -> status", status, rejected ? "(thrown Response)" : "(returned Response)");
    check("Case C is rejected (not a 200 with real pricing)", status !== 200);
  }

  // --- Case F: Phase 2.7 — a synthetic product with product colors AND 4-color
  // decoration pricing, proving the new dimensions work through a genuinely signed
  // GET-catalog-then-POST-calculate chain, exactly like LNY01 above but exercising
  // paths LNY01's real (unenriched) data can't. Seeded via the same existing
  // importPricingProfile architecture — no second import path was built for this. ---
  {
    await importPricingProfile(prisma, {
      shopDomain: SHOP,
      sku: "SAGE-DEMO",
      name: "Sage-style demo product",
      quantityTiers: [{ minQuantity: 100, listPriceCents: 500, netPriceCents: 400, priceCode: "A" }],
      decorationRules: [
        { code: "SETUP_1C1L", name: "Setup", method: "SCREEN_PRINT", chargeBasis: "ONE_TIME", listPriceCents: 1000, netPriceCents: 800 },
      ],
      decorationColorCharges: [
        { method: "SCREEN_PRINT", colorNumber: 2, chargeBasis: "ONE_TIME", listPriceCents: 300, netPriceCents: 250, priceCode: "B" },
        { method: "SCREEN_PRINT", colorNumber: 2, chargeBasis: "PER_UNIT", listPriceCents: 10, netPriceCents: 8 },
        { method: "SCREEN_PRINT", colorNumber: 3, chargeBasis: "ONE_TIME", listPriceCents: 350, netPriceCents: 280 },
        { method: "SCREEN_PRINT", colorNumber: 3, chargeBasis: "PER_UNIT", listPriceCents: 12, netPriceCents: 10 },
      ],
      productColors: [
        { code: "ROYAL", name: "Royal Blue", priceCode: "P2", priceAdjustmentCents: 15 },
        { code: "BLACK", name: "Black", priceAdjustmentCents: null },
      ],
      optionGroups: [],
      productionRules: [{ code: "STANDARD", name: "Standard", minBusinessDays: 5 }],
      packagingRules: [{ code: "CARTON", name: "Carton" }],
    });

    const catalogUrl = buildProxyUrl("/apps/imprintid-pricing/pricing", { sku: "SAGE-DEMO" });
    const catalogResponse = await loader({ request: new Request(catalogUrl, { method: "GET" }), params: {}, context: {} });
    const catalogBody = await catalogResponse.json();
    console.log("\n[Case F] GET catalog for synthetic SAGE-DEMO product -> status", catalogResponse.status);
    check("Case F catalog status is 200", catalogResponse.status === 200);
    check(
      "Case F catalog exposes both product colors with real price codes",
      catalogBody.ok === true &&
        catalogBody.data.productColors.length === 2 &&
        catalogBody.data.productColors.find((c) => c.code === "ROYAL")?.priceCode === "P2",
    );
    check(
      "Case F catalog exposes color 2 AND color 3 decoration pricing separately",
      catalogBody.ok === true &&
        new Set(catalogBody.data.decorationColorCharges.map((c) => c.colorNumber)).size === 2,
    );

    const calcUrl = buildProxyUrl("/apps/imprintid-pricing/pricing");
    const calcRequest = new Request(calcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sku: "SAGE-DEMO",
        quantity: 100,
        productColor: { code: "ROYAL" },
        decoration: {
          method: "SCREEN_PRINT",
          colors: 3,
          locations: 1,
          reverseSide: false,
          differentReverseArtwork: false,
          repeatOrder: false,
        },
      }),
    });
    const calcResponse = await action({ request: calcRequest, params: {}, context: {} });
    const calcBody = await calcResponse.json();
    console.log("[Case F] POST calculate (3 colors + Royal Blue) -> status", calcResponse.status);
    console.log(JSON.stringify(calcBody.ok ? { productColor: calcBody.data.productColor, decoration: calcBody.data.decoration.charges.map((c) => c.code), totals: calcBody.data.totals } : calcBody, null, 2));
    check("Case F calculation status is 200", calcResponse.status === 200);
    check(
      "Case F applies the Royal Blue color adjustment (+15)",
      calcBody.ok === true && calcBody.data.productColor?.priceAdjustmentCents === 15,
    );
    const decorationCodes = calcBody.ok ? calcBody.data.decoration.charges.map((c) => c.code).sort() : [];
    check(
      "Case F sums colors 2 AND 3 independently (not one flat additional-color fee)",
      JSON.stringify(decorationCodes) ===
        JSON.stringify(["COLOR_2_RUN", "COLOR_2_SETUP", "COLOR_3_RUN", "COLOR_3_SETUP", "SETUP_1C1L"]),
    );
    // base: 500*100=50000 list / 400*100=40000 net
    // decoration: setup 1000/800 + color2 300/250 + color2run 10*100=1000/8*100=800 + color3 350/280 + color3run 12*100=1200/10*100=1000
    //   list = 1000+300+1000+350+1200 = 3850; net = 800+250+800+280+1000 = 3130
    // color: +15 both
    const expectedList = 50000 + 3850 + 15;
    const expectedNet = 40000 + 3130 + 15;
    check(
      `Case F total matches hand-computed figure (list ${expectedList}, net ${expectedNet}) — every cent traced to a seeded row`,
      calcBody.ok === true &&
        calcBody.data.totals.listTotalCents === expectedList &&
        calcBody.data.totals.netTotalCents === expectedNet,
    );
  }

  // --- Case D: a shop with no offline session must not silently succeed -----------
  {
    const unknownShop = `app-proxy-verify-no-session-${process.pid}.myshopify.com`;
    const params = { shop: unknownShop, timestamp: String(Math.trunc(Date.now() / 1000)) };
    const signature = signAppProxyQuery(params);
    const qs = new URLSearchParams({ ...params, signature }).toString();
    const request = new Request(`https://example.com/apps/imprintid-pricing/pricing?${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: "LNY01", quantity: 1000 }),
    });
    const response = await action({ request, params: {}, context: {} });
    const body = await response.json();
    console.log("\n[Case D] valid signature, no installed session -> status", response.status, JSON.stringify(body));
    check("Case D status is 404 (SHOP_NOT_AVAILABLE)", response.status === 404 && body.error?.code === "SHOP_NOT_AVAILABLE");
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exitCode = 1;
} finally {
  await prisma.store.deleteMany({ where: { shopDomain: SHOP } });
  await prisma.session.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
}
