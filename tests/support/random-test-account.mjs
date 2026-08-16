import { randomBytes } from "node:crypto";
import { assertTemporaryDatabaseScope } from "./postgresql-test-scope.mjs";

export async function createRandomTestAccount(input) {
  assertTemporaryDatabaseScope(input.databaseUrl);
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Random test accounts require NODE_ENV=test.");
  }
  const suffix = randomBytes(12).toString("hex");
  const username = `test_${suffix}`;
  const password = randomBytes(24).toString("base64url");
  const { hashPassword } = await import("../../quickhack_server/core/password.ts");
  const now = new Date();
  const user = await input.prisma.users.create({
    data: {
      username,
      password_hash: await hashPassword(password),
      role: input.role ?? "STAFF",
      is_developer: input.isDeveloper ? 1 : 0,
      mobile_packing_enabled: 0,
      must_change_password: 0,
      is_active: 1,
      created_at: now,
      updated_at: now,
      employee_profiles: {
        create: {
          display_name: input.displayName ?? `Test ${suffix.slice(0, 8)}`,
          created_at: now,
          updated_at: now,
        },
      },
    },
  });
  return { user, username, password };
}
