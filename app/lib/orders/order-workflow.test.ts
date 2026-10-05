import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOrderWorkflow } from "./order-workflow.ts";

test("normalizes signed cart configuration from an order line", () => {
  const result = normalizeOrderWorkflow({
    admin_graphql_api_id: "gid://shopify/Order/9001",
    name: "#1001",
    currency: "USD",
    line_items: [{
      admin_graphql_api_id: "gid://shopify/LineItem/1",
      product_id: 8438071820427,
      variant_id: 44010010000,
      sku: "LNY01",
      quantity: 100,
      properties: [
        { name: "_imprintid_pricing_version", value: "2" },
        { name: "_imprintid_pricing_payload", value: JSON.stringify({ configDigest: "digest-1" }) },
        { name: "_imprintid_pricing_signature", value: "signature" },
        { name: "_imprintid_pricing_config", value: JSON.stringify({ quantity: 100, decoration: { method: "SCREEN_PRINT" } }) },
      ],
    }],
  });
  assert.equal(result?.shopifyOrderId, "gid://shopify/Order/9001");
  assert.equal(result?.configurations[0]?.quoteEnvelopePresent, true);
  assert.equal(result?.configurations[0]?.configDigest, "digest-1");
  assert.equal(result?.configurations[0]?.quantity, 100);
});

test("does not mark malformed or incomplete properties as a valid quote", () => {
  const result = normalizeOrderWorkflow({ id: 9002, line_items: [{ id: 2, quantity: 1, properties: { _imprintid_pricing_version: "2", _imprintid_pricing_signature: "sig" } }] });
  assert.equal(result?.configurations[0]?.quoteEnvelopePresent, false);
  assert.equal(result?.configurations[0]?.configuration, null);
});
