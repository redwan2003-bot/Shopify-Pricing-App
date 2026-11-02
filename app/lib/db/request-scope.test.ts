import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { createScopedDb } from "./request-scope.ts";

/**
 * Regression for the Worker failure where one process-wide Neon pool was shared by parallel
 * requests ("A promise was resolved or rejected from a different request context").
 * These use fake clients, so they prove the isolation and lifecycle rules without a database.
 */

interface FakeClient {
  id: number;
  disconnected: boolean;
  $disconnect(): Promise<void>;
}

function harness(workerRuntime = true) {
  let created = 0;
  const clients: FakeClient[] = [];
  const pending: Promise<unknown>[] = [];
  const scoped = createScopedDb({
    workerRuntime,
    createClient: () => {
      const client: FakeClient = {
        id: ++created,
        disconnected: false,
        async $disconnect() {
          client.disconnected = true;
        },
      };
      clients.push(client);
      return client as unknown as PrismaClient;
    },
    fallback: () => ({ id: -1, disconnected: false, async $disconnect() {} }) as unknown as PrismaClient,
  });
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const settle = async () => void (await Promise.all(pending));
  const idOf = () => (scoped.db as unknown as FakeClient).id;
  return { ...scoped, clients, ctx, settle, idOf, created: () => created };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("parallel requests each get their own client, and never see another request's", async () => {
  const h = harness();
  const seen = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      h.runInRequestScope(`conn-${i}`, async () => {
        const first = h.idOf();
        await sleep(Math.random() * 15);
        const second = h.idOf();
        await sleep(Math.random() * 15);
        const third = h.idOf();
        assert.equal(first, second, "same client across awaits inside one request");
        assert.equal(second, third);
        return new Response(String(first));
      }, h.ctx).then((r) => r.text()),
    ),
  );
  await h.settle();
  assert.equal(new Set(seen).size, 40, "forty requests, forty distinct clients");
  assert.equal(h.created(), 40);
  assert.ok(h.clients.every((c) => c.disconnected), "every client is disconnected afterwards");
});

test("a request that never touches the database creates and disconnects nothing", async () => {
  const h = harness();
  const res = await h.runInRequestScope("conn", async () => new Response("static"), h.ctx);
  assert.equal(await res.text(), "static");
  await h.settle();
  assert.equal(h.created(), 0);
});

test("the client is released only after the response body has fully streamed", async () => {
  const h = harness();
  const encoder = new TextEncoder();
  const res = await h.runInRequestScope("conn", async () => {
    h.idOf(); // touch the database so a client exists
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode("a"));
          await sleep(20);
          controller.enqueue(encoder.encode("b"));
          controller.close();
        },
      }),
      { status: 201, headers: { "x-test": "kept" } },
    );
  }, h.ctx);

  assert.equal(h.clients[0].disconnected, false, "not released while the body is still pending");
  assert.equal(res.status, 201, "status survives the wrapping");
  assert.equal(res.headers.get("x-test"), "kept", "headers survive the wrapping");
  assert.equal(await res.text(), "ab");
  await h.settle();
  assert.equal(h.clients[0].disconnected, true);
});

test("cancelling the response body still releases the client", async () => {
  const h = harness();
  const res = await h.runInRequestScope("conn", async () => {
    h.idOf();
    return new Response(new ReadableStream({ start() {} })); // never produces data
  }, h.ctx);
  await res.body!.cancel();
  await h.settle();
  assert.equal(h.clients[0].disconnected, true);
});

test("a handler that throws still releases the client and rethrows", async () => {
  const h = harness();
  await assert.rejects(
    h.runInRequestScope("conn", async () => {
      h.idOf();
      throw new Error("boom");
    }, h.ctx),
    /boom/,
  );
  await h.settle();
  assert.equal(h.clients[0].disconnected, true);
});

test("in the Worker runtime there is no global fallback outside a request scope", () => {
  const h = harness(true);
  assert.throws(() => h.idOf(), /outside a request scope/);
  assert.throws(() => h.current(), /outside a request scope/);
  assert.equal(h.created(), 0, "nothing was created as a side effect");
});

test("database work that outlives its request is refused, not silently reconnected", async () => {
  const h = harness();
  let late: unknown;
  const res = await h.runInRequestScope("conn", async () => {
    h.idOf();
    setTimeout(() => {
      try {
        h.idOf();
      } catch (error) {
        late = error;
      }
    }, 40);
    return new Response("done");
  }, h.ctx);
  await res.text();
  await h.settle();
  await sleep(80);
  assert.match(String((late as Error)?.message), /after its request finished/);
  assert.equal(h.created(), 1, "no second client was created for the stale work");
});

test("awaiting or inspecting the db proxy does not resolve a client", async () => {
  const h = harness(true);
  assert.equal(await Promise.resolve(h.db), h.db, "await db is safe outside a scope");
  assert.equal((h.db as unknown as { then?: unknown }).then, undefined);
  assert.equal(h.created(), 0);
});

test("outside the Worker runtime the process-wide client is still used", () => {
  const h = harness(false);
  assert.equal(h.idOf(), -1);
  assert.equal(h.idOf(), -1);
  assert.equal(h.created(), 0);
});
