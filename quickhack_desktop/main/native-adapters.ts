import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import os from "node:os";
import { createLinuxClientPlatform } from "@/quickhack_client/platform/linux/index";
import { createWindowsClientPlatform } from "@/quickhack_client/platform/windows/index";
import type { ClientPlatform } from "@/quickhack_client/platform/contracts";
import type { NativeBrokerHandlers } from "./native-broker";
import { getConnectedAdbDevices, runAdbAction } from "@/quickhack_client/adb/adb";
import { deliverMobileProvisioningBootstrap } from "@/quickhack_client/adb/mobile-provisioning";

const runFile = promisify(execFile);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Native adapter payload is invalid.");
  return value as Record<string, unknown>;
}

function platformFor(name: NodeJS.Platform): ClientPlatform {
  const capabilities = name === "win32" ? createWindowsClientPlatform(name) : createLinuxClientPlatform(name);
  return Object.freeze({ ...capabilities, role: "client", platform: name });
}

function parseAdbDevices(stdout: string) {
  return stdout.split(/\r?\n/u).slice(1).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [serial = "", state = "unknown", ...details] = line.split(/\s+/u);
    return { serial, state, details: details.join(" ") };
  });
}

function adbEnumerationRevision(devices: readonly { serial: string; state?: string; connectionState?: string }[]) {
  const identity = devices
    .map((device) => ({ serial: device.serial, state: device.state ?? device.connectionState ?? "unknown" }))
    .sort((left, right) => left.serial.localeCompare(right.serial));
  return crypto.createHash("sha256").update(JSON.stringify(identity)).digest("base64url");
}

let adbQueue: Promise<unknown> = Promise.resolve();
function enqueueAdb<T>(operation: () => Promise<T>): Promise<T> {
  const next = adbQueue.catch(() => undefined).then(operation);
  adbQueue = next;
  return next;
}

export function createNativeAdapterHandlers(input: {
  platform: NodeJS.Platform;
  appRoot: string;
  runtimeDirectory: string;
}): NativeBrokerHandlers {
  const platform = platformFor(input.platform);
  const context = { appRoot: input.appRoot, runtimeDir: input.runtimeDirectory, environment: process.env };
  const directories = platform.runtimeDirectories.resolve({
    appRoot: input.appRoot,
    runtimeDir: input.runtimeDirectory,
    homeDirectory: os.homedir(),
    environment: process.env,
    deployment: "development",
  });
  return {
    "printer.list": async () => platform.printerBackend.list(context),
    "printer.print": async (value) => {
      const payload = record(value);
      const printerName = String(payload.printerName ?? "").trim();
      const requestedBytes = Number(payload.requestedBytes);
      const spoolPath = await realpath(String(payload.spoolPath ?? ""));
      const spoolRoot = await realpath(path.join(directories.stateDir, "print-jobs"));
      if (path.relative(spoolRoot, spoolPath).startsWith("..")) throw new TypeError("Print spool path is outside the private spool.");
      return platform.printerBackend.submit({ ...context, printerName, spoolPath, requestedBytes });
    },
    "printer.secure-spool": async (value) => {
      const payload = record(value);
      const directory = await realpath(String(payload.directory ?? ""));
      const expected = await realpath(path.join(directories.stateDir, "print-jobs"));
      if (directory !== expected) throw new TypeError("Print spool directory is not the private spool.");
      await platform.printerBackend.secureSpoolDirectory({ ...context, directory });
      return { secured: true };
    },
    "adb.list": async () => enqueueAdb(async () => {
      const devices = await getConnectedAdbDevices();
      return { revision: adbEnumerationRevision(devices), devices };
    }),
    "adb.action": async (value) => enqueueAdb(async () => {
      const payload = record(value);
      const serials = Array.isArray(payload.serials) ? [...new Set(payload.serials.map((item) => String(item ?? "").trim()).filter(Boolean))] : [String(payload.serial ?? "").trim()].filter(Boolean);
      const expectedRevision = String(payload.enumerationRevision ?? "").trim();
      if (!serials.length || !expectedRevision) throw Object.assign(new Error("ADB selection evidence is required."), { code: "SELECTION_STALE" });
      const plan = await platform.adbExecutableResolver.resolve(context);
      const listed = await runFile(plan.executable, ["devices", "-l"], { cwd: plan.cwd, env: { ...process.env, ...plan.environment }, timeout: 10_000, maxBuffer: 256 * 1024 });
      const current = parseAdbDevices(listed.stdout);
      if (adbEnumerationRevision(current) !== expectedRevision) throw Object.assign(new Error("ADB device selection is stale."), { code: "SELECTION_STALE" });
      for (const serial of serials) {
        const selected = current.find((device) => device.serial === serial);
        if (!selected || selected.state !== "device" || /^(emulator-|\d+\.\d+\.\d+\.\d+:)/u.test(serial)) throw Object.assign(new Error("ADB device is not eligible."), { code: "ADB_TARGET_REJECTED" });
      }
      const action = String(payload.action ?? "");
      if (action === "get-state") {
        const result = await runFile(plan.executable, ["-s", serials[0], "get-state"], { cwd: plan.cwd, env: { ...process.env, ...plan.environment }, timeout: 10_000, maxBuffer: 64 * 1024 });
        return { serial: serials[0], state: result.stdout.trim() };
      }
      return runAdbAction(action, serials);
    }),
    "adb.provision": async (value) => enqueueAdb(async () => {
      const payload = record(value);
      const serial = String(payload.serial ?? "").trim();
      const expectedRevision = String(payload.enumerationRevision ?? "").trim();
      const plan = await platform.adbExecutableResolver.resolve(context);
      const listed = await runFile(plan.executable, ["devices", "-l"], { cwd: plan.cwd, env: { ...process.env, ...plan.environment }, timeout: 10_000, maxBuffer: 256 * 1024 });
      const current = parseAdbDevices(listed.stdout);
      if (!serial || adbEnumerationRevision(current) !== expectedRevision) throw Object.assign(new Error("ADB device selection is stale."), { code: "SELECTION_STALE" });
      const selected = current.find((device) => device.serial === serial);
      if (!selected || selected.state !== "device" || /^(emulator-|\d+\.\d+\.\d+\.\d+:)/u.test(serial)) throw Object.assign(new Error("ADB device is not eligible."), { code: "ADB_TARGET_REJECTED" });
      await deliverMobileProvisioningBootstrap({ serial, serverOrigin: String(payload.serverOrigin ?? ""), bootstrap: record(payload.bootstrap) as never, trustBundle: record(payload.trustBundle) as never });
      return { delivered: true, serial };
    }),
  };
}
