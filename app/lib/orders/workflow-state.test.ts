import { test } from "node:test";
import assert from "node:assert/strict";
import { canTransition, createProofToken, hashProofToken } from "./workflow-state.ts";

test("allows only the approved production sequence", () => {
  assert.equal(canTransition("received", "artwork_pending"), true);
  assert.equal(canTransition("proof_ready", "revision_requested"), true);
  assert.equal(canTransition("approved", "production"), true);
  assert.equal(canTransition("received", "production"), false);
  assert.equal(canTransition("completed", "production"), false);
});

test("proof tokens are stored as hashes and never equal the raw token", () => {
  const proof = createProofToken();
  assert.notEqual(proof.token, proof.tokenHash);
  assert.equal(hashProofToken(proof.token), proof.tokenHash);
});
