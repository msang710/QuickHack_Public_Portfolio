import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAppRoot,
  getRuntimeDir,
} from "@/quickhack_shared/core/runtime";
import { composeClientPlatform } from "@/quickhack_client/platform/compose-client-platform";
import { LOGEN_LABEL_TEMPLATE } from "@/quickhack_shared/shipment/logen-label";
import {
  ClientPrintSpoolError,
  acknowledgeClientPrintSpoolRecovery,
  armClientPrintSpoolAttempt,
  createPrivatePrintSpoolFile,
  initializeClientPrintSpool,
  inspectClientPrintSpoolRecovery,
  removePrivatePrintSpoolFile,
} from "@/tools/client-print-spool-core.mjs";

const JOB_KEY_PATTERN = /^LOGEN-LABEL-\d+-[0-9a-f-]{36}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const TRACKING_PATTERN = /^\d{11}$/;
const BITMAP_BYTES =
  (LOGEN_LABEL_TEMPLATE.widthDots / 8) * LOGEN_LABEL_TEMPLATE.lengthDots;

export type PrinterSettings = {
  printerName: string;
  sensorType: "GAP" | "BLINE";
  gapMm: number;
  gapOffsetMm: number;
  direction: 0 | 1;
  referenceX: number;
  referenceY: number;
  shiftX: number;
  shiftY: number;
  speed: number;
  density: number;
};

export type LocalLabelBitmap = {
  issueItemId: number;
  issueSequence: number;
  trackingNumber: string;
  bitmapBase64: string;
};

type PrintJobLedger = {
  requestKey: string;
  payloadHash: string;
  contentHash: string;
  printerName: string;
  status: "SPOOLED" | "FAILED" | "UNKNOWN";
  labelCount: number;
  requestedBytes: number | null;
  writtenBytes: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  nativeJobId: string | null;
  createdAt: string;
  acknowledgement?: {
    resolution: "CONFIRMED" | "PRINTED" | "NOT_PRINTED";
    acknowledgedAt: string;
  };
};

const DEFAULT_SETTINGS: PrinterSettings = {
  printerName: "",
  sensorType: "GAP",
  gapMm: 3,
  gapOffsetMm: 0,
  direction: 1,
  referenceX: 0,
  referenceY: 0,
  shiftX: 0,
  shiftY: 0,
  speed: 3,
  density: 8,
};

export class LocalPrinterError extends Error {
  readonly code: string;
  readonly uncertain: boolean;

  constructor(code: string, message: string, uncertain = false) {
    super(message);
    this.name = "LocalPrinterError";
    this.code = code;
    this.uncertain = uncertain;
  }
}

function clientRuntime() {
  const platform = composeClientPlatform();
  const appRoot = getAppRoot();
  const runtimeDir = getRuntimeDir();
  const context = {
    appRoot,
    runtimeDir,
    environment: process.env,
  };
  const directories = platform.runtimeDirectories.resolve({
    appRoot,
    runtimeDir,
    homeDirectory: os.homedir(),
    environment: process.env,
    deployment: "development",
  });
  return { platform, context, directories };
}

function clientDataDir() {
  return clientRuntime().directories.stateDir;
}

function spoolPlatform(platform: string): "win32" | "linux" {
  if (platform === "win32" || platform === "linux") return platform;
  throw new LocalPrinterError(
    "UNSUPPORTED_PLATFORM",
    `Local label printing is not supported on ${platform}.`
  );
}

function settingsPath() {
  return path.join(clientDataDir(), "printer-settings.json");
}

function jobsDir() {
  return path.join(clientDataDir(), "print-jobs");
}

function jobPath(requestKey: string) {
  return path.join(jobsDir(), `${requestKey}.json`);
}

function numberInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number
) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function normalizeSettings(value: unknown): PrinterSettings {
  const source =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return {
    printerName: String(source.printerName ?? "").trim(),
    sensorType: source.sensorType === "BLINE" ? "BLINE" : "GAP",
    gapMm: numberInRange(source.gapMm, DEFAULT_SETTINGS.gapMm, 0, 20),
    gapOffsetMm: numberInRange(
      source.gapOffsetMm,
      DEFAULT_SETTINGS.gapOffsetMm,
      -10,
      10
    ),
    direction: source.direction === 0 ? 0 : 1,
    referenceX: Math.round(
      numberInRange(source.referenceX, DEFAULT_SETTINGS.referenceX, -200, 200)
    ),
    referenceY: Math.round(
      numberInRange(source.referenceY, DEFAULT_SETTINGS.referenceY, -200, 200)
    ),
    shiftX: Math.round(
      numberInRange(source.shiftX, DEFAULT_SETTINGS.shiftX, -200, 200)
    ),
    shiftY: Math.round(
      numberInRange(source.shiftY, DEFAULT_SETTINGS.shiftY, -200, 200)
    ),
    speed: numberInRange(source.speed, DEFAULT_SETTINGS.speed, 1, 6),
    density: Math.round(
      numberInRange(source.density, DEFAULT_SETTINGS.density, 0, 15)
    ),
  };
}

