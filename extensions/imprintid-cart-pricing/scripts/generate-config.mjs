#!/usr/bin/env node
// Regenerates src/config.generated.ts with the real signing secret, baked in at build
// time because Shopify Functions have no runtime environment access — see that file's
// own doc comment for the full explanation. Run this (with the real secret set) before
// `shopify app function build` / `shopify app deploy` for this extension; running
// `shopify app function build` without it leaves the safe, always-rejecting placeholder
// in place rather than silently shipping a non-functional or insecure default.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const secret = process.env.IMPRINTID_CART_SIGNING_SECRET;
if (!secret || secret.trim().length === 0) {
  console.error(
    "IMPRINTID_CART_SIGNING_SECRET is not set. Refusing to generate a config that would " +
      "either be empty (fails closed, but silently) or accidentally leave a stale secret in place.",
  );
  process.exit(1);
}

const outPath = fileURLToPath(new URL("../src/config.generated.ts", import.meta.url));
const contents = `/**
 * THIS FILE IS GENERATED — see scripts/generate-config.mjs. Do not edit by hand; your
 * changes will be overwritten the next time this script runs.
 */
export const CART_SIGNING_SECRET = ${JSON.stringify(secret)};
`;

writeFileSync(outPath, contents, "utf8");
console.log(`Wrote ${outPath} (secret length: ${secret.length})`);
