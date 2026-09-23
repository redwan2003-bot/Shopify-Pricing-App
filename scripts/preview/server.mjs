// Local storefront preview harness for the ImprintID theme app block.
//
// Renders extensions/imprintid-dynamic-pricing/blocks/dynamic-pricing.liquid with liquidjs
// (mimicking Shopify's `t` filter, including its "translation missing" output), serves the
// real block CSS/JS, and answers the App Proxy URL by calling the REAL route module
// (app/routes/apps.imprintid-pricing.pricing.tsx) with a genuinely HMAC-signed request
// against the local database. Only the two Shopify Admin GraphQL calls the route makes
// (variant verification and the enforcement-policy metafields) are stubbed, because a local
// Admin token is not available.
//
//   npm run preview:storefront          (then open http://localhost:4173)
//
// Data: the harness uses its own isolated store `preview-harness.myshopify.com`, seeded from
// the catalog CSV on first run (PREVIEW_CSV, default ../imprintid_catalog_shopify_import_updated.csv)
// with product ids copied from the dev store's overrides. Nothing here touches Shopify.
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXT = path.join(ROOT, "extensions/imprintid-dynamic-pricing");
const PORT = Number(process.env.PREVIEW_PORT || 4173);
const HARNESS_SHOP = "preview-harness.myshopify.com";
const DEV_SHOP = "imprintid-pricing-dev.myshopify.com";
const CSV = process.env.PREVIEW_CSV || path.resolve(ROOT, "imprintid_catalog_shopify_import_updated.csv");

process.env.SHOPIFY_API_KEY ??= "preview_api_key";
process.env.SHOPIFY_API_SECRET ??= "preview_shared_secret_value";
process.env.SCOPES ??= "write_products";
process.env.SHOPIFY_APP_URL ??= "https://example.com";

const { PrismaClient } = await import("@prisma/client");
const { Liquid } = await import("liquidjs");
const { shopPolicyValue } = await import(pathToFileURL(path.join(ROOT, "scripts/shopify/constants.mjs")).href);
const prisma = new PrismaClient();

// ---------------------------------------------------------------------------------------
// Harness data
// ---------------------------------------------------------------------------------------
const SHOWCASE = [
  { key: "lny01", sku: "LNY01", title: '1" Nylon Lanyards (Screen Print)' },
  { key: "ldspk", sku: "LDSPK", title: "3/4 inch Dye-Sublimation Carabiner Pocket Lanyards (Sublimation)" },
  { key: "lwv01", sku: "LWV01", title: '1" Woven Lanyards (Woven)' },
  { key: "unpriced", sku: "LB58", title: "5/8 inch Blank Polyester Lanyards (no pricing profile)", unpriced: true },
];
const COLORS = ["White", "Black", "Royal-Blue"];

async function ensureHarnessData() {
  const store = await prisma.store.findUnique({ where: { shopDomain: HARNESS_SHOP } });
  const have = store ? await prisma.pricingProfile.count({ where: { storeId: store.id } }) : 0;
  if (have < 100) {
    if (!fs.existsSync(CSV)) throw new Error(`catalog CSV not found at ${CSV} (set PREVIEW_CSV)`);
    console.log("[preview] seeding harness store from CSV …");
    execFileSync(process.execPath, [path.join(ROOT, "scripts/import-catalog-pricing.ts"), CSV, "--shop", HARNESS_SHOP], {
      cwd: ROOT,
      stdio: "ignore",
    });
  }
  const harness = await prisma.store.findUniqueOrThrow({ where: { shopDomain: HARNESS_SHOP } });
  const dev = await prisma.store.findUnique({ where: { shopDomain: DEV_SHOP } });
  const profiles = await prisma.pricingProfile.findMany({ where: { storeId: harness.id }, select: { id: true, sku: true } });
  const bySku = new Map(profiles.map((p) => [p.sku, p.id]));
  if (dev) {
    const devOverrides = await prisma.productPricingOverride.findMany({
      where: { storeId: dev.id },
      include: { pricingProfile: { select: { sku: true } } },
    });
    for (const o of devOverrides) {
      const pid = o.pricingProfile && bySku.get(o.pricingProfile.sku);
      if (!pid) continue;
      await prisma.productPricingOverride.upsert({
        where: { storeId_shopifyProductId: { storeId: harness.id, shopifyProductId: o.shopifyProductId } },
        update: { pricingProfileId: pid, isActive: true },
        create: { storeId: harness.id, shopifyProductId: o.shopifyProductId, pricingProfileId: pid, isActive: true },
      });
    }
  }
  await prisma.session.upsert({
    where: { id: `offline_${HARNESS_SHOP}` },
    update: { accessToken: "preview-fake-token", expires: null },
    create: {
      id: `offline_${HARNESS_SHOP}`,
      shop: HARNESS_SHOP,
      state: "preview",
      isOnline: false,
      accessToken: "preview-fake-token",
      scope: "write_products",
      expires: null,
    },
  });
  return harness;
}

