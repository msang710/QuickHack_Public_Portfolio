import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const service = read("quickhack_server/mobile/mobile-device-service.ts");
const baseline = read(
  "prisma/migrations/20260811010000_postgresql_baseline/migration.sql"
);
const bridge = read("quickhack_client/api/adb/mobile-provision.ts");
const adb = read("quickhack_client/adb/adb.ts");
const adbTargetPolicy = read("quickhack_shared/adb/adb-target-policy.ts");
const personalUi = read(
  "quickhack_client/components/user/account-mobile-app-panel.tsx"
);
const adminUi = read(
  "quickhack_client/components/admin/user-account-manager-view.tsx"
);
const packing = read("quickhack_server/mobile/packing-check-service.ts");
const androidApi = read(
  "quickhack_android/app/src/main/java/com/quickhack/mobile/QuickHackApi.java"
);
const androidActivity = read(
  "quickhack_android/app/src/main/java/com/quickhack/mobile/MainActivity.java"
);
const androidCredentials = read(
  "quickhack_android/app/src/main/java/com/quickhack/mobile/MobileCredentialStore.java"
);
const androidManifest = read(
  "quickhack_android/app/src/main/AndroidManifest.xml"
);
const androidStrings = read(
  "quickhack_android/app/src/main/res/values/strings.xml"
);

assert.match(baseline, /registration_state.*PROVISIONING/s);
assert.match(baseline, /uq_mobile_registered_devices_live_adb_serial/);
assert.match(baseline, /uq_mobile_registered_devices_active_public_key/);
assert.match(service, /expectedRegistrationRevision/);
assert.match(service, /QH-MOBILE-PROVISION-V1/);
assert.match(service, /requireMobilePackingDeviceInTransaction/);
assert.equal(
  [...service.matchAll(/requireActiveAccount:\s*false/g)].length,
  2,
  "Provisioning compensation and explicit revocation must remain available after account deactivation."
);
assert.doesNotMatch(service, /activation_code_hash|randomActivationCode/);

assert.match(bridge, /deliverMobileProvisioningBootstrap/);
assert.match(bridge, /cancelProvisioning/);
const successfulBridgeResponse = bridge.slice(
  bridge.lastIndexOf("return NextResponse.json")
);
assert.doesNotMatch(successfulBridgeResponse, /bootstrap|provisioningToken/);
assert.match(adb, /runExactAdbCommand/);
assert.match(adb, /requestedSerials: string\[\]/);
assert.doesNotMatch(adb, /serials === undefined/);
assert.match(adbTargetPolicy, /_adb-tls-/);
assert.match(adbTargetPolicy, /\/:\//);

assert.doesNotMatch(personalUi, /activationCode|직접 입력/);
assert.doesNotMatch(adminUi, /등록코드 발급|serial 직접 입력|수동 입력/);
assert.match(personalUi, /registrationRevision/);
assert.match(adminUi, /registrationRevision/);

assert.match(packing, /ACTIVE_MATCH_WORKER_ALLOCATION_STATUSES/);
assert.match(packing, /current_carrier_shipment/);
assert.match(packing, /required_color/);
assert.doesNotMatch(packing, /take:\s*50/);

assert.match(androidApi, /setInstanceFollowRedirects\(false\)/);
assert.match(androidApi, /value instanceof Boolean && Boolean\.TRUE\.equals\(value\)/);
assert.match(androidActivity, /ProvisioningInbox\.take/);
assert.match(androidActivity, /proofKey\.signBase64/);
assert.doesNotMatch(androidActivity, /activationCodeInput|CameraTarget\.ACTIVATION/);
assert.doesNotMatch(androidStrings, /activation_code|scan_activation_code|기기 등록 코드/);
assert.match(androidCredentials, /updateAAD\(origin\.getBytes/);
assert.match(androidCredentials, /getSharedPreferences\("quickhack\.mobile"/);
assert.match(
  androidManifest,
  /android:name="\.AdbProvisioningActivity"[\s\S]*android:permission="android\.permission\.DUMP"/
);

console.log(
  "Mobile provisioning, exact ADB target, origin-bound Android credential, and packing transaction contracts verified."
);
