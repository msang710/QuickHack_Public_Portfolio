import crypto from "node:crypto";
import net from "node:net";
import {
  NATIVE_BROKER_COMMANDS,
  NATIVE_BROKER_MAX_MESSAGE_BYTES,
  NATIVE_BROKER_VERSION,
  type NativeBrokerCommand,
  type NativeBrokerResponse,
} from "@/quickhack_desktop/shared/native-broker-contract";

const INSTANCE_ID = /^[a-f0-9]{48}$/u;
const SECRET = /^[a-f0-9]{64}$/u;
const commandSet = new Set<string>(NATIVE_BROKER_COMMANDS);

export class NativeBrokerClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function nativeBrokerConfig(environment: NodeJS.ProcessEnv = process.env) {
  const endpoint = String(environment.QUICKHACK_DESKTOP_BROKER_ENDPOINT ?? "").trim();
  const secret = String(environment.QUICKHACK_DESKTOP_BROKER_SECRET ?? "").trim();
  const instanceId = String(environment.QUICKHACK_DESKTOP_BROKER_INSTANCE_ID ?? "").trim();
  if (!endpoint || !INSTANCE_ID.test(instanceId) || !SECRET.test(secret)) {
    throw new NativeBrokerClientError("NATIVE_ADAPTER_UNAVAILABLE", "QuickHack desktop native adapter is unavailable.");
  }
  return Object.freeze({ endpoint, secret, instanceId });
}

export async function requestNativeBroker(
  command: NativeBrokerCommand,
  payload: unknown,
  options: Readonly<{ environment?: NodeJS.ProcessEnv; timeoutMs?: number }> = {},
) {
  if (!commandSet.has(command)) throw new NativeBrokerClientError("BROKER_COMMAND_REJECTED", "Native broker command is not allowed.");
  const config = nativeBrokerConfig(options.environment);
  const requestId = crypto.randomUUID();
  const body = JSON.stringify({
    version: NATIVE_BROKER_VERSION,
    instanceId: config.instanceId,
    secret: config.secret,
    requestId,
    command,
    payload,
  });
  if (Buffer.byteLength(body, "utf8") > NATIVE_BROKER_MAX_MESSAGE_BYTES) {
    throw new NativeBrokerClientError("BROKER_MESSAGE_TOO_LARGE", "Native broker request is too large.");
  }
  const response = await new Promise<NativeBrokerResponse>((resolve, reject) => {
    const socket = net.createConnection(config.endpoint);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new NativeBrokerClientError("BROKER_TIMEOUT", "Native broker did not respond in time."));
    }, options.timeoutMs ?? 15_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${body}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > NATIVE_BROKER_MAX_MESSAGE_BYTES) {
        socket.destroy(new NativeBrokerClientError("BROKER_MESSAGE_TOO_LARGE", "Native broker response is too large."));
      }
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("end", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(buffer) as NativeBrokerResponse); }
      catch { reject(new NativeBrokerClientError("BROKER_RESPONSE_INVALID", "Native broker response is invalid.")); }
    });
  });
  if (response.requestId !== requestId) throw new NativeBrokerClientError("BROKER_RESPONSE_INVALID", "Native broker response identity does not match.");
  if (!response.ok) throw new NativeBrokerClientError(response.error?.code ?? "BROKER_REQUEST_FAILED", response.error?.message ?? "Native broker request failed.");
  return response.result;
}
