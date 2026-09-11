/**
 * Validated normalization of the generated `CartValidationsGenerateRunInput` into a
 * small internal representation (Task 5B.2 / 5B.2.1). NO `any` cast of the full Function
 * input — every field comes from the generated type, and the ProductVariant vs.
 * CustomProduct discriminant is checked via `__typename`.
 *
 * The input query is kept under Shopify's Validation query-complexity limit (30). A
 * component line's `parentRelationship` is queried as ONLY `parent { id }` — the
 * validator resolves that id back to the parent's own complete top-level normalized
 * line (`resolveParent`) and revalidates the full v2 quote from THAT authoritative
 * record. A component whose parent id does not resolve to a complete top-level line
 * fails closed (Task 5B.2.1 §2 — no permissive fallback, no shallow-attribute auth).
 */

import type { CartValidationsGenerateRunInput } from "../generated/api.ts";
import { decimalStringToCents } from "./decimal-cents.ts";

export interface QuoteAttrs {
  version: string | null;
  payload: string | null;
  signature: string | null;
  config: string | null;
}

export interface NormalizedMoney {
  amountPerQuantityCents: number | null;
  subtotalCents: number | null;
  currency: string | null;
}

export interface NormalizedValidationLine {
  id: string;
  quantity: number;
  isProductVariant: boolean;
  variantGid: string | null;
  productGid: string | null;
  productPolicyJson: unknown;
  hasSellingPlan: boolean;
  attrs: QuoteAttrs;
  money: NormalizedMoney;
  /** For a nested / expanded component line: the id of its parent cart line (resolved
   * to the parent's complete top-level record by the validator). `null` for a
   * customer-added top-level line. */
  parentLineId: string | null;
}

export interface NormalizedValidationInput {
  buyerStep: string | null;
  shopPolicyJson: unknown;
  lines: NormalizedValidationLine[];
}

/** Resolves a component's `parentLineId` to the parent's COMPLETE top-level normalized
 * line. Returns `null` when no such complete top-level line exists in this input —
 * callers MUST fail closed (Task 5B.2.1 §2). */
export function resolveParent(
  lines: NormalizedValidationLine[],
  parentLineId: string,
): NormalizedValidationLine | null {
  const parent = lines.find((l) => l.id === parentLineId && l.parentLineId === null);
  return parent && parent.isProductVariant ? parent : null;
}

type RawLine = CartValidationsGenerateRunInput["cart"]["lines"][number];
type RawMerch = RawLine["merchandise"];

function attr(a: { value?: string | null } | null | undefined): string | null {
  return a && typeof a.value === "string" ? a.value : null;
}

function merchIsVariant(m: RawMerch): m is Extract<RawMerch, { __typename: "ProductVariant" }> {
  return m.__typename === "ProductVariant";
}

function money(cost: RawLine["cost"]): NormalizedMoney {
  return {
    amountPerQuantityCents: decimalStringToCents(cost.amountPerQuantity.amount),
    subtotalCents: decimalStringToCents(cost.subtotalAmount.amount),
    currency: cost.subtotalAmount.currencyCode ? String(cost.subtotalAmount.currencyCode) : null,
  };
}

export function normalizeValidationInput(input: CartValidationsGenerateRunInput): NormalizedValidationInput {
  const lines: NormalizedValidationLine[] = input.cart.lines.map((line) => {
    const m = line.merchandise;
    const isVariant = merchIsVariant(m);
    const product = isVariant ? m.product : null;

    return {
      id: line.id,
      quantity: line.quantity,
      isProductVariant: isVariant,
      variantGid: isVariant ? m.id : null,
      productGid: product ? product.id : null,
      productPolicyJson: product ? (product.pricingPolicy?.jsonValue ?? null) : null,
      hasSellingPlan: !!line.sellingPlanAllocation && !!line.sellingPlanAllocation.sellingPlan,
      attrs: {
        version: attr(line.version),
        payload: attr(line.payload),
        signature: attr(line.signature),
        config: attr(line.config),
      },
      money: money(line.cost),
      parentLineId: line.parentRelationship?.parent.id ?? null,
    };
  });

  return {
    buyerStep: input.buyerJourney.step ?? null,
    shopPolicyJson: input.shop.enforcementPolicy?.jsonValue ?? null,
    lines,
  };
}
