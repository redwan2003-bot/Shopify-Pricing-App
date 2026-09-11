/**
 * Task 6A.1 — a synthetic Admin GraphQL transport.
 *
 * Implements exactly the documents `app/lib/catalog/admin-client.ts` sends, with Shopify's
 * real semantics for the parts that matter:
 *   - `bulkOperationRunQuery` mints a NEW BulkOperation GID each call;
 *   - `node(id:)` returns that operation only for its own id (a foreign id returns a
 *     different-typed node or null);
 *   - `metafieldsSet` enforces `compareDigest` and returns a fresh digest;
 *   - `metafieldsDelete` has NO compare-and-set (matching the platform gap).
 *
 * No real shop, token, or network is involved.
 */

import type { AdminGraphqlClientLike } from "../../app/lib/catalog/admin-client.ts";
import { normalizeExistingPolicyJson } from "../../app/lib/catalog/policy-value.ts";

/**
 * Bulk-operation GIDs must be unique across the whole test run, not just per FakeAdmin:
 * the sync's cross-job ownership check deliberately looks for ANY other job holding the
 * same operation id, and two `FakeAdmin` instances restarting at 1 would collide.
 */
let globalOpSeq = Date.now() % 1_000_000;

export interface FakeBulkOperation {
  id: string;
  status: "CREATED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED" | "EXPIRED";
  errorCode?: string | null;
  objectCount?: number;
  url?: string | null;
  partialDataUrl?: string | null;
  type?: string;
}

export interface FakeAdminOptions {
  shopCurrency?: string | null;
  enforcementPolicy?: unknown;
  /** JSONL body served for a bulk operation's result url. */
  resultBody?: string;
  /** Force `bulkOperationRunQuery` to report user errors. */
  bulkStartUserErrors?: string[];
  /** A pre-existing in-flight operation reported by `currentBulkOperation`. */
  currentOperation?: { id: string; status: string } | null;
}

export class FakeAdmin implements AdminGraphqlClientLike {
  readonly operations = new Map<string, FakeBulkOperation>();
  readonly calls: Array<{ op: string }> = [];
  /** productGid -> { json, digest } */
  readonly metafields = new Map<string, { json: string; digest: string; id: string }>();
  /** Set by tests to fail the next N requests of a kind. */
  failNext = new Map<string, number>();
  /** Task 6A.1.1 — the next N `metafieldsSet` calls return an UNATTRIBUTABLE user error
   * (no elementIndex, no field path) with empty `metafields`, as an atomic-mutation
   * rollback / internal error would. */
  failNextSetUnattributable = 0;

  private opSeq = 0;
  private digestSeq = 0;
  options: FakeAdminOptions;

  constructor(options: FakeAdminOptions = {}) {
    this.options = { shopCurrency: "USD", enforcementPolicy: null, resultBody: "", ...options };
  }

  /** Registers an operation as if another app/session had started it. */
  registerForeignOperation(op: FakeBulkOperation): void {
    this.operations.set(op.id, op);
  }

  setOperationStatus(id: string, patch: Partial<FakeBulkOperation>): void {
    const op = this.operations.get(id);
    if (op) this.operations.set(id, { ...op, ...patch });
  }

  /** The GID of the most recently started operation. */
  get lastOperationId(): string | null {
    const ids = [...this.operations.keys()];
    return ids.length ? ids[ids.length - 1]! : null;
  }

  seedMetafield(productGid: string, json: string): string {
    this.digestSeq += 1;
    const digest = `fdg_${this.digestSeq}`;
    this.metafields.set(productGid, { json: normalizeExistingPolicyJson(safeParse(json)), digest, id: `gid://shopify/Metafield/${this.digestSeq}` });
    return digest;
  }

  /**
   * Task 6A.1.1 — the exact GraphQL variables the write port produced for the most recent
   * `ImprintIdSetProductPolicy` call, AFTER a JSON round-trip. The round-trip reproduces
   * what actually reaches Shopify: an `undefined` field is DROPPED (key omitted), a
   * `null` field survives as `null`, `""` survives as `""`. Transport-level tests assert
   * against this.
   */
  lastSetVariables: { metafields: Array<Record<string, unknown>> } | null = null;

