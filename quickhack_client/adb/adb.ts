// QuickHack note: 연결 기기 조회, 속성 수집, 원격 제어 등 ADB 기반 검수 보조 기능을 제공합니다.
﻿import { composeClientPlatform } from "@/quickhack_client/platform/compose-client-platform";
import {
  AdbCommandExecutionError,
  runAdbCommand,
} from "@/quickhack_client/adb/adb-command-runner";
import {
  CSC_MAP,
  DEVICE_ACTIONS,
  MODEL_MAP,
  getCameraCheckByModelCode,
} from "@/quickhack_client/adb/adb-config";
import { normalizeFirstCallDate } from "@/quickhack_shared/inspection/inspection-schema";
import path from "node:path";
import { PlatformCapabilityError } from "@/quickhack_shared/platform/platform-capability-error.mjs";
import { isAdbVirtualSerial } from "@/quickhack_shared/adb/adb-target-policy";

const ADB_COMMAND_TIMEOUT_MS = 15_000;
const LONG_ADB_COMMAND_TIMEOUT_MS = 45_000;
const MAX_PARALLEL_ADB_DEVICES = 10;

const connectionOrder: string[] = [];

function clientAppRoot() {
  return path.resolve(String(process.env.QUICKHACK_APP_ROOT ?? "").trim() || process.cwd());
}

function clientRuntimeDir() {
  return path.resolve(String(process.env.QUICKHACK_RUNTIME_DIR ?? "").trim() || path.join(clientAppRoot(), ".quickhack-runtime"));
}

export const ADB_ACTION_IDS = [
  "show-device-numbers",
  "set-timeout",
  "reset-display",
  "afterimage-test",
  "camera",
  "accounts",
  "imei-check",
  "function-test",
  "reboot-recovery",
] as const;

export type AdbActionId = (typeof ADB_ACTION_IDS)[number];

export type ConnectedAdbDevice = {
  serial: string;
  index: number;
  connectionState: string;
  modelCode: string;
  product: string;
  csc: string;
  storage: string;
  firstCallDate: string;
  account: string;
  cameraCheck: string;
  warning: string;
};

export type AdbActionResult = {
  serial: string;
  ok: boolean;
  message: string;
};

type AdbDeviceEntry = {
  serial: string;
  connectionState: string;
};

class AdbError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 500, code = "ADB_COMMAND_FAILED") {
    super(message);
    this.name = "AdbError";
    this.status = status;
    this.code = code;
  }
}

export async function runAdb(
  args: string[],
  options: { timeoutMs?: number; allowFailure?: boolean } = {}
) {
  const timeout = options.timeoutMs ?? ADB_COMMAND_TIMEOUT_MS;
  const platform = composeClientPlatform();
  try {
    return await runAdbCommand({
      resolver: platform.adbExecutableResolver,
      context: {
        appRoot: clientAppRoot(),
        runtimeDir: clientRuntimeDir(),
        environment: process.env,
      },
      arguments: args,
      timeoutMs: timeout,
      allowFailure: options.allowFailure,
    });
  } catch (error) {
    if (
      error instanceof AdbCommandExecutionError ||
      error instanceof PlatformCapabilityError
    ) {
      throw new AdbError(error.message, 500, error.code);
    }
    throw new AdbError(
      "ADB command could not be prepared safely.",
      500,
      "ADB_EXECUTION_FAILED"
    );
  }
}

async function adbShell(serial: string, args: string[], allowFailure = true) {
  return runAdb(["-s", serial, "shell", ...args], { allowFailure });
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
) {
  const results: R[] = [];
  let cursor = 0;

  async function runNext() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runNext())
  );

  return results;
}

function getOrderedDevices(devices: string[]) {
  for (const serial of devices) {
    if (!connectionOrder.includes(serial)) {
      connectionOrder.push(serial);
    }
  }

  return connectionOrder.filter((serial) => devices.includes(serial));
}

function getOrderedDeviceEntries(devices: AdbDeviceEntry[]) {
  const serials = devices.map((device) => device.serial);
  const bySerial = new Map(devices.map((device) => [device.serial, device]));

  return getOrderedDevices(serials)
    .map((serial) => bySerial.get(serial))
    .filter((device): device is AdbDeviceEntry => Boolean(device));
}

function convertStorage(storage: string) {
  try {
    const normalized = storage.toUpperCase();
    let size = Number.parseFloat(normalized.replace("G", "").replace("T", ""));

    if (normalized.includes("T")) {
      size *= 1024;
    }

    if (size < 180) {
      return "128GB";
    }

    if (size < 350) {
      return "256GB";
    }

    if (size < 700) {
      return "512GB";
    }

    return "1TB";
  } catch {
    return storage;
  }
}

