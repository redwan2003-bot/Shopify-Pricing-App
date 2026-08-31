import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signHex, timingSafeEqualHex, sha256, bytesToHex, utf8ToBytes } from "./hmac-sha256.ts";

test("sha256 matches a known FIPS 180-4 test vector (empty message)", () => {
  assert.equal(
    bytesToHex(sha256(utf8ToBytes(""))),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".slice(0, 64),
  );
});

test("sha256 matches a known FIPS 180-4 test vector (\"abc\")", () => {
  assert.equal(
    bytesToHex(sha256(utf8ToBytes("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("signHex agrees with Node's own crypto.createHmac for a variety of secrets/messages", () => {
  const cases = [
    { secret: "shh", message: "" },
    { secret: "a-shopify-app-secret-1234567890", message: '{"sku":"LNY01","quantity":1000}' },
    { secret: "x", message: "y".repeat(500) },
    { secret: "", message: "empty secret is a degenerate but valid case" },
  ];

  for (const { secret, message } of cases) {
    const expected = createHmac("sha256", secret).update(message, "utf8").digest("hex");
    assert.equal(signHex(secret, message), expected, `mismatch for secret=${JSON.stringify(secret)}`);
  }
});

test("signHex is deterministic", () => {
  const a = signHex("secret", "same payload");
  const b = signHex("secret", "same payload");
  assert.equal(a, b);
});

test("signHex differs for any change to the message", () => {
  const base = signHex("secret", "payload-a");
  const changed = signHex("secret", "payload-b");
  assert.notEqual(base, changed);
});

test("signHex differs for any change to the secret", () => {
  const a = signHex("secret-a", "same payload");
  const b = signHex("secret-b", "same payload");
  assert.notEqual(a, b);
});

test("timingSafeEqualHex correctly compares equal and unequal hex strings", () => {
  assert.equal(timingSafeEqualHex("abcd", "abcd"), true);
  assert.equal(timingSafeEqualHex("abcd", "abce"), false);
  assert.equal(timingSafeEqualHex("abcd", "abcde"), false);
  assert.equal(timingSafeEqualHex("", ""), true);
});
