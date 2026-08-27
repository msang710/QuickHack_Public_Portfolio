import crypto from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  NATIVE_BROKER_COMMANDS,
  NATIVE_BROKER_MAX_MESSAGE_BYTES,
  NATIVE_BROKER_VERSION,
  type NativeBrokerCommand,
  type NativeBrokerRequest,
  type NativeBrokerResponse,
} from "../shared/native-broker-contract.ts";

const ID = /^[a-f0-9]{48}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const commandSet = new Set<string>(NATIVE_BROKER_COMMANDS);

export function nativeBrokerEndpoint(platform: NodeJS.Platform, runtimeDirectory: string, instanceId: string) {
  if (!ID.test(instanceId)) throw new TypeError("Native broker instance id is invalid.");
  return platform === "win32"
    ? `\\\\.\\pipe\\quickhack-native-${instanceId}`
    : path.join(path.resolve(runtimeDirectory), `native-${instanceId}.sock`);
}

function equalSecret(expected: string, observed: unknown) {
  if (typeof observed !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(observed);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function validateRequest(value: unknown, instanceId: string, secret: string): NativeBrokerRequest {
  const input = value as Partial<NativeBrokerRequest> | null;
  if (input?.version !== NATIVE_BROKER_VERSION) throw failure("BROKER_VERSION_MISMATCH", "Native broker protocol version mismatch.");
  if (input.instanceId !== instanceId || !equalSecret(secret, input.secret)) throw failure("BROKER_AUTH_FAILED", "Native broker owner authentication failed.");
  if (!REQUEST_ID.test(String(input.requestId ?? ""))) throw failure("BROKER_REQUEST_INVALID", "Native broker request id is invalid.");
  if (!commandSet.has(String(input.command ?? ""))) throw failure("BROKER_COMMAND_REJECTED", "Native broker command is not allowed.");
  return input as NativeBrokerRequest;
}

export type NativeBrokerHandlers = Partial<Record<NativeBrokerCommand, (payload: unknown) => Promise<unknown>>>;

export function createNativeBroker(options: Readonly<{
  platform: NodeJS.Platform;
  runtimeDirectory: string;
  instanceId?: string;
  secret?: string;
  handlers?: NativeBrokerHandlers;
}>) {
  const instanceId = options.instanceId ?? crypto.randomBytes(24).toString("hex");
  const secret = options.secret ?? crypto.randomBytes(32).toString("hex");
  const endpoint = nativeBrokerEndpoint(options.platform, options.runtimeDirectory, instanceId);
  const replay = new Set<string>();
  let server: net.Server | null = null;

  async function respond(line: string): Promise<NativeBrokerResponse> {
    let requestId = "invalid";
    try {
      if (Buffer.byteLength(line, "utf8") > NATIVE_BROKER_MAX_MESSAGE_BYTES) throw failure("BROKER_MESSAGE_TOO_LARGE", "Native broker message is too large.");
      const parsed = JSON.parse(line) as unknown;
      requestId = String((parsed as { requestId?: unknown })?.requestId ?? "invalid");
      const request = validateRequest(parsed, instanceId, secret);
      if (replay.has(request.requestId)) throw failure("BROKER_REPLAY_REJECTED", "Native broker request was already processed.");
      replay.add(request.requestId);
      if (replay.size > 4096) replay.delete(replay.values().next().value as string);
      const handler = options.handlers?.[request.command];
      if (!handler) throw failure("NATIVE_ADAPTER_UNAVAILABLE", "Native adapter is not available.");
      return { requestId, ok: true, result: await handler(request.payload) };
    } catch (error) {
      return {
        requestId,
        ok: false,
        error: {
          code: typeof error === "object" && error && "code" in error ? String(error.code) : "BROKER_REQUEST_INVALID",
          message: error instanceof Error ? error.message : "Native broker request failed.",
        },
      };
    }
  }

  return Object.freeze({
    endpoint,
    instanceId,
    secret,
    async start() {
      if (server) return;
      if (options.platform !== "win32") {
        await mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 });
        await rm(endpoint, { force: true });
      }
      const next = net.createServer((socket) => {
        socket.setEncoding("utf8");
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer, "utf8") > NATIVE_BROKER_MAX_MESSAGE_BYTES + 1) {
            socket.destroy();
            return;
          }
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline);
          buffer = "";
          void respond(line).then((response) => socket.end(`${JSON.stringify(response)}\n`));
        });
      });
      await new Promise<void>((resolve, reject) => {
        next.once("error", reject);
        next.listen(endpoint, () => resolve());
      });
      server = next;
      if (options.platform !== "win32") await chmod(endpoint, 0o600);
    },
    async stop() {
      const current = server;
      server = null;
      if (current) await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
      if (options.platform !== "win32") await rm(endpoint, { force: true });
      replay.clear();
    },
  });
}
