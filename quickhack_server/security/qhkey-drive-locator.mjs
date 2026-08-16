import { composeServerPlatform } from "../platform/compose-server-platform.ts";
import {
  QHKEY_PROVIDER_RELATIVE_PATHS,
  qhkeyProviderRelativePath,
} from "../platform/qhkey-contract.mjs";
import path from "node:path";

export { QHKEY_PROVIDER_RELATIVE_PATHS };

export function qhkeyProviderFilePath(root, provider) {
  return path.join(root, qhkeyProviderRelativePath(provider));
}

export async function discoverWindowsQhkeyDrives() {
  const volumes = await composeServerPlatform().removableVolume.list();
  return volumes.map((volume) => ({
    root: volume.rootPath,
    volumeId: volume.volumeId,
    deviceId: volume.deviceId,
    fileSystemUuid: volume.fileSystemUuid,
    label: volume.label,
    driveType: "Removable",
    removable: true,
    readOnly: volume.readOnly,
    hasCoupangQhkey: volume.providers.includes("COUPANG"),
    hasLogenQhkey: volume.providers.includes("LOGEN"),
    hasQhkey: volume.providers.length > 0,
  }));
}

export async function locateSingleQhkeyRoot() {
  const drives = await discoverWindowsQhkeyDrives();
  const roots = drives.filter((drive) => drive.hasQhkey);
  if (roots.length === 0) {
    return {
      root: "",
      volumeId: "",
      drives,
      errorCode: "QHKEY_VOLUME_MISSING",
      errorMessage: "QHKEY가 있는 removable volume을 찾을 수 없습니다.",
    };
  }
  if (roots.length > 1) {
    return {
      root: "",
      volumeId: "",
      drives,
      errorCode: "QHKEY_VOLUME_AMBIGUOUS",
      errorMessage: "QHKEY가 있는 removable volume이 여러 개라 자동 선택할 수 없습니다.",
    };
  }
  return {
    root: roots[0].root,
    volumeId: roots[0].volumeId,
    drives,
    errorCode: "",
    errorMessage: "",
  };
}
