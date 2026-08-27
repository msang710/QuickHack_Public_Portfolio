export const NATIVE_BROKER_VERSION = 1;
export const NATIVE_BROKER_MAX_MESSAGE_BYTES = 64 * 1024;
export const NATIVE_BROKER_COMMANDS = [
  "printer.list",
  "printer.print",
  "printer.secure-spool",
  "adb.list",
  "adb.action",
  "adb.provision",
  "notification.show",
] as const;

export type NativeBrokerCommand = (typeof NATIVE_BROKER_COMMANDS)[number];
export type NativeBrokerRequest = Readonly<{
  version: 1;
  instanceId: string;
  secret: string;
  requestId: string;
  command: NativeBrokerCommand;
  payload: unknown;
}>;

export type NativeBrokerResponse = Readonly<{
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: Readonly<{ code: string; message: string }>;
}>;
