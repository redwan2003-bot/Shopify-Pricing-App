import crypto from "node:crypto";
process.env.SHOPIFY_API_KEY = "live_key";
process.env.SHOPIFY_API_SECRET = "live_shared_secret_value";
process.env.SCOPES = "write_products,write_cart_transforms,write_validations";
process.env.SHOPIFY_APP_URL = "https://example.com";
const SHOP = `billing-live-${process.pid}.myshopify.com`;
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
await prisma.session.create({ data: { id: `offline_${SHOP}`, shop: SHOP, state: "x", isOnline: false, accessToken: "t", scope: process.env.SCOPES } });

const ACTIVE_SUBSCRIPTION = {
  id: "gid://shopify/AppSubscription/live1",
  name: "ImprintID Dynamic Pricing Monthly",
  test: true,
  trialDays: 14,
  createdAt: "2026-09-25T00:00:00Z",
  currentPeriodEnd: "2026-10-25T00:00:00Z",
  returnUrl: "https://example.com/app/billing",
  lineItems: [],
  status: "ACTIVE",
};
const store = { billingActive: false, createCalls: 0, cancelCalls: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.includes(`${SHOP}/admin/api`)) return realFetch(input, init);
  const { query, variables } = JSON.parse(init.body);
  let data;
  if (query.includes("appSubscription("))
    data = {
      currentAppInstallation: {
        activeSubscriptions: store.billingActive ? [ACTIVE_SUBSCRIPTION] : [],
        oneTimePurchases: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    };
  else if (query.includes("AppSubscriptionCreate")) {
    store.createCalls++;
    store.lastCreateVariables = variables;
    data = {
      appSubscriptionCreate: {
        appSubscription: { ...ACTIVE_SUBSCRIPTION, id: "gid://shopify/AppSubscription/pending1", status: "PENDING" },
        confirmationUrl: "https://admin.shopify.com/store/billing-live/charges/pending1/confirm_recurring_application_charge",
        userErrors: [],
      },
    };
  } else if (query.includes("appSubscriptionCancel")) {
    store.cancelCalls++;
    store.lastCancelVariables = variables;
    data = { appSubscriptionCancel: { appSubscription: { ...ACTIVE_SUBSCRIPTION, status: "CANCELLED" }, userErrors: [] } };
    store.billingActive = false;
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
// Session-token (Bearer) requests are what App Bridge sends from an embedded page — this is the
// realistic path, and it's also what exercises the 401 + reauth-header redirect flow (rather than
// a plain 3xx Location), so this script asserts against that header rather than the usual pattern.
const req = (form) =>
  new Request(`https://example.com/app/billing?shop=${SHOP}`, {
    method: form ? "POST" : "GET",
    headers: { Authorization: `Bearer ${sessionToken()}`, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });

const { billingLoader, billingAction } = await import("../app/lib/billing/billing-route.server.ts");
let fail = 0;
const ok = (l, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"} - ${l}${d ? ` (${d})` : ""}`);
  if (!c) fail++;
};

try {
  // --- no subscription ---
  let l = await billingLoader({ request: req(), params: {}, context: {} });
  ok("loader: no subscription reports hasActivePayment=false, no crash", l.hasActivePayment === false && l.subscription === null && l.checkFailed === false, JSON.stringify(l));
  ok("loader: test mode is on by default outside NODE_ENV=production", l.isTest === true);
  ok("loader: reports the configured plan name", l.planName === "ImprintID Dynamic Pricing Monthly");

  // --- subscribe: throws a 401 carrying the reauth/confirmation URL (the App Bridge XHR path) ---
  let threw = null;
  try {
    await billingAction({ request: req({ intent: "subscribe" }), params: {}, context: {} });
  } catch (e) {
    threw = e;
  }
  const reauthUrl = threw instanceof Response ? threw.headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url") : null;
  ok(
    "action(subscribe): throws a 401 carrying Shopify's confirmation URL for the merchant to approve",
    threw instanceof Response && threw.status === 401 && reauthUrl === "https://admin.shopify.com/store/billing-live/charges/pending1/confirm_recurring_application_charge",
    `status=${threw?.status} url=${reauthUrl}`,
  );
  ok("action(subscribe): requested the configured plan in test mode", store.createCalls === 1 && store.lastCreateVariables.name === "ImprintID Dynamic Pricing Monthly" && store.lastCreateVariables.test === true, JSON.stringify(store.lastCreateVariables));
  ok("action(subscribe): requested the configured price and 14-day trial", store.lastCreateVariables.trialDays === 14 && store.lastCreateVariables.lineItems[0].plan.appRecurringPricingDetails.price.amount === 29.99, JSON.stringify(store.lastCreateVariables.lineItems));

  // --- merchant approves: subscription is now active ---
  store.billingActive = true;
  l = await billingLoader({ request: req(), params: {}, context: {} });
  ok("loader: after approval, reports the active subscription's details", l.hasActivePayment === true && l.subscription?.status === "ACTIVE" && l.subscription?.name === "ImprintID Dynamic Pricing Monthly", JSON.stringify(l.subscription));

  // --- cancel ---
  let r = await billingAction({ request: req({ intent: "cancel", subscriptionId: l.subscription.id }), params: {}, context: {} });
  ok("action(cancel): cancels and reports the storefront/existing-profile impact", r.ok && /storefront keeps quoting/.test(r.message), r.message);
  ok("action(cancel): the mutation ran once for the right subscription id", store.cancelCalls === 1 && store.lastCancelVariables.id === "gid://shopify/AppSubscription/live1");
  l = await billingLoader({ request: req(), params: {}, context: {} });
  ok("loader: reports no active subscription after cancellation", l.hasActivePayment === false);

  // --- cancel with no subscription id ---
  r = await billingAction({ request: req({ intent: "cancel", subscriptionId: "" }), params: {}, context: {} });
  ok("action(cancel): refuses cleanly with no subscription id", !r.ok && /no subscription/i.test(r.message), r.message);

  // --- unrecognized intent ---
  r = await billingAction({ request: req({ intent: "bogus" }), params: {}, context: {} });
  ok("action: an unrecognized intent is refused, not silently ignored", !r.ok, r.message);
} finally {
  await prisma.session.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
}
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
