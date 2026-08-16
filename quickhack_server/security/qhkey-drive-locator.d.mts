export type QhkeyDrive = {
  root: string;
  volumeId: string;
  deviceId: string;
  fileSystemUuid: string;
  label: string;
  driveType: string;
  removable: boolean;
  readOnly: boolean;
  hasCoupangQhkey: boolean;
  hasLogenQhkey: boolean;
  hasQhkey: boolean;
};

export const QHKEY_PROVIDER_RELATIVE_PATHS: Readonly<{
  COUPANG: string;
  LOGEN: string;
}>;
export function qhkeyProviderFilePath(
  root: string,
  provider: "COUPANG" | "LOGEN"
): string;
export function discoverWindowsQhkeyDrives(): Promise<QhkeyDrive[]>;
export function locateSingleQhkeyRoot(): Promise<{
  root: string;
  volumeId: string;
  drives: QhkeyDrive[];
  errorCode: string;
  errorMessage: string;
}>;
