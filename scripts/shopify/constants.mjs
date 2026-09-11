/**
 * Task 5B.3B.2 — DEVELOPMENT-STORE provisioning constants.
 *
 * These describe the ONE authorized development store and the exact resources the
 * ImprintID pilot needs. Nothing here is a secret, a token, or an authenticated URL.
 * The store is hard-coded and cannot be overridden by an argument or an environment
 * variable — a production store is unreachable by construction.
 */

/** The ONLY store this tooling will ever talk to.
 * Repointed from imprintid-pricing-development.myshopify.com (dead — no longer
 * resolves in this account) to the replacement dev store. */
export const DEV_STORE = "imprintid-pricing-dev.myshopify.com";
export const DEV_STORE_HANDLE = "imprintid-pricing-dev";

/** Admin API version — matches `app/shopify.server.ts` `ApiVersion.July26`. */
export const API_VERSION = "2026-07";

/** The real LNY01 Shopify product on the dev store (has an active ProductPricingOverride
 * → the pilot's single enforced product). Found by title search ("1\" Nylon Lanyards")
 * on imprintid-pricing-dev.myshopify.com — variant SKUs are per-color (LNY01_White-Lanyard
 * etc.), so no variant's SKU literally equals "LNY01". */
export const LNY01_PRODUCT_GID = "gid://shopify/Product/8438071820427";

/** The app-reserved metafield namespace + keys (mirrors `cart-pricing-contract.ts`). */
export const APP_NS = "$app:imprintid";
export const SHOP_POLICY_KEY = "enforcement_policy";
export const PRODUCT_POLICY_KEY = "pricing_policy";

/** Function handles — must equal the `handle` in each extension's `shopify.extension.toml`. */
export const TRANSFORM_HANDLE = "imprintid-cart-pricing";
export const VALIDATION_HANDLE = "imprintid-cart-validation";
export const VALIDATION_TITLE = "ImprintID Dynamic Pricing Validation";

/** The development-only adjustment product the Cart Transform expands lines into. */
export const ADJ_PRODUCT_TITLE = "DEV ONLY — ImprintID Pricing Adjustment";
export const ADJ_PRODUCT_VENDOR = "ImprintID (dev)";
export const ADJ_PRODUCT_TYPE = "ImprintID Pricing Adjustment";
export const ADJ_PRODUCT_TAGS = ["imprintid-internal", "do-not-sell-directly"];
export const ADJ_PRODUCT_DESCRIPTION_HTML =
  "<p>Development-only. Used by the ImprintID Cart Transform Function to expand a cart " +
  "line into base + surcharge components. Direct addition to cart is blocked by the " +
  "ImprintID Validation Function. Do not add to collections, promote, or sell directly.</p>";

/** The exact variant shape this provisioner owns and reconciles on every `--prepare`. */
export const ADJ_VARIANT_DESIRED = Object.freeze({
  price: "0.01",
  inventoryPolicy: "CONTINUE", // sellable at zero stock — the component must never be "unavailable"
  taxable: false,
  inventoryTracked: false,
  requiresShipping: false,
});

/** Local pricing-profile identity for LNY01 (see `prisma` — the active LNY01
 * `PricingProfile.id`). `profileRevision` / `policyRevision` are synthetic stable dev
 * values (the local schema has no revision column). */
export const PROFILE_REF = "cmtxfdpjh05h78zg4cjauv98d";
export const PROFILE_REVISION = 1;
export const POLICY_REVISION = 1;

/** A stable, opaque per-install binding for the dev pilot. */
export const INSTALL_BINDING = "dev-imprintid-pricing-development-pilot-1";

/** The app-owned shop enforcement policy this provisioner writes. `enabled` starts
 * FALSE — only `--enable-pilot` flips it, and only after activation. */
export function shopPolicyValue({ adjustmentVariantGid, enabled }) {
  return {
    schema: 1,
    mode: "pilot",
    enabled: enabled === true,
    adjustmentVariantGid,
    installBinding: INSTALL_BINDING,
    policyRevision: POLICY_REVISION,
  };
}

/** The app-owned product pricing policy for LNY01. */
export function productPolicyValue() {
  return {
    schema: 1,
    required: true,
    active: true,
    profileRef: PROFILE_REF,
    profileRevision: PROFILE_REVISION,
    policyRevision: POLICY_REVISION,
  };
}

/** Ordered phases. Each is strictly its own step — no phase performs a later one. */
export const PHASES = Object.freeze(["check", "prepare", "activate", "enable-pilot", "rollback-check"]);

/** The phases that mutate Shopify or the local `.env`. They refuse to start without a
 * confirmed authenticated-session lease (see `MUTATION_LEASE_MINUTES`). */
export const MUTATING_PHASES = Object.freeze(["prepare", "activate", "enable-pilot"]);

/** Minimum minutes of remaining offline-session validity required before a mutating
 * phase may start — long enough to finish the phase's Admin round-trips well inside the
 * token's life. `--check` / `--rollback-check` are exempt (read-only / no Admin writes). */
export const MUTATION_LEASE_MINUTES = 15;

/** Monotonic phase-reached ladder recorded in the receipt. */
export const PHASE_RANK = Object.freeze({ none: 0, prepared: 1, activated: 2, "pilot-enabled": 3 });

export const SCRIPT_VERSION = "5B.3B.2";

/** Path (relative to repo root) of the git-ignored recovery receipt. */
export const RECEIPT_RELPATH = ".shopify/provision-receipt.json";

/** Scopes the provisioning mutations require (each `write_*` also grants the matching
 * read). Shopify does NOT list the implicit `read_*` in a token's scope string, so this
 * checks ONLY the writes. */
export const REQUIRED_SCOPES = ["write_products", "write_cart_transforms", "write_validations"];
