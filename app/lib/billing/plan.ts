/**
 * Single flat plan (decision: 2026-09-25) — see BILLING_ARCHITECTURE.md for the price/trial
 * record and rationale. Kept in its own side-effect-free module, separate from
 * app/shopify.server.ts, so it can be imported by unit tests without pulling in `shopifyApp()`
 * (which throws at import time if SHOPIFY_APP_URL/SHOPIFY_API_KEY aren't set).
 */
export const MONTHLY_PLAN = "ImprintID Dynamic Pricing Monthly";
