import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
  ValidationError,
} from "../generated/api.ts";
import { CART_SIGNING_SECRET } from "./config.generated.ts";
import {
  normalizeValidationInput,
  resolveParent,
  type NormalizedValidationInput,
  type NormalizedValidationLine,
} from "./normalize-input.ts";
import {
  parseShopEnforcementPolicy,
  parseProductPricingPolicy,
  verifyCartPricingAttributesV2,
  parseV2Payload,
  type ShopEnforcementPolicy,
  type ProductPricingPolicy,
} from "./verify-payload-v2.ts";
import { CART_PRICING_LIMITS, type CartPricingPayloadV2, type QuoteRejectCode } from "./cart-pricing-contract.ts";
import { expectedExpandedComponents, hasComponentMultisetMismatch } from "./expanded-components.ts";

/**
 * imprintid-cart-validation — Cart & Checkout Validation Function.
 *
 * DEVELOPMENT-DRAFT ONLY. Not deployed, not activated, no Checkout Rule. It independently
 * re-verifies the server's signed v2 quote against **Shopify-owned** data (the app-owned
 * shop `enforcement_policy` + product `pricing_policy` metafields) and blocks the cart
 * (`$.cart`) for every enforced line whose quote is missing / invalid / mismatched.
 *
 * NEVER calculates a price. NEVER uses a clock (replay/expiry is revision-bound).
 * Envelope v1 is ALWAYS rejected for an enforced line.
 *
 * TASK 5B.2.1 — ACTIVATION READINESS. `activationReadiness()` is the single auditable
 * gate the exported run path consults. While effective-price runtime semantics are
 * unverified (`EFFECTIVE_PRICE_ENFORCED === false`), the Function is **NOT activation
 * ready**: checkout for every enforced pilot/universal line FAILS CLOSED with the safe
 * pricing-unavailable message — a valid v2 signature does NOT allow checkout. Cart
 * interaction is permitted solely to observe Shopify's post-Transform representation;
 * it cannot be used to complete checkout. Only genuinely-unenforced lines
 * (unmarked-under-pilot, ordinary-under-disabled) otherwise proceed;
 * direct adjustment-variant additions stay blocked under every policy. The gate lives in
 * `runValidation` / `cartValidationsGenerateRun`, not merely in helpers or tests.
 *
 * COMPONENT VALIDATION. A nested/expanded component line is authenticated ONLY by
 * resolving `parentRelationship.parent.id` to the parent's COMPLETE top-level normalized
 * line and revalidating the full v2 quote from that authoritative record (product GID,
 * variant GID, quantity, config digest, profileRef/revision, policyRevision, install
 * binding, adjustment GID, currency, signature). If the complete parent cannot be
 * resolved → fail closed. No shallow-attribute authentication, no permissive fallback.
 *
 * All customer-facing messages are generic. Errors are deterministic, bounded
 * (MAX_ERRORS), deduplicated, and always target `$.cart`.
 */

const TARGET = "$.cart";

/**
 * Whether the *exact effective-price / component-multiset* comparison may ACCEPT a line
 * as correctly priced. Stays `false` until a `shopify app function replay` on a real
 * post-Cart-Transform cart proves the runtime component + quantity representation
 * (Task 5B.3). Rejecting a mismatch is always safe and is NOT gated by this flag.
 */
const EFFECTIVE_PRICE_ENFORCED = false;

const MAX_ERRORS = 5;

const MESSAGES = {
  /** Missing/malformed shop policy, maintenance mode, OR the activation-readiness gate. */
  unavailable: "Dynamic pricing is temporarily unavailable. Please refresh the page or contact us.",
  /** Any quote / component failure on an enforced line. */
  stalePricing: "This product’s pricing is no longer valid. Please return to the product page and configure it again.",
  /** A pricing-adjustment line the customer added directly. */
  directAdjustment: "This item can’t be added to the cart on its own.",
  /** An enforced product bought with a selling plan (subscription) — unsupported. */
  sellingPlan: "This product can’t be purchased on a subscription. Please configure it as a one-time order.",
} as const;

