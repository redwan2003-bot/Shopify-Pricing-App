/**
 * Task 6A.1 / 6A.1.1 — the ONLY Shopify write surface the catalog subsystem has,
 * compare-and-set.
 *
 * Every write to the app-owned `$app:imprintid/pricing_policy` product metafield carries
 * an explicit `compareDigest`:
 *   - replacing a value  → the exact digest string Shopify returned when we read it;
 *   - creating a value   → literal JSON `null` (NEVER `""`, never omitted) asserting the
 *     metafield is currently absent.
 *
 * `serializeCompareDigest` (admin-client.ts) is applied to every request as it is turned
 * into GraphQL variables — it throws on `""` so a regression fails loudly rather than
 * sending a value Shopify would reject or, worse, silently treat as "no compare".
 *
 * A digest mismatch is returned as an explicit `conflict` outcome. It is never retried
 * into an overwrite and never reported as success, so a concurrent change made by a
 * merchant, another session, or another app is preserved and surfaced.
 *
 * Reads and writes are batched (Shopify caps `metafieldsSet` at `METAFIELDS_SET_MAX` = 25
 * metafields per mutation), so a 25-item processor batch is exactly one read round-trip
 * and one write round-trip.
 *
 * NOTHING here can touch a product title, description, image, SKU, native price,
 * inventory, publication, collection or tag — the documents in `admin-client.ts` have no
 * such fields.
 */

import {
  ABSENT_COMPARE_DIGEST,
  METAFIELDS_DELETE_MUTATION,
  METAFIELDS_SET_MAX,
  METAFIELDS_SET_MUTATION,
  PRODUCT_POLICY_METAFIELDS_QUERY,
  adminRequest,
  AdminRequestError,
  isDigestMismatch,
  serializeCompareDigest,
  type AdminGraphqlClientLike,
} from "./admin-client.ts";
import { PRICING_POLICY_KEY, PRICING_POLICY_NAMESPACE } from "./constants.ts";

/** One product's current app-owned policy metafield, as observed. */
export interface PolicyRead {
  productGid: string;
  /** false = Shopify has no such metafield (a subsequent write must assert absence with
   * `compareDigest: null`). */
  present: boolean;
  metafieldId: string | null;
  /** parsed metafield value, or null when absent */
  jsonValue: unknown;
  /** Shopify's compare-and-set token for the observed value; null when absent. */
  compareDigest: string | null;
}

export type PolicyWriteOutcome =
  | { ok: true; compareDigest: string | null }
  | { ok: false; conflict: true; code: "CONFLICT_DIGEST_MISMATCH"; message: string }
  | { ok: false; conflict?: false; retryable: boolean; code: string; message: string };

export interface PolicySetRequest {
  productGid: string;
  valueJson: string;
  /**
   * The compare-and-set token:
   *   - a non-empty digest string  → replace only if the metafield still has that digest;
   *   - `null` (`ABSENT_COMPARE_DIGEST`) → create only if the metafield is currently absent.
   * NEVER `""` — `serializeCompareDigest` throws on it.
   */
  compareDigest: string | null;
}

export interface CatalogWritePort {
  /** Batch-reads the app-owned policy metafield (with `compareDigest`) for up to
   * `METAFIELDS_SET_MAX` products. */
  readProductPolicies(productGids: string[]): Promise<Map<string, PolicyRead>>;
  /** Batch compare-and-set. Returns one outcome per requested product, keyed by GID. */
  setProductPolicies(requests: PolicySetRequest[]): Promise<Map<string, PolicyWriteOutcome>>;
  /** Deletes the app-owned policy metafield, but ONLY if its current digest still equals
   * `expectedDigest` (rollback-to-absent). See the race note in `admin-client.ts`. */
  deleteProductPolicy(productGid: string, expectedDigest: string | null): Promise<PolicyWriteOutcome>;
}

