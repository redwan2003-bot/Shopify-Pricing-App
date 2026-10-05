import { test } from "node:test";
import assert from "node:assert/strict";
import { hashProofToken } from "./workflow-state.ts";

test("proof tokens can be verified only through their hash", () => {
  const token = "example-proof-token";
  assert.equal(hashProofToken(token).length, 64);
  assert.notEqual(hashProofToken(token), hashProofToken(`${token}-changed`));
});
