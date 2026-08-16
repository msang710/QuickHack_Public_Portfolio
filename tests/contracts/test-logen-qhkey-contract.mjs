import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

assert.equal(fs.existsSync(path.join(root, ".env.example")), false);
const logenConfig = read(
  "quickhack_server/shipment/carrier-integration/logen/config.ts"
);
const logenApiClient = read(
  "quickhack_server/shipment/carrier-integration/logen/api-client.ts"
);
const credentialSession = read(
  "quickhack_server/shipment/carrier-integration/logen/credential-session.ts"
);
const registrationService = read(
  "quickhack_server/shipment/carrier-integration/logen/shipment-registration-service.ts"
);
const securityStatus = read("quickhack_server/api/admin/security-status.ts");
const serverConsole = read("tools/server-console-operational.mjs");
const stagingPackage = read("packaging/create-staging-package.mjs");

for (const legacyName of [
  "LOGEN_SECRET_KEY",
  "LOGEN_USER_ID",
  "LOGEN_CUSTOMER_CODE",
]) {
  assert.doesNotMatch(logenConfig, new RegExp(`process\\.env\\.${legacyName}`));
}
assert.doesNotMatch(logenConfig, /LOGEN_(?:SENDER|LIVE|DEFAULT_BOX)/);
assert.match(logenConfig, /requireLogenIntegrationSettings/);
assert.doesNotMatch(
  logenConfig,
  /liveWriteEnabled|livePreprintRegistrationEnabled|assertLogenPreprintRegistrationAllowed/
);

const sessionOpenIndex = logenApiClient.indexOf(
  "const session = options.credentialSession"
);
const retryLoopIndex = logenApiClient.indexOf(
  "for (let attempt = 0; attempt < attempts; attempt += 1)"
);
assert(sessionOpenIndex >= 0 && retryLoopIndex > sessionOpenIndex);
assert.match(logenApiClient, /secretKey: session\.secretKey/);
assert.match(logenApiClient, /JSON\.stringify\(\{ userId: session\.userId/);

const prepareReadIndex = registrationService.indexOf(
  'apiName: "shipmentRegistrationPrepare"'
);
const preparedFingerprintIndex = registrationService.indexOf(
  "credentialFingerprint: credentialSession.status.keyFingerprint"
);
const writeSessionIndex = registrationService.indexOf('apiName: "slipPrintM"');
const settingsRecheckIndex = registrationService.indexOf(
  "currentConfig.settingsRevision !== prepared.settingsRevision"
);
const consistencyIndex = registrationService.indexOf(
  "assertLogenPreparedCredentialMatchesWriteSession("
);
const submittingIndex = registrationService.indexOf(
  "work_status: WORK_STATUS.submitting"
);
assert(prepareReadIndex >= 0);
assert(preparedFingerprintIndex > prepareReadIndex);
assert(writeSessionIndex > preparedFingerprintIndex);
assert(settingsRecheckIndex > preparedFingerprintIndex);
assert(writeSessionIndex > settingsRecheckIndex);
assert(consistencyIndex > writeSessionIndex);
assert(submittingIndex > consistencyIndex);
assert.match(
  registrationService,
  /credentialSession: writeCredentialSession/
);
assert.match(
  credentialSession,
  /writeSession\.status\.keyFingerprint !== prepared\.credentialFingerprint/
);
assert.match(
  credentialSession,
  /LOGEN_CREDENTIAL_CHANGED_DURING_PREPARATION/
);

assert.match(securityStatus, /key: "logen-auth"/);
assert.match(securityStatus, /getLogenCredentialStatus/);
assert.match(serverConsole, /\/api\/qhkey\/logen\/rotate/);
assert.match(serverConsole, /id="logen-key-form"/);
assert.match(serverConsole, /importQhkeyMasterKey/);
assert.doesNotMatch(serverConsole, /mock_server|mock-issue|issueMock/iu);
assert.match(stagingPackage, /server-console-qhkey\.mjs/);

console.log("Logen QHKey integration contract checks passed.");
