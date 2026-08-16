// QuickHack note: Prisma CLI는 제품 환경변수가 아니라 서버 소유 연결 resolver를 사용합니다.
import { defineConfig } from "prisma/config";
import { resolvePostgresqlConnectionStringSync } from "./quickhack_server/core/database/postgresql-credential.mjs";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: resolvePostgresqlConnectionStringSync({
      role: "migrator",
      applicationName: "quickhack-prisma-cli",
      allowSchemaOnlyFallback: true,
      runtimeConfigPath: String(
        process.env.QUICKHACK_PRISMA_RUNTIME_CONFIG_PATH ?? ""
      ).trim(),
    }),
  },
});