const harnessStore = await ensureHarnessData();

async function buildProducts() {
  const products = {};
  let n = 0;
  for (const spec of SHOWCASE) {
    n += 1;
    let gidNum = `8438099999${String(n).padStart(3, "0")}`;
    let profile = null;
    if (!spec.unpriced) {
      profile = await prisma.pricingProfile.findFirst({ where: { storeId: harnessStore.id, sku: spec.sku } });
      if (!profile) throw new Error(`no ${spec.sku} pricing profile in the harness store`);
      let ov = await prisma.productPricingOverride.findFirst({ where: { storeId: harnessStore.id, pricingProfileId: profile.id } });
      if (!ov) {
        ov = await prisma.productPricingOverride.create({
          data: { storeId: harnessStore.id, shopifyProductId: `gid://shopify/Product/${gidNum}`, pricingProfileId: profile.id, isActive: true },
        });
      }
      gidNum = ov.shopifyProductId.replace(/^gid:\/\/shopify\/Product\//, "");
    }
    const variants = COLORS.map((c, i) => ({
      id: `44${String(n).padStart(2, "0")}${String(i + 1).padStart(3, "0")}00000`,
      sku: `${spec.sku}_${c}`,
      available: true,
      title: c,
    }));
    products[spec.key] = {
      spec,
      id: gidNum,
      handle: spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40),
      title: spec.title,
      variants,
      profile,
    };
  }
  return products;
}
const PRODUCTS = await buildProducts();
const VARIANT_TO_PRODUCT = new Map();
for (const p of Object.values(PRODUCTS)) for (const v of p.variants) VARIANT_TO_PRODUCT.set(v.id, p);

// ---------------------------------------------------------------------------------------
// Stub ONLY the Shopify Admin GraphQL calls, before the Shopify adapter captures fetch.
// ---------------------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const ADJUSTMENT_GID = process.env.IMPRINTID_ADJUSTMENT_VARIANT_ID || "gid://shopify/ProductVariant/49349058199691";
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/\/admin\/api\/[^/]+\/graphql\.json/.test(url) && url.includes(HARNESS_SHOP)) {
    const body = JSON.parse(init?.body ?? "{}");
    const q = String(body.query || "");
    let data;
    if (q.includes("ImprintIdResolveVariant")) {
      const vid = String(body.variables?.id || "").replace(/^gid:\/\/shopify\/ProductVariant\//, "");
      const p = VARIANT_TO_PRODUCT.get(vid);
      data = {
        productVariant: p
          ? { id: `gid://shopify/ProductVariant/${vid}`, availableForSale: true, product: { id: `gid://shopify/Product/${p.id}` } }
          : null,
      };
    } else if (q.includes("ImprintIdCartEnforcementPolicy")) {
      const pid = String(body.variables?.productId || "").replace(/^gid:\/\/shopify\/Product\//, "");
      const p = Object.values(PRODUCTS).find((x) => x.id === pid);
      const shopPolicy = shopPolicyValue({ adjustmentVariantGid: ADJUSTMENT_GID, enabled: true });
      const productPolicy = p?.profile
        ? { schema: 1, required: true, active: true, profileRef: p.profile.id, profileRevision: p.profile.revision, policyRevision: 1 }
        : null;
      data = {
        shop: { currencyCode: "USD", metafield: { jsonValue: shopPolicy } },
        product: { metafield: productPolicy ? { jsonValue: productPolicy } : null },
      };
    } else {
      data = null;
    }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(input, init);
};

const route = await import(pathToFileURL(path.join(ROOT, "app/routes/apps.imprintid-pricing.pricing.tsx")).href);
const inquiryRoute = await import(pathToFileURL(path.join(ROOT, "app/routes/apps.imprintid-pricing.inquiry.tsx")).href);

// ---------------------------------------------------------------------------------------
// Liquid rendering
// ---------------------------------------------------------------------------------------
const locales = JSON.parse(fs.readFileSync(path.join(EXT, "locales/en.default.json"), "utf8"));
const engine = new Liquid({ strictVariables: false, strictFilters: false, jsTruthy: false });
engine.registerFilter("t", (key) => {
  const v = String(key).split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), locales);
  return typeof v === "string" ? v : `translation missing: en.${key}`;
});
engine.registerFilter("asset_url", (f) => `/assets/${f}`);
engine.registerFilter("stylesheet_tag", (u) => `<link rel="stylesheet" href="${u}" media="all">`);

