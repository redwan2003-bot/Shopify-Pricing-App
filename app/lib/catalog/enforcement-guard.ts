/**
 * Task 6A — the bulk-assignment / rollback processor refuses to run while shop
 * enforcement is ENABLED. Bulk assignment (writing pricing-policy metadata) and
 * enforcement activation (flipping `enforcement_policy.enabled` → true) are separate
 * operations; doing a large metadata write while the Functions are live would change
 * checkout pricing mid-flight for every touched product.
 *
 * Pure: takes the already-fetched shop `$app:imprintid/enforcement_policy` metafield
 * jsonValue (the route fetches it once via the authenticated Admin client). Fails
 * closed — an unreadable / malformed policy is treated as "cannot confirm disabled".
 */

import { parseShopEnforcementPolicy } from "../pricing-api/policy-metafields.ts";

export type EnforcementGateResult =
  | { ok: true; mode: string }
  | { ok: false; reason: "enabled" | "unknown" | "malformed"; message: string };

export function checkEnforcementDisabled(shopPolicyJson: unknown): EnforcementGateResult {
  if (shopPolicyJson === null || shopPolicyJson === undefined) {
    // No shop policy at all → the Functions are inert regardless, so assignment is safe.
    return { ok: true, mode: "absent" };
  }
  const parsed = parseShopEnforcementPolicy(shopPolicyJson);
  if (!parsed) {
    return { ok: false, reason: "malformed", message: "the shop enforcement_policy metafield is present but does not parse — refusing to run a bulk assignment until it is corrected" };
  }
  if (parsed.enabled) {
    return {
      ok: false,
      reason: "enabled",
      message: `shop enforcement is ENABLED (mode: ${parsed.mode}). Bulk assignment and enforcement activation are separate operations — disable enforcement first, run the assignment, then re-enable.`,
    };
  }
  return { ok: true, mode: parsed.mode };
}
