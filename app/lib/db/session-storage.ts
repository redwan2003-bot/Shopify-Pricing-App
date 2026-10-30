import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import type { PrismaClient } from "@prisma/client";

/**
 * Shopify's PrismaSessionStorage probes the session table once, when it is constructed, and
 * keeps the result for the lifetime of the process (a failed probe leaves every later session
 * call failing). Constructed at module load in a Worker, that probe would run on a request's
 * connection that is closed when the request ends. The table is created by migrations, so the
 * probe is skipped here; real session calls still reach the database and surface real errors.
 *
 * Patched on this subclass only, so the shared package behaves as before everywhere else.
 */
class ScopedSessionStorage extends PrismaSessionStorage<PrismaClient> {}
(ScopedSessionStorage.prototype as unknown as { pollForTable(): Promise<void> }).pollForTable = async () => {};

/**
 * Session storage that resolves the database client at CALL time via `getClient`, so each
 * session read/write uses the current request's client and nothing is bound at module load.
 */
export function createScopedSessionStorage(getClient: () => PrismaClient): PrismaSessionStorage<PrismaClient> {
  const session = new Proxy(
    {},
    {
      get(_target, method) {
        if (typeof method === "symbol" || method === "then") return undefined;
        return (...args: unknown[]) =>
          (getClient().session as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);
      },
    },
  );
  return new ScopedSessionStorage({ session } as unknown as PrismaClient);
}
