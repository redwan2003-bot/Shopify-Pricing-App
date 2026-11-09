import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const extensionRoot = new URL("../../extensions/imprintid-dynamic-pricing/", import.meta.url);

test("the theme block uses collision-safe storefront asset names", async () => {
  const [block, client] = await Promise.all([
    readFile(new URL("blocks/dynamic-pricing.liquid", extensionRoot), "utf8"),
    readFile(new URL("assets/imprintid-dynamic-pricing-bundle.js", extensionRoot), "utf8"),
  ]);

  assert.match(block, /'imprintid-dynamic-pricing-bundle\.js' \| asset_url/);
  assert.doesNotMatch(block, /'dynamic-pricing\.js' \| asset_url/);
  assert.doesNotMatch(client, /^import\s/m);
  assert.match(client, /function readSignedV2Quote/);
  assert.match(client, /"quoteId"/);
  assert.match(client, /"issuedAtServer"/);
  assert.match(client, /catalog\.productColors && catalog\.productColors\.length/);
});