const blockSource = fs.readFileSync(path.join(EXT, "blocks/dynamic-pricing.liquid"), "utf8").replace(/{%\s*schema\s*%}[\s\S]*?{%\s*endschema\s*%}/, "");

function liquidProduct(p) {
  const v0 = p.variants[0];
  return { id: Number(p.id), handle: p.handle, title: p.title, variants: p.variants, selected_or_first_available_variant: v0 };
}

async function renderBlock(p) {
  return engine.parseAndRender(blockSource, {
    product: liquidProduct(p),
    block: { id: "preview", settings: { product: null, sku_override: "", show_breakdown_by_default: false }, shopify_attributes: "" },
    section: { id: "preview-section" },
  });
}

function pageHtml(p, blockHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${p.title} — preview</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#121212;background:#fff}
  .bar{background:#121212;color:#fff;padding:10px 16px;font-size:13px}
  .wrap{max-width:1100px;margin:0 auto;padding:16px;display:grid;grid-template-columns:minmax(0,1fr);gap:24px}
  @media(min-width:900px){.wrap{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
  .media{background:#f3f3f3;aspect-ratio:1;display:flex;align-items:center;justify-content:center;color:#888;border-radius:4px}
  h1{font-size:28px;margin:0 0 12px}
  .product-form__submit{width:100%;padding:14px;border:1px solid #121212;background:#121212;color:#fff;font-size:16px;cursor:pointer;margin:12px 0 8px}
  .shopify-payment-button__button{width:100%;padding:14px;border:0;background:#5a31f4;color:#fff;font-size:16px;cursor:pointer}
</style></head><body>
<div class="bar">Preview harness · ${p.spec.key} · product ${p.id}</div>
<div id="shopify-section-preview-section" class="shopify-section"><div class="wrap"><div class="media">product image</div>
<div class="info"><h1>${p.title}</h1>
<form method="post" action="/cart/add" id="product-form" class="product-form" novalidate>
  <input type="hidden" name="id" value="${p.variants[0].id}">
  <button type="submit" name="add" class="product-form__submit">Add to cart</button>
  <div data-shopify="payment-button" class="shopify-payment-button"><button type="button" class="shopify-payment-button__button">Buy it now</button></div>
</form>
${blockHtml}
</div></div></div></body></html>`;
}

// ---------------------------------------------------------------------------------------
// App-proxy signing + HTTP server
// ---------------------------------------------------------------------------------------
function signQuery(params) {
  const message = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).reduce((acc, [k, v]) => `${acc}${k}=${v}`, "");
  return crypto.createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(message).digest("hex");
}

const cartLog = [];
const MIME = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (u.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    if (u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<h1>Preview harness</h1><ul>${Object.values(PRODUCTS).map((p) => `<li><a href="/p/${p.spec.key}">${p.title}</a></li>`).join("")}</ul>`);
    }
    if (u.pathname.startsWith("/p/")) {
      const p = PRODUCTS[u.pathname.slice(3)];
      if (!p) { res.writeHead(404); return res.end("no such product"); }
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(pageHtml(p, await renderBlock(p)));
    }
    if (u.pathname.startsWith("/assets/")) {
      const f = path.join(EXT, "assets", path.basename(u.pathname));
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(f));
    }
    if (u.pathname === "/__cart-log") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(cartLog));
    }
    if (u.pathname === "/cart/add.js" && req.method === "POST") {
      const raw = (await readBody(req)).toString("utf8");
      cartLog.push({ contentType: req.headers["content-type"], body: raw });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ items: [{ id: 1, quantity: 1 }] }));
    }
    if (u.pathname === "/apps/imprintid-pricing/pricing" || u.pathname === "/apps/imprintid-pricing/inquiry") {
      const params = { shop: HARNESS_SHOP, timestamp: String(Math.trunc(Date.now() / 1000)) };
      for (const [k, v] of u.searchParams) params[k] = v;
      const signature = signQuery(params);
      const qs = new URLSearchParams({ ...params, signature }).toString();
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const request = new Request(`https://example.com${u.pathname}?${qs}`, {
        method: req.method,
        headers: { "Content-Type": req.headers["content-type"] || "application/json" },
        body,
      });
      const handler = u.pathname.endsWith("/inquiry") ? inquiryRoute.action : req.method === "POST" ? route.action : route.loader;
      const response = await handler({ request, params: {}, context: {} });
      res.writeHead(response.status, { "Content-Type": "application/json" });
      return res.end(await response.text());
    }
    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    console.error("[preview] error:", e);
    res.writeHead(500);
    res.end(String(e));
  }
});

server.listen(PORT, () => console.log(`[preview] http://localhost:${PORT}  (harness shop ${HARNESS_SHOP})`));
