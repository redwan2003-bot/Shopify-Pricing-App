import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../../shopify.server";
import { choiceFromPolicy, planEnforcementChange, readEnforcement, writeEnforcement } from "./settings.ts";
import { provisionStatusFrom, readProvisionState } from "../provisioning/provision-shop.ts";
import { canIssueSignedV2Quote } from "../pricing-api/storefront-handler.ts";

/** Loader and action for app/routes/app.settings.tsx, kept free of JSX so they can be exercised directly. */

async function readiness(admin: Parameters<typeof readProvisionState>[0]) {
  let setupComplete = false;
  try {
    setupComplete = provisionStatusFrom(await readProvisionState(admin)).complete;
  } catch {
    setupComplete = false;
  }
  return { setupComplete, canSignQuotes: canIssueSignedV2Quote() };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const [read, ready] = await Promise.all([readEnforcement(admin).catch(() => null), readiness(admin)]);
  return {
    readable: !!read,
    configured: !!read?.policy,
    current: read?.policy ? choiceFromPolicy(read.policy) : null,
    ...ready,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const choice = String(form.get("choice") ?? "");
  const confirmUniversal = form.get("confirmUniversal") === "on";

  // Re-read immediately before writing: the compare-and-set digest comes from this read.
  const read = await readEnforcement(admin).catch(() => null);
  if (!read) return { ok: false, message: "Couldn't read the current setting. Reload and try again." };
  if (!read.policy) return { ok: false, message: "Setup isn't finished on this store. Use Finish setup on the Home page first." };

  const plan = planEnforcementChange(read.policy, choice, { confirmUniversal }, await readiness(admin));
  if (!plan.ok) return { ok: false, message: plan.message };
  if (plan.unchanged) return { ok: true, message: "No change — that is already the current setting." };

  const result = await writeEnforcement(admin, read, plan.next);
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, message: "Saved. Carts priced under the previous setting will need to be reconfigured." };
};
