/**
 * THIS FILE IS GENERATED — see scripts/generate-config.mjs.
 *
 * Shopify Functions have no runtime environment/secret access (no `process.env` inside
 * the WASM sandbox — see this extension's top-level doc comment in
 * cart_transform_run.ts for the full explanation). The signing secret therefore has to
 * be baked into the compiled function at build time, not read at runtime.
 *
 * The checked-in value below is a deliberately non-functional placeholder — an empty
 * secret makes `verifyCartPricingAttributes` fail closed (every line is rejected,
 * nothing is ever silently trusted) rather than fail open. Before building or
 * deploying this extension for real, run:
 *
 *   IMPRINTID_CART_SIGNING_SECRET=<a real secret> node scripts/generate-config.mjs
 *
 * which overwrites this file with the real value. That secret must match
 * `IMPRINTID_CART_SIGNING_SECRET` in the main app's server environment (see
 * app/lib/pricing-api/cart-signature.ts) — it is intentionally a *different* secret
 * from `SHOPIFY_API_SECRET` (the OAuth app secret): baking the OAuth secret itself into
 * a distributable WASM binary would mean a compromised/extracted function leaks full
 * app credentials, not just cart-pricing signing ability.
 */
export const CART_SIGNING_SECRET = "";