export function createAdminWritePort(admin: AdminGraphqlClientLike): CatalogWritePort {
  return {
    async readProductPolicies(productGids) {
      const out = new Map<string, PolicyRead>();
      for (let i = 0; i < productGids.length; i += METAFIELDS_SET_MAX) {
        const slice = productGids.slice(i, i + METAFIELDS_SET_MAX);
        const data = await adminRequest(admin, PRODUCT_POLICY_METAFIELDS_QUERY, { ids: slice });
        const nodes = Array.isArray(data.nodes) ? data.nodes : [];
        for (const raw of nodes) {
          const node = raw as {
            __typename?: string;
            id?: string;
            metafield?: { id?: string; jsonValue?: unknown; compareDigest?: string | null } | null;
          } | null;
          if (!node || node.__typename !== "Product" || typeof node.id !== "string") continue;
          const mf = node.metafield ?? null;
          out.set(node.id, {
            productGid: node.id,
            present: mf != null,
            metafieldId: mf?.id ?? null,
            jsonValue: mf?.jsonValue ?? null,
            compareDigest: mf?.compareDigest ?? null,
          });
        }
        // A GID Shopify did not return at all (deleted product) is recorded as absent so
        // the caller can classify it rather than silently skip it.
        for (const gid of slice) {
          if (!out.has(gid)) {
            out.set(gid, { productGid: gid, present: false, metafieldId: null, jsonValue: null, compareDigest: null });
          }
        }
      }
      return out;
    },

    async setProductPolicies(requests) {
      const out = new Map<string, PolicyWriteOutcome>();

      // Task 6A.1.1 — validate the compare-and-set contract for the WHOLE batch up front,
      // OUTSIDE any try/catch. A `""` compareDigest is a programming error: it must fail
      // loudly here, never be classified as a transient error and retried forever.
      const wireInputs = requests.map((r) => ({
        ownerId: r.productGid,
        namespace: PRICING_POLICY_NAMESPACE,
        key: PRICING_POLICY_KEY,
        type: "json",
        value: r.valueJson,
        // ALWAYS an explicit key — a digest string, or literal `null` for an absence
        // assertion. Never `""`, never `undefined`, never omitted.
        compareDigest: serializeCompareDigest(r.compareDigest),
      }));

      for (let i = 0; i < requests.length; i += METAFIELDS_SET_MAX) {
        const slice = requests.slice(i, i + METAFIELDS_SET_MAX);
        const wireSlice = wireInputs.slice(i, i + METAFIELDS_SET_MAX);
        try {
          const data = await adminRequest(admin, METAFIELDS_SET_MUTATION, { metafields: wireSlice });
          const result = data.metafieldsSet as
            | {
                metafields?: Array<{ owner?: { id?: string } | null; compareDigest?: string | null }> | null;
                userErrors?: Array<{ message?: string; code?: string; elementIndex?: number | null; field?: string[] | null }> | null;
              }
            | undefined;

          // 1. Explicit per-item errors that we can attribute to a specific request.
          for (const err of result?.userErrors ?? []) {
            const index = resolveErrorIndex(err, slice.length);
            if (index == null) continue; // unattributable — handled in step 3 below
            const target = slice[index]!;
            out.set(
              target.productGid,
              isDigestMismatch(err)
                ? {
                    ok: false,
                    conflict: true,
                    code: "CONFLICT_DIGEST_MISMATCH",
                    message: "the product's pricing policy changed since it was read — not overwritten",
                  }
                : {
                    ok: false,
                    retryable: false,
                    code: "PERMANENT_POLICY_USERERROR",
                    message: (err.message ?? "metafieldsSet rejected the write").slice(0, 300),
                  },
            );
          }

          // 2. Explicit confirmations — the ONLY way a request becomes `ok`.
          const digestByOwner = new Map<string, string | null>();
          for (const mf of result?.metafields ?? []) {
            const ownerId = mf?.owner?.id;
            if (typeof ownerId === "string") digestByOwner.set(ownerId, mf.compareDigest ?? null);
          }

          // 3. Everything else — a request Shopify neither confirmed nor attributed an
          //    error to. This is a REMOTE UNCERTAINTY (an unattributable user error, an
          //    atomic-mutation rollback, a silently dropped input). It must NOT be
          //    assumed written and must NOT be turned into a permanent conflict: it is
          //    RETRYABLE, and the caller re-reads + reconciles before any retry write
          //    (see processor.ts / rollback.ts).
          const hadUnattributableError = (result?.userErrors ?? []).some((e) => resolveErrorIndex(e, slice.length) == null);
          for (const r of slice) {
            if (out.has(r.productGid)) continue;
            if (digestByOwner.has(r.productGid)) {
              out.set(r.productGid, { ok: true, compareDigest: digestByOwner.get(r.productGid) ?? null });
            } else {
              out.set(r.productGid, {
                ok: false,
                retryable: true,
                code: "TRANSIENT_UNCONFIRMED_WRITE",
                message: hadUnattributableError
                  ? "metafieldsSet reported an error that could not be attributed to a specific product — reconcile and retry"
                  : "metafieldsSet returned no confirmation for this product",
              });
            }
          }
        } catch (error) {
          const outcome = classify(error);
          for (const r of slice) if (!out.has(r.productGid)) out.set(r.productGid, outcome);
        }
      }
      return out;
    },

    async deleteProductPolicy(productGid, expectedDigest) {
      // Shopify's metafieldsDelete has no compareDigest. Fail closed: re-read the digest
      // immediately before deleting and refuse unless it is exactly what this app wrote.
      let current: PolicyRead | undefined;
      try {
        current = (await this.readProductPolicies([productGid])).get(productGid);
      } catch (error) {
        return classify(error);
      }
      if (!current || !current.present) {
        // Already absent — the desired end state. Idempotent success.
        return { ok: true, compareDigest: null };
      }
      if (expectedDigest === null || current.compareDigest !== expectedDigest) {
        return {
          ok: false,
          conflict: true,
          code: "CONFLICT_DIGEST_MISMATCH",
          message: "the product's pricing policy changed since this job wrote it — not deleted",
        };
      }
      try {
        const data = await adminRequest(admin, METAFIELDS_DELETE_MUTATION, {
          metafields: [{ ownerId: productGid, namespace: PRICING_POLICY_NAMESPACE, key: PRICING_POLICY_KEY }],
        });
        const r = data.metafieldsDelete as { userErrors?: Array<{ message?: string }> } | undefined;
        if (r?.userErrors?.length) {
          return {
            ok: false,
            retryable: false,
            code: "PERMANENT_POLICY_DELETE_USERERROR",
            message: r.userErrors.map((e) => e.message ?? "").join("; ").slice(0, 300),
          };
        }
        return { ok: true, compareDigest: null };
      } catch (error) {
        return classify(error);
      }
    },
  };
}