export type ValidationRejectCode =
  | "shop_policy_missing_or_malformed"
  | "maintenance_block"
  | "direct_adjustment"
  | "selling_plan_unsupported"
  | "not_activation_ready"
  | "v1_rejected"
  | "quote_invalid"
  | "product_policy_missing_or_malformed"
  | "product_policy_inactive"
  | "component_forgery"
  | "orphan_component"
  | "effective_price_mismatch"
  | QuoteRejectCode;

export interface InternalError {
  code: ValidationRejectCode;
  message: string;
}

// ---------------------------------------------------------------------------
// Activation readiness — the single auditable gate
// ---------------------------------------------------------------------------

export type ActivationReadiness =
  | { ready: true }
  | { ready: false; reason: "effective_price_runtime_unverified" };

/**
 * The one auditable readiness result. `ready: false` while the exact effective-price /
 * component-multiset runtime semantics are unverified — in which case the exported run
 * path returns a validation error for every enforced line.
 */
export function activationReadiness(): ActivationReadiness {
  if (!EFFECTIVE_PRICE_ENFORCED) {
    return { ready: false, reason: "effective_price_runtime_unverified" };
  }
  return { ready: true };
}

// ---------------------------------------------------------------------------

function err(code: ValidationRejectCode, message: string): InternalError {
  return { code, message };
}

/** A line's merchandise is the authoritative adjustment variant (shop-policy GID is the
 * only authoritative source). */
function isAdjustmentMerchandise(line: { variantGid: string | null }, policy: ShopEnforcementPolicy): boolean {
  return !!line.variantGid && line.variantGid === policy.adjustmentVariantGid;
}

function attrsWellFormed(a: NormalizedValidationLine["attrs"]): boolean {
  if (!a.version || !a.payload || !a.signature || !a.config) return false;
  if (a.payload.length > CART_PRICING_LIMITS.maxPayloadBytes) return false;
  if (a.config.length > CART_PRICING_LIMITS.maxConfigBytes) return false;
  return true;
}

/**
 * Full independent v2 verification for one enforced TOP-LEVEL line against Shopify-owned
 * policy (product GID, variant GID, quantity, currency, `installBinding`,
 * `adjustmentVariantGid`, `profileRef`/`profileRevision`, `policyRevision`, config
 * digest, HMAC signature, monetary invariants + line-total formula). v1 always rejected.
 * Returns `null` on success, else a reject code.
 */
function validateEnforcedQuote(
  line: NormalizedValidationLine,
  policy: ShopEnforcementPolicy,
  productPolicy: ProductPricingPolicy,
  secret: string,
): { code: ValidationRejectCode } | null {
  if (line.attrs.version !== "2") return { code: "v1_rejected" };
  if (!attrsWellFormed(line.attrs)) return { code: "quote_invalid" };
  const v = verifyCartPricingAttributesV2(
    secret,
    { quantity: line.quantity, variantGid: line.variantGid, productGid: line.productGid, currencyCode: line.money.currency },
    line.attrs,
    policy,
    productPolicy,
  );
  return v.ok ? null : { code: v.reason };
}

/** Whether a line is subject to pilot/universal enforcement. Emits its own policy error
 * (and returns `false`) for a present-but-malformed / inactive policy on an intended
 * enforced product. */
function determineEnforced(
  mode: ShopEnforcementPolicy["mode"],
  line: NormalizedValidationLine,
  emit: (e: InternalError) => void,
): { enforced: boolean; productPolicy: ProductPricingPolicy | null } {
  const present = line.productPolicyJson !== null && line.productPolicyJson !== undefined;
  const productPolicy = parseProductPricingPolicy(line.productPolicyJson);

  if (mode === "universal") {
    if (!productPolicy || !productPolicy.active) {
      emit(err(productPolicy ? "product_policy_inactive" : "product_policy_missing_or_malformed", MESSAGES.stalePricing));
      return { enforced: false, productPolicy: null };
    }
    return { enforced: true, productPolicy };
  }

  // pilot
  if (!present) return { enforced: false, productPolicy: null };
  if (!productPolicy) {
    emit(err("product_policy_missing_or_malformed", MESSAGES.stalePricing));
    return { enforced: false, productPolicy: null };
  }
  if (!productPolicy.active) {
    emit(err("product_policy_inactive", MESSAGES.stalePricing));
    return { enforced: false, productPolicy: null };
  }
  return { enforced: productPolicy.required, productPolicy };
}

