import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "@prisma/client";

/**
 * Request-scoped database access.
 *
 * Cloudflare Workers forbid using an I/O object (a WebSocket, a pooled connection) that was
 * created during one request from another request. A process-wide Prisma client with a Neon
 * WebSocket pool therefore works for one request at a time and then fails or hangs under
 * parallel requests ("A promise was resolved or rejected from a different request context").
 *
 * In the Worker every request gets its own client, created lazily on first use and
 * disconnected once the response has finished streaming. Outside a request scope the Worker
 * runtime refuses to hand out a client at all, so no module can silently fall back to a
 * shared one. Node (tests, scripts, dev tooling) keeps its single process-wide client.
 */

export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScopedDbOptions {
  /** True in Cloudflare Workers / workerd, where a connection must never outlive its request. */
  workerRuntime: boolean;
  createClient(connectionString: string): PrismaClient;
  /** Node only: the process-wide client used when no request scope is active. */
  fallback(): PrismaClient;
}

interface RequestScope {
  connectionString: string;
  client?: PrismaClient;
  released: boolean;
}

export function createScopedDb(options: ScopedDbOptions) {
  const storage = new AsyncLocalStorage<RequestScope>();

  function current(): PrismaClient {
    const scope = storage.getStore();
    if (scope) {
      if (scope.released) {
        throw new Error("Database used after its request finished; await all database work before the response completes.");
      }
      return (scope.client ??= options.createClient(scope.connectionString));
    }
    if (options.workerRuntime) {
      throw new Error("Database client requested outside a request scope in the Worker runtime.");
    }
    return options.fallback();
  }

  /** Behaves like a PrismaClient; every property access resolves the CURRENT request's client. */
  const db = new Proxy({} as PrismaClient, {
    get(_target, prop) {
      // Never resolve a client for promise/inspection probes (`await db`, console.log, JSON).
      if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return undefined;
      const client = current();
      const value = Reflect.get(client, prop, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });

  async function release(scope: RequestScope): Promise<void> {
    scope.released = true;
    const client = scope.client;
    scope.client = undefined;
    if (!client) return;
    try {
      await client.$disconnect();
    } catch (error) {
      console.error("failed to disconnect the request-scoped database client", error instanceof Error ? error.message : error);
    }
  }

  /**
   * Runs `handler` inside a fresh request scope and releases the scope's client when the
   * response is done: immediately for a bodiless response, otherwise once the body has been
   * fully streamed (or the consumer cancelled it).
   */
  async function runInRequestScope(connectionString: string, handler: () => Promise<Response>, ctx: WaitUntil): Promise<Response> {
    const scope: RequestScope = { connectionString, released: false };

    let response: Response;
    try {
      response = await storage.run(scope, handler);
    } catch (error) {
      ctx.waitUntil(release(scope));
      throw error;
    }

    if (!response.body) {
      ctx.waitUntil(release(scope));
      return response;
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    ctx.waitUntil(
      response.body.pipeTo(writable).then(
        () => release(scope),
        () => release(scope),
      ),
    );
    return new Response(readable, response);
  }

  return { db, current, runInRequestScope };
}
