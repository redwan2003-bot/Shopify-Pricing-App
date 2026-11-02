#!/usr/bin/env node
import { createHash } from "node:crypto";
import process from "node:process";

const secret = process.env.IMPRINTID_CART_SIGNING_SECRET ?? "";
const expected = (
  process.env.IMPRINTID_CART_SIGNING_SECRET_FINGERPRINT ?? ""
).toLowerCase();

if (!/^[0-9a-f]{8}$/.test(expected)) {
  console.error(
    "::error title=Invalid fingerprint contract::" +
      "IMPRINTID_CART_SIGNING_SECRET_FINGERPRINT must be an 8-character lowercase SHA-256 prefix.",
  );
  process.exit(1);
}

if (secret.length === 0 || secret !== secret.trim()) {
  console.error(
    "::error title=Invalid signing secret::" +
      "IMPRINTID_CART_SIGNING_SECRET is missing, blank, or contains leading/trailing whitespace.",
  );
  process.exit(1);
}

const actual = createHash("sha256")
  .update(secret, "utf8")
  .digest("hex")
  .slice(0, 8);

if (actual !== expected) {
  console.error(
    `::error title=Signing secret mismatch::Expected sha256:${expected}…, got sha256:${actual}…. ` +
      "Refusing to release Shopify Functions with a secret that differs from the Worker.",
  );
  process.exit(1);
}

console.log(
  `[verify-signing-secret] production fingerprint confirmed: sha256:${actual}…`,
);
