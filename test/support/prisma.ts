/**
 * Test-only Prisma factory. Every test file builds its own client through this so files
 * stay isolated, and every client points at the isolated Neon test branch
 * (`TEST_DATABASE_URL`, loaded from `.env.test` by `pnpm test`) — never production.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

export function createTestPrisma(): PrismaClient {
  const connectionString = process.env.TEST_DATABASE_URL;

  if (!connectionString) {
    throw new Error("Missing TEST_DATABASE_URL. Tests must use the isolated Neon test branch.");
  }

  return new PrismaClient({
    adapter: new PrismaNeon({ connectionString }),
  });
}
