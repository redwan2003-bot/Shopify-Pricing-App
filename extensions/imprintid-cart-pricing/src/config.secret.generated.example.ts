/**
 * TEMPLATE — the shape of the gitignored `./config.secret.generated.ts` that
 * `scripts/generate-config.mjs` writes. Copy is NOT needed: run the script.
 *
 *   # fail-closed empty secret (every signed line rejected) — safe default:
 *   node scripts/generate-config.mjs
 *
 *   # real dev/prod secret (must byte-match the app server env + the Validation Function):
 *   IMPRINTID_CART_SIGNING_SECRET="<32+ random bytes>" node scripts/generate-config.mjs
 *
 * The generated file contains ONLY this one export. Never commit it.
 */
export const CART_SIGNING_SECRET = "";
