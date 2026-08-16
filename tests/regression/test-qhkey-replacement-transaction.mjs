import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createQhkeyVolumeIdentity } from "../../quickhack_server/platform/qhkey-contract.mjs";
import { decryptQhkey } from "../../quickhack_server/security/qhkey-format.mjs";
import { createQhkeyReplacementService } from "../../quickhack_server/security/qhkey-replacement-transaction.mjs";
import {
  QHKEY_PUBLISH_HELPER_PATH,
  authorizeQhkeyReplacement,
  createQhkeyAuthorizationPlan,
} from "../../tools/qhkey-authorize.mjs";
import { publishQhkeyReplacement } from "../../tools/qhkey-publish-helper.mjs";

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "quickhack-qhkey-replacement-")
);
const dataDir = path.join(temporaryDirectory, "data");
const stateRoot = path.join(dataDir, "state", "qhkey-replacements");
const volumeRoot = path.join(temporaryDirectory, "volume");
const targetFile = path.join(volumeRoot, "quickhack-keys", "coupang.qhkey");
fs.mkdirSync(volumeRoot, { recursive: true });

const masterKey = Buffer.alloc(32, 0x63);
let now = Date.parse("2026-08-16T00:00:00.000Z");
let volume = createQhkeyVolumeIdentity({
  platform: "linux",
  volumeId: "LINUX-TEST-UUID",
  rootPath: volumeRoot,
  deviceId: "8:17",
  fileSystemUuid: "TEST-UUID",
  label: "QHKEY",
  readOnly: false,
  providers: [],
});
let invalidations = 0;
const masterKeyProvider = {
  async read() {
    return Buffer.from(masterKey);
  },
};
const volumeProvider = {
  async locate(input = {}) {
    if (input.volumeId && input.volumeId !== volume.volumeId) {
      const error = new Error("missing");
      error.code = "QHKEY_VOLUME_MISSING";
      throw error;
    }
    return volume;
  },
  async validate(expected) {
    if (
      expected.volumeId !== volume.volumeId ||
      expected.rootPath !== volume.rootPath ||
      expected.deviceId !== volume.deviceId ||
      expected.fileSystemUuid !== volume.fileSystemUuid
    ) {
      const error = new Error("identity changed");
      error.code = "QHKEY_VOLUME_IDENTITY_CHANGED";
      throw error;
    }
    return volume;
  },
};

function service(overrides = {}) {
  return createQhkeyReplacementService({
    dataDir,
    stateRoot,
    platform: "linux",
    masterKeyProvider,
    volumeProvider,
    clock: () => now,
    transactionTtlMs: 60_000,
    getUid: () => null,
    getGid: () => null,
    invalidateCredentialState() {
      invalidations += 1;
    },
    async syncDirectory() {},
    enforcePosixSecurity: false,
    ...overrides,
  });
}

function credential(suffix) {
  return {
    vendorId: `VENDOR-${suffix}`,
    accessKey: `ACCESS-${suffix}`,
    secretKey: `SECRET-${suffix}`,
  };
}

function replacementInput(suffix, replaceExisting = false) {
  return {
    provider: "COUPANG",
    volumeId: volume.volumeId,
    replaceExisting,
    environment: "live",
    keyAlias: `live-${suffix}`,
    credential: credential(suffix),
    issuedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2027-01-28T00:00:00.000Z",
  };
}

