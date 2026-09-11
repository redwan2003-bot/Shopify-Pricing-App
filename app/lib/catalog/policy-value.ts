/**
 * Task 6A — builds the app-owned `$app:imprintid/pricing_policy` product-metafield
 * value for a pricing profile. Mirrors the shape `policy-metafields.ts#ProductPricingPolicy`
 * validates and the Cart Transform / Validation Functions verify against.
 *
 * `profileRef` is the local `PricingProfile.id` (already used by the shop-policy
 * `enforcement_policy` and by `cart-pricing-policy-provider.ts`). `profileRevision` is
 * `PricingProfile.revision`. `policyRevision` is the shop-policy revision passed in.
 */

import { POLICY_SCHEMA_VERSION } from "./constants.ts";

export interface ProductPolicyInput {
  profileId: string;
  profileRevision: number;
  policyRevision: number;
  /** Task 6A never enables enforcement; a fresh assignment writes `required:true,
   * active:true` so the policy is *ready* but the shop `enforcement_policy.enabled`
   * gate (still `false`) keeps the Functions inert. */
  required?: boolean;
  active?: boolean;
}

export interface ProductPolicyValue {
  schema: number;
  required: boolean;
  active: boolean;
  profileRef: string;
  profileRevision: number;
  policyRevision: number;
}

export function buildProductPolicyValue(input: ProductPolicyInput): ProductPolicyValue {
  return {
    schema: POLICY_SCHEMA_VERSION,
    required: input.required ?? true,
    active: input.active ?? true,
    profileRef: input.profileId,
    profileRevision: input.profileRevision,
    policyRevision: input.policyRevision,
  };
}

/** Canonical JSON for a policy value — key order fixed so an equality check between the
 * desired value and the value already on the product is a plain string compare. */
export function canonicalPolicyJson(v: ProductPolicyValue): string {
  return JSON.stringify({
    schema: v.schema,
    required: v.required,
    active: v.active,
    profileRef: v.profileRef,
    profileRevision: v.profileRevision,
    policyRevision: v.policyRevision,
  });
}

/** Reads an unknown metafield jsonValue into canonical JSON, or `""` when absent /
 * unparseable — so "no policy" and "malformed policy" both compare unequal to any real
 * desired value and the assignment proceeds to (re)write it. */
export function normalizeExistingPolicyJson(jsonValue: unknown): string {
  if (jsonValue === null || jsonValue === undefined) return "";
  const v = typeof jsonValue === "string" ? safeParse(jsonValue) : jsonValue;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  const r = v as Record<string, unknown>;
  if (
    typeof r.schema !== "number" ||
    typeof r.required !== "boolean" ||
    typeof r.active !== "boolean" ||
    typeof r.profileRef !== "string" ||
    typeof r.profileRevision !== "number" ||
    typeof r.policyRevision !== "number"
  ) {
    return "";
  }
  return canonicalPolicyJson({
    schema: r.schema,
    required: r.required,
    active: r.active,
    profileRef: r.profileRef,
    profileRevision: r.profileRevision,
    policyRevision: r.policyRevision,
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
