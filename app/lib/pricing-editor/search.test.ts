import test from "node:test";
import assert from "node:assert/strict";
import { pricingProfileSearchWhere } from "./search.ts";

test("pricing-profile search is store-scoped and case-insensitive for SKU and name", () => {
  assert.deepEqual(pricingProfileSearchWhere("store-1", "edt"), {
    storeId: "store-1",
    OR: [
      { sku: { contains: "edt", mode: "insensitive" } },
      { name: { contains: "edt", mode: "insensitive" } },
    ],
  });
});

test("an empty pricing-profile search keeps only the store boundary", () => {
  assert.deepEqual(pricingProfileSearchWhere("store-1", ""), { storeId: "store-1" });
});