interface ObservedComponent {
  merchandiseGid: string;
  quantity: number;
  perUnitCents: number | null;
  currency: string | null;
}

/**
 * Exact, order-independent, multiplicity-sensitive component-integrity check for one
 * validated parent quote. Rejects (returns `"component_forgery"`) on: a component with a
 * malformed / negative / unsafe quantity or amount; a component in the wrong currency; a
 * missing / duplicate / extra component; an altered component quantity; the wrong
 * adjustment variant; unexpected merchandise. This REJECT path is always active — it is
 * not gated by `EFFECTIVE_PRICE_ENFORCED` (rejecting a mismatch is always safe).
 */
function checkComponentIntegrity(
  parentPayload: CartPricingPayloadV2,
  observed: ObservedComponent[],
): "component_forgery" | null {
  for (const c of observed) {
    if (!Number.isSafeInteger(c.quantity) || c.quantity < 1 || c.quantity > CART_PRICING_LIMITS.maxQuantity) return "component_forgery";
    if (c.perUnitCents === null || !Number.isSafeInteger(c.perUnitCents) || c.perUnitCents < 0) return "component_forgery";
    if (c.currency !== null && c.currency !== parentPayload.currency) return "component_forgery";
  }
  if (
    hasComponentMultisetMismatch(
      expectedExpandedComponents(parentPayload),
      observed.map((c) => ({ merchandiseGid: c.merchandiseGid, quantity: c.quantity, perUnitCents: c.perUnitCents })),
    )
  ) {
    return "component_forgery";
  }
  return null;
}

// ---------------------------------------------------------------------------

