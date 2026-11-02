import { PrismaClient } from "@prisma/client";

// Cached on globalThis because a dev hot-reload re-evaluates this module and a
// fresh PrismaClient each time would leak its connection pool.
const globalForPrisma = globalThis as typeof globalThis & {
  __misePrisma?: PrismaClient;
};

/** The one PrismaClient for the process — never construct another. */
export const prisma: PrismaClient =
  globalForPrisma.__misePrisma ?? new PrismaClient();

globalForPrisma.__misePrisma = prisma;

export * from "@prisma/client";
