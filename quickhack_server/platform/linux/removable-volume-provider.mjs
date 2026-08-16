import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  QHKEY_PROVIDER_RELATIVE_PATHS,
  QhkeyPlatformError,
  createQhkeyVolumeIdentity,
  sameQhkeyVolumeIdentity,
} from "../qhkey-contract.mjs";

export const LINUX_QHKEY_MOUNT_ROOT = "/run/quickhack/qhkey";

function descriptor(platform, role) {
  return Object.freeze({
    id: "removable-volume-provider",
    role,
    platform,
    state: "READY",
    ownerStage: "PR-08",
  });
}

function decodeMountField(value) {
  return String(value).replace(/\\(040|011|012|134)/gu, (_match, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  );
}

export function parseLinuxMountInfo(source) {
  return String(source ?? "")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(" - ");
      if (separator < 0) return null;
      const before = line.slice(0, separator).split(" ");
      const after = line.slice(separator + 3).split(" ");
      if (before.length < 6 || after.length < 3) return null;
      return Object.freeze({
        deviceId: before[2],
        mountRoot: decodeMountField(before[3]),
        mountPoint: path.resolve(decodeMountField(before[4])),
        mountOptions: Object.freeze(before[5].split(",")),
        fileSystemType: after[0],
        source: decodeMountField(after[1]),
        superOptions: Object.freeze(after[2].split(",")),
      });
    })
    .filter(Boolean);
}

export function parseLinuxUdevProperties(source) {
  const properties = {};
  for (const line of String(source ?? "").split(/\r?\n/u)) {
    if (!line.startsWith("E:")) continue;
    const separator = line.indexOf("=", 2);
    if (separator < 0) continue;
    properties[line.slice(2, separator)] = line.slice(separator + 1);
  }
  return Object.freeze(properties);
}

function volumeError(code, message) {
  return new QhkeyPlatformError(code, message);
}

async function regularProviderPresence(root, fileSystem) {
  const providers = [];
  for (const [provider, relativePath] of Object.entries(QHKEY_PROVIDER_RELATIVE_PATHS)) {
    try {
      const filePath = path.join(root, relativePath);
      const parentPath = path.dirname(filePath);
      const parentStat = await fileSystem.lstat(parentPath);
      const stat = await fileSystem.lstat(filePath);
      const realPath = await fileSystem.realpath(filePath);
      if (
        parentStat.isDirectory() &&
        !parentStat.isSymbolicLink() &&
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        path.resolve(realPath) === path.resolve(filePath)
      ) {
        providers.push(provider);
      }
    } catch {}
  }
  return providers;
}

export function createLinuxRemovableVolumeProvider(options = {}) {
  const platform = options.platform ?? "linux";
  const role = options.role ?? "server";
  const fileSystem = options.fileSystem ?? fsPromises;
  const fixedMountRoot = path.resolve(options.fixedMountRoot ?? LINUX_QHKEY_MOUNT_ROOT);
  const readMountInfo = options.readMountInfo ?? (() => fileSystem.readFile("/proc/self/mountinfo", "utf8"));
  const readUdevData = options.readUdevData ?? ((deviceId) => fileSystem.readFile(`/run/udev/data/b${deviceId}`, "utf8"));
  const readSysfsRemovable = options.readSysfsRemovable ?? (async (deviceId) => {
    const target = await fileSystem.realpath(`/sys/dev/block/${deviceId}`);
    let current = target;
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        return (await fileSystem.readFile(path.join(current, "removable"), "utf8")).trim();
      } catch {}
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return "0";
  });

  async function list() {
    const mounts = parseLinuxMountInfo(await readMountInfo());
    const identities = [];
    for (const mount of mounts) {
      if (path.dirname(mount.mountPoint) !== fixedMountRoot || mount.mountRoot !== "/") continue;
      let properties;
      try {
        properties = parseLinuxUdevProperties(await readUdevData(mount.deviceId));
      } catch {
        continue;
      }
      const fileSystemUuid = String(properties.ID_FS_UUID ?? "").trim();
      const usb = properties.ID_BUS === "usb" || properties.ID_DRIVE_FLASH_SD === "1";
      let removable = false;
      try {
        removable = String(await readSysfsRemovable(mount.deviceId)).trim() === "1";
      } catch {}
      if (!fileSystemUuid || (!usb && !removable)) continue;
      let rootStat;
      try {
        rootStat = await fileSystem.lstat(mount.mountPoint);
        await fileSystem.access(mount.mountPoint);
        if (path.resolve(await fileSystem.realpath(mount.mountPoint)) !== mount.mountPoint) {
          continue;
        }
      } catch {
        continue;
      }
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;
      const readOnly = mount.mountOptions.includes("ro") || mount.superOptions.includes("ro");
      identities.push(
        createQhkeyVolumeIdentity({
          platform: "linux",
          volumeId: `LINUX-${fileSystemUuid}`,
          rootPath: mount.mountPoint,
          deviceId: mount.deviceId,
          fileSystemUuid,
          label: properties.ID_FS_LABEL ?? "",
          readOnly,
          providers: await regularProviderPresence(mount.mountPoint, fileSystem),
        })
      );
    }
    return Object.freeze(identities);
  }

  async function locate(input = {}) {
    let candidates = await list();
    if (input.volumeId) candidates = candidates.filter((item) => item.volumeId === input.volumeId);
    if (input.rootPath) {
      const requestedRoot = path.resolve(String(input.rootPath));
      candidates = candidates.filter((item) => item.rootPath === requestedRoot);
    }
    if (input.requireProvider) candidates = candidates.filter((item) => item.providers.includes(input.requireProvider));
    if (input.requireWritable) candidates = candidates.filter((item) => !item.readOnly);
    if (candidates.length === 0) {
      throw volumeError("QHKEY_VOLUME_MISSING", "A service-visible removable QHKEY volume was not found.");
    }
    if (candidates.length > 1) {
      throw volumeError("QHKEY_VOLUME_AMBIGUOUS", "Multiple service-visible QHKEY volumes match the request.");
    }
    return candidates[0];
  }

  async function validate(identity) {
    const current = await locate({ volumeId: identity.volumeId });
    if (!sameQhkeyVolumeIdentity(identity, current)) {
      throw volumeError("QHKEY_VOLUME_IDENTITY_CHANGED", "The service-visible QHKEY volume identity changed.");
    }
    return current;
  }

  return Object.freeze({ descriptor: descriptor(platform, role), list, locate, validate });
}
