import { createHash, randomBytes } from "node:crypto";

export const WORKFLOW_TRANSITIONS: Record<string, readonly string[]> = {
  received: ["artwork_pending"],
  artwork_pending: ["proof_ready"],
  proof_ready: ["revision_requested", "approved"],
  revision_requested: ["proof_ready"],
  approved: ["production"],
  production: ["shipped"],
  shipped: ["completed"],
  completed: [],
};

export function canTransition(from: string, to: string): boolean {
  return (WORKFLOW_TRANSITIONS[from] ?? []).includes(to);
}

export function createProofToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: createHash("sha256").update(token).digest("hex") };
}

export function hashProofToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
