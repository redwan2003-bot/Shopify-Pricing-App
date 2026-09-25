import crypto from "node:crypto";
process.env.SHOPIFY_API_KEY = "live_key";
process.env.SHOPIFY_API_SECRET = "live_shared_secret_value";
process.env.SCOPES = "write_products,write_cart_transforms,write_validations";
process.env.SHOPIFY_APP_URL = "https://example.com";
const SHOP = `editor-live-${process.pid}.myshopify.com`;
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
await prisma.session.create({ data: { id: `offline_${SHOP}`, shop: SHOP, state: "x", isOnline: false, accessToken: "t", scope: process.env.SCOPES } });

// Simulated store: product 501 sells EDT01_*, product 502 sells OTHER_*.
const store = {
  products: [
    { id: "gid://shopify/Product/501", title: "Editor lanyard", skus: ["EDT01_Red", "EDT01_Blue"] },
    { id: "gid://shopify/Product/502", title: "Other", skus: ["OTHER_White"] },
  ],
  metafields: new Map(),
  writes: [],
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.includes(`${SHOP}/admin/api`)) return realFetch(input, init);
  const { query, variables } = JSON.parse(init.body);
  let data;
  if (query.includes("ImprintIdShopPolicy")) data = { shop: { currencyCode: "USD", metafield: null } };
  else if (query.includes("ImprintIdSkuIndex"))
    data = {
      products: {
        edges: store.products.map((p) => ({ cursor: p.id, node: { id: p.id, title: p.title, variants: { edges: p.skus.map((sku) => ({ node: { sku } })) } } })),
        pageInfo: { hasNextPage: false },
      },
    };
  else if (query.includes("ImprintIdPolicyRead"))
    data = { nodes: variables.ids.map((id) => ({ id, metafield: store.metafields.has(id) ? { value: store.metafields.get(id) } : null })) };
  else if (query.includes("ImprintIdPolicyWrite")) {
    for (const m of variables.metafields) {
      store.metafields.set(m.ownerId, m.value);
      store.writes.push(m);
    }
    data = { metafieldsSet: { metafields: variables.metafields.map(() => ({ id: "m" })), userErrors: [] } };
  } else data = null;
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sessionToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: process.env.SHOPIFY_API_KEY, sub: "1", exp: now + 60, nbf: now - 5, iat: now, jti: crypto.randomUUID(), sid: "s" });
  const sig = crypto.createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const req = (path, form) =>
  new Request(`https://example.com${path}${path.includes("?") ? "&" : "?"}shop=${SHOP}`, {
    method: form ? "POST" : "GET",
    headers: { Authorization: `Bearer ${sessionToken()}`, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });

const { listLoader, editLoader, editAction } = await import("../app/lib/pricing-editor/editor-route.server.ts");
let fail = 0;
const ok = (l, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"} - ${l}${d ? ` (${d})` : ""}`);
  if (!c) fail++;
};
const save = (id, draft) => editAction({ request: req(`/app/pricing-profiles/${id}`, { draft: JSON.stringify(draft) }), params: { id }, context: {} });
const policyOf = (gid) => (store.metafields.has(gid) ? JSON.parse(store.metafields.get(gid)) : null);
const P501 = "gid://shopify/Product/501";

try {
  // --- new profile ---
  const fresh = await editLoader({ request: req("/app/pricing-profiles/new"), params: { id: "new" }, context: {} });
  ok("new: blank draft in the shop's currency", fresh.isNew && fresh.draft.currency === "USD" && fresh.draft.production.length === 1);

  let r = await save("new", fresh.draft);
  ok("new: empty form is refused with field errors, nothing created", !r.ok && r.errors.some((e) => e.field === "sku") && (await prisma.pricingProfile.count({ where: { store: { shopDomain: SHOP } } })) === 0, r.message);

  const draft = structuredClone(fresh.draft);
  draft.sku = "EDT01";
  draft.name = "Editor lanyard";
  draft.tiers = [
    { min: "100", max: "299", list: "2.29", net: "1.37" },
    { min: "300", max: "", list: "2.12", net: "1.27" },
  ];
  draft.decorations = [{ method: "SCREEN_PRINT", slots: { SETUP_1C1L: { name: "", list: "45.00", net: "36.00" }, COLOR_2_RUN: { name: "", list: "0.25", net: "0.20" } } }];
  draft.optionGroups = [{ name: "Attachment", kind: "ATTACHMENT", isRequired: false, values: [{ label: "Oval hook", code: "", list: "0.31", net: "0.23", isDefault: false }] }];
  r = await save("new", draft);
  const created = await prisma.pricingProfile.findFirst({ where: { store: { shopDomain: SHOP }, sku: "EDT01" } });
  ok("new: valid profile saves and redirects to its page", r instanceof Response && created && (r.headers.get("Location") ?? "").includes(`/app/pricing-profiles/${created.id}?saved=1`), r instanceof Response ? `${r.status} ${r.headers.get("Location")}` : JSON.stringify(r));
  let pol = policyOf(P501);
  ok("new: product 501 linked to the new profile at its revision", pol && pol.profileRef === created.id && pol.profileRevision === created.revision && pol.active === true, JSON.stringify(pol));

  // --- list ---
  let list = await listLoader({ request: req("/app/pricing-profiles"), params: {}, context: {} });
  const row = list.profiles.find((p) => p.sku === "EDT01");
  ok("list: shows the profile with its counts and linked product", row && row.tiers === 2 && row.optionGroups === 1 && row.linkedProducts.join() === "501", JSON.stringify(row));
  list = await listLoader({ request: req("/app/pricing-profiles?q=edt"), params: {}, context: {} });
  ok("list: search matches on SKU", list.total === 1);
  list = await listLoader({ request: req("/app/pricing-profiles?q=zzz"), params: {}, context: {} });
  ok("list: search with no match is empty", list.total === 0 && list.profiles.length === 0);

  // --- edit ---
  const loaded = await editLoader({ request: req(`/app/pricing-profiles/${created.id}`), params: { id: created.id }, context: {} });
  ok("edit: stored prices come back exactly", JSON.stringify(loaded.draft.tiers) === JSON.stringify(draft.tiers) && loaded.draft.decorations[0].slots.SETUP_1C1L.net === "36.00" && loaded.draft.optionGroups[0].values[0].net === "0.23", JSON.stringify(loaded.draft.tiers));

  const writesBefore = store.writes.length;
  r = await save(created.id, loaded.draft);
  const same = await prisma.pricingProfile.findUnique({ where: { id: created.id } });
  ok("edit: saving unchanged keeps the revision, no metafield write", r.ok && /no price changes/.test(r.message) && same.revision === created.revision && store.writes.length === writesBefore, r.message);

  const changed = structuredClone(loaded.draft);
  changed.tiers[0].net = "1.30";
  r = await save(created.id, changed);
  const bumped = await prisma.pricingProfile.findUnique({ where: { id: created.id }, include: { quantityTiers: true } });
  pol = policyOf(P501);
  ok("edit: a price change saves exactly (130 cents)", r.ok && bumped.quantityTiers.some((t) => t.minQuantity === 100 && t.netPriceCents === 130), r.message);
  ok("edit: revision bumped and the product relinked to it", bumped.revision > created.revision && pol.profileRevision === bumped.revision, `${created.revision} -> ${bumped.revision}, policy ${pol.profileRevision}`);
  ok("edit: warns about carts needing re-pricing", /reconfigure/.test(r.message), r.message);

  const renamed = structuredClone(changed);
  renamed.sku = "EDT02";
  r = await save(created.id, renamed);
  ok("edit: SKU change is refused", !r.ok && r.errors[0].field === "sku", r.message);

  const bad = structuredClone(changed);
  bad.tiers[0].list = "2.2.9";
  bad.optionGroups[0].values[0].label = "";
  r = await save(created.id, bad);
  ok("edit: bad input comes back per field, nothing saved", !r.ok && r.errors.some((e) => e.field === "tiers.0.list") && r.errors.some((e) => e.field === "optionGroups.0.values.0.label") && (await prisma.pricingProfile.findUnique({ where: { id: created.id } })).revision === bumped.revision, r.errors.map((e) => e.field).join(","));

  const netAboveList = structuredClone(changed);
  netAboveList.tiers[0].net = "9.99";
  r = await save(created.id, netAboveList);
  ok("edit: net above list is refused by the importer's validation", !r.ok && r.message === "Not saved: Quantity break 1, net price must not exceed the list price.", r.message);

  r = await editAction({ request: req(`/app/pricing-profiles/${created.id}`, { draft: "{not json" }), params: { id: created.id }, context: {} });
  ok("edit: unreadable form gives a friendly error", !r.ok && /could not be read/.test(r.message));

  // --- duplicates, unlinked, other shops ---
  r = await save("new", draft);
  ok("new: duplicate SKU is refused", !r.ok && r.errors[0].field === "sku", r.message);

  const orphan = structuredClone(draft);
  orphan.sku = "NOPROD1";
  orphan.name = "No product yet";
  r = await save("new", orphan);
  const orphanRow = await prisma.pricingProfile.findFirst({ where: { store: { shopDomain: SHOP }, sku: "NOPROD1" } });
  ok("new: a profile with no matching product still saves", r instanceof Response && orphanRow);
  const orphanDraft = (await editLoader({ request: req(`/app/pricing-profiles/${orphanRow.id}`), params: { id: orphanRow.id }, context: {} })).draft;
  orphanDraft.tiers[0].net = "1.00";
  r = await save(orphanRow.id, orphanDraft);
  ok("edit: unlinked profile says it isn't linked yet", r.ok && r.linked === false && /isn't linked/.test(r.message) && !/cart/.test(r.message), r.message);

  const foreign = await prisma.pricingProfile.findFirst({ where: { store: { shopDomain: { not: SHOP } } }, select: { id: true } });
  if (foreign) {
    let status = null;
    try {
      await editLoader({ request: req(`/app/pricing-profiles/${foreign.id}`), params: { id: foreign.id }, context: {} });
    } catch (e) {
      status = e instanceof Response ? e.status : String(e);
    }
    ok("another shop's profile can't be opened (404)", status === 404, String(status));
    r = await save(foreign.id, draft);
    ok("another shop's profile can't be saved", !r.ok && /no longer exists/.test(r.message), r.message);
  } else console.log("SKIP - no other shop's profile in this database");
} finally {
  await prisma.store.deleteMany({ where: { shopDomain: SHOP } });
  await prisma.session.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
}
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
