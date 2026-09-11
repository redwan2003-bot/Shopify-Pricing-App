/**
 * Task 6A / 6A.1 — the narrow Admin GraphQL surface the catalog subsystem uses.
 *
 * Deliberately tiny so tests inject a fake transport and never construct a real Shopify
 * client. The real client comes from `authenticate.admin(request).admin`.
 *
 * READ-ONLY for catalog sync. The only WRITES the subsystem ever performs are
 * `metafieldsSet` / `metafieldsDelete` on the app-owned `$app:imprintid/pricing_policy`
 * PRODUCT metafield (see `write-port.ts`) — never a product, variant, inventory,
 * publication, collection or tag mutation. The mutations below simply have no such
 * fields.
 */

import { ENFORCEMENT_POLICY_KEY, PRICING_POLICY_KEY, PRICING_POLICY_NAMESPACE } from "./constants.ts";

export interface AdminGraphqlClientLike {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

/** Shopify caps `metafieldsSet` at 25 metafields per mutation. */
export const METAFIELDS_SET_MAX = 25;

/**
 * `MetafieldsSetUserErrorCode` value returned when a supplied `compareDigest` does not
 * match the metafield's current state (including "asserted absent but present" and
 * "asserted present but absent").
 *
 * NOTE (see the report's limitations section): the live Admin schema could not be
 * introspected during this task — the app's offline access token had expired and this
 * task is not authorized to re-auth. `isDigestMismatch()` therefore matches this code
 * *or* any user error whose code/message mentions a digest, so a mismatch is classified
 * as an explicit CONFLICT under either spelling and is NEVER treated as "write
 * succeeded" or silently retried into an overwrite.
 */
export const DIGEST_MISMATCH_CODE = "PRESENT_OR_ABSENT_DIGEST_MISMATCH";

/**
 * The value the `compareDigest` GraphQL variable MUST take to assert "this metafield does
 * not currently exist": literal JSON `null`.
 *
 * Task 6A.1.1 — it is NEVER `""`, `undefined`, an omitted key, or an inferred value.
 * Shopify's `metafieldsSet` compare-and-set treats an EMPTY STRING as an invalid digest
 * (not as "absent"), and an OMITTED / undefined `compareDigest` as "no compare-and-set at
 * all" (a blind overwrite). Both would break the fail-closed contract, so this constant
 * is `null` and `serializeCompareDigest()` (write-port.ts) rejects `""`.
 */
export const ABSENT_COMPARE_DIGEST = null;

/**
 * Serializes the caller's `string | null` compare token into exactly what goes on the
 * GraphQL wire: a non-empty digest string, or literal `null` for an absence assertion.
 * Throws on `""` — an empty string is never a valid Shopify compareDigest and its
 * presence here is a programming error we want to fail loudly, not send.
 */
export function serializeCompareDigest(token: string | null | undefined): string | null {
  if (token === "") {
    throw new Error(
      'compareDigest must be a non-empty digest string or null (absence assertion) — never "". ' +
        "See admin-client.ts#ABSENT_COMPARE_DIGEST.",
    );
  }
  return token ?? null;
}

export function isDigestMismatch(error: { code?: string | null; message?: string | null }): boolean {
  const code = (error.code ?? "").toUpperCase();
  if (code === DIGEST_MISMATCH_CODE) return true;
  if (code.includes("DIGEST")) return true;
  return /digest/i.test(error.message ?? "");
}

/** Fetches the shop's primary currency — refreshed on every sync. */
export const SHOP_CURRENCY_QUERY = `#graphql
  query ImprintIdShopCurrency { shop { currencyCode } }`;

/** Shop currency + the app-owned enforcement_policy metafield. The bulk-assignment and
 * rollback processors refuse to run unless enforcement is provably disabled. */
export const SHOP_POLICY_QUERY = `#graphql
  query ImprintIdShopPolicy {
    shop {
      currencyCode
      metafield(namespace: "${PRICING_POLICY_NAMESPACE}", key: "${ENFORCEMENT_POLICY_KEY}") { jsonValue }
    }
  }`;

export type ShopPolicyContext =
  | { ok: true; shopCurrency: string | null; enforcementPolicyJson: unknown }
  | { ok: false; error: string };

/** Reads `{ shopCurrency, enforcementPolicyJson }` for the authenticated shop.
 * `enforcementPolicyJson` is `null` only when the metafield is genuinely absent; a
 * transport failure returns `{ ok: false }` so callers refuse the operation (never treat
 * "could not read" as "enforcement is off"). */
export async function readShopPolicyContext(admin: AdminGraphqlClientLike): Promise<ShopPolicyContext> {
  try {
    const data = await adminRequest(admin, SHOP_POLICY_QUERY);
    const shop = (data.shop ?? {}) as { currencyCode?: unknown; metafield?: { jsonValue?: unknown } | null };
    const code = typeof shop.currencyCode === "string" ? shop.currencyCode : null;
    return {
      ok: true,
      shopCurrency: code,
      enforcementPolicyJson: shop.metafield ? (shop.metafield.jsonValue ?? null) : null,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : "shop policy read failed" };
  }
}

/**
 * The full-catalog bulk query.
 *
 * Task 6A.1: `variants` carries NO `first:` argument. Inside a bulk operation a nested
 * connection without pagination arguments is traversed IN FULL and its members are
 * emitted as separate JSONL lines linked by `__parentId` — so a product with 400 variants
 * yields 400 variant lines, and `variants(first: 100)` (which would silently truncate at
 * 100 and make an exact SKU search wrong past that point) is never used.
 *
 * Only pricing-admin fields: product identity/status/vendor/type/tags/updatedAt and the
 * variant identity/title/sku/updatedAt needed for exact SKU search. NO description,
 * images, native price, inventory, publications or collections.
 */
export const CATALOG_BULK_QUERY = `#graphql
  {
    products {
      edges {
        node {
          id
          title
          handle
          status
          vendor
          productType
          tags
          updatedAt
          variantsCount { count }
          variants {
            edges {
              node {
                id
                title
                sku
                updatedAt
              }
            }
          }
        }
      }
    }
  }`;

export const BULK_OPERATION_RUN_QUERY = `#graphql
  mutation ImprintIdCatalogBulkRun($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status createdAt }
      userErrors { field message }
    }
  }`;

/**
 * Task 6A.1 — poll the EXACT operation this job owns, by id.
 *
 * `currentBulkOperation` is deliberately NOT used as an authoritative poll: it returns
 * whatever query-type bulk operation the app most recently started on that shop, which
 * may be a different (or concurrently started) run. Attaching a catalog job's ingest to
 * an unrelated operation's result file would import the wrong data.
 */
export const BULK_OPERATION_BY_ID_QUERY = `#graphql
  query ImprintIdBulkOperationById($id: ID!) {
    node(id: $id) {
      __typename
      ... on BulkOperation {
        id
        status
        errorCode
        objectCount
        fileSize
        url
        partialDataUrl
        query
        type
        createdAt
        completedAt
      }
    }
  }`;

/** Used ONLY to detect a pre-existing in-flight operation before starting a new one
 * (Shopify allows one running query-type bulk operation per app per shop). Never used to
 * decide which file a job ingests. */
export const CURRENT_BULK_OPERATION_QUERY = `#graphql
  query ImprintIdCurrentBulkOperation {
    currentBulkOperation(type: QUERY) { id status createdAt }
  }`;

export const BULK_OPERATION_CANCEL_MUTATION = `#graphql
  mutation ImprintIdBulkCancel($id: ID!) {
    bulkOperationCancel(id: $id) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;

/**
 * Reads the current app-owned pricing_policy metafield for a batch of products, INCLUDING
 * Shopify's `compareDigest` — the compare-and-set token. `metafield` is null when absent,
 * which is materially different from "present with an empty value" and is tracked
 * explicitly (see `BulkAssignmentItem.prevPolicyPresent`).
 */
export const PRODUCT_POLICY_METAFIELDS_QUERY = `#graphql
  query ImprintIdProductPolicies($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Product {
        id
        metafield(namespace: "${PRICING_POLICY_NAMESPACE}", key: "${PRICING_POLICY_KEY}") {
          id
          type
          value
          jsonValue
          compareDigest
        }
      }
    }
  }`;

/**
 * The compare-and-set write. Each `MetafieldsSetInput` carries a `compareDigest`:
 *   - the digest we just read (a non-empty string) → the write applies only if nothing
 *     changed since;
 *   - literal JSON `null` (`ABSENT_COMPARE_DIGEST`) → the write applies only if the
 *     metafield is currently absent.
 * The `compareDigest` key is ALWAYS present in the input object (never omitted, never
 * `""`) — see `serializeCompareDigest`. A mismatch comes back as a `userErrors` entry,
 * never as a silent overwrite.
 */
export const METAFIELDS_SET_MUTATION = `#graphql
  mutation ImprintIdSetProductPolicy($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        owner { ... on Product { id } }
        compareDigest
      }
      userErrors { field message code elementIndex }
    }
  }`;

/**
 * Deletes the app-owned pricing_policy metafield — used ONLY by rollback when the
 * previous state was "absent".
 *
 * Shopify's `metafieldsDelete` has NO compare-and-set parameter, so the delete itself
 * cannot be made atomic against a concurrent write. `write-port.ts#deleteProductPolicy`
 * therefore re-reads the digest immediately before deleting and refuses unless it still
 * equals the digest this app wrote. See the report's limitations section for the residual
 * one-round-trip race this leaves.
 */
