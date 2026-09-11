/**
 * Task 5B.3B.2 — currency safety for signed cart-pricing enforcement.
 *
 * INITIAL-RELEASE STANCE — single currency, NO foreign-exchange:
 *
 *  - The app NEVER invents or fetches an exchange rate.
 *  - The browser NEVER supplies or overrides a currency. Every currency value used for
 *    a *signing* decision comes from a server-trusted source (the pricing-profile row +
 *    the authenticated shop); every currency value used for *verification* comes from
 *    Shopify's own cart cost inside a Function, never a cart line property.
 *  - A signed, enforceable v2 quote is issued ONLY when the authoritative pricing-
 *    profile currency EQUALS the authenticated shop's currency. Anything else fails
 *    closed: no signed quote (server), no price operation (Cart Transform — see
 *    `verifyCartPricingAttributesV2`), and the Validation Function blocks the required
 *    product from checkout.
 *
 * Reasons — surfaced in server logs / Function reject codes, NEVER shown raw to a
 * customer:
 *  - `PROFILE_SHOP_CURRENCY_MISMATCH` — profile currency ≠ shop currency (server, pre-sign).
 *  - `QUOTE_CART_CURRENCY_MISMATCH`   — signed quote currency ≠ Shopify cart currency
 *                                       (Function; the Function reject code is
 *                                       `currency_mismatch`).
 *  - `CURRENCY_CONTEXT_UNAVAILABLE`   — a currency value required to compare is missing
 *                                       or malformed (server: no quote; Function reject
 *                                       code `currency_context_unavailable`).
 *
 * `normalizeCurrencyCode` is deliberately imported from `cart-pricing-contract.ts` (the
 * single source of truth, mirrored verbatim into both Functions) so the server and the
 * Functions normalize a currency code identically.
 */

import { normalizeCurrencyCode } from "./cart-pricing-contract.ts";

export { normalizeCurrencyCode };

export type CurrencySafetyReason =
  | "PROFILE_SHOP_CURRENCY_MISMATCH"
  | "QUOTE_CART_CURRENCY_MISMATCH"
  | "CURRENCY_CONTEXT_UNAVAILABLE";

export type EnforceableCurrencyResult =
  | { ok: true; currency: string }
  | {
      ok: false;
      reason: Extract<CurrencySafetyReason, "PROFILE_SHOP_CURRENCY_MISMATCH" | "CURRENCY_CONTEXT_UNAVAILABLE">;
    };

/**
 * The server-side gate: may a signed, enforceable v2 quote be issued for a profile
 * priced in `profileCurrency`, for a shop whose authoritative currency is `shopCurrency`?
 *
 *  - either value missing / not a valid ISO-4217 alpha code → `CURRENCY_CONTEXT_UNAVAILABLE`
 *  - both valid but different                               → `PROFILE_SHOP_CURRENCY_MISMATCH`
 *  - both valid and equal                                   → `{ ok: true, currency }`
 *
 * No conversion is ever attempted. There is no default — an absent profile currency is
 * a fail-closed condition, not "assume USD".
 */
export function resolveEnforceableCurrency(
  profileCurrency: unknown,
  shopCurrency: unknown,
): EnforceableCurrencyResult {
  const profile = normalizeCurrencyCode(profileCurrency);
  const shop = normalizeCurrencyCode(shopCurrency);
  if (profile === null || shop === null) {
    return { ok: false, reason: "CURRENCY_CONTEXT_UNAVAILABLE" };
  }
  if (profile !== shop) {
    return { ok: false, reason: "PROFILE_SHOP_CURRENCY_MISMATCH" };
  }
  return { ok: true, currency: profile };
}
