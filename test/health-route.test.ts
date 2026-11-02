import assert from "node:assert/strict";
import test from "node:test";
import { loader } from "../app/routes/health.ts";

test("health route returns a non-cacheable Worker liveness response", async () => {
  const response = await loader();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "shopify-pricing-app",
  });
});
