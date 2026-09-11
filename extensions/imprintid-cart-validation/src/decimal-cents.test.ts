import { test } from "node:test";
import assert from "node:assert/strict";
import { decimalStringToCents } from "./decimal-cents.ts";

test("decimalStringToCents: accepts exact 2-decimal, 1-decimal, and integer currency values", () => {
  assert.equal(decimalStringToCents("12.99"), 1299);
  assert.equal(decimalStringToCents("0.10"), 10); // no binary float: exactly 10, not 9
  assert.equal(decimalStringToCents("0.1"), 10);
  assert.equal(decimalStringToCents("64.00"), 6400);
  assert.equal(decimalStringToCents("1234"), 123400);
  assert.equal(decimalStringToCents("0"), 0);
  assert.equal(decimalStringToCents("0.00"), 0);
});

test("decimalStringToCents: rejects negatives, exponent notation, >2 decimals, signs, whitespace, separators, non-strings", () => {
  for (const bad of [
    "-1.00",
    "1e2",
    "1E2",
    "1.234",
    "+1.00",
    " 1.00",
    "1.00 ",
    "1,000.00",
    "1.",
    ".50",
    "abc",
    "",
    "NaN",
    "Infinity",
    12.99 as unknown as string,
    null as unknown as string,
    undefined as unknown as string,
  ]) {
    assert.equal(decimalStringToCents(bad), null, JSON.stringify(bad));
  }
});

test("decimalStringToCents: rejects an integer part large enough to overflow safe-integer cents", () => {
  assert.equal(decimalStringToCents("9999999999999.99"), null);
});