function formatActDate(raw: string) {
  return normalizeFirstCallDate(raw) || "-";
}

function checkWarning({ csc, account }: { csc: string; account: string }) {
  const warnings = [];

  if (["0000", "Unknown", "-", ""].includes(csc)) {
    warnings.push("통신사 확인 필요");
  }

  if (account === "있음") {
    warnings.push("계정 확인 필요");
  }

  if (account === "확인 실패") {
    warnings.push("계정 조회 실패");
  }

  return warnings.length > 0 ? `재확인:\n${warnings.join("\n")}` : "정상";
}

function getConnectionWarning(connectionState: string) {
  if (connectionState === "offline") {
    return "ADB 상태: offline\nUSB 연결을 다시 꽂거나 ADB 서버를 재시작하세요.";
  }

  if (connectionState === "unauthorized") {
    return "ADB 상태: unauthorized\n휴대폰에서 USB 디버깅 허용을 승인하세요.";
  }

  return `ADB 상태: ${connectionState || "unknown"}`;
}

function createUnreadyDevice(
  device: AdbDeviceEntry,
  index: number,
  warning = getConnectionWarning(device.connectionState)
): ConnectedAdbDevice {
  return {
    serial: device.serial,
    index: index + 1,
    connectionState: device.connectionState,
    modelCode: "-",
    product: "-",
    csc: "-",
    storage: "-",
    firstCallDate: "-",
    account: "-",
    cameraCheck: "-",
    warning,
  };
}

async function getModelCode(serial: string) {
  return adbShell(serial, ["getprop", "ro.product.model"]);
}

async function getCsc(serial: string) {
  for (const prop of [
    "ro.csc.sales_code",
    "ril.sales_code",
    "persist.omc.sales_code",
  ]) {
    const value = await adbShell(serial, ["getprop", prop]);

    if (value) {
      return CSC_MAP[value] ?? value;
    }
  }

  return "Unknown";
}

async function getStorage(serial: string) {
  const raw = await adbShell(serial, ["df", "-h", "/data"]);

  try {
    const lines = raw.split(/\r?\n/);
    const columns = lines[1]?.split(/\s+/) ?? [];

    return columns[1] ? convertStorage(columns[1]) : "-";
  } catch {
    return "-";
  }
}

async function getFirstCallDate(serial: string) {
  const raw = await adbShell(serial, ["getprop", "ril.actdate"]);
  return formatActDate(raw);
}

async function getAccountStatus(serial: string) {
  const out = await adbShell(serial, ["dumpsys", "account"]);

  if (!out || /error|failed|exception|not found/i.test(out)) {
    return "확인 실패";
  }

  return out.includes("Accounts: 0") ? "없음" : "있음";
}

async function inspectDevice(
  serial: string,
  index: number
): Promise<ConnectedAdbDevice> {
  const modelCode = await getModelCode(serial);
  const [csc, storage, firstCallDate, account] = await Promise.all([
    getCsc(serial),
    getStorage(serial),
    getFirstCallDate(serial),
    getAccountStatus(serial),
  ]);
  const product = MODEL_MAP[modelCode] ?? modelCode;
  const cameraCheck = getCameraCheckByModelCode(modelCode);

  return {
    serial,
    index: index + 1,
    connectionState: "device",
    modelCode,
    product,
    csc,
    storage,
    firstCallDate,
    account,
    cameraCheck,
    warning: checkWarning({ csc, account }),
  };
}

export async function connectedDeviceEntries() {
  const out = await runAdb(["devices"]);

  return out
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({
      serial: parts[0],
      connectionState: parts[1],
    }));
}

async function connectedSerials() {
  const ordered = getOrderedDeviceEntries(await connectedDeviceEntries());

  return ordered
    .filter((device) => device.connectionState === "device")
    .map((device) => device.serial);
}

async function resolveTargetSerials(serials: string[]) {
  const ordered = getOrderedDevices(await connectedSerials());
  if (serials.length === 0) {
    throw new AdbError("ADB 작업 대상 기기 목록이 비어 있습니다.", 400);
  }
  const requested = [...new Set(serials.map((serial) => serial.trim()))];
  if (requested.some((serial) => !serial || isAdbVirtualSerial(serial))) {
    throw new AdbError("ADB 작업은 실제 연결 기기만 대상으로 지정할 수 있습니다.", 400);
  }
  const ready = new Set(ordered.filter((serial) => !isAdbVirtualSerial(serial)));
  const disconnected = requested.filter((serial) => !ready.has(serial));
  if (disconnected.length > 0) {
    throw new AdbError(
      `선택한 ADB 기기가 더 이상 준비 상태가 아닙니다: ${disconnected.join(", ")}`,
      409
    );
  }
  return requested;
}

