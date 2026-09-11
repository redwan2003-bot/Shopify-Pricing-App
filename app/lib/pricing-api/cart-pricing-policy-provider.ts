/**
 * Task 5B.3A / 5B.3A.1 — the production `CartPricingPolicyProvider`.
 *
 * Resolves the AUTHORITATIVE THREE-STATE decision (`enforce` | `bypass` | `block`) a
 * storefront request needs, reading ONLY server-trusted, merchant-uneditable sources:
 *   - the authenticated shop domain (from the verified App Proxy session);
 *   - the app-owned shop metafield  `$app:imprintid/enforcement_policy`;
 *   - the app-owned product metafield `$app:imprintid/pricing_policy`.
 *
 * NOTHING here is taken from the storefront request body.
 *
 * Decision mapping:
 *   - shop policy metafield absent               → block:shop_policy_missing
 *   - shop policy present but malformed          → block:shop_policy_malformed
 *   - shop policy `enabled:false` or mode `disabled` → BYPASS:shop_disabled
 *   - mode `maintenance`                         → block:maintenance
 *   - mode `pilot`, product metafield absent     → BYPASS:pilot_unmarked
 *   - mode `pilot`, product metafield malformed  → block:product_policy_malformed
 *   - mode `pilot`, product `required:false`     → BYPASS:pilot_unmarked
 *   - mode `pilot`, product `required:true` + `active:false` → block:required_policy_inactive
 *   - mode `pilot`, product `required:true` + `active:true`  → ENFORCE
 *   - mode `universal`, product metafield absent → block:universal_policy_missing
 *   - mode `universal`, product malformed        → block:product_policy_malformed
 *   - mode `universal`, product `active:false`   → block:required_policy_inactive
 *   - mode `universal`, product `active:true`    → ENFORCE
 *   - no Admin client / GraphQL failure / no product id → block:provider_failure
 *
 * An `enforce` decision also carries `context.shopCurrency` (Admin `shop.currencyCode`,
 * normalized) — Task 5B.3B.2. The signer requires the pricing-profile currency to equal
 * it before issuing a quote; this provider does not itself reject on currency (it has no
 * profile currency to compare), it only supplies the shop side of that gate.
 *
 * Warnings name only the failure category — never a metafield value, GID, or revision.
 */

import type { PrismaClient } from "@prisma/client";
import type { CartPricingPolicyProvider, CartPricingPolicyDecision } from "./cart-signature.ts";
import type { AdminGraphqlClientLike } from "./product-resolver.ts";
import { toProductGid } from "./product-resolver.ts";
import { CART_PRICING_METAFIELD, normalizeCurrencyCode } from "./cart-pricing-contract.ts";
import { parseShopEnforcementPolicy, parseProductPricingPolicy } from "./policy-metafields.ts";

export interface DefaultCartPricingPolicyProviderDeps {
  prisma: PrismaClient;
  admin: AdminGraphqlClientLike | null;
}

const POLICY_QUERY = `#graphql
  query ImprintIdCartEnforcementPolicy($productId: ID!) {
    shop {
      currencyCode
      metafield(namespace: "${CART_PRICING_METAFIELD.namespace}", key: "${CART_PRICING_METAFIELD.shopPolicyKey}") {
        jsonValue
      }
    }
    product(id: $productId) {
      metafield(namespace: "${CART_PRICING_METAFIELD.namespace}", key: "${CART_PRICING_METAFIELD.productPolicyKey}") {
        jsonValue
      }
    }
  }`;

interface MetafieldNode {
  present: boolean;
  jsonValue: unknown;
}

function readMetafield(node: unknown): MetafieldNode {
  if (!node || typeof node !== "object") return { present: false, jsonValue: null };
  const mf = (node as { metafield?: { jsonValue?: unknown } | null }).metafield;
  if (!mf || typeof mf !== "object") return { present: false, jsonValue: null };
  return { present: true, jsonValue: mf.jsonValue ?? null };
}

const block = (reason: Extract<CartPricingPolicyDecision, { action: "block" }>["reason"]): CartPricingPolicyDecision => ({
  action: "block",
  reason,
});
const bypass = (reason: Extract<CartPricingPolicyDecision, { action: "bypass" }>["reason"]): CartPricingPolicyDecision => ({
  action: "bypass",
  reason,
});

