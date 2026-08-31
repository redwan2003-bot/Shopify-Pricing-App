import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DecorationRuleNotFound,
  PricingProfileNotFound,
  QuantityBelowMinimum,
  StoreNotFound,
} from "../pricing/errors.ts";
import { mapPricingErrorToStatus, toErrorBody } from "./response.ts";

test("StoreNotFound maps to 404", () => {
  assert.equal(mapPricingErrorToStatus(new StoreNotFound("no-shop.myshopify.com")), 404);
});

test("PricingProfileNotFound maps to 404", () => {
  assert.equal(mapPricingErrorToStatus(new PricingProfileNotFound("shop.myshopify.com", "NOPE")), 404);
});

test("QuantityBelowMinimum maps to 422", () => {
  assert.equal(mapPricingErrorToStatus(new QuantityBelowMinimum(10, 100)), 422);
});

test("DecorationRuleNotFound maps to 422", () => {
  assert.equal(mapPricingErrorToStatus(new DecorationRuleNotFound("SCREEN_PRINT", "SETUP_1C1L")), 422);
});

test("an unrecognized error maps to 500", () => {
  assert.equal(mapPricingErrorToStatus(new Error("connection refused at 10.0.0.5:5432")), 500);
});

test("a PricingError's real code and message are preserved in the response body", () => {
  const body = toErrorBody(new QuantityBelowMinimum(10, 100));
  assert.equal(body.error.code, "QUANTITY_BELOW_MINIMUM");
  assert.match(body.error.message, /quantity 10 is below the minimum/);
});

test("an unexpected error never leaks its raw message to the client", () => {
  const sensitiveError = new Error(
    'Prisma error: connect ECONNREFUSED to postgres://admin:s3cret@10.0.0.5:5432/prod',
  );
  const body = toErrorBody(sensitiveError);
  assert.equal(body.error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(body.error.message, /s3cret|ECONNREFUSED|postgres:\/\//);
  assert.equal(body.error.message, "An unexpected error occurred while calculating pricing.");
});

test("an unexpected error's response body carries no stack trace", () => {
  const body = toErrorBody(new Error("boom"));
  assert.equal(JSON.stringify(body).includes("at "), false); // no stack-frame-shaped text
  assert.equal("stack" in body.error, false);
});
