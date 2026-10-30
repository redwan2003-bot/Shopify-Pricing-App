import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { createScopedDb } from "./lib/db/request-scope.ts";

// Cloudflare Workers identify themselves this way; Node reports "Node.js/<version>".
const isWorkerRuntime = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

function newClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaNeon({ connectionString }) });
}

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

/** Node only (tests, scripts, dev tooling): one process-wide client, exactly as before. */
function nodeSingleton(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("Missing DATABASE_URL");
  }

  const prisma = globalForPrisma.prisma ?? newClient(connectionString);

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = prisma;
  }

  return prisma;
}

const scoped = createScopedDb({
  workerRuntime: isWorkerRuntime,
  createClient(connectionString) {
    if (!connectionString) throw new Error("Missing DATABASE_URL");
    return newClient(connectionString);
  },
  fallback: nodeSingleton,
});

// Preserve the Node fail-fast behaviour: a missing DATABASE_URL still throws at import.
if (!isWorkerRuntime) nodeSingleton();

/** Wrap each Worker request in this so the database client is created and released per request. */
export const runInRequestScope = scoped.runInRequestScope;

/** The client for the current request (Worker) or the process-wide client (Node). */
export const currentPrisma = scoped.current;

export default scoped.db;
