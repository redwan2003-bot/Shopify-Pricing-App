import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { createScopedSessionStorage } from "./session-storage.ts";

/**
 * The session storage must not touch the database when it is constructed (that happens at
 * module load in the Worker, outside any request), and each call must use the client that is
 * current AT THAT CALL.
 */

function fakeClient(label: string, calls: string[], row: unknown = null) {
  return {
    session: {
      findUnique: async (args: { where: { id: string } }) => {
        calls.push(`${label}:findUnique:${args.where.id}`);
        return row;
      },
      upsert: async (args: { where: { id: string } }) => {
        calls.push(`${label}:upsert:${args.where.id}`);
        return {};
      },
    },
  } as unknown as PrismaClient;
}

test("constructing the storage performs no database access and reports ready", async () => {
  let resolved = 0;
  const storage = createScopedSessionStorage(() => {
    resolved += 1;
    throw new Error("no client may be resolved at construction");
  });
  assert.equal(resolved, 0, "construction did not resolve a client");
  assert.equal(await storage.isReady(), true);
  assert.equal(resolved, 0, "neither did the readiness check");
});

test("every call resolves the client that is current at call time", async () => {
  const calls: string[] = [];
  let current = fakeClient("request-A", calls);
  const storage = createScopedSessionStorage(() => current);

  assert.equal(await storage.loadSession("offline_shop"), undefined);
  current = fakeClient("request-B", calls);
  assert.equal(await storage.loadSession("offline_shop"), undefined);

  assert.deepEqual(calls, ["request-A:findUnique:offline_shop", "request-B:findUnique:offline_shop"]);
});

test("storing a session goes through the current client's upsert", async () => {
  const calls: string[] = [];
  const storage = createScopedSessionStorage(() => fakeClient("request-C", calls));
  // A minimal stand-in for Shopify's Session: only what the storage reads when it builds the row.
  const session = {
    id: "offline_shop.example",
    shop: "shop.example",
    state: "state",
    isOnline: false,
    scope: undefined,
    expires: undefined,
    accessToken: "test-only-token",
    toObject: () => ({}),
  } as unknown as Parameters<typeof storage.storeSession>[0];
  assert.equal(await storage.storeSession(session), true);
  assert.deepEqual(calls, ["request-C:upsert:offline_shop.example"]);
});