export const METAFIELDS_DELETE_MUTATION = `#graphql
  mutation ImprintIdDeleteProductPolicy($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key namespace ownerId }
      userErrors { field message }
    }
  }`;

/** Runs a GraphQL doc and returns `data`, throwing a classified error on a transport
 * failure, 401/403, or top-level `errors`. `THROTTLED` is surfaced distinctly so the
 * caller can back off rather than fail. */
export async function adminRequest(
  admin: AdminGraphqlClientLike,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    const res = await admin.graphql(query, variables ? { variables } : undefined);
    body = await res.json();
  } catch (error) {
    throw new AdminRequestError("network", error instanceof Error ? error.message : "request failed");
  }
  if (!body || typeof body !== "object") throw new AdminRequestError("malformed", "empty response body");
  const b = body as { errors?: unknown; data?: unknown };
  if (b.errors) {
    const text = JSON.stringify(b.errors);
    if (/throttl/i.test(text)) throw new AdminRequestError("throttled", "rate limited");
    if (/access denied|not authorized/i.test(text)) throw new AdminRequestError("auth", "access denied");
    throw new AdminRequestError("graphql", text.slice(0, 500));
  }
  return (b.data ?? {}) as Record<string, unknown>;
}

export class AdminRequestError extends Error {
  readonly kind: "network" | "malformed" | "throttled" | "auth" | "graphql";
  constructor(kind: AdminRequestError["kind"], message: string) {
    super(message);
    this.name = "AdminRequestError";
    this.kind = kind;
  }
  /** whether a retry could plausibly succeed */
  get retryable(): boolean {
    return this.kind === "throttled" || this.kind === "network";
  }
}
