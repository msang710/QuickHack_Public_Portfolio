const VIRTUAL_ADB_SERIAL_PATTERNS = [
  /^emulator-\d+$/i,
  /:/,
  /\._adb-tls-(?:connect|pairing)\._tcp$/i,
] as const;

export function isAdbVirtualSerial(value: unknown) {
  const serial = String(value ?? "").trim();
  return VIRTUAL_ADB_SERIAL_PATTERNS.some((pattern) => pattern.test(serial));
}
