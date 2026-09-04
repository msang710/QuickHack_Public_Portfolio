import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const schema = read("prisma/schema.prisma");
const migration = read(
  "prisma/migrations/20260828010000_user_locale/migration.sql"
);
const service = read("quickhack_server/user/personal-settings-service.ts");
const login = read("quickhack_server/api/auth/login.ts");
const settingsApi = read(
  "quickhack_server/api/auth/personal-settings.ts"
);

assert.match(schema, /locale\s+String\s+@default\("ko"\)/u);
assert.match(migration, /ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'ko'/u);
assert.match(migration, /CHECK \("locale" IN \('ko', 'en'\)\)/u);
assert.match(service, /settings_revision: input\.expectedRevision/u);
assert.match(service, /locale: input\.locale/u);
assert.match(service, /normalizeQuickHackLocale\(input\.locale\)/u);
assert.match(login, /setLocaleSnapshotCookie/u);
assert.match(settingsApi, /setLocaleSnapshotCookie/u);

console.log("i18n locale persistence contract passed.");
