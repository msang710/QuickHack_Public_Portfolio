import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  QHKEY_ERROR_CODES,
  QHKEY_PROVIDERS,
  QHKEY_PROVIDER_RELATIVE_PATHS,
  QHKEY_REPLACEMENT_STATES,
  createQhkeyVolumeIdentity,
} from "../../quickhack_server/platform/qhkey-contract.mjs";
import { createWindowsQhkeyMasterKeyProvider } from "../../quickhack_server/platform/windows/qhkey-master-key-provider.mjs";
import { createWindowsRemovableVolumeProvider } from "../../quickhack_server/platform/windows/removable-volume-provider.mjs";
import { createLinuxQhkeyMasterKeyProvider } from "../../quickhack_server/platform/linux/qhkey-master-key-provider.mjs";
import { createLinuxRemovableVolumeProvider } from "../../quickhack_server/platform/linux/removable-volume-provider.mjs";

const fixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/qhkey-platform-cases.json", import.meta.url), "utf8")
);
assert.equal(fixture.version, 1);
assert.deepEqual([...QHKEY_PROVIDERS], fixture.providers);
assert.deepEqual([...QHKEY_REPLACEMENT_STATES], fixture.states);
assert.deepEqual([...QHKEY_ERROR_CODES], fixture.errorCodes);
assert.deepEqual(
  Object.fromEntries(
    Object.entries(QHKEY_PROVIDER_RELATIVE_PATHS).map(([key, value]) => [
      key,
      value.replaceAll("\\", "/"),
    ])
  ),
  fixture.relativePaths
);

const immutable = createQhkeyVolumeIdentity({
  platform: "linux",
  volumeId: "LINUX-ABC",
  rootPath: "/run/quickhack/qhkey/ABC",
  deviceId: "8:17",
  fileSystemUuid: "ABC",
  label: "QHKEY",
  readOnly: false,
  providers: ["COUPANG"],
});
assert.equal(Object.isFrozen(immutable), true);
assert.equal(Object.isFrozen(immutable.providers), true);
assert.throws(() => createQhkeyVolumeIdentity({ ...immutable, providers: ["COUPANG", "COUPANG"] }), /unique/);
assert.throws(() => createQhkeyVolumeIdentity({ ...immutable, rootPath: "relative" }), /absolute|invalid/);
assert.throws(() => createQhkeyVolumeIdentity({ ...immutable, platform: "darwin" }), /unsupported/);

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "quickhack-qhkey-platform-"));
try {
  const masterFile = path.join(temporaryDirectory, "security", "qhkey-master.key");
  const securityProcess = {
    runPowerShellScriptSync(_script, options) {
      return options.inputLine;
    },
    async runPowerShellScript(_script, options) {
      return options.inputLine ?? "";
    },
  };
  const windowsMaster = createWindowsQhkeyMasterKeyProvider({
    platform: "win32",
    securityProcess,
  });
  windowsMaster.write({ filePath: masterFile, protection: "DPAPI" });
  assert.equal(windowsMaster.protectionSync({ filePath: masterFile }), "DPAPI");
  const windowsMasterBytes = windowsMaster.readSync({ filePath: masterFile });
  assert.equal(windowsMasterBytes.length, 32);
  windowsMasterBytes.fill(0);

  const windowsVolume = createWindowsRemovableVolumeProvider({
    platform: "win32",
    production: false,
    fileSystem: {
      lstatSync(filePath) {
        return {
          isDirectory: () => filePath.endsWith("quickhack-keys"),
          isFile: () => filePath.endsWith("coupang.qhkey"),
          isSymbolicLink: () => false,
        };
      },
      realpathSync(filePath) {
        return filePath;
      },
    },
    async discoverSnapshot() {
      return [
        {
          root: "R:\\",
          label: "QHKEY",
          serial: "12AB34CD",
          filesystem: "exFAT",
          bitlocker: "NOT_REQUIRED",
          readOnly: false,
        },
      ];
    },
  });
  const windowsIdentity = await windowsVolume.locate({ volumeId: "WIN-12AB34CD" });
  assert.equal(windowsIdentity.rootPath, "R:\\");
  assert.deepEqual(windowsIdentity.providers, ["COUPANG"]);
  await assert.rejects(
    () => windowsVolume.locate({ volumeId: "WIN-12AB34CD", production: true }),
    (error) => error.code === "QHKEY_VOLUME_MISSING"
  );

  const linuxMasterBytes = Buffer.alloc(32, 0x5a);
  const linuxMaster = createLinuxQhkeyMasterKeyProvider({
    platform: "linux",
    reader: {
      async read(identity) {
        assert.equal(identity.id, "quickhack.qhkey-master-key");
        return Buffer.from(linuxMasterBytes);
      },
      readSync() {
        return Buffer.from(linuxMasterBytes);
      },
    },
  });
  assert.equal(linuxMaster.identity.id, "quickhack.qhkey-master-key");
  assert.equal((await linuxMaster.read()).equals(linuxMasterBytes), true);
  assert.equal((await linuxMaster.status()).protection, "SYSTEMD_CREDENTIAL");

  const fixedMountRoot = path.join(temporaryDirectory, "mounts");
  const mountPoint = path.join(fixedMountRoot, "A1B2-C3D4");
  fs.mkdirSync(path.join(mountPoint, "quickhack-keys"), { recursive: true });
  fs.writeFileSync(path.join(mountPoint, "quickhack-keys", "coupang.qhkey"), "ciphertext");
  const escapedMountPoint = mountPoint.replaceAll(" ", "\\040");
  const linuxVolume = createLinuxRemovableVolumeProvider({
    platform: "linux",
    fixedMountRoot,
    fileSystem: fsPromises,
    async readMountInfo() {
      return `61 40 8:17 / ${escapedMountPoint} rw,nosuid,nodev - ext4 /dev/sdb1 rw\n`;
    },
    async readUdevData(deviceId) {
      assert.equal(deviceId, "8:17");
      return "E:ID_BUS=usb\nE:ID_FS_UUID=A1B2-C3D4\nE:ID_FS_LABEL=QHKEY\n";
    },
    async readSysfsRemovable() {
      return "1";
    },
  });
  const linuxIdentity = await linuxVolume.locate({
    volumeId: "LINUX-A1B2-C3D4",
    requireProvider: "COUPANG",
  });
  assert.equal(linuxIdentity.deviceId, "8:17");
  assert.equal(linuxIdentity.rootPath, mountPoint);
  assert.equal(linuxIdentity.readOnly, false);
  assert.deepEqual(linuxIdentity.providers, ["COUPANG"]);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("QHKEY platform contracts and injected Windows/Linux adapters verified.");
