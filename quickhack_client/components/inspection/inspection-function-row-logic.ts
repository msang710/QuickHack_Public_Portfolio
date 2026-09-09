"use client";

import {
  isOptionValue,
  storageValuesForProduct,
  type FunctionRow,
  type ProductCriteriaRuntime,
} from "@/quickhack_client/components/inspection/function-inspection-edit-table";
import { validateBarcodeInput } from "@/quickhack_shared/inspection/inspection-schema";
import { isAdbVirtualSerial } from "@/quickhack_shared/adb/adb-target-policy";

export type BarcodeScanTarget = "PG" | "IMEI";

type BarcodeScan = {
  target: BarcodeScanTarget;
  value: string;
};

export type ConnectedAdbDevice = {
  serial: string;
  index: number;
  connectionState: string;
  product: string;
  csc: string;
  storage: string;
  firstCallDate: string;
  account: string;
  accountStatus: "UNKNOWN" | "NONE" | "PRESENT" | "QUERY_FAILED";
  cameraCheck: string;
  warning: string;
  warningCodes: FunctionRow["warningCodes"];
  warningDetail: string | null;
};

export function isAdbVirtualEmulatorPort(device: ConnectedAdbDevice) {
  return isAdbVirtualSerial(device.serial);
}

export function createFunctionRow(id?: string): FunctionRow {
  return {
    id:
      id ??
      globalThis.crypto?.randomUUID?.() ??
      `row-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    serial: "",
    connectionState: "manual",
    product: "",
    csc: "",
    storage: "",
    firstCallDate: "",
    account: "",
    accountStatus: "UNKNOWN",
    cameraCheck: "-",
    warning: "",
    warningCodes: [],
    warningDetail: null,
    pg: "",
    imei: "",
    functionDefect: "",
    returnYn: "N",
  };
}

export function isCompleteFunctionRow(row: FunctionRow) {
  return Boolean(row.pg && row.imei);
}

// QuickHack object: 스캐너로 들어온 문자열에서 PG/IMEI 토큰을 자동 감지해 행 입력에 사용합니다.
export function parseBarcodeScans(rawValue: string) {
  const compactValue = rawValue
    .trim()
    .toUpperCase()
    .replace(/[\s,;|/\\_-]+/g, "");
  const tokens = compactValue.match(/[A-Z]{2}\d{10}|\d{15}/g) ?? [];

  if (!compactValue || tokens.length === 0 || tokens.join("") !== compactValue) {
    return {
      ok: false as const,
      scans: [] as BarcodeScan[],
      errorCode: "INVALID_BARCODE" as const,
    };
  }

  const scans: BarcodeScan[] = [];

  for (const token of tokens) {
    const pgValidation = validateBarcodeInput(token, "PG");

    if (pgValidation.ok) {
      scans.push({ target: "PG", value: pgValidation.value });
      continue;
    }

    const imeiValidation = validateBarcodeInput(token, "IMEI");

    if (imeiValidation.ok) {
      scans.push({ target: "IMEI", value: imeiValidation.value });
      continue;
    }

    return {
      ok: false as const,
      scans: [] as BarcodeScan[],
      errorCode: "INVALID_BARCODE" as const,
    };
  }

  return { ok: true as const, scans };
}

export function fieldForBarcodeScan(target: BarcodeScanTarget): "pg" | "imei" {
  return target === "PG" ? "pg" : "imei";
}

export function findRowIndexForBarcodeScan(
  rows: FunctionRow[],
  selectedRowId: string,
  target: BarcodeScanTarget
) {
  const field = fieldForBarcodeScan(target);
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => row.id === selectedRowId)
  );
  const orderedIndexes = [
    ...rows.slice(selectedIndex).map((_, offset) => selectedIndex + offset),
    ...rows.slice(0, selectedIndex).map((_, offset) => offset),
  ];

  return orderedIndexes.find((index) => {
    const row = rows[index];

    return row && !isCompleteFunctionRow(row) && !row[field];
  });
}

export function findNextIncompleteFunctionRowIndex(
  rows: FunctionRow[],
  afterIndex: number
) {
  const orderedIndexes = [
    ...rows.slice(afterIndex + 1).map((_, offset) => afterIndex + 1 + offset),
    ...rows.slice(0, afterIndex + 1).map((_, offset) => offset),
  ];

  return orderedIndexes.find((index) => {
    const row = rows[index];

    return row && !isCompleteFunctionRow(row);
  });
}

function hasFunctionRowDraft(row: FunctionRow) {
  return Boolean(row.pg || row.imei || row.functionDefect || row.returnYn === "Y");
}

function preserveDisconnectedDraft(row: FunctionRow): FunctionRow {
  if (!row.serial) {
    return row;
  }

  return {
    ...row,
    connectionState: "disconnected",
    warning: row.warning,
  };
}

function createFunctionRowFromAdbDevice(
  device: ConnectedAdbDevice,
  criteriaRuntime: ProductCriteriaRuntime,
  existing?: FunctionRow
): FunctionRow {
  const product = isOptionValue(device.product, criteriaRuntime.productValues)
    ? device.product
    : "";

  return {
    id: device.serial,
    serial: device.serial,
    connectionState: device.connectionState,
    product,
    csc: isOptionValue(device.csc, criteriaRuntime.carrierValues)
      ? device.csc
      : "",
    storage: isOptionValue(
      device.storage,
      storageValuesForProduct(criteriaRuntime, product)
    )
      ? device.storage
      : "",
    firstCallDate: device.firstCallDate,
    account: device.account,
    accountStatus: device.accountStatus,
    cameraCheck: device.cameraCheck,
    warning: device.warning,
    warningCodes: device.warningCodes,
    warningDetail: device.warningDetail,
    pg: existing?.pg ?? "",
    imei: existing?.imei ?? "",
    functionDefect: existing?.functionDefect ?? "",
    returnYn: existing?.returnYn ?? "N",
  };
}

// QuickHack object: 현재 기능 검수 행과 새 ADB 조회 결과를 합쳐 작업 중인 수동 입력을 보존합니다.
export function mergeFunctionRowsWithAdbDevices(
  currentRows: FunctionRow[],
  devices: ConnectedAdbDevice[],
  criteriaRuntime: ProductCriteriaRuntime
) {
  if (devices.length === 0) {
    const drafts = currentRows.filter(hasFunctionRowDraft);
    return drafts.length > 0 ? drafts : [createFunctionRow("row-1")];
  }

  const currentBySerial = new Map(
    currentRows
      .filter((row) => row.serial || row.id)
      .map((row) => [row.serial || row.id, row])
  );
  const nextRows = devices.map((device) =>
    createFunctionRowFromAdbDevice(
      device,
      criteriaRuntime,
      currentBySerial.get(device.serial)
    )
  );
  const connectedSerials = new Set(devices.map((device) => device.serial));
  const disconnectedDrafts = currentRows
    .filter(
      (row) => !connectedSerials.has(row.serial) && hasFunctionRowDraft(row)
    )
    .map(preserveDisconnectedDraft);

  return [...nextRows, ...disconnectedDrafts];
}
