#!/usr/bin/env node
/**
 * Task 5B.3B §Phase-2 / 5B.3B.2 — writes the GITIGNORED `src/config.secret.generated.ts`
 * with the signing secret baked in (Shopify Functions have no runtime env access — see
 * `src/config.generated.ts`). Run automatically by the repo-root npm hooks `fn:config`
 * <- `pretest` / `pretypecheck` / `predev` / `predeploy`, so every local build / test /
 * `shopify app dev` / `shopify app deploy` has the file (fail-closed when the secret is
 * unset).
 *
 * Secret source, in order:
 *   1. `process.env.IMPRINTID_CART_SIGNING_SECRET` when it is a non-empty string;
 *   2. otherwise the `IMPRINTID_CART_SIGNING_SECRET=` line of the repo-root `.env`
 *      (git-ignored) — this is what `scripts/shopify/provision.mjs --prepare` writes, so
 *      the manual `npm run fn:config` boundary needs NO secret on the command line;
 *   3. otherwise a FAIL-CLOSED empty secret (every signed line is rejected) + a warning.
 * A blank / whitespace-padded value from either source is refused (fail-closed), never
 * an insecure default.
 *
 * NEVER prints the secret value — only its byte length and a SHA-256 fingerprint prefix
 * (first 8 hex chars) so the runtime / Transform / Validation can be confirmed to match
 * without exposure.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

function fromDotEnv() {
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (!existsSync(envPath)) return undefined;
  const m = readFileSync(envPath, "utf8").match(/^IMPRINTID_CART_SIGNING_SECRET=(.*)$/m);
  if (!m) return undefined;
  const v = m[1].replace(/^(['"])(.*)\1$/, "$2"); // tolerate a surrounding quote pair
  return v.length ? v : undefined;
}

// The `.env` file is consulted ONLY when the env var is entirely unset. An explicit
// empty / whitespace value is honoured as-is (fail-closed) so hermetic tests and CI stay
// deterministic regardless of a developer's local `.env`.
const envValue = process.env.IMPRINTID_CART_SIGNING_SECRET;
const raw =
  typeof envValue === "string" && envValue.length > 0
    ? envValue
    : envValue === undefined
      ? fromDotEnv()
      : envValue;

let secret = "";
let mode = "fail-closed placeholder";
if (typeof raw === "string" && raw.length > 0) {
  if (raw.trim().length === 0 || raw !== raw.trim()) {
    console.warn(
      "[generate-config] IMPRINTID_CART_SIGNING_SECRET is blank or has leading/trailing whitespace — " +
        "refusing to bake it. Writing the fail-closed empty secret instead.",
    );
  } else {
    secret = raw;
    mode = "real secret";
  }
}

const outPath = fileURLToPath(new URL("../src/config.secret.generated.ts", import.meta.url));
writeFileSync(
  outPath,
  `/**
 * GENERATED + GITIGNORED — see scripts/generate-config.mjs. Do not edit or commit.
 */
export const CART_SIGNING_SECRET = ${JSON.stringify(secret)};
`,
  "utf8",
);

const fp = secret.length ? createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 8) : "0".repeat(8);
console.log(`[generate-config] imprintid-cart-validation: wrote config.secret.generated.ts (${mode}, ${secret.length} bytes, sha256:${fp}…)`);
