import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase("quickhack-personal-settings-locale-");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const { PersonalSettingsValidationError, getPersonalSettings, savePersonalSettings } =
    await import("@/quickhack_server/user/personal-settings-service");
  const { createDefaultPersonalSettings } = await import(
    "@/quickhack_shared/user/personal-settings"
  );

  const user = await prisma.users.create({
    data: {
      username: `locale-${process.pid}`,
      password_hash: "integration-test-only",
      role: "STAFF",
    },
  });
  const defaults = createDefaultPersonalSettings();
  const initial = await getPersonalSettings(prisma, user.user_id);
  assert.equal(initial.locale, "ko");
  assert.equal(initial.revision, 0);

  const saved = await savePersonalSettings(prisma, user.user_id, {
    expectedRevision: 0,
    locale: "en",
    preferences: defaults.preferences,
    shortcutBindings: defaults.shortcutBindings,
  });
  assert.equal(saved.locale, "en");
  assert.equal(saved.revision, 1);
  assert.deepEqual(
    await prisma.user_preferences.findUnique({
      where: { user_id: user.user_id },
      select: { locale: true, settings_revision: true },
    }),
    { locale: "en", settings_revision: 1 }
  );

  await assert.rejects(
    savePersonalSettings(prisma, user.user_id, {
      expectedRevision: 0,
      locale: "ko",
      preferences: defaults.preferences,
      shortcutBindings: defaults.shortcutBindings,
    }),
    (error) =>
      error instanceof PersonalSettingsValidationError && error.status === 409
  );
  await assert.rejects(
    savePersonalSettings(prisma, user.user_id, {
      expectedRevision: 1,
      locale: "ja",
      preferences: defaults.preferences,
      shortcutBindings: defaults.shortcutBindings,
    }),
    (error) => error instanceof PersonalSettingsValidationError
  );
  assert.equal((await getPersonalSettings(prisma, user.user_id)).locale, "en");

  const attempts = await Promise.allSettled([
    savePersonalSettings(prisma, user.user_id, {
      expectedRevision: 1,
      locale: "ko",
      preferences: defaults.preferences,
      shortcutBindings: defaults.shortcutBindings,
    }),
    savePersonalSettings(prisma, user.user_id, {
      expectedRevision: 1,
      locale: "en",
      preferences: defaults.preferences,
      shortcutBindings: defaults.shortcutBindings,
    }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  assert.equal((await getPersonalSettings(prisma, user.user_id)).revision, 2);

  console.log("personal settings locale PostgreSQL integration passed.");
} finally {
  await prisma?.$disconnect();
  temporaryDatabase.cleanup();
}
