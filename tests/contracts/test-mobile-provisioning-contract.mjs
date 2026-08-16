import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const service = read("quickhack_server/mobile/mobile-device-service.ts");
const baseline = read(
  "prisma/migrations/20260811010000_postgresql_baseline/migration.sql"
);
const bridge = read("quickhack_client/api/adb/mobile-provision.ts");
const delivery = read("quickhack_client/adb/mobile-provisioning.ts");
const clientTrust = read("quickhack_client/security/mobile-trust-bundle.ts");
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
const androidInbox = read(
  "quickhack_android/app/src/main/java/com/quickhack/mobile/ProvisioningInbox.java"
);
const androidPending = read(
  "quickhack_android/app/src/main/java/com/quickhack/mobile/PendingActivationRecord.java"
);
const androidRecoveryPolicy = read(
  "quickhack_android/app/src/main/java/com/quickhack/mobile/ActivationRecoveryPolicy.java"
);
const androidManagedTrust = read(
  "quickhack_android/app/src/main/java/com/quickhack/mobile/ManagedTrustBundle.java"
);
const androidTrustStore = read(
  "quickhack_android/app/src/main/java/com/quickhack/mobile/MobileTrustStore.java"
);
const androidNetworkSecurity = read(
  "quickhack_android/app/src/main/res/xml/network_security_config.xml"
);
const androidManifest = read(
  "quickhack_android/app/src/main/AndroidManifest.xml"
);
const androidStrings = read(
  "quickhack_android/app/src/main/res/values/strings.xml"
);
const androidLayout = read(
  "quickhack_android/app/src/main/res/layout/activity_main.xml"
);
const activationRoute = read(
  "quickhack_server/api/mobile/activate-device.ts"
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
assert.match(bridge, /loadMobileManagedTrustBundle/);
assert.ok(
  bridge.indexOf("loadMobileManagedTrustBundle") < bridge.indexOf("mutateServerJson<ProvisionResponse>"),
  "The client must validate its managed trust bundle before creating provisioning state."
);
assert.match(delivery, /trustBundle:\s*input\.trustBundle/);
assert.match(clientTrust, /readClientTrustBundleSync/);
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
assert.match(androidApi, /HttpsURLConnection/);
assert.match(androidApi, /setSSLSocketFactory/);
assert.match(androidApi, /Authenticated QuickHack managed trust is required/);
assert.match(androidApi, /value instanceof Boolean && Boolean\.TRUE\.equals\(value\)/);
assert.doesNotMatch(androidActivity, /ProvisioningInbox\.take/);
assert.match(androidActivity, /ProvisioningInbox\.peek/);
assert.match(androidActivity, /ProvisioningInbox\.removeIfMatches/);
assert.match(androidActivity, /proofKey\.signBase64/);
assert.doesNotMatch(androidActivity, /activationCodeInput|CameraTarget\.ACTIVATION/);
assert.doesNotMatch(androidStrings, /activation_code|scan_activation_code|기기 등록 코드/);
assert.match(androidCredentials, /DEVICE_TOKEN, encrypt\(token, origin\)/);
assert.match(androidCredentials, /updateAAD\(aad\.getBytes/);
assert.match(androidCredentials, /getSharedPreferences\("quickhack\.mobile"/);
assert.match(androidCredentials, /QH-MOBILE-PENDING-ACTIVATION-V1/);
assert.match(androidCredentials, /savePendingActivation/);
assert.match(androidCredentials, /saveDeviceToken[\s\S]*\.commit\(\)/);
assert.match(androidInbox, /AES\/GCM\/NoPadding/);
assert.match(androidInbox, /QH-MOBILE-PROVISIONING-INBOX-V1/);
assert.match(androidInbox, /writeEncrypted[\s\S]*\.commit\(\)/);
assert.doesNotMatch(androidInbox, /static synchronized String take/);
assert.match(androidPending, /proofPublicKeySpki/);
assert.match(androidPending, /trustBundleDigestSha256/);
assert.match(androidPending, /version != 1 && version != VERSION/);
assert.match(androidPending, /inboxPayload/);
assert.match(androidManagedTrust, /requireExactKeys/);
assert.match(androidManagedTrust, /getBasicConstraints\(\) < 0/);
assert.match(androidManagedTrust, /TrustManagerFactory/);
assert.match(androidManagedTrust, /quickhack-current/);
assert.match(androidManagedTrust, /quickhack-previous/);
assert.match(androidTrustStore, /AndroidKeyStore/);
assert.match(androidTrustStore, /AES\/GCM\/NoPadding/);
assert.match(androidTrustStore, /QH-MOBILE-MANAGED-TRUST-V1/);
assert.match(androidTrustStore, /\.commit\(\)/);
assert.doesNotMatch(androidNetworkSecurity, /@raw\/quickhack_ca/);
assert.match(androidNetworkSecurity, /cleartextTrafficPermitted="false"/);
assert.equal(
  fs.existsSync("quickhack_android/app/src/main/res/raw/quickhack_ca.pem"),
  false,
  "The release APK still embeds a static QuickHack CA."
);
assert.match(androidRecoveryPolicy, /MOBILE_DEVICE_PROVISIONING_EXPIRED/);
assert.match(androidRecoveryPolicy, /MOBILE_DEVICE_PROVISIONING_INVALIDATED/);
assert.match(androidRecoveryPolicy, /FINALIZE_SAVED_CREDENTIAL/);
assert.match(androidRecoveryPolicy, /BLOCK_PROOF_MISMATCH/);
assert.match(androidLayout, /@\+id\/cancel_activation_button/);
assert.match(androidStrings, /activation_recovery_ready/);
assert.match(service, /MOBILE_DEVICE_PROVISIONING_EXPIRED/);
assert.match(service, /MOBILE_DEVICE_PROVISIONING_INVALIDATED/);
assert.match(activationRoute, /status: error\.status/);
assert.match(activationRoute, /code: error\.code/);

assert.match(
  androidActivity,
  /activateProvisioningRequest\(\)[\s\S]*preparePendingActivation\(request\)[\s\S]*api\.activateDevice\(body\)/
);
assert.match(
  androidActivity,
  /trustStore\.save\(parsed\.trustBundle\)[\s\S]*api\.setManagedTrustBundle\(managedTrustBundle\)/
);
assert.match(
  androidActivity,
  /record\.trustBundleDigestSha256\.isEmpty\(\)[\s\S]*recoveredTrust\.identityDigestSha256/
);
assert.match(
  androidActivity,
  /preparePendingActivation\(ProvisioningRequest request\)[\s\S]*credentialStore\.savePendingActivation\(created\)/
);
assert.match(
  androidActivity,
  /credentialStore\.saveDeviceToken\([\s\S]*finalizePendingActivation\(record\)/
);
assert.match(
  androidActivity,
  /!ServerOrigin\.same\(pendingActivation\.serverOrigin, serverUrl\)[\s\S]*discardPendingActivation\(pendingActivation\)/
);
assert.match(
  androidActivity,
  /ActivationRecoveryPolicy\.isTerminalFailure\(response\)[\s\S]*discardPendingActivation\(record\)/
);
assert.match(
  androidActivity,
  /finalizePendingActivation\(PendingActivationRecord record\)[\s\S]*ProvisioningInbox\.removeIfMatches\(this, record\.inboxPayload\)[\s\S]*credentialStore\.clearPendingActivation\(record\)/
);
assert.match(
  androidActivity,
  /discardPendingActivation\(PendingActivationRecord record\)[\s\S]*ProvisioningInbox\.removeIfMatches\(this, record\.inboxPayload\)[\s\S]*credentialStore\.clearCredentialMaterial\(\)/
);
assert.match(
  androidManifest,
  /android:name="\.AdbProvisioningActivity"[\s\S]*android:permission="android\.permission\.DUMP"/
);

console.log(
  "Mobile provisioning, durable Android activation replay, exact ADB target, origin-bound credential, and packing transaction contracts verified."
);