export function getPrinterSettings() {
  try {
    return normalizeSettings(JSON.parse(readFileSync(settingsPath(), "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function savePrinterSettings(value: unknown) {
  const settings = normalizeSettings(value);
  mkdirSync(clientDataDir(), { recursive: true });
  writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return settings;
}

export async function listPrinters() {
  const runtime = clientRuntime();
  return runtime.platform.printerBackend.list(runtime.context);
}

function ascii(value: string) {
  return Buffer.from(value, "ascii");
}

function command(value: string) {
  return ascii(`${value}\r\n`);
}

function buildTspl(settings: PrinterSettings, labels: LocalLabelBitmap[]) {
  const chunks: Buffer[] = [
    command(
      `SIZE ${LOGEN_LABEL_TEMPLATE.widthMm} mm,${LOGEN_LABEL_TEMPLATE.lengthMm} mm`
    ),
    settings.sensorType === "BLINE"
      ? command(`BLINE ${settings.gapMm} mm,${settings.gapOffsetMm} mm`)
      : command(`GAP ${settings.gapMm} mm,${settings.gapOffsetMm} mm`),
    command(`DIRECTION ${settings.direction}`),
    command(`REFERENCE ${settings.referenceX},${settings.referenceY}`),
    command(`SHIFT ${settings.shiftX},${settings.shiftY}`),
    command(`SPEED ${settings.speed}`),
    command(`DENSITY ${settings.density}`),
  ];

  for (const label of labels) {
    if (!TRACKING_PATTERN.test(label.trackingNumber)) {
      throw new LocalPrinterError(
        "INVALID_TRACKING_NUMBER",
        "Every Logen tracking number must contain 11 digits."
      );
    }
    const bitmap = Buffer.from(label.bitmapBase64, "base64");
    if (bitmap.length !== BITMAP_BYTES) {
      throw new LocalPrinterError(
        "INVALID_LABEL_BITMAP",
        `A label bitmap must contain exactly ${BITMAP_BYTES} bytes.`
      );
    }
    chunks.push(
      command("CLS"),
      ascii(
        `BITMAP 0,0,${LOGEN_LABEL_TEMPLATE.widthDots / 8},${
          LOGEN_LABEL_TEMPLATE.lengthDots
        },0,`
      ),
      bitmap,
      command(""),
      command(
        `BARCODE 442,820,"128",72,1,0,2,2,"${label.trackingNumber}"`
      ),
      command("PRINT 1,1")
    );
  }
  return Buffer.concat(chunks);
}

export function buildLogenTsplForTest(
  settings: unknown,
  labels: LocalLabelBitmap[]
) {
  return buildTspl(normalizeSettings(settings), labels);
}

function readLedger(requestKey: string): PrintJobLedger | null {
  try {
    return JSON.parse(readFileSync(jobPath(requestKey), "utf8")) as PrintJobLedger;
  } catch {
    return null;
  }
}

function writeLedger(ledger: PrintJobLedger) {
  mkdirSync(jobsDir(), { recursive: true });
  const target = jobPath(ledger.requestKey);
  const temporary = path.join(
    jobsDir(),
    `.${ledger.requestKey}.${randomUUID()}.tmp`
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify(ledger, null, 2)}\n`,
      "utf8"
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, target);
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The durable ledger write error is propagated below.
      }
    }
    rmSync(temporary, { force: true });
  }
}

let printSpoolInitialization: Promise<void> | null = null;
let printSpoolRuntimeFailure: LocalPrinterError | null = null;

function printSpoolError(error: unknown, uncertain = true) {
  if (error instanceof LocalPrinterError) return error;
  const code =
    error instanceof ClientPrintSpoolError
      ? error.code
      : "PRINT_SPOOL_SECURITY_INITIALIZATION_FAILED";
  return new LocalPrinterError(
    code,
    error instanceof Error
      ? error.message
      : "The private local print spool could not be initialized.",
    uncertain
  );
}

async function ensurePrintSpoolReady() {
  if (printSpoolRuntimeFailure) {
    throw printSpoolRuntimeFailure;
  }
  const startupErrorCode = String(
    process.env.QUICKHACK_PRINT_SPOOL_STARTUP_ERROR_CODE || ""
  ).trim();
  if (startupErrorCode) {
    printSpoolRuntimeFailure = new LocalPrinterError(
      startupErrorCode,
      String(
        process.env.QUICKHACK_PRINT_SPOOL_STARTUP_ERROR_MESSAGE ||
          "The private local print spool failed its startup security check."
      ),
      true
    );
    throw printSpoolRuntimeFailure;
  }
  if (process.env.QUICKHACK_PRINT_SPOOL_INITIALIZED === "1") {
    return;
  }
  const runtime = clientRuntime();
  printSpoolInitialization ??= initializeClientPrintSpool({
    clientDataDir: runtime.directories.stateDir,
    platform: spoolPlatform(runtime.platform.platform),
    applyWindowsAcl: (directory: string) =>
      runtime.platform.printerBackend.secureSpoolDirectory({
        ...runtime.context,
        directory,
      }),
  })
    .then(() => undefined)
    .catch((error) => {
      printSpoolRuntimeFailure = printSpoolError(error);
      throw printSpoolRuntimeFailure;
    });
  await printSpoolInitialization;
}

export function getLocalPrintJob(requestKey: unknown) {
  const normalized = String(requestKey ?? "").trim();
  if (!JOB_KEY_PATTERN.test(normalized)) {
    throw new LocalPrinterError(
      "INVALID_PRINT_REQUEST_KEY",
      "The print request key is invalid."
    );
  }
  return readLedger(normalized);
}

export async function acknowledgeLocalPrintJob(input: {
  requestKey?: unknown;
  resolution?: unknown;
}) {
  const requestKey = String(input.requestKey ?? "").trim();
  const resolution = String(input.resolution ?? "") as
    | "CONFIRMED"
    | "PRINTED"
    | "NOT_PRINTED";
  if (!JOB_KEY_PATTERN.test(requestKey)) {
    throw new LocalPrinterError(
      "INVALID_PRINT_REQUEST_KEY",
      "The print request key is invalid."
    );
  }
  if (!["CONFIRMED", "PRINTED", "NOT_PRINTED"].includes(resolution)) {
    throw new LocalPrinterError(
      "INVALID_PRINT_RESOLUTION",
      "The print resolution is invalid."
    );
  }
  await ensurePrintSpoolReady();
  const ledger = readLedger(requestKey);
  if (
    !ledger ||
    ledger.requestKey !== requestKey ||
    !HASH_PATTERN.test(String(ledger.contentHash || ""))
  ) {
    throw new LocalPrinterError(
      "PRINT_LEDGER_NOT_ACKNOWLEDGEABLE",
      "The local print ledger cannot be acknowledged safely."
    );
  }
  if (
    (resolution === "CONFIRMED" && ledger.status !== "SPOOLED") ||
    (resolution !== "CONFIRMED" && ledger.status !== "UNKNOWN")
  ) {
    throw new LocalPrinterError(
      "PRINT_LEDGER_STATUS_CONFLICT",
      "The local print ledger status does not match the resolution."
    );
  }
  if (
    ledger.acknowledgement &&
    ledger.acknowledgement.resolution !== resolution
  ) {
    throw new LocalPrinterError(
      "PRINT_LEDGER_ACKNOWLEDGEMENT_CONFLICT",
      "The local print ledger was already acknowledged differently."
    );
  }
  if (
    ledger.acknowledgement &&
    (!Number.isFinite(Date.parse(ledger.acknowledgement.acknowledgedAt)) ||
      new Date(ledger.acknowledgement.acknowledgedAt).toISOString() !==
        ledger.acknowledgement.acknowledgedAt)
  ) {
    throw new LocalPrinterError(
      "PRINT_LEDGER_ACKNOWLEDGEMENT_INVALID",
      "The local print acknowledgement timestamp is invalid."
    );
  }
  const acknowledgedAt =
    ledger.acknowledgement?.acknowledgedAt ?? new Date().toISOString();
  const acknowledgedLedger: PrintJobLedger = {
    ...ledger,
    acknowledgement: { resolution, acknowledgedAt },
  };
  writeLedger(acknowledgedLedger);
  try {
    await acknowledgeClientPrintSpoolRecovery({
      clientDataDir: clientDataDir(),
      requestKey,
      contentHash: ledger.contentHash,
      resolution,
      acknowledgedAt,
    });
  } catch (error) {
    throw printSpoolError(error, true);
  }
  return acknowledgedLedger;
}

export async function printLogenLabels(input: {
  requestKey?: unknown;
  payloadHash?: unknown;
  printerName?: unknown;
  labels?: unknown;
}) {
  const requestKey = String(input.requestKey ?? "").trim();
  const payloadHash = String(input.payloadHash ?? "").trim();
  const printerName = String(input.printerName ?? "").trim();
  if (!JOB_KEY_PATTERN.test(requestKey)) {
    throw new LocalPrinterError(
      "INVALID_PRINT_REQUEST_KEY",
      "The print request key is invalid."
    );
  }
  if (!HASH_PATTERN.test(payloadHash)) {
    throw new LocalPrinterError(
      "INVALID_PRINT_PAYLOAD_HASH",
      "The print payload hash is invalid."
    );
  }
  if (!printerName || printerName.length > 256) {
    throw new LocalPrinterError(
      "INVALID_PRINTER_NAME",
      "A valid local printer queue is required."
    );
  }
  if (!Array.isArray(input.labels)) {
    throw new LocalPrinterError(
      "INVALID_LABELS",
      "The label payload must be an array."
    );
  }
  const labels = input.labels.map((value) => {
    const item =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    return {
      issueItemId: Number(item.issueItemId),
      issueSequence: Number(item.issueSequence),
      trackingNumber: String(item.trackingNumber ?? "").trim(),
      bitmapBase64: String(item.bitmapBase64 ?? ""),
    };
  });
  if (
    labels.length === 0 ||
    labels.length > LOGEN_LABEL_TEMPLATE.maxBatchSize ||
    labels.some(
      (label) =>
        !Number.isSafeInteger(label.issueItemId) ||
        label.issueItemId <= 0 ||
        !Number.isSafeInteger(label.issueSequence) ||
        label.issueSequence <= 0
    )
  ) {
    throw new LocalPrinterError(
      "INVALID_LABELS",
      `Between 1 and ${LOGEN_LABEL_TEMPLATE.maxBatchSize} ordered labels are required.`
    );
  }
  const existing = readLedger(requestKey);
  if (existing) {
    if (
      existing.payloadHash !== payloadHash ||
      existing.printerName !== printerName
    ) {
      throw new LocalPrinterError(
        "PRINT_REQUEST_CONFLICT",
        "The request key was already used with a different payload."
      );
    }
    return existing;
  }

  const settings = { ...getPrinterSettings(), printerName };
  const payload = buildTspl(settings, labels);
  const contentHash = createHash("sha256").update(payload).digest("hex");
  await ensurePrintSpoolReady();
  let recovery;
  try {
    recovery = await inspectClientPrintSpoolRecovery({
      clientDataDir: clientDataDir(),
      requestKey,
      contentHash,
    });
  } catch (error) {
    printSpoolRuntimeFailure = printSpoolError(error);
    throw printSpoolRuntimeFailure;
  }
  if (recovery.status === "MATCH" || recovery.status === "CONFLICT") {
    const ledger: PrintJobLedger = {
      requestKey,
      payloadHash,
      contentHash,
      printerName,
      status: "UNKNOWN",
      labelCount: labels.length,
      requestedBytes: payload.length,
      writtenBytes: null,
      errorCode:
        recovery.status === "MATCH"
          ? "ORPHANED_PRINT_SPOOL_RECOVERED"
          : "ORPHANED_PRINT_SPOOL_CONFLICT",
      errorMessage:
        recovery.status === "MATCH"
          ? "A previous local print process ended before recording its result. Automatic reprinting is blocked."
           : "A previous local print process used this request key with different spool content. Automatic reprinting is blocked.",
      nativeJobId: null,
      createdAt: new Date().toISOString(),
    };
    writeLedger(ledger);
    return ledger;
  }

  const runtime = clientRuntime();
  let spoolPath: string;
  try {
    spoolPath = await createPrivatePrintSpoolFile({
      clientDataDir: clientDataDir(),
      requestKey,
      contentHash,
      payload,
      platform: spoolPlatform(runtime.platform.platform),
    });
  } catch (error) {
    throw printSpoolError(error, true);
  }
  try {
    await armClientPrintSpoolAttempt({
      clientDataDir: clientDataDir(),
      requestKey,
      contentHash,
    });
  } catch (error) {
    printSpoolRuntimeFailure = printSpoolError(error, true);
    throw printSpoolRuntimeFailure;
  }

  let ledger: PrintJobLedger;
  try {
    const result = await runtime.platform.printerBackend.submit({
      ...runtime.context,
      printerName,
      spoolPath,
      requestedBytes: payload.length,
    });
    ledger = {
      requestKey,
      payloadHash,
      contentHash,
      printerName,
      status: result.status,
      labelCount: labels.length,
      requestedBytes: result.requestedBytes,
      writtenBytes: result.writtenBytes,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      nativeJobId: result.nativeJobId,
      createdAt: new Date().toISOString(),
    };
  } catch {
    ledger = {
      requestKey,
      payloadHash,
      contentHash,
      printerName,
      status: "UNKNOWN",
      labelCount: labels.length,
      requestedBytes: payload.length,
      writtenBytes: null,
      errorCode: "PRINTER_BACKEND_RESULT_UNKNOWN",
      errorMessage:
        "The local printer backend may have received the request; automatic retry is blocked.",
      nativeJobId: null,
      createdAt: new Date().toISOString(),
    };
  }

  try {
    writeLedger(ledger);
  } catch (error) {
    printSpoolRuntimeFailure = new LocalPrinterError(
      "PRINT_LEDGER_PERSIST_FAILED",
      error instanceof Error
        ? error.message
        : "The local print result could not be recorded durably.",
      true
    );
    // Keep the private spool in place. Startup recovery and the durable
    // attempt marker will block an automatic replay.
    throw printSpoolRuntimeFailure;
  }

  try {
    await removePrivatePrintSpoolFile(spoolPath, {
      clientDataDir: clientDataDir(),
    });
  } catch (error) {
    ledger = {
      requestKey,
      payloadHash,
      contentHash,
      printerName,
      status: "UNKNOWN",
      labelCount: labels.length,
      requestedBytes: payload.length,
      writtenBytes: null,
      errorCode: "PRINT_SPOOL_CLEANUP_FAILED",
      errorMessage:
        "The local print result is unknown because its private spool file could not be removed.",
      nativeJobId: ledger.nativeJobId,
      createdAt: new Date().toISOString(),
    };
    try {
      writeLedger(ledger);
    } catch (ledgerError) {
      printSpoolRuntimeFailure = new LocalPrinterError(
        "PRINT_LEDGER_PERSIST_FAILED",
        ledgerError instanceof Error
          ? ledgerError.message
          : "The unknown local print result could not be recorded durably.",
        true
      );
      throw printSpoolRuntimeFailure;
    }
    printSpoolRuntimeFailure = printSpoolError(error, true);
  }
  return ledger;
}

export async function printCalibrationLabel(printerName: unknown) {
  const normalizedPrinter = String(printerName ?? "").trim();
  const bitmap = Buffer.alloc(BITMAP_BYTES);
  const widthBytes = LOGEN_LABEL_TEMPLATE.widthDots / 8;
  const setPixel = (x: number, y: number) => {
    if (
      x < 0 ||
      x >= LOGEN_LABEL_TEMPLATE.widthDots ||
      y < 0 ||
      y >= LOGEN_LABEL_TEMPLATE.lengthDots
    ) {
      return;
    }
    const index = y * widthBytes + Math.floor(x / 8);
    bitmap[index] |= 0x80 >> (x % 8);
  };
  for (let x = 0; x < LOGEN_LABEL_TEMPLATE.widthDots; x += 8) {
    setPixel(x, 0);
    setPixel(x, LOGEN_LABEL_TEMPLATE.lengthDots - 1);
  }
  for (let y = 0; y < LOGEN_LABEL_TEMPLATE.lengthDots; y += 8) {
    setPixel(0, y);
    setPixel(LOGEN_LABEL_TEMPLATE.widthDots - 1, y);
  }
  for (let x = 0; x < LOGEN_LABEL_TEMPLATE.widthDots; x += 80) {
    for (let y = 0; y < LOGEN_LABEL_TEMPLATE.lengthDots; y += 4) {
      setPixel(x, y);
    }
  }
  for (let y = 0; y < LOGEN_LABEL_TEMPLATE.lengthDots; y += 80) {
    for (let x = 0; x < LOGEN_LABEL_TEMPLATE.widthDots; x += 4) {
      setPixel(x, y);
    }
  }
  const requestKey = `LOGEN-LABEL-0-${randomUUID()}`;
  const payloadHash = createHash("sha256").update(bitmap).digest("hex");
  return printLogenLabels({
    requestKey,
    payloadHash,
    printerName: normalizedPrinter,
    labels: [
      {
        issueItemId: 1,
        issueSequence: 1,
        trackingNumber: "00000000000",
        bitmapBase64: bitmap.toString("base64"),
      },
    ],
  });
}
