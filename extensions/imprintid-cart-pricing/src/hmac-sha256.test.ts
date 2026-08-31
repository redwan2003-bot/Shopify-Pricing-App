import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signHex, bytesToHex, sha256, utf8ToBytes } from "./hmac-sha256.ts";

/** Same known-answer cross-check as app/lib/pricing-api/hmac-sha256.test.ts — this is
 * the extension's own copy (see that file's header for why it's duplicated, not
 * imported), so it needs its own proof of correctness independent of the server copy. */

test("sha256 matches a known FIPS 180-4 test vector (\"abc\")", () => {
  assert.equal(
    bytesToHex(sha256(utf8ToBytes("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("signHex agrees with Node's own crypto.createHmac", () => {
  const secret = "a-dedicated-cart-signing-secret";
  const message = "sku=LNY01\nquantity=1000";
  const expected = createHmac("sha256", secret).update(message, "utf8").digest("hex");
  assert.equal(signHex(secret, message), expected);
});
