import type { RemovableVolumeProvider } from "../contracts.ts";

export const LINUX_QHKEY_MOUNT_ROOT: "/run/quickhack/qhkey";
export function parseLinuxMountInfo(source: string): readonly Readonly<{
  deviceId: string;
  mountRoot: string;
  mountPoint: string;
  mountOptions: readonly string[];
  fileSystemType: string;
  source: string;
  superOptions: readonly string[];
}>[];
export function parseLinuxUdevProperties(source: string): Readonly<Record<string, string>>;
export function createLinuxRemovableVolumeProvider(options?: Record<string, unknown>): RemovableVolumeProvider;
