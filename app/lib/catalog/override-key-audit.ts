/**
 * Task 6A.3B §4 — legacy override-key safety audit (READ-ONLY).
 *
 * `ProductPricingOverride.shopifyProductId` must be the BARE numeric product id — the
 * shape the enforcement-critical storefront resolver and the provisioner use (see
 * `gid.ts#overrideProductKey`). A row keyed by the canonical GID
 * (`gid://shopify/Product/123`) is a LEGACY artifact: it is invisible to the storefront
 * and to `loadOverridesByGid`, so acting on the bare key while a divergent GID-keyed row
 * exists would make the product's effective price ambiguous.
 *
 * This module DETECTS that situation. It never migrates, rewrites or deletes a row — the
 * remediation is a separate, explicit, human-reviewed step.
 *
 *   bare-only           → the canonical, healthy state.
 *   gid-only            → a legacy row; the bare key the subsystem will write does not
 *                         exist yet. Flagged (`legacy`) but not fail-closed: writing the
 *                         bare key is still safe and is the fix.
 *   collision-identical → both keys exist and are semantically identical. Flagged
 *                         (`collision`) — a duplicate to clean up, but not dangerous.
 *   collision-conflict  → both keys exist and DISAGREE (profile, active flag or base
 *                         price). FAIL CLOSED: the effective price is undefined and the
 *                         subsystem must refuse to touch this product until a human
 *                         resolves it.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { parseProductGid, productGidNumericId } from "./gid.ts";

export type OverrideKeyState = "none" | "bare-only" | "gid-only" | "collision-identical" | "collision-conflict";

export interface OverrideKeyFinding {
  /** canonical product GID */
  productGid: string;
  bareKey: string;
  gidKey: string;
  state: OverrideKeyState;
  /** true only for `collision-conflict` — the subsystem must not write this product */
  failClosed: boolean;
}

export interface OverrideKeyAudit {
  ok: boolean; // false iff any finding is fail-closed
  findings: OverrideKeyFinding[];
  conflicts: OverrideKeyFinding[];
  /** GIDs the caller must NOT act on */
  blockedGids: Set<string>;
}

type SemRow = { pricingProfileId: string | null; isActive: boolean; basePriceCents: number | null };

function sameSemantics(a: SemRow, b: SemRow): boolean {
  return (
    (a.pricingProfileId ?? null) === (b.pricingProfileId ?? null) &&
    a.isActive === b.isActive &&
    (a.basePriceCents ?? null) === (b.basePriceCents ?? null)
  );
}

/** Pure classifier — given the (optional) bare-keyed row and the (optional) GID-keyed
 * row for one product, name the state. */
export function classifyOverrideKeyState(bare: SemRow | undefined, gid: SemRow | undefined): OverrideKeyState {
  if (!bare && !gid) return "none";
  if (bare && !gid) return "bare-only";
  if (!bare && gid) return "gid-only";
  return sameSemantics(bare!, gid!) ? "collision-identical" : "collision-conflict";
}

const AUDIT_SELECT = {
  shopifyProductId: true,
  pricingProfileId: true,
  isActive: true,
  basePriceCents: true,
} satisfies Prisma.ProductPricingOverrideSelect;

/**
 * Audits a batch of product GIDs for legacy / colliding override keys. One indexed
 * `findMany` over both key forms; no writes.
 */
export async function auditOverrideKeys(
  client: Pick<PrismaClient, "productPricingOverride">,
  storeId: string,
  productIdsOrGids: readonly string[],
): Promise<OverrideKeyAudit> {
  const byGid = new Map<string, { gid: string; bareKey: string; gidKey: string }>();
  const keys = new Set<string>();
  for (const raw of productIdsOrGids) {
    const gid = parseProductGid(raw);
    if (!gid) continue;
    const bareKey = productGidNumericId(gid);
    if (!bareKey) continue;
    byGid.set(gid, { gid, bareKey, gidKey: gid });
    keys.add(bareKey);
    keys.add(gid);
  }

  const findings: OverrideKeyFinding[] = [];
  const conflicts: OverrideKeyFinding[] = [];
  const blockedGids = new Set<string>();

  if (byGid.size > 0) {
    const rows = await client.productPricingOverride.findMany({
      where: { storeId, shopifyProductId: { in: [...keys] } },
      select: AUDIT_SELECT,
    });
    const rowByKey = new Map(rows.map((r) => [r.shopifyProductId, r]));

    for (const { gid, bareKey, gidKey } of byGid.values()) {
      const state = classifyOverrideKeyState(rowByKey.get(bareKey), rowByKey.get(gidKey));
      if (state === "none" || state === "bare-only") continue;
      const failClosed = state === "collision-conflict";
      const finding: OverrideKeyFinding = { productGid: gid, bareKey, gidKey, state, failClosed };
      findings.push(finding);
      if (failClosed) {
        conflicts.push(finding);
        blockedGids.add(gid);
      }
    }
  }

  return { ok: conflicts.length === 0, findings, conflicts, blockedGids };
}

/** A one-line, non-sensitive summary for a blocking error / audit log. */
export function describeOverrideKeyConflict(f: OverrideKeyFinding): string {
  return `product ${f.bareKey}: a legacy override keyed by its full GID disagrees with the current one — resolve the duplicate before assigning this product`;
}
