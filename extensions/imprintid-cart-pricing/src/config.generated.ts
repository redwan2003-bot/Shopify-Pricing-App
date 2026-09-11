/**
 * NON-SECRET configuration wrapper for the `imprintid-cart-pricing` Cart Transform.
 *
 * Task 5B.3B §Phase-2 — this file is TRACKED and never contains a secret. The real
 * signing secret is baked into the sibling `./config.secret.generated.ts`, which is:
 *   - written by `scripts/generate-config.mjs` (run automatically by the repo-root
 *     npm hooks `fn:config` <- `pretest` / `pretypecheck` / `predev` / `predeploy`);
 *   - listed in `extensions/imprintid-cart-pricing/.gitignore` — it never appears in
 *     `git status` or `git diff`.
 *
 * A clean clone has NO `./config.secret.generated.ts`. Run
 *   node scripts/generate-config.mjs
 * to create it. Without `IMPRINTID_CART_SIGNING_SECRET` set, the script writes a
 * FAIL-CLOSED empty secret (every signed line is then rejected — see
 * `verify-payload.ts` / `verify-payload-v2.ts`), never an insecure default. With the
 * env var set, it writes the real value — which must byte-match
 * `IMPRINTID_CART_SIGNING_SECRET` in the main app's server environment (see
 * `app/lib/pricing-api/cart-signature.ts`) and the Cart Validation Function's own
 * generated config. See `./config.secret.generated.example.ts` for the shape.
 *
 * The adjustment-variant GID is deliberately NOT baked here: the Function reads it from
 * the app-owned shop `enforcement_policy` metafield at runtime and cross-checks it
 * against the signed payload — two independently trusted sources (Task 5A §7).
 */
export { CART_SIGNING_SECRET } from "./config.secret.generated.ts";