try {
  const replacement = service();
  const prepared = await replacement.prepareReplacement(replacementInput("ONE"));
  assert.equal(prepared.state, "AUTHORIZATION_REQUIRED");
  assert.equal(prepared.volumeId, volume.volumeId);
  assert.equal("credential" in prepared, false);
  assert.equal("rootPath" in prepared, false);
  const duplicate = await replacement.prepareReplacement(replacementInput("DUPLICATE"));
  assert.equal(duplicate.transactionId, prepared.transactionId);

  const recordPath = path.join(stateRoot, `${prepared.transactionId}.json`);
  const stagePath = path.join(stateRoot, `${prepared.transactionId}.stage`);
  const persisted = fs.readFileSync(recordPath, "utf8");
  const staged = fs.readFileSync(stagePath);
  for (const marker of ["VENDOR-ONE", "ACCESS-ONE", "SECRET-ONE", masterKey.toString("hex")]) {
    assert.equal(persisted.includes(marker), false);
    assert.equal(staged.includes(Buffer.from(marker)), false);
  }
  if (os.platform() !== "win32") {
    assert.equal((fs.statSync(recordPath).mode & 0o077), 0);
    assert.equal((fs.statSync(stagePath).mode & 0o077), 0);
  }
  assert.equal((await replacement.replacementStatus(prepared.transactionId)).state, "AUTHORIZATION_REQUIRED");

  await assert.rejects(
    () => publishQhkeyReplacement(prepared.transactionId, {
      platform: "linux",
      getUid: () => 1000,
      service: replacement,
    }),
    (error) => error.code === "QHKEY_AUTHORIZATION_REQUIRED"
  );
  const published = await publishQhkeyReplacement(prepared.transactionId, {
    platform: "linux",
    getUid: () => 0,
    service: replacement,
  });
  assert.equal(published.state, "PUBLISHED");
  assert.equal(fs.existsSync(stagePath), false);
  const opened = decryptQhkey(targetFile, masterKey);
  assert.deepEqual(opened.credential, credential("ONE"));
  assert.equal(invalidations, 1);
  assert.equal((await replacement.publishReplacement(prepared.transactionId, { uid: 0 })).state, "PUBLISHED");
  assert.equal(invalidations, 1);

  volume = createQhkeyVolumeIdentity({ ...volume, providers: ["COUPANG"] });
  const cancelled = await replacement.prepareReplacement(replacementInput("CANCEL", true));
  const beforeCancel = fs.readFileSync(targetFile);
  assert.equal((await replacement.cancelReplacement(cancelled.transactionId)).state, "CANCELLED");
  assert.deepEqual(fs.readFileSync(targetFile), beforeCancel);

  const expiring = await replacement.prepareReplacement(replacementInput("EXPIRE", true));
  now += 60_001;
  const expired = await replacement.replacementStatus(expiring.transactionId);
  assert.equal(expired.state, "EXPIRED");
  assert.equal(expired.errorCode, "QHKEY_TRANSACTION_EXPIRED");
  assert.deepEqual(fs.readFileSync(targetFile), beforeCancel);

  now += 1;
  const targetChanged = await replacement.prepareReplacement(replacementInput("TARGET", true));
  fs.writeFileSync(targetFile, Buffer.from("externally-changed"));
  const targetChangedResult = await replacement.publishReplacement(targetChanged.transactionId, { uid: 0 });
  assert.equal(targetChangedResult.state, "FAILED");
  assert.equal(targetChangedResult.errorCode, "QHKEY_TARGET_CHANGED");
  assert.equal(fs.readFileSync(targetFile, "utf8"), "externally-changed");

  fs.writeFileSync(targetFile, beforeCancel);
  const volumeChanged = await replacement.prepareReplacement(replacementInput("VOLUME", true));
  volume = createQhkeyVolumeIdentity({ ...volume, deviceId: "8:18" });
  const volumeChangedResult = await replacement.publishReplacement(volumeChanged.transactionId, { uid: 0 });
  assert.equal(volumeChangedResult.state, "FAILED");
  assert.equal(volumeChangedResult.errorCode, "QHKEY_VOLUME_IDENTITY_CHANGED");
  assert.deepEqual(fs.readFileSync(targetFile), beforeCancel);
  volume = createQhkeyVolumeIdentity({ ...volume, deviceId: "8:17" });

  const staleLockPrepared = await replacement.prepareReplacement(replacementInput("STALE-LOCK", true));
  const staleRecordPath = path.join(stateRoot, `${staleLockPrepared.transactionId}.json`);
  const staleLockPath = path.join(stateRoot, `${staleLockPrepared.transactionId}.lock`);
  const staleRecord = JSON.parse(fs.readFileSync(staleRecordPath, "utf8"));
  fs.writeFileSync(staleRecordPath, `${JSON.stringify({ ...staleRecord, state: "PUBLISHING" })}\n`);
  fs.writeFileSync(staleLockPath, "");
  fs.utimesSync(staleLockPath, new Date(0), new Date(0));
  const staleLockRecovered = await service({ lockStaleMs: 1000 }).replacementStatus(
    staleLockPrepared.transactionId
  );
  assert.equal(staleLockRecovered.state, "FAILED");
  assert.equal(staleLockRecovered.errorCode, "QHKEY_PUBLISH_FAILED");
  assert.equal(fs.existsSync(staleLockPath), false);

  const recoveryPrepared = await replacement.prepareReplacement(replacementInput("RECOVER", true));
  let targetCommitted = false;
  let failOutcomeRecordOnce = true;
  const recoveryFileSystem = new Proxy(fsPromises, {
    get(target, property) {
      if (property !== "rename") return Reflect.get(target, property);
      return async (source, destination) => {
        if (String(destination).endsWith("coupang.qhkey")) {
          await fsPromises.rename(source, destination);
          targetCommitted = true;
          return;
        }
        if (targetCommitted && failOutcomeRecordOnce && String(destination).endsWith(".json")) {
          failOutcomeRecordOnce = false;
          const error = new Error("simulated outcome interruption");
          error.code = "EIO";
          throw error;
        }
        return fsPromises.rename(source, destination);
      };
    },
  });
  const recoveryService = service({ fileSystem: recoveryFileSystem });
  const recovered = await recoveryService.publishReplacement(recoveryPrepared.transactionId, { uid: 0 });
  assert.equal(recovered.state, "PUBLISHED");
  assert.deepEqual(decryptQhkey(targetFile, masterKey).credential, credential("RECOVER"));

  const concurrent = await Promise.allSettled([
    replacement.prepareReplacement(replacementInput("RACE-A", true)),
    replacement.prepareReplacement(replacementInput("RACE-B", true)),
  ]);
  const concurrentPrepared = concurrent
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  assert(concurrentPrepared.length >= 1);
  assert(
    concurrent
      .filter((result) => result.status === "rejected")
      .every((result) => result.reason?.code === "QHKEY_PUBLISH_FAILED")
  );
  assert.equal(new Set(concurrentPrepared.map((result) => result.transactionId)).size, 1);
  const activeRecords = fs.readdirSync(stateRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(stateRoot, name), "utf8")))
    .filter((record) => ["PREPARED", "AUTHORIZATION_REQUIRED", "PUBLISHING"].includes(record.state));
  assert.equal(activeRecords.length, 1);
  await replacement.cancelReplacement(concurrentPrepared[0].transactionId);

  const plan = createQhkeyAuthorizationPlan({
    transactionId: recoveryPrepared.transactionId,
    platform: "linux",
    environment: { TERM: "xterm", SECRET_MARKER: "must-not-forward" },
  });
  assert.equal(plan.provider, "SUDO_TTY");
  assert.equal(plan.executable, "/usr/bin/sudo");
  assert.deepEqual(plan.arguments, ["--", QHKEY_PUBLISH_HELPER_PATH, "--transaction", recoveryPrepared.transactionId]);
  assert.equal("SECRET_MARKER" in plan.environment, false);
  const authorized = await authorizeQhkeyReplacement(recoveryPrepared.transactionId, {
    platform: "linux",
    environment: { DISPLAY: ":0", SECRET_MARKER: "must-not-forward" },
    async run(currentPlan) {
      assert.equal(currentPlan.provider, "POLKIT");
      assert.equal("SECRET_MARKER" in currentPlan.environment, false);
      return { status: 0 };
    },
  });
  assert.equal(authorized.authorized, true);
  await assert.rejects(
    () => authorizeQhkeyReplacement(recoveryPrepared.transactionId, {
      platform: "linux",
      environment: { TERM: "xterm" },
      async run() {
        return { status: 1 };
      },
    }),
    (error) => error.code === "QHKEY_AUTHORIZATION_CANCELLED"
  );
} finally {
  masterKey.fill(0);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("QHKEY single-use replacement, authorization, atomic publish, and reconciliation verified.");
