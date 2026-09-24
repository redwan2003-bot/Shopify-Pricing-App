import { randomUUID } from "node:crypto";
import type { AdminGraphqlClientLike } from "../pricing-api/product-resolver.ts";
import { parseShopEnforcementPolicy } from "../pricing-api/policy-metafields.ts";

/**
 * Per-shop setup the app needs before dynamic pricing can run on a store, done automatically
 * on install (and retryable from the app home page). Idempotent: every step checks what already
 * exists and only creates what is missing, so running it twice, or after a partial failure,
 * converges on the same end state.
 *
 * ORDER MATTERS. The Validation Function blocks every checkout when the shop enforcement policy
 * is missing or malformed, so the policy (written DISABLED on a new shop) is always in place
 * before the Validation is activated. A step that fails stops the run before later steps.
 *
 * An existing, well-formed policy is never switched on or off here: enforcement is a merchant
 * decision. The only thing corrected on an existing policy is the adjustment variant it points
 * at (e.g. after the merchant deleted the adjustment product), which also bumps its revision so
 * quotes signed against the old variant stop validating.
 */

export const APP_NAMESPACE = "$app:imprintid";
export const SHOP_POLICY_KEY = "enforcement_policy";
export const PRODUCT_POLICY_KEY = "pricing_policy";
export const TRANSFORM_HANDLE = "imprintid-cart-pricing";
export const VALIDATION_HANDLE = "imprintid-cart-validation";
export const VALIDATION_TITLE = "ImprintID Dynamic Pricing Validation";
export const ADJUSTMENT_TAGS = ["imprintid-internal", "do-not-sell-directly"];
export const ADJUSTMENT_TITLE = "ImprintID Pricing Adjustment (do not delete)";

export type ProvisionStep =
  | "definitions"
  | "adjustment_product"
  | "shop_policy"
  | "cart_transform"
  | "validation";

export interface ProvisionReport {
  ok: boolean;
  /** Steps that made a change on this run (empty when everything was already in place). */
  changed: ProvisionStep[];
  /** The step that failed, when `ok` is false. Later steps were not attempted. */
  failedStep?: ProvisionStep;
  error?: string;
  adjustmentVariantGid?: string;
}

export interface ProvisionStatus {
  complete: boolean;
  missing: ProvisionStep[];
}

export class ProvisionError extends Error {
  readonly step: ProvisionStep;
  constructor(step: ProvisionStep, message: string) {
    super(message);
    this.name = "ProvisionError";
    this.step = step;
  }
}

// ---------------------------------------------------------------------------------------
// GraphQL (validated against the Admin API schema)
// ---------------------------------------------------------------------------------------

export const PROVISION_STATE_QUERY = `#graphql
  query ImprintIdProvisionState($adjustmentQuery: String!) {
    shop {
      id
      metafield(namespace: "$app:imprintid", key: "enforcement_policy") { jsonValue }
    }
    shopDefinitions: metafieldDefinitions(first: 5, ownerType: SHOP, namespace: "$app:imprintid", key: "enforcement_policy") { nodes { id } }
    productDefinitions: metafieldDefinitions(first: 5, ownerType: PRODUCT, namespace: "$app:imprintid", key: "pricing_policy") { nodes { id } }
    shopifyFunctions(first: 50) { nodes { id apiType } }
    cartTransforms(first: 25) { nodes { id functionId } }
    validations(first: 25) { nodes { id title enabled } }
    adjustmentProducts: products(first: 5, query: $adjustmentQuery) { nodes { id tags variants(first: 2) { nodes { id } } } }
  }`;

const DEFINITION_CREATE = `#graphql
  mutation ImprintIdDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) { createdDefinition { id } userErrors { field message code } }
  }`;

const PRODUCT_CREATE = `#graphql
  mutation ImprintIdAdjustmentCreate($product: ProductCreateInput!) {
    productCreate(product: $product) { product { id variants(first: 1) { nodes { id } } } userErrors { field message } }
  }`;

const VARIANT_UPDATE = `#graphql
  mutation ImprintIdAdjustmentVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } }
  }`;

const METAFIELDS_SET = `#graphql
  mutation ImprintIdPolicySet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } }
  }`;

const CART_TRANSFORM_CREATE = `#graphql
  mutation ImprintIdCartTransformCreate($functionHandle: String!) {
    cartTransformCreate(functionHandle: $functionHandle, blockOnFailure: true) { cartTransform { id } userErrors { field message } }
  }`;

const VALIDATION_CREATE = `#graphql
  mutation ImprintIdValidationCreate($validation: ValidationCreateInput!) {
    validationCreate(validation: $validation) { validation { id } userErrors { field message } }
  }`;

