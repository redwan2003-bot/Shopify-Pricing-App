import type { AdminGraphqlClientLike } from "../pricing-api/product-resolver.ts";
import { parseShopEnforcementPolicy, type ShopEnforcementPolicy } from "../pricing-api/policy-metafields.ts";
import { isDigestMismatch } from "../catalog/admin-client.ts";

/**
 * The merchant-facing enforcement switch. Four choices map onto the app-owned shop policy:
 *
 *   off          mode "disabled", enabled false — every product sells at its normal price
 *   pilot        only products carrying an active pricing policy are enforced
 *   universal    every product must carry an active pricing policy and a valid quote
 *   maintenance  enforced products are blocked from cart/checkout (pricing incident)
 *
 * Every change bumps `policyRevision`: the Validation Function rejects any quote whose signed
 * revision differs, so switching modes invalidates carts priced under the old setting. The
 * write is compare-and-set against the digest that was read, so two admins cannot silently
 * overwrite each other.
 */

export type EnforcementChoice = "off" | "pilot" | "universal" | "maintenance";
export const ENFORCEMENT_CHOICES: readonly EnforcementChoice[] = ["off", "pilot", "universal", "maintenance"];

export function choiceFromPolicy(policy: ShopEnforcementPolicy): EnforcementChoice {
  if (!policy.enabled || policy.mode === "disabled") return "off";
  return policy.mode;
}

export interface ChangeReadiness {
  /** Install-time setup has fully completed on this store. */
  setupComplete: boolean;
  /** This deployment can sign quotes (signing secret configured, v2 envelope). */
  canSignQuotes: boolean;
}

export type ChangePlan =
  | { ok: true; unchanged: true }
  | { ok: true; unchanged: false; next: ShopEnforcementPolicy }
  | { ok: false; message: string };

/**
 * Decides whether `choice` may be applied and what the new policy is. Turning pricing ON for
 * real (pilot/universal) without working quote signing would block every enforced product at
 * checkout, so it is refused rather than allowed to break the store. Maintenance and off never
 * need signing. Universal blocks every product without a pricing policy, so it must be
 * explicitly confirmed.
 */
export function planEnforcementChange(
  current: ShopEnforcementPolicy,
  choice: string,
  opts: { confirmUniversal: boolean },
  readiness: ChangeReadiness,
): ChangePlan {
  if (!(ENFORCEMENT_CHOICES as readonly string[]).includes(choice)) {
    return { ok: false, message: "Choose one of the listed options." };
  }
  const target = choice as EnforcementChoice;
  if (target === choiceFromPolicy(current)) return { ok: true, unchanged: true };

  if (target === "pilot" || target === "universal") {
    if (!readiness.setupComplete) {
      return { ok: false, message: "Finish setup on the Home page before turning dynamic pricing on." };
    }
    if (!readiness.canSignQuotes) {
      return {
        ok: false,
        message:
          "The app can't sign prices yet (its signing configuration is missing), so turning this on would block checkout for priced products. Contact the app's support.",
      };
    }
  }
  if (target === "universal" && !opts.confirmUniversal) {
    return {
      ok: false,
      message: "Universal blocks every product that has no pricing set up. Tick the confirmation box to continue.",
    };
  }

  const next: ShopEnforcementPolicy = {
    ...current,
    mode: target === "off" ? "disabled" : target,
    enabled: target !== "off",
    policyRevision: current.policyRevision + 1,
  };
  return { ok: true, unchanged: false, next };
}

// ---------------------------------------------------------------------------------------

const READ = `#graphql
  query ImprintIdEnforcementRead {
    shop { id metafield(namespace: "$app:imprintid", key: "enforcement_policy") { jsonValue compareDigest } }
  }`;

const WRITE = `#graphql
  mutation ImprintIdEnforcementWrite($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { id compareDigest } userErrors { field message code } }
  }`;

export interface EnforcementReadResult {
  shopId: string;
  policy: ShopEnforcementPolicy | null;
  compareDigest: string | null;
}

export async function readEnforcement(admin: AdminGraphqlClientLike): Promise<EnforcementReadResult> {
  const response = await admin.graphql(READ);
  const body = (await response.json()) as {
    data?: { shop?: { id?: string; metafield?: { jsonValue?: unknown; compareDigest?: string } | null } };
    errors?: unknown;
  };
  if (body.errors || !body.data?.shop?.id) throw new Error("could not read the store's enforcement setting");
  const mf = body.data.shop.metafield ?? null;
  return {
    shopId: body.data.shop.id,
    policy: mf ? parseShopEnforcementPolicy(mf.jsonValue ?? null) : null,
    compareDigest: mf?.compareDigest ?? null,
  };
}

export type WriteResult = { ok: true } | { ok: false; conflict: boolean; message: string };

export async function writeEnforcement(
  admin: AdminGraphqlClientLike,
  read: EnforcementReadResult,
  next: ShopEnforcementPolicy,
): Promise<WriteResult> {
  const value: Record<string, unknown> = {
    schema: next.schema,
    mode: next.mode,
    enabled: next.enabled,
    adjustmentVariantGid: next.adjustmentVariantGid,
    installBinding: next.installBinding,
    policyRevision: next.policyRevision,
  };
  if (next.allowLegacyV1) value.allowLegacyV1 = true;

  const response = await admin.graphql(WRITE, {
    variables: {
      metafields: [
        {
          ownerId: read.shopId,
          namespace: "$app:imprintid",
          key: "enforcement_policy",
          type: "json",
          value: JSON.stringify(value),
          compareDigest: read.compareDigest,
        },
      ],
    },
  });
  const body = (await response.json()) as {
    data?: { metafieldsSet?: { userErrors?: { message: string; code?: string | null }[] } };
    errors?: unknown;
  };
  if (body.errors) return { ok: false, conflict: false, message: "Shopify rejected the change. Try again." };
  const errors = body.data?.metafieldsSet?.userErrors ?? [];
  if (errors.some((e) => isDigestMismatch(e))) {
    return { ok: false, conflict: true, message: "The setting was changed somewhere else a moment ago. Reload the page and try again." };
  }
  if (errors.length) return { ok: false, conflict: false, message: errors.map((e) => e.message).join("; ").slice(0, 300) };
  return { ok: true };
}
