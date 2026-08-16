// QuickHack note: 서버 소유 PostgreSQL pool에 연결할 Prisma client를 생성하고 재사용합니다.
import { PrismaClient } from "@/generated/prisma/client";
import { createPostgresqlPrismaClient } from "@/quickhack_server/core/database/postgresql-client";
import { resolvePostgresqlConnectionStringSync } from "@/quickhack_server/core/database/postgresql-credential.mjs";
import { recordOperationQuery } from "@/quickhack_server/observability/operation-trace";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaProxy?: PrismaClient;
};
let localPrisma: PrismaClient | undefined;

function createClient() {
  const connectionString = resolvePostgresqlConnectionStringSync({
    role: "runtime",
    applicationName: "quickhack-server",
  });
  const { client } = createPostgresqlPrismaClient({
    connectionString,
    applicationName: "quickhack-server",
  });

  return client.$extends({
    query: {
      $allOperations: async ({ operation, args, query }) => {
        const startedAt = performance.now();

        try {
          return await query(args);
        } finally {
          recordOperationQuery(operation, performance.now() - startedAt);
        }
      },
    },
  }) as unknown as PrismaClient;
}

function getClient() {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;
  if (localPrisma) return localPrisma;

  const client = createClient();
  localPrisma = client;
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
  }
  return client;
}

function createLazyClient() {
  return new Proxy({} as PrismaClient, {
    get(target, property) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, target);
      }
      const client = getClient();
      const value = Reflect.get(client, property, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}

export const prisma = globalForPrisma.prismaProxy ?? createLazyClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaProxy = prisma;
}