const VALIDATION_UPDATE = `#graphql
  mutation ImprintIdValidationUpdate($id: ID!, $validation: ValidationUpdateInput!) {
    validationUpdate(id: $id, validation: $validation) { validation { id } userErrors { field message } }
  }`;

// ---------------------------------------------------------------------------------------

interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

async function gql(admin: AdminGraphqlClientLike, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await admin.graphql(query, { variables });
  const body = (await response.json()) as { data?: Record<string, unknown>; errors?: unknown };
  if (body.errors) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors).slice(0, 300)}`);
  if (!body.data) throw new Error("GraphQL response had no data");
  return body.data;
}

function payload(data: Record<string, unknown>, field: string): { userErrors?: UserError[] } & Record<string, unknown> {
  return (data[field] ?? {}) as { userErrors?: UserError[] } & Record<string, unknown>;
}

function assertNoUserErrors(step: ProvisionStep, result: { userErrors?: UserError[] }, allow: (e: UserError) => boolean = () => false) {
  const errors = (result.userErrors ?? []).filter((e) => !allow(e));
  if (errors.length) throw new ProvisionError(step, errors.map((e) => e.message).join("; ").slice(0, 300));
}

interface ProvisionState {
  shopId: string;
  shopPolicyRaw: unknown;
  hasShopDefinition: boolean;
  hasProductDefinition: boolean;
  transformFunctionIds: Set<string>;
  hasOurCartTransform: boolean;
  validation: { id: string; enabled: boolean } | null;
  adjustment: { productId: string; variantId: string } | null;
  ambiguousAdjustment: boolean;
}

export async function readProvisionState(admin: AdminGraphqlClientLike): Promise<ProvisionState> {
  const data = await gql(admin, PROVISION_STATE_QUERY, { adjustmentQuery: `tag:${ADJUSTMENT_TAGS[0]}` });
  const shop = (data.shop ?? {}) as { id?: string; metafield?: { jsonValue?: unknown } | null };
  const nodes = <T>(key: string) => (((data[key] ?? {}) as { nodes?: T[] }).nodes ?? []) as T[];

  const transformFunctionIds = new Set(
    nodes<{ id: string; apiType: string }>("shopifyFunctions")
      .filter((f) => String(f.apiType).toLowerCase() === "cart_transform")
      .map((f) => f.id),
  );
  const transforms = nodes<{ id: string; functionId: string }>("cartTransforms");
  const validations = nodes<{ id: string; title: string; enabled: boolean }>("validations");
  const ours = validations.find((v) => v.title === VALIDATION_TITLE) ?? null;
  const adjustmentProducts = nodes<{ id: string; tags: string[]; variants: { nodes: { id: string }[] } }>("adjustmentProducts").filter(
    (p) => ADJUSTMENT_TAGS.every((t) => (p.tags ?? []).includes(t)),
  );
  const single = adjustmentProducts.length === 1 && adjustmentProducts[0].variants.nodes.length === 1 ? adjustmentProducts[0] : null;

  return {
    shopId: shop.id ?? "",
    shopPolicyRaw: shop.metafield ? (shop.metafield.jsonValue ?? null) : null,
    hasShopDefinition: nodes("shopDefinitions").length > 0,
    hasProductDefinition: nodes("productDefinitions").length > 0,
    transformFunctionIds,
    hasOurCartTransform: transforms.some((t) => transformFunctionIds.has(t.functionId)),
    validation: ours ? { id: ours.id, enabled: ours.enabled } : null,
    adjustment: single ? { productId: single.id, variantId: single.variants.nodes[0].id } : null,
    ambiguousAdjustment: adjustmentProducts.length > 1 || (adjustmentProducts.length === 1 && !single),
  };
}

/** What is still missing, from a read of the shop. Used by the app home page. */
export function provisionStatusFrom(state: ProvisionState): ProvisionStatus {
  const missing: ProvisionStep[] = [];
  if (!state.hasShopDefinition || !state.hasProductDefinition) missing.push("definitions");
  if (!state.adjustment) missing.push("adjustment_product");
  const policy = parseShopEnforcementPolicy(state.shopPolicyRaw);
  if (!policy || !state.adjustment || policy.adjustmentVariantGid !== state.adjustment.variantId) missing.push("shop_policy");
  if (!state.hasOurCartTransform) missing.push("cart_transform");
  if (!state.validation || !state.validation.enabled) missing.push("validation");
  return { complete: missing.length === 0, missing };
}

export async function provisionShop(admin: AdminGraphqlClientLike): Promise<ProvisionReport> {
  const changed: ProvisionStep[] = [];
  let step: ProvisionStep = "definitions";
  try {
    const state = await readProvisionState(admin);

    // 1. Metafield definitions (app-owned; merchants can read but not edit).
    for (const [ownerType, key, name, present] of [
      ["SHOP", SHOP_POLICY_KEY, "ImprintID enforcement policy", state.hasShopDefinition],
      ["PRODUCT", PRODUCT_POLICY_KEY, "ImprintID pricing policy", state.hasProductDefinition],
    ] as const) {
      if (present) continue;
      const data = await gql(admin, DEFINITION_CREATE, {
        definition: { namespace: APP_NAMESPACE, key, name, ownerType, type: "json", access: { admin: "MERCHANT_READ" } },
      });
      assertNoUserErrors(step, payload(data, "metafieldDefinitionCreate"), (e) => e.code === "TAKEN");
      if (!changed.includes(step)) changed.push(step);
    }

    // 2. The hidden adjustment product the Cart Transform expands surcharges into.
    step = "adjustment_product";
    if (state.ambiguousAdjustment) {
      throw new ProvisionError(step, "more than one ImprintID adjustment product exists — remove the extras, then retry setup");
    }
    let adjustment = state.adjustment;
    if (!adjustment) {
      const created = payload(
        await gql(admin, PRODUCT_CREATE, {
          product: {
            title: ADJUSTMENT_TITLE,
            status: "ACTIVE",
            vendor: "ImprintID",
            productType: "ImprintID Pricing Adjustment",
            tags: ADJUSTMENT_TAGS,
            descriptionHtml:
              "<p>Used by the ImprintID Dynamic Pricing app to apply configured surcharges at checkout. It cannot be bought on its own. Do not delete, publish or add it to collections.</p>",
          },
        }),
        "productCreate",
      );
      assertNoUserErrors(step, created);
      const product = created.product as { id: string; variants: { nodes: { id: string }[] } };
      adjustment = { productId: product.id, variantId: product.variants.nodes[0].id };
      const updated = payload(
        await gql(admin, VARIANT_UPDATE, {
          productId: adjustment.productId,
          variants: [
            {
              id: adjustment.variantId,
              price: "0.01",
              inventoryPolicy: "CONTINUE",
              taxable: false,
              inventoryItem: { tracked: false, requiresShipping: false },
            },
          ],
        }),
        "productVariantsBulkUpdate",
      );
      assertNoUserErrors(step, updated);
      changed.push(step);
    }

    // 3. Shop enforcement policy — before the Validation (see file comment).
    step = "shop_policy";
    const existing = parseShopEnforcementPolicy(state.shopPolicyRaw);
    let nextPolicy: Record<string, unknown> | null = null;
    if (!existing) {
      nextPolicy = {
        schema: 1,
        mode: "pilot",
        enabled: false,
        adjustmentVariantGid: adjustment.variantId,
        installBinding: `inst_${randomUUID()}`,
        policyRevision: 1,
      };
    } else if (existing.adjustmentVariantGid !== adjustment.variantId) {
      nextPolicy = { ...existing, adjustmentVariantGid: adjustment.variantId, policyRevision: existing.policyRevision + 1 };
    }
    if (nextPolicy) {
      if (!state.shopId) throw new ProvisionError(step, "could not read the shop id");
      const set = payload(
        await gql(admin, METAFIELDS_SET, {
          metafields: [{ ownerId: state.shopId, namespace: APP_NAMESPACE, key: SHOP_POLICY_KEY, type: "json", value: JSON.stringify(nextPolicy) }],
        }),
        "metafieldsSet",
      );
      assertNoUserErrors(step, set);
      changed.push(step);
    }

    // 4. Cart Transform (prices configured lines).
    step = "cart_transform";
    if (!state.hasOurCartTransform) {
      const created = payload(await gql(admin, CART_TRANSFORM_CREATE, { functionHandle: TRANSFORM_HANDLE }), "cartTransformCreate");
      assertNoUserErrors(step, created);
      changed.push(step);
    }

    // 5. Validation (blocks carts whose pricing does not check out) — last.
    step = "validation";
    if (!state.validation) {
      const created = payload(
        await gql(admin, VALIDATION_CREATE, {
          validation: { functionHandle: VALIDATION_HANDLE, title: VALIDATION_TITLE, enable: true, blockOnFailure: true },
        }),
        "validationCreate",
      );
      assertNoUserErrors(step, created);
      changed.push(step);
    } else if (!state.validation.enabled) {
      const updated = payload(
        await gql(admin, VALIDATION_UPDATE, { id: state.validation.id, validation: { enable: true, blockOnFailure: true } }),
        "validationUpdate",
      );
      assertNoUserErrors(step, updated);
      changed.push(step);
    }

    return { ok: true, changed, adjustmentVariantGid: adjustment.variantId };
  } catch (error) {
    const failedStep = error instanceof ProvisionError ? error.step : step;
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, changed, failedStep, error: message.slice(0, 300) };
  }
}