export function runValidation(input: NormalizedValidationInput, secret: string): InternalError[] {
  const out: InternalError[] = [];
  const push = (e: InternalError) => {
    if (out.length < MAX_ERRORS && !out.some((x) => x.code === e.code && x.message === e.message)) out.push(e);
  };

  const topLevel = input.lines.filter((l) => l.parentLineId === null);
  const components = input.lines.filter((l) => l.parentLineId !== null);
  const ordinaryVariantLines = topLevel.filter((l) => l.isProductVariant);

  const policy = parseShopEnforcementPolicy(input.shopPolicyJson);

  // A. missing / malformed shop policy -> one global error (never legacy compat).
  if (policy === null) {
    if (ordinaryVariantLines.length > 0) push(err("shop_policy_missing_or_malformed", MESSAGES.unavailable));
    return finalize(out);
  }

  // Direct-adjustment protection — every mode.
  for (const line of topLevel) {
    if (isAdjustmentMerchandise(line, policy)) push(err("direct_adjustment", MESSAGES.directAdjustment));
  }

  // F. kill switch -> treated as disabled.
  const effectiveMode: ShopEnforcementPolicy["mode"] = policy.enabled ? policy.mode : "disabled";

  // B. disabled -> ordinary products allowed (business-authorized); only direct-adjustment blocks.
  if (effectiveMode === "disabled") return finalize(out);

  // E. maintenance -> block every ordinary ProductVariant, one global error, no fallback.
  if (effectiveMode === "maintenance") {
    if (ordinaryVariantLines.length > 0) push(err("maintenance_block", MESSAGES.unavailable));
    return finalize(out);
  }

  // ---- C. pilot / D. universal ----
  const readiness = activationReadiness();

  // The Cart Transform authenticates and expands the customer line before the
  // cart is rendered. While this pilot rollout gate is closed, observing that
  // rendered cart must not run a second expensive HMAC pass here. Checkout is
  // still fail-closed below.
  if (input.buyerStep === "CART_INTERACTION") return finalize(out);

  const componentsByParentId = new Map<string, NormalizedValidationLine[]>();
  for (const c of components) {
    const arr = componentsByParentId.get(c.parentLineId!) ?? [];
    arr.push(c);
    componentsByParentId.set(c.parentLineId!, arr);
  }

  for (const line of topLevel) {
    if (!line.isProductVariant) continue;
    if (isAdjustmentMerchandise(line, policy)) continue; // already handled

    const { enforced, productPolicy } = determineEnforced(effectiveMode, line, push);
    if (!enforced || !productPolicy) continue;

    // Selling plan -> block, no native fallback.
    if (line.hasSellingPlan) {
      push(err("selling_plan_unsupported", MESSAGES.sellingPlan));
      continue;
    }

    // ---- ACTIVATION-READINESS GATE ----
    // While effective-price runtime semantics are unverified, the Cart Transform still
    // needs one real cart interaction to reveal Shopify's post-transform line shape.
    // Allow that interaction only; every checkout step remains fail-closed.
    if (!readiness.ready) {
      push(err("not_activation_ready", MESSAGES.unavailable));
      continue;
    }

    // ---- (reached only when activation ready; EFFECTIVE_PRICE_ENFORCED === true) ----
    const quoteFailure = validateEnforcedQuote(line, policy, productPolicy, secret);
    if (quoteFailure) {
      push(err(quoteFailure.code, MESSAGES.stalePricing));
      continue;
    }
    const payload = parseV2Payload(line.attrs.payload ?? "");
    if (!payload) {
      push(err("quote_invalid", MESSAGES.stalePricing));
      continue;
    }
    const observed: ObservedComponent[] = (componentsByParentId.get(line.id) ?? []).map((c) => ({
      merchandiseGid: c.variantGid ?? "",
      quantity: c.quantity,
      perUnitCents: c.money.amountPerQuantityCents,
      currency: c.money.currency,
    }));
    if (observed.length > 0) {
      const compIssue = checkComponentIntegrity(payload, observed);
      if (compIssue) {
        push(err(compIssue, MESSAGES.stalePricing));
        continue;
      }
    } else if (line.money.subtotalCents !== null && line.money.subtotalCents !== payload.lineTotalCents) {
      push(err("effective_price_mismatch", MESSAGES.stalePricing));
      continue;
    }
  }

  // ---- Component lines: authenticate via the COMPLETE resolved parent ----
  const checkedParents = new Set<string>();
  for (const child of components) {
    const parent = resolveParent(input.lines, child.parentLineId!);

    // §2 — the complete authoritative parent must resolve. No permissive fallback.
    if (!parent) {
      push(err("orphan_component", MESSAGES.stalePricing));
      continue;
    }

    // Re-validate the FULL v2 quote from the authoritative parent record.
    const parentProductPolicy = parseProductPricingPolicy(parent.productPolicyJson);
    if (!parentProductPolicy || !parentProductPolicy.active) {
      push(err("orphan_component", MESSAGES.stalePricing));
      continue;
    }
    if (validateEnforcedQuote(parent, policy, parentProductPolicy, secret) !== null) {
      push(err("orphan_component", MESSAGES.stalePricing));
      continue;
    }
    const parentPayload = parseV2Payload(parent.attrs.payload ?? "");
    if (!parentPayload) {
      push(err("orphan_component", MESSAGES.stalePricing));
      continue;
    }

    // An adjustment component must be the adjustment variant the parent's quote names.
    if (isAdjustmentMerchandise(child, policy) && child.variantGid !== parentPayload.adjustmentVariantGid) {
      push(err("component_forgery", MESSAGES.stalePricing));
      continue;
    }

    // Exact multiset, once per resolved parent (always rejects a mismatch).
    if (!checkedParents.has(parent.id)) {
      checkedParents.add(parent.id);
      const observed: ObservedComponent[] = (componentsByParentId.get(parent.id) ?? []).map((c) => ({
        merchandiseGid: c.variantGid ?? "",
        quantity: c.quantity,
        perUnitCents: c.money.amountPerQuantityCents,
        currency: c.money.currency,
      }));
      const compIssue = checkComponentIntegrity(parentPayload, observed);
      if (compIssue) push(err(compIssue, MESSAGES.stalePricing));
    }
  }

  return finalize(out);
}

function finalize(errors: InternalError[]): InternalError[] {
  return [...errors].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)).slice(0, MAX_ERRORS);
}

export function cartValidationsGenerateRun(input: CartValidationsGenerateRunInput): CartValidationsGenerateRunResult {
  const internal = runValidation(normalizeValidationInput(input), CART_SIGNING_SECRET);
  const errors: ValidationError[] = internal.map((e) => ({ message: e.message, target: TARGET }));
  return { operations: [{ validationAdd: { errors } }] };
}