/** `metafieldsSet` reports the failing input either as `elementIndex` or as a
 * `field: ["metafields", "<i>", …]` path. Accept both. */
function resolveErrorIndex(
  err: { elementIndex?: number | null; field?: string[] | null },
  batchSize: number,
): number | null {
  if (typeof err.elementIndex === "number" && err.elementIndex >= 0 && err.elementIndex < batchSize) {
    return err.elementIndex;
  }
  for (const part of err.field ?? []) {
    const n = Number(part);
    if (Number.isInteger(n) && n >= 0 && n < batchSize) return n;
  }
  return null;
}

function classify(error: unknown): PolicyWriteOutcome {
  if (error instanceof AdminRequestError) {
    if (error.kind === "throttled") return { ok: false, retryable: true, code: "TRANSIENT_THROTTLED", message: "rate limited" };
    if (error.kind === "network") return { ok: false, retryable: true, code: "TRANSIENT_NETWORK", message: error.message.slice(0, 200) };
    if (error.kind === "auth") return { ok: false, retryable: false, code: "PERMANENT_AUTH", message: "admin access denied" };
    return { ok: false, retryable: false, code: "PERMANENT_GRAPHQL", message: error.message.slice(0, 200) };
  }
  return {
    ok: false,
    retryable: true,
    code: "TRANSIENT_UNKNOWN",
    message: error instanceof Error ? error.message.slice(0, 200) : "unknown error",
  };
}

export { ABSENT_COMPARE_DIGEST, serializeCompareDigest };
