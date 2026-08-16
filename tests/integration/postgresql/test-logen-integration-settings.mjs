import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase(
  "quickhack-logen-integration-settings-"
);
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

const { prisma } = await import("@/quickhack_server/core/prisma");
const {
  getLogenIntegrationSettings,
  saveLogenIntegrationSettings,
} = await import(
  "@/quickhack_server/shipment/carrier-integration/logen/settings-service"
);
const { assertLogenWriteAllowed, getLogenRegistrationConfig } = await import(
  "@/quickhack_server/shipment/carrier-integration/logen/config"
);

const actor = await prisma.users.create({
  data: {
    username: "settings-leader",
    password_hash: "test-only-hash",
    role: "LEADER",
  },
});

const firstInput = {
  sender: {
    name: "QuickHack 물류",
    tel: "0200000000",
    cell: "01000000000",
    zipCode: "05555",
    address1: "서울특별시 테스트로 1",
    address2: "QuickHack 물류센터",
  },
  defaultBoxTypeCode: "AS080",
  expectedRevision: 0,
};

function writeLiveRuntimeConfig(writeApiEnabled) {
  const runtimeConfig = JSON.parse(
    readFileSync(temporaryDatabase.runtimeConfigPath, "utf8")
  );
  const operationalDatabase = {
    host: runtimeConfig.database.host,
    port: runtimeConfig.database.port,
    name: runtimeConfig.database.name,
    runtimeUser: runtimeConfig.database.runtimeUser,
    migratorUser: runtimeConfig.database.migratorUser,
  };
  writeFileSync(
    temporaryDatabase.runtimeConfigPath,
    `${JSON.stringify(
      {
        ...runtimeConfig,
        packageFlavor: "OPERATIONAL",
        environment: "production",
        coupangWriteApiEnabled: true,
        logenWriteApiEnabled: writeApiEnabled,
        database: operationalDatabase,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

try {
  assert.deepEqual(await getLogenIntegrationSettings(), {
    configured: false,
    carrierCode: "LOGEN",
    revision: 0,
  });

  writeLiveRuntimeConfig(true);
  assert.equal((await assertLogenWriteAllowed("getSlipNo")).mode, "live");
  await assert.rejects(
    getLogenRegistrationConfig(),
    (error) => error?.code === "LOGEN_INTEGRATION_SETTINGS_REQUIRED"
  );

  writeLiveRuntimeConfig(false);
  await assert.rejects(
    assertLogenWriteAllowed("getSlipNo"),
    /Logen 쓰기 API가 금지 상태/
  );
  writeLiveRuntimeConfig(true);

  const concurrentCreates = await Promise.allSettled([
    saveLogenIntegrationSettings(firstInput, { userId: actor.user_id }),
    saveLogenIntegrationSettings(firstInput, { userId: actor.user_id }),
  ]);
  assert.equal(
    concurrentCreates.filter((result) => result.status === "fulfilled").length,
    1,
    "Concurrent first settings creation did not elect exactly one writer."
  );
  const rejectedCreate = concurrentCreates.find(
    (result) => result.status === "rejected"
  );
  assert.equal(
    rejectedCreate?.reason?.code,
    "LOGEN_INTEGRATION_SETTINGS_STALE",
    "The losing first settings writer was not mapped to a stale conflict."
  );
  const first = concurrentCreates.find(
    (result) => result.status === "fulfilled"
  ).value;
  assert.equal(first.configured, true);
  assert.equal(first.revision, 1);
  assert.equal(first.sender.name, "QuickHack 물류");
  assert.equal("liveWriteEnabled" in first, false);
  assert.equal("livePreprintRegistrationEnabled" in first, false);

  await assert.rejects(
    saveLogenIntegrationSettings(
      { ...firstInput, sender: { ...firstInput.sender, name: "stale" } },
      { userId: actor.user_id }
    ),
    (error) => error?.code === "LOGEN_INTEGRATION_SETTINGS_STALE"
  );

  const second = await saveLogenIntegrationSettings(
    {
      ...firstInput,
      sender: { ...firstInput.sender, name: "QuickHack 새 물류" },
      expectedRevision: 1,
    },
    { userId: actor.user_id }
  );
  assert.equal(second.revision, 2);
  assert.equal(second.sender.name, "QuickHack 새 물류");

  const activityLogs = await prisma.employee_activity_logs.findMany({
    where: { action_type: "LOGEN_INTEGRATION_SETTINGS_UPDATE" },
    include: { changes: true },
    orderBy: { id: "asc" },
  });
  assert.equal(activityLogs.length, 2);
  assert.equal(activityLogs[0].user_id, actor.user_id);
  assert.equal(activityLogs[1].target_id, "LOGEN");
  assert.doesNotMatch(JSON.stringify(activityLogs), /secret|access.?key|credential/i);

  const registration = await getLogenRegistrationConfig();
  assert.equal(registration.mode, "live");
  assert.equal(registration.settingsRevision, 2);
  assert.equal(registration.sender.name, "QuickHack 새 물류");
  assert.equal(registration.boxTypeCode, "AS080");

  const root = path.resolve(import.meta.dirname, "..", "..", "..");
  const apiSource = readFileSync(
    path.join(root, "quickhack_server/api/admin/carrier-integration-settings.ts"),
    "utf8"
  );
  const uiSource = readFileSync(
    path.join(
      root,
      "quickhack_client/components/invoice/carrier-dispatch-settings-view.tsx"
    ),
    "utf8"
  );
  const securityStatusSource = readFileSync(
    path.join(root, "quickhack_client/components/admin/security-status-view.tsx"),
    "utf8"
  );
  const menuSource = readFileSync(
    path.join(root, "quickhack_client/components/app-shell/device-workspace-menu.ts"),
    "utf8"
  );
  assert.match(apiSource, /SENSITIVE_ACTIONS\.carrierIntegrationSettings/);
  assert.match(apiSource, /canAccessRole\(user\.role, "LEADER"\)/);
  assert.doesNotMatch(apiSource, /liveWriteEnabled|livePreprintRegistrationEnabled/);
  assert.match(uiSource, /택배사 발송 설정/);
  assert.match(uiSource, /expectedRevision: revision/);
  assert.match(uiSource, /verifySensitiveOtpCode/);
  assert.doesNotMatch(uiSource, /liveWriteEnabled|livePreprintRegistrationEnabled/);
  assert.doesNotMatch(
    securityStatusSource,
    /carrier-integration-settings|택배사 발송 설정/
  );
  assert.match(menuSource, /id: "invoice-carrier-dispatch-settings"/);
  assert.match(menuSource, /label: "택배사 발송 설정"/);

  console.log("Logen integration settings checks passed.");
} finally {
  await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