export function createDefaultCartPricingPolicyProvider(
  deps: DefaultCartPricingPolicyProviderDeps,
): CartPricingPolicyProvider {
  return {
    async resolve(args): Promise<CartPricingPolicyDecision> {
      const { admin } = deps;
      if (!admin) {
        console.warn("[cart-pricing:v2] no Admin GraphQL context — cannot read enforcement policy metafields; failing closed (block).");
        return block("provider_failure");
      }
      if (!args.shopifyProductId) {
        console.warn("[cart-pricing:v2] no Shopify product id on the request — failing closed (block).");
        return block("provider_failure");
      }

      let payload: unknown;
      try {
        const response = await admin.graphql(POLICY_QUERY, {
          variables: { productId: toProductGid(args.shopifyProductId) },
        });
        payload = await response.json();
      } catch (error) {
        console.error("[cart-pricing:v2] enforcement policy metafield query failed:", error);
        return block("provider_failure");
      }

      const data =
        payload && typeof payload === "object"
          ? (payload as { data?: { shop?: { currencyCode?: unknown } | null; product?: unknown } }).data
          : undefined;
      if (!data) return block("provider_failure");

      // Task 5B.3B.2 — the authenticated shop's own currency, carried on an `enforce`
      // decision so the signer can require the pricing-profile currency to match it
      // before issuing a quote. `null` when Admin did not return it ⇒ the signer fails
      // closed (CURRENCY_CONTEXT_UNAVAILABLE).
      const shopCurrency = normalizeCurrencyCode(
        data.shop && typeof data.shop === "object" ? data.shop.currencyCode : null,
      );

      const shopMf = readMetafield(data.shop);
      if (!shopMf.present) return block("shop_policy_missing");
      const shopPolicy = parseShopEnforcementPolicy(shopMf.jsonValue);
      if (!shopPolicy) return block("shop_policy_malformed");

      // Explicit, safe native bypass — the merchant turned enforcement off.
      if (!shopPolicy.enabled || shopPolicy.mode === "disabled") return bypass("shop_disabled");
      if (shopPolicy.mode === "maintenance") return block("maintenance");

      const productMf = readMetafield(data.product);
      const productPolicy = parseProductPricingPolicy(productMf.jsonValue);

      if (shopPolicy.mode === "pilot") {
        if (!productPolicy) {
          // present-but-unparseable is a mandatory fail-closed; genuinely absent is the
          // explicit "not in the pilot" bypass.
          return productMf.present ? block("product_policy_malformed") : bypass("pilot_unmarked");
        }
        if (!productPolicy.required) return bypass("pilot_unmarked");
        if (!productPolicy.active) return block("required_policy_inactive");
      } else {
        // universal — every supported product needs an active policy.
        if (!productPolicy) {
          return productMf.present ? block("product_policy_malformed") : block("universal_policy_missing");
        }
        if (!productPolicy.active) return block("required_policy_inactive");
      }

      return {
        action: "enforce",
        context: {
          installBinding: shopPolicy.installBinding,
          adjustmentVariantGid: shopPolicy.adjustmentVariantGid,
          policyRevision: shopPolicy.policyRevision,
          profileRef: productPolicy.profileRef,
          profileRevision: productPolicy.profileRevision,
          shopCurrency,
        },
      };
    },
  };
}

/** The storefront-facing enforcement state — what the browser branches on. */
export type EnforcementUiState = "enforce" | "bypass" | "block";

/**
 * Collapses a `CartPricingPolicyDecision` to the state the storefront response carries.
 * `canIssueSignedQuote` — whether this deployment could actually PRODUCE a signed v2
 * quote right now (envelope v2 + a valid signing secret + a valid adjustment GID). An
 * `enforce` decision on a deployment that cannot sign is downgraded to `block` (the
 * product is enforced but no valid quote can be issued → fail closed, stay contained).
 * `bypass` and `block` pass through unchanged.
 */
export function cartPricingEnforcementUiState(
  decision: CartPricingPolicyDecision,
  canIssueSignedQuote: boolean,
): EnforcementUiState {
  if (decision.action === "bypass") return "bypass";
  if (decision.action === "block") return "block";
  return canIssueSignedQuote ? "enforce" : "block";
}