async function runForDevices(
  serials: string[],
  worker: (serial: string) => Promise<void>
) {
  return mapWithLimit(serials, MAX_PARALLEL_ADB_DEVICES, async (serial) => {
    try {
      await worker(serial);
      return {
        serial,
        ok: true,
        message: "완료",
      };
    } catch (error) {
      return {
        serial,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

async function clearDialerInput(serial: string) {
  await adbShell(serial, ["input", "keyevent", "KEYCODE_MOVE_END"], false);
  await sleep(100);

  for (let index = 0; index < 4; index += 1) {
    await adbShell(serial, ["input", "keyevent", "KEYCODE_DEL"], false);
  }
}

async function dialCodeOnDevice(serial: string, code: string) {
  await adbShell(
    serial,
    ["am", "start", "-a", "android.intent.action.DIAL"],
    false
  );
  await sleep(700);
  await clearDialerInput(serial);
  await sleep(200);
  await adbShell(serial, ["input", "text", code], false);
}

async function packageExists(serial: string, packageName: string) {
  const out = await adbShell(serial, ["pm", "path", packageName]);
  return out.startsWith("package:");
}

async function openGallery(serial: string) {
  if (await packageExists(serial, "com.sec.android.gallery3d")) {
    await runAdb(
      [
        "-s",
        serial,
        "shell",
        "monkey",
        "-p",
        "com.sec.android.gallery3d",
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ],
      { timeoutMs: LONG_ADB_COMMAND_TIMEOUT_MS }
    );
    return;
  }

  await adbShell(
    serial,
    [
      "am",
      "start",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.APP_GALLERY",
    ],
    false
  );
}

async function findLatestScreenshot(serial: string) {
  const picturePath = await adbShell(serial, [
    "sh",
    "-c",
    "ls -t /sdcard/Pictures/Screenshots/*.png 2>/dev/null | head -n 1",
  ]);

  if (picturePath) {
    return picturePath;
  }

  return adbShell(serial, [
    "sh",
    "-c",
    "ls -t /sdcard/DCIM/Screenshots/*.png 2>/dev/null | head -n 1",
  ]);
}

async function takeScreenshot(serial: string) {
  const before = await findLatestScreenshot(serial);

  await adbShell(serial, ["input", "keyevent", "KEYCODE_SYSRQ"]);
  await sleep(1000);

  const after = await findLatestScreenshot(serial);

  if (after && after !== before) {
    return after;
  }

  const screenshotPath = `/sdcard/Pictures/Screenshots/gqc_afterimage_${Date.now()}.png`;

  await adbShell(serial, ["mkdir", "-p", "/sdcard/Pictures/Screenshots"]);
  await adbShell(serial, ["screencap", "-p", screenshotPath], false);
  await sleep(500);

  return screenshotPath;
}

async function openImageFile(serial: string, imagePath: string) {
  await adbShell(
    serial,
    [
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      `file://${imagePath}`,
      "-t",
      "image/png",
    ],
    false
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertKnownAction(action: string): asserts action is AdbActionId {
  if (!ADB_ACTION_IDS.includes(action as AdbActionId)) {
    throw new AdbError("지원하지 않는 ADB 작업입니다.", 400);
  }
}

export async function getConnectedAdbDevices() {
  const ordered = getOrderedDeviceEntries(await connectedDeviceEntries());

  return mapWithLimit(
    ordered,
    MAX_PARALLEL_ADB_DEVICES,
    async (device, index) => {
      if (device.connectionState !== "device") {
        return createUnreadyDevice(device, index);
      }

      try {
        return await inspectDevice(device.serial, index);
      } catch (error) {
        return createUnreadyDevice(
          device,
          index,
          `ADB 조회 실패:\n${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  );
}

export async function getReadyPhysicalAdbSerials() {
  return (await connectedDeviceEntries())
    .filter(
      (device) =>
        device.connectionState === "device" && !isAdbVirtualSerial(device.serial)
    )
    .map((device) => device.serial);
}

export async function runExactAdbCommand(
  serial: string,
  args: string[],
  options: { timeoutMs?: number } = {}
) {
  const [target] = await resolveTargetSerials([serial]);
  return runAdb(["-s", target, ...args], {
    timeoutMs: options.timeoutMs ?? LONG_ADB_COMMAND_TIMEOUT_MS,
  });
}

export async function runAdbAction(action: string, requestedSerials: string[]) {
  assertKnownAction(action);

  const serials = await resolveTargetSerials(requestedSerials);

  if (serials.length === 0) {
    return {
      action,
      successCount: 0,
      failCount: 0,
      results: [] as AdbActionResult[],
    };
  }

  let results: AdbActionResult[];

  switch (action) {
    case "show-device-numbers": {
      const ordered = getOrderedDevices(await connectedSerials()).filter(
        (serial) => !isAdbVirtualSerial(serial)
      );
      const numberBySerial = new Map(
        ordered.map((serial, index) => [serial, String(index + 1)])
      );
      results = await runForDevices(serials, async (serial) => {
        await dialCodeOnDevice(serial, numberBySerial.get(serial) ?? "");
      });
      break;
    }
    case "set-timeout":
      results = await runForDevices(serials, async (serial) => {
        await adbShell(
          serial,
          ["settings", "put", "system", "screen_off_timeout", "600000"],
          false
        );
        await adbShell(
          serial,
          ["settings", "put", "global", "stay_on_while_plugged_in", "3"],
          false
        );
      });
      break;
    case "reset-display":
      results = await runForDevices(serials, async (serial) => {
        const commands = [
          ["settings", "put", "system", "screen_mode_automatic_setting", "0"],
          ["settings", "put", "system", "screen_mode_setting", "4"],
          ["settings", "put", "system", "sec_display_preset_index", "2"],
          ["settings", "put", "system", "sec_display_temperature_red", "0"],
          ["settings", "put", "system", "sec_display_temperature_green", "0"],
          ["settings", "put", "system", "sec_display_temperature_blue", "0"],
          ["settings", "put", "system", "vividness_intensity", "0"],
          ["settings", "put", "system", "sec_display_temperature_custom", "0"],
          ["settings", "put", "system", "blue_light_filter", "0"],
          ["settings", "put", "system", "blue_light_filter_adaptive_mode", "0"],
          ["settings", "put", "system", "blue_light_filter_scheduled", "0"],
          [
            "settings",
            "put",
            "secure",
            "accessibility_display_inversion_enabled",
            "0",
          ],
          [
            "settings",
            "put",
            "secure",
            "accessibility_display_daltonizer_enabled",
            "0",
          ],
          [
            "settings",
            "put",
            "secure",
            "accessibility_display_daltonizer",
            "-1",
          ],
        ];

        for (const command of commands) {
          await adbShell(serial, command, false);
        }
      });
      break;
    case "afterimage-test":
      results = await runForDevices(serials, async (serial) => {
        await openGallery(serial);
        await sleep(1000);
        const latest = await takeScreenshot(serial);

        if (latest) {
          await openImageFile(serial, latest);
        }
      });
      break;
    case "camera":
      results = await runForDevices(serials, async (serial) => {
        await adbShell(serial, [...DEVICE_ACTIONS.camera], false);
      });
      break;
    case "accounts":
      results = await runForDevices(serials, async (serial) => {
        await adbShell(serial, [...DEVICE_ACTIONS.accounts], false);
      });
      break;
    case "imei-check":
      results = await runForDevices(serials, async (serial) => {
        await dialCodeOnDevice(serial, "\\*\\#06\\#");
      });
      break;
    case "function-test":
      results = await runForDevices(serials, async (serial) => {
        await dialCodeOnDevice(serial, "\\*\\#0\\*\\#");
      });
      break;
    case "reboot-recovery":
      results = await runForDevices(serials, async (serial) => {
        await runAdb(["-s", serial, "reboot", "recovery"], {
          timeoutMs: LONG_ADB_COMMAND_TIMEOUT_MS,
        });
      });
      break;
  }

  const failCount = results.filter((result) => !result.ok).length;

  return {
    action,
    successCount: results.length - failCount,
    failCount,
    results,
  };
}

export function toAdbErrorResponse(error: unknown) {
  if (error instanceof AdbError) {
    return {
      status: error.status,
      body: { ok: false, code: error.code, message: error.message },
    };
  }

  return {
    status: 500,
    body: {
      ok: false,
      code: "ADB_EXECUTION_FAILED",
      message: "ADB command failed unexpectedly.",
    },
  };
}
