/**
 * Task 5B.3B.2 — the server-side currency gate (`currency-contract.ts`). Single
 * currency, NO foreign-exchange, no default.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeCurrencyCode, resolveEnforceableCurrency } from "./currency-contract.ts";

test("normalizeCurrencyCode: canonicalizes a valid ISO-4217 alpha code; rejects everything else", () => {
  assert.equal(normalizeCurrencyCode("USD"), "USD");
  assert.equal(normalizeCurrencyCode(" usd "), "USD");
  assert.equal(normalizeCurrencyCode("bdt"), "BDT");
  for (const bad of ["", "US", "USDD", "US1", "US Dollars", "$", 123, null, undefined, {}, ["USD"]]) {
    assert.equal(normalizeCurrencyCode(bad as unknown), null, JSON.stringify(bad));
  }
});

test("resolveEnforceableCurrency: equal + valid → ok; different → PROFILE_SHOP_CURRENCY_MISMATCH; missing → CURRENCY_CONTEXT_UNAVAILABLE", () => {
  assert.deepEqual(resolveEnforceableCurrency("USD", "USD"), { ok: true, currency: "USD" });
  assert.deepEqual(resolveEnforceableCurrency("usd", " USD "), { ok: true, currency: "USD" });

  assert.deepEqual(resolveEnforceableCurrency("USD", "BDT"), { ok: false, reason: "PROFILE_SHOP_CURRENCY_MISMATCH" });
  assert.deepEqual(resolveEnforceableCurrency("EUR", "USD"), { ok: false, reason: "PROFILE_SHOP_CURRENCY_MISMATCH" });

  assert.deepEqual(resolveEnforceableCurrency(null, "USD"), { ok: false, reason: "CURRENCY_CONTEXT_UNAVAILABLE" });
  assert.deepEqual(resolveEnforceableCurrency("USD", undefined), { ok: false, reason: "CURRENCY_CONTEXT_UNAVAILABLE" });
  assert.deepEqual(resolveEnforceableCurrency("US Dollars", "USD"), { ok: false, reason: "CURRENCY_CONTEXT_UNAVAILABLE" });
});

test("resolveEnforceableCurrency: there is NO default — an absent profile currency never becomes USD", () => {
  const r = resolveEnforceableCurrency(undefined, "USD");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "CURRENCY_CONTEXT_UNAVAILABLE");
});

test("resolveEnforceableCurrency: never performs conversion — the result currency is the shared code verbatim", () => {
  const r = resolveEnforceableCurrency("JPY", "JPY");
  assert.deepEqual(r, { ok: true, currency: "JPY" });
});