  async graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<{ json: () => Promise<unknown> }> {
    // Serialize + parse exactly as the real HTTP client would, so omission / null / ""
    // are distinguishable in the handler below.
    const wire = JSON.parse(JSON.stringify(options?.variables ?? {})) as Record<string, unknown>;
    const data = this.resolve(query, wire);
    return { json: async () => data };
  }

  private resolve(query: string, vars: Record<string, unknown>): unknown {
    if (query.includes("ImprintIdShopPolicy")) {
      this.calls.push({ op: "shopPolicy" });
      if (this.consumeFailure("shopPolicy")) return { errors: [{ message: "simulated shop policy failure" }] };
      return {
        data: {
          shop: {
            currencyCode: this.options.shopCurrency,
            metafield: this.options.enforcementPolicy == null ? null : { jsonValue: this.options.enforcementPolicy },
          },
        },
      };
    }

    if (query.includes("ImprintIdShopCurrency")) {
      this.calls.push({ op: "shopCurrency" });
      return { data: { shop: { currencyCode: this.options.shopCurrency } } };
    }

    if (query.includes("ImprintIdCurrentBulkOperation")) {
      this.calls.push({ op: "currentBulkOperation" });
      return { data: { currentBulkOperation: this.options.currentOperation ?? null } };
    }

    if (query.includes("ImprintIdCatalogBulkRun")) {
      this.calls.push({ op: "bulkRun" });
      if (this.options.bulkStartUserErrors?.length) {
        return {
          data: { bulkOperationRunQuery: { bulkOperation: null, userErrors: this.options.bulkStartUserErrors.map((m) => ({ field: null, message: m })) } },
        };
      }
      this.opSeq += 1;
      globalOpSeq += 1;
      const id = `gid://shopify/BulkOperation/${globalOpSeq}`;
      this.operations.set(id, { id, status: "CREATED", type: "QUERY", objectCount: 0, url: null, partialDataUrl: null });
      return { data: { bulkOperationRunQuery: { bulkOperation: { id, status: "CREATED", createdAt: new Date().toISOString() }, userErrors: [] } } };
    }

    if (query.includes("ImprintIdBulkOperationById")) {
      this.calls.push({ op: "bulkById" });
      const id = String(vars.id ?? "");
      const op = this.operations.get(id);
      if (!op) return { data: { node: null } };
      return {
        data: {
          node: {
            __typename: op.type === "NOT_A_BULK_OP" ? "Product" : "BulkOperation",
            id: op.id,
            status: op.status,
            errorCode: op.errorCode ?? null,
            objectCount: String(op.objectCount ?? 0),
            fileSize: null,
            url: op.url ?? null,
            partialDataUrl: op.partialDataUrl ?? null,
            query: "{ products { edges { node { id } } } }",
            type: op.type ?? "QUERY",
            createdAt: new Date().toISOString(),
            completedAt: op.status === "COMPLETED" ? new Date().toISOString() : null,
          },
        },
      };
    }

    if (query.includes("ImprintIdProductPolicies")) {
      this.calls.push({ op: "readPolicies" });
      if (this.consumeFailure("readPolicies")) return { errors: [{ message: "Throttled" }] };
      const ids = (vars.ids as string[]) ?? [];
      return {
        data: {
          nodes: ids.map((id) => {
            const mf = this.metafields.get(id);
            return {
              __typename: "Product",
              id,
              metafield: mf ? { id: mf.id, type: "json", value: mf.json, jsonValue: safeParse(mf.json), compareDigest: mf.digest } : null,
            };
          }),
        },
      };
    }

    if (query.includes("ImprintIdSetProductPolicy")) {
      this.calls.push({ op: "setPolicies" });
      const inputsRaw = (vars.metafields as Array<Record<string, unknown>>) ?? [];
      this.lastSetVariables = { metafields: inputsRaw };

      // Task 6A.1.1 — strict validation of the compare-and-set contract. These are
      // programming errors in the write port, not merchant-visible states: throw so a
      // regression fails the test loudly rather than being silently tolerated.
      inputsRaw.forEach((input, index) => {
        if (!("compareDigest" in input)) {
          throw new Error(`metafieldsSet input #${index} OMITTED compareDigest — a blind overwrite is never allowed`);
        }
        const cd = input.compareDigest;
        if (cd === "") {
          throw new Error(`metafieldsSet input #${index} sent compareDigest: "" — Shopify treats this as an invalid digest, not "absent". Use null.`);
        }
        if (cd !== null && typeof cd !== "string") {
          throw new Error(`metafieldsSet input #${index} sent compareDigest of type ${typeof cd} — must be a digest string or null`);
        }
      });

      if (this.consumeFailure("setPolicies")) return { errors: [{ message: "Throttled" }] };
      if (this.failNextSetUnattributable > 0) {
        this.failNextSetUnattributable -= 1;
        return {
          data: {
            metafieldsSet: {
              metafields: [],
              userErrors: [{ field: null, message: "Something went wrong", code: "INTERNAL_ERROR", elementIndex: null }],
            },
          },
        };
      }

      const written: Array<{ id: string; namespace: string; key: string; owner: { id: string }; compareDigest: string }> = [];
      const userErrors: Array<{ field: string[] | null; message: string; code: string; elementIndex: number }> = [];
      const applied: Array<() => void> = [];
      inputsRaw.forEach((raw, index) => {
        const input = raw as { ownerId: string; value: string; compareDigest: string | null };
        const existing = this.metafields.get(input.ownerId);
        // The expected compare token: the existing digest, or `null` when absent.
        const expected: string | null = existing ? existing.digest : null;
        if (input.compareDigest !== expected) {
          userErrors.push({
            field: ["metafields", String(index), "compareDigest"],
            message:
              expected === null
                ? "The metafield does not exist but a digest was supplied"
                : input.compareDigest === null
                  ? "The metafield exists but absence was asserted"
                  : "The metafield was modified since it was last read",
            code: "PRESENT_OR_ABSENT_DIGEST_MISMATCH",
            elementIndex: index,
          });
          return;
        }
        this.digestSeq += 1;
        const digest = `fdg_${this.digestSeq}`;
        const id = existing?.id ?? `gid://shopify/Metafield/${this.digestSeq}`;
        applied.push(() => this.metafields.set(input.ownerId, { json: normalizeExistingPolicyJson(safeParse(input.value)), digest, id }));
        written.push({ id, namespace: "$app:imprintid", key: "pricing_policy", owner: { id: input.ownerId }, compareDigest: digest });
      });

      // `metafieldsSet` is atomic: if ANY input failed validation, NOTHING is written.
      if (userErrors.length === 0) for (const apply of applied) apply();
      return { data: { metafieldsSet: { metafields: userErrors.length ? [] : written, userErrors } } };
    }

    if (query.includes("ImprintIdDeleteProductPolicy")) {
      this.calls.push({ op: "deletePolicies" });
      const inputs = (vars.metafields as Array<{ ownerId: string }>) ?? [];
      const deleted = inputs.filter((i) => this.metafields.delete(i.ownerId));
      return {
        data: {
          metafieldsDelete: {
            deletedMetafields: deleted.map((d) => ({ key: "pricing_policy", namespace: "$app:imprintid", ownerId: d.ownerId })),
            userErrors: [],
          },
        },
      };
    }

    return { errors: [{ message: `FakeAdmin has no handler for this document` }] };
  }

  private consumeFailure(kind: string): boolean {
    const n = this.failNext.get(kind) ?? 0;
    if (n <= 0) return false;
    this.failNext.set(kind, n - 1);
    return true;
  }
}

/** A `fetchResult` implementation backed by an in-memory JSONL string. */
export function fakeResultFetcher(bodies: Record<string, string>) {
  return async (url: string, startByteOffset: number): Promise<AsyncIterable<Uint8Array>> => {
    const body = bodies[url];
    if (body === undefined) throw new Error(`no fake result body registered for ${url}`);
    const bytes = new TextEncoder().encode(body).subarray(startByteOffset);
    return (async function* () {
      const chunk = 4096;
      for (let i = 0; i < bytes.length; i += chunk) yield bytes.subarray(i, i + chunk);
    })();
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
