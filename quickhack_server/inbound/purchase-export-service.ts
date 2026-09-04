// QuickHack object: Builds purchase-related Excel workbooks for the purchase pending workflow.
import fs from "node:fs";
import path from "node:path";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { MODEL_MAP } from "@/quickhack_client/adb/adb-config";
import { actualDefectText } from "@/quickhack_shared/inspection/inspection-schema";
import { INSPECTION_TYPE } from "@/quickhack_shared/inspection/inspection-types";
import { INBOUND_STATUS } from "@/quickhack_shared/inbound/inbound-status";
import { getAppRoot } from "@/quickhack_shared/core/runtime";
import { readZipEntries, writeZipEntries } from "@/quickhack_server/core/xlsx-zip";
import {
  publicBadRequest,
  publicConflict,
} from "@/quickhack_server/core/public-error";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";

export type PurchaseExportKind = "purchase-statement" | "jungabi-registration";
type PurchaseExportInput = Record<string, unknown>;
type PurchaseExportItem = {
  pgNo: string;
  expectedInboundId: number;
  expectedInboundRevision: number;
  purchasePrice: number;
  purchasePriceRateId: number | null;
  purchasePriceRateRevision: number | null;
  purchasePriceQueryContext: {
    priceDate: string;
    note: string;
  };
};
type ExportDeviceRow = {
  sequence: number;
  pgNo: string;
  batchNo: number | null;
  supplierName: string;
  model: string;
  modelCode: string;
  grade: string;
  saleGrade: string;
  storage: string;
  color: string;
  carrier: string;
  phoneState: string;
  imei: string;
  imei2: string;
  serial: string;
  refurbishUntil: string;
  fullChargeCount: string;
  batteryHealth: string;
  returnYn: string;
  basePrice: number;
  deductionPrice: number;
  additionalPrice: number;
  purchasePrice: number;
  lossStatus: string;
  memo: string;
};
type PurchaseExportWorkbook = {
  buffer: Buffer;
  filename: string;
};

const JUNGABI_TEMPLATE_PATH = path.join(
  getAppRoot(),
  "templates",
  "jungabi-bulk-registration-template.xlsx"
);
const PURCHASE_STATEMENT_TEMPLATE_PATH = path.join(
  getAppRoot(),
  "templates",
  "purchase-statement-template.xlsx"
);
const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FALLBACK_MODEL_CODE_BY_PRODUCT = new Map(
  Object.entries(MODEL_MAP).map(([modelCode, product]) => [product, modelCode])
);

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function parsePurchasePrice(value: unknown) {
  const normalized = text(value).replace(/,/g, "");

  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  return Number.parseInt(normalized, 10);
}

function optionalInteger(value: unknown, minimum: number, label: string) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw publicBadRequest(
      "PURCHASE_EXPORT_RATE_EVIDENCE_INVALID",
      "PURCHASE_EXPORT_RATE_EVIDENCE_INVALID"
    );
  }

  return parsed;
}

function parseItems(input: PurchaseExportInput): PurchaseExportItem[] {
  const rows = Array.isArray(input.items) ? input.items : [];
  const items = rows
    .map((row) => {
      if (!row || typeof row !== "object") {
        return null;
      }

      const source = row as Record<string, unknown>;
      const pgNo = text(source.pgNo).toUpperCase();
      const purchasePrice = parsePurchasePrice(source.purchasePrice);

      if (!pgNo || purchasePrice === null) {
        return null;
      }

      const context =
        typeof source.purchasePriceQueryContext === "object" &&
        source.purchasePriceQueryContext !== null
          ? (source.purchasePriceQueryContext as Record<string, unknown>)
          : {};

      return {
        pgNo,
        expectedInboundId:
          optionalInteger(source.expectedInboundId, 1, "입고 ID") ?? -1,
        expectedInboundRevision:
          optionalInteger(source.expectedInboundRevision, 0, "입고 revision") ?? -1,
        purchasePrice,
        purchasePriceRateId: optionalInteger(
          source.purchasePriceRateId ?? source.rateId,
          1,
          "매입가 기준 ID"
        ),
        purchasePriceRateRevision: optionalInteger(
          source.purchasePriceRateRevision ?? source.rateRevision,
          0,
          "매입가 기준 revision"
        ),
        purchasePriceQueryContext: {
          priceDate: text(context.priceDate),
          note: text(context.note),
        },
      };
    })
    .filter((item): item is PurchaseExportItem => Boolean(item));

  for (const item of items) {
    if (item.expectedInboundId <= 0 || item.expectedInboundRevision < 0) {
      throw publicBadRequest(
        "PURCHASE_EXPORT_TARGET_INVALID",
        "PURCHASE_EXPORT_TARGET_INVALID"
      );
    }
    if (
      (item.purchasePriceRateId === null) !==
      (item.purchasePriceRateRevision === null)
    ) {
      throw publicBadRequest(
        "PURCHASE_EXPORT_RATE_EVIDENCE_INVALID",
        "PURCHASE_EXPORT_RATE_EVIDENCE_INVALID"
      );
    }
  }

  return [...new Map(items.map((item) => [item.pgNo, item])).values()];
}

function parseKind(value: unknown): PurchaseExportKind {
  if (value === "purchase-statement" || value === "jungabi-registration") {
    return value;
  }

  throw publicBadRequest(
    "PURCHASE_EXPORT_INPUT_INVALID",
    "PURCHASE_EXPORT_INPUT_INVALID"
  );
}

function normalizeDate(value: unknown) {
  const candidate = text(value);

  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    return candidate;
  }

  throw publicBadRequest(
    "PURCHASE_EXPORT_DATE_INVALID",
    "PURCHASE_EXPORT_DATE_INVALID"
  );
}

function safeFilePart(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 80);
}

function compactDateForFilename(value: string) {
  return value.replace(/-/g, "").slice(2);
}

function jungabiBatchLabel(inputBatchNo: unknown, rows: ExportDeviceRow[]) {
  const explicitBatchNo = text(inputBatchNo).replace(/차$/, "").trim();

  if (explicitBatchNo) {
    return `${safeFilePart(explicitBatchNo)}차`;
  }

  const batchNos = [
    ...new Set(
      rows
        .map((row) => row.batchNo)
        .filter((value): value is number => value !== null)
    ),
  ].sort((left, right) => left - right);

  if (batchNos.length === 1) {
    return `${batchNos[0]}차`;
  }

  if (batchNos.length > 1) {
    return `${batchNos[0]}차외${batchNos.length - 1}`;
  }

  return "차수미지정";
}

function escapeXml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function inlineStringCell(ref: string, value: unknown, style = 0) {
  const content = String(value ?? "");
  const space =
    /^\s|\s$|\n/.test(content) || content.includes("  ")
      ? ' xml:space="preserve"'
      : "";

  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t${space}>${escapeXml(
    content
  )}</t></is></c>`;
}

function numberCell(ref: string, value: number, style = 0) {
  return `<c r="${ref}" s="${style}"><v>${Number.isFinite(value) ? value : 0}</v></c>`;
}

function blankCell(ref: string, style = 0) {
  return `<c r="${ref}" s="${style}"/>`;
}

function cellXml(
  column: string,
  row: number,
  value: string | number | null | undefined,
  style = 0
) {
  const ref = `${column}${row}`;

  if (value === null || value === undefined || value === "") {
    return blankCell(ref, style);
  }

  return typeof value === "number"
    ? numberCell(ref, value, style)
    : inlineStringCell(ref, value, style);
}

function rowXml(rowNumber: number, cells: string[], attributes = "") {
  return `<row r="${rowNumber}"${attributes}>${cells.join("")}</row>`;
}

function joinText(parts: Array<string | null | undefined>) {
  return parts.map(text).filter(Boolean).join(", ");
}

function normalizedGrade(value: string) {
  return value.toUpperCase().replace(/\s+/g, "");
}

function purchaseStatementGradeLabel(value: string) {
  const grade = text(value);

  if (!grade) {
    return "";
  }

  const normalized = normalizedGrade(grade);

  if (normalized.includes("~")) {
    return grade;
  }

  return `${grade}급`;
}

function needsPurchaseConsultation(row: ExportDeviceRow) {
  return ["A-~B+", "B+", "B"].includes(normalizedGrade(row.grade));
}

function carrierLabelForPurchaseStatement(value: string) {
  const normalized = text(value);
  const compact = normalized.toUpperCase().replace(/\s+/g, "");
  const carrierMap: Record<string, string> = {
    SKC: "SKT",
    SKT: "SKT",
    KTC: "KT",
    KT: "KT",
    LUC: "LG U+",
    LGU: "LG U+",
    "LGU+": "LG U+",
    "LGU＋": "LG U+",
    "LG유플러스": "LG U+",
    KOO: "자급제",
    자급제: "자급제",
  };

  return carrierMap[compact] ?? normalized;
}

function purchaseStatementStatus(row: ExportDeviceRow) {
  if (row.returnYn === "Y") {
    return "반품";
  }

  return needsPurchaseConsultation(row) ? "입고보류" : "재고";
}

function purchaseStatementStatusOrder(row: ExportDeviceRow) {
  const status = purchaseStatementStatus(row);

  if (status === "재고") {
    return 0;
  }

  if (status === "입고보류") {
    return 1;
  }

  return 2;
}

function purchaseStatementGradeOrder(row: ExportDeviceRow) {
  const gradeOrder = new Map([
    ["A", 0],
    ["A-", 1],
    ["A-~B+", 2],
    ["B+", 3],
    ["B", 4],
  ]);

  return gradeOrder.get(normalizedGrade(row.grade)) ?? 99;
}

function comparePurchaseStatementRows(left: ExportDeviceRow, right: ExportDeviceRow) {
  const statusOrder =
    purchaseStatementStatusOrder(left) - purchaseStatementStatusOrder(right);

  if (statusOrder !== 0) {
    return statusOrder;
  }

  const modelOrder = left.model.localeCompare(right.model, "ko-KR", {
    numeric: true,
    sensitivity: "base",
  });

  if (modelOrder !== 0) {
    return modelOrder;
  }

  return purchaseStatementGradeOrder(left) - purchaseStatementGradeOrder(right);
}

function sortPurchaseStatementRows(rows: ExportDeviceRow[]) {
  return [...rows]
    .sort(comparePurchaseStatementRows)
    .map((row, index) => ({ ...row, sequence: index + 1 }));
}

function capacityForJungabi(value: string) {
  const normalized = value.toUpperCase().replace(/\s+/g, "");
  const gbMatch = normalized.match(/^(\d+)GB$/);
  const tbMatch = normalized.match(/^(\d+)TB$/);

  if (gbMatch) {
    return Number.parseInt(gbMatch[1], 10);
  }

  if (tbMatch) {
    return Number.parseInt(tbMatch[1], 10) * 1024;
  }

  return value;
}

function replaceCellXml(row: string, ref: string, cell: string) {
  const pattern = new RegExp(`<c\\b[^>]*\\sr="${ref}"[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`);

  if (pattern.test(row)) {
    return row.replace(pattern, cell);
  }

  return row.replace("</row>", `${cell}</row>`);
}

function shiftRowXml(row: string, rowNumber: number) {
  const originalRowNumber = /<row\b[^>]*\sr="(\d+)"/.exec(row)?.[1];

  if (!originalRowNumber) {
    return row;
  }

  return row
    .replace(/\sr="\d+"/, ` r="${rowNumber}"`)
    .replace(
      new RegExp(`([A-Z]+)${originalRowNumber}\\b`, "g"),
      `$1${rowNumber}`
    );
}

function shiftMergeRef(ref: string, offset: number) {
  return ref.replace(/([A-Z]+)(\d+)/g, (match, column: string, rowText: string) => {
    const rowNumber = Number.parseInt(rowText, 10);

    return `${column}${rowNumber >= 17 ? rowNumber + offset : rowNumber}`;
  });
}

function buildPurchaseStatementWorkbook(
  rows: ExportDeviceRow[],
  input: {
    purchaseDate: string;
    supplierName: string;
    batchNo: unknown;
  }
) {
  if (!fs.existsSync(PURCHASE_STATEMENT_TEMPLATE_PATH)) {
    throw new Error("매입 명세표 템플릿 파일을 찾을 수 없습니다.");
  }

  const sortedRows = sortPurchaseStatementRows(rows);
  const batchLabel = jungabiBatchLabel(input.batchNo, rows);
  const entries = readZipEntries(fs.readFileSync(PURCHASE_STATEMENT_TEMPLATE_PATH));
  const sheetEntry = entries.find(
    (entry) => entry.name === "xl/worksheets/sheet1.xml"
  );

  if (!sheetEntry) {
    throw new Error("매입 명세표의 Sheet1을 찾을 수 없습니다.");
  }

  const originalSheet = sheetEntry.data.toString("utf8");
  const rowMatches = [
    ...originalSheet.matchAll(/<row\b[^>]*\sr="(\d+)"[\s\S]*?<\/row>/g),
  ];
  const topRows = rowMatches
    .filter((match) => Number.parseInt(match[1], 10) < 11)
    .map((match) => {
      const rowNumber = Number.parseInt(match[1], 10);
      let row = match[0];

      if (rowNumber === 2) {
        row = replaceCellXml(
          row,
          "A2",
          inlineStringCell(
            "A2",
            `${input.purchaseDate} ${input.supplierName} ${batchLabel} 매입명세표`,
            14
          )
        );
      }

      if (rowNumber === 4) {
        row = replaceCellXml(row, "C4", inlineStringCell("C4", input.purchaseDate, 3));
      }

      if (rowNumber === 5) {
        row = replaceCellXml(row, "C5", inlineStringCell("C5", input.supplierName, 3));
      }

      if (rowNumber === 8) {
        row = replaceCellXml(
          row,
            "C8",
            numberCell(
              "C8",
            sortedRows.reduce(
              (sum, rowData) =>
                sum +
                (needsPurchaseConsultation(rowData)
                  ? 0
                  : rowData.purchasePrice),
              0
            ),
            4
          )
        );
      }

      return row;
    })
    .join("");
  const dataRows = sortedRows
    .map((row, index) => purchaseStatementTemplateRowXml(index + 11, row))
    .join("");
  const footerOffset = sortedRows.length - 5;
  const footerRows = rowMatches
    .filter((match) => Number.parseInt(match[1], 10) >= 17)
    .map((match) =>
      shiftRowXml(
        match[0],
        Number.parseInt(match[1], 10) + footerOffset
      )
    )
    .join("");
  const lastRow = 21 + footerOffset;
  const patchedSheetData = `<sheetData>${topRows}${dataRows}${footerRows}</sheetData>`;
  const patchedMergeCells = originalSheet.replace(
    /<mergeCells\b[^>]*>[\s\S]*?<\/mergeCells>/,
    (mergeXml) => {
      const refs = [...mergeXml.matchAll(/<mergeCell ref="([^"]+)"/g)].map(
        (match) => shiftMergeRef(match[1], footerOffset)
      );

      return `<mergeCells count="${refs.length}">${refs
        .map((ref) => `<mergeCell ref="${ref}"/>`)
        .join("")}</mergeCells>`;
    }
  );
  const patchedSheet = patchedMergeCells
    .replace(/<dimension ref="[^"]+"/, `<dimension ref="A2:W${lastRow}"`)
    .replace(/<sheetData>[\s\S]*?<\/sheetData>/, patchedSheetData);
  const patchedEntries = entries.map((entry) =>
    entry.name === sheetEntry.name
      ? { ...entry, data: Buffer.from(patchedSheet, "utf8") }
      : entry
  );

  return writeZipEntries(patchedEntries);
}

function purchaseStatementTemplateRowXml(rowNumber: number, row: ExportDeviceRow) {
  const isConsultation = needsPurchaseConsultation(row);
  const status = purchaseStatementStatus(row);
  const textStyle = isConsultation ? 8 : 5;
  const memoStyle = isConsultation ? 9 : 6;
  const moneyStyle = isConsultation ? 10 : 7;
  const basePrice = isConsultation ? null : row.basePrice;
  const purchasePrice = isConsultation ? null : row.purchasePrice;
  const productMemo = status === "재고" ? "" : row.memo;
  const cells = [
    cellXml("A", rowNumber, row.sequence, textStyle),
    cellXml("B", rowNumber, status, textStyle),
    cellXml("C", rowNumber, row.pgNo, textStyle),
    cellXml("D", rowNumber, row.model, textStyle),
    cellXml("E", rowNumber, row.modelCode, textStyle),
    cellXml("F", rowNumber, purchaseStatementGradeLabel(row.grade), textStyle),
    cellXml("G", rowNumber, capacityForJungabi(row.storage), textStyle),
    cellXml("H", rowNumber, row.color, textStyle),
    cellXml("I", rowNumber, carrierLabelForPurchaseStatement(row.carrier), textStyle),
    cellXml("J", rowNumber, "", memoStyle),
    cellXml("K", rowNumber, row.imei, memoStyle),
    cellXml("L", rowNumber, row.imei2, memoStyle),
    cellXml("M", rowNumber, row.serial, memoStyle),
    cellXml("N", rowNumber, row.refurbishUntil, textStyle),
    cellXml("O", rowNumber, 0, textStyle),
    cellXml("P", rowNumber, row.batteryHealth, textStyle),
    cellXml("Q", rowNumber, basePrice, moneyStyle),
    cellXml("R", rowNumber, row.deductionPrice, moneyStyle),
    cellXml("S", rowNumber, row.additionalPrice, moneyStyle),
    cellXml("T", rowNumber, purchasePrice, moneyStyle),
    cellXml("U", rowNumber, row.lossStatus, textStyle),
    cellXml("V", rowNumber, productMemo, memoStyle),
  ];

  if (isConsultation) {
    cells.push(cellXml("W", rowNumber, "협의필요", 17));
  }

  return rowXml(rowNumber, cells, ' spans="1:23" x14ac:dyDescent="0.25"');
}

function jungabiRowXml(rowNumber: number, row: ExportDeviceRow) {
  const values: Array<string | number> = [
    row.sequence,
    row.pgNo,
    row.model,
    row.modelCode,
    "중고",
    capacityForJungabi(row.storage),
    row.color,
    row.phoneState,
    row.imei,
    row.serial,
    row.batteryHealth,
    row.fullChargeCount,
    row.basePrice,
    row.deductionPrice,
    row.purchasePrice,
    row.memo,
  ];
  const columns = [
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
  ];
  const styles = [6, 7, 7, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 3];

  return rowXml(
    rowNumber,
    values.map((value, index) =>
      cellXml(columns[index], rowNumber, value, styles[index])
    ),
    ' spans="1:17"'
  );
}

function buildJungabiWorkbook(rows: ExportDeviceRow[]) {
  if (!fs.existsSync(JUNGABI_TEMPLATE_PATH)) {
    throw new Error("중가비 등록 양식 템플릿 파일을 찾을 수 없습니다.");
  }

  const entries = readZipEntries(fs.readFileSync(JUNGABI_TEMPLATE_PATH));
  const sheetEntry = entries.find(
    (entry) => entry.name === "xl/worksheets/sheet1.xml"
  );

  if (!sheetEntry) {
    throw new Error("중가비 등록 양식의 Sheet1을 찾을 수 없습니다.");
  }

  const originalSheet = sheetEntry.data.toString("utf8");
  const fixedRows = [...originalSheet.matchAll(/<row\b[^>]*\sr="(?:2|3|4|5|6)"[\s\S]*?<\/row>/g)]
    .map((match) => match[0])
    .join("");
  const dataRows = rows
    .map((row, index) => jungabiRowXml(index + 7, row))
    .join("");
  const lastRow = Math.max(7, rows.length + 6);
  const patchedSheet = originalSheet
    .replace(/<dimension ref="[^"]+"/, `<dimension ref="A2:Q${lastRow}"`)
    .replace(
      /<sheetData>[\s\S]*?<\/sheetData>/,
      `<sheetData>${fixedRows}${dataRows}</sheetData>`
    );
  const patchedEntries = entries.map((entry) =>
    entry.name === sheetEntry.name
      ? { ...entry, data: Buffer.from(patchedSheet, "utf8") }
      : entry
  );

  return writeZipEntries(patchedEntries);
}

async function loadExportRows(
  client: Prisma.TransactionClient,
  items: PurchaseExportItem[]
): Promise<ExportDeviceRow[]> {
  const pgNos = items.map((item) => item.pgNo);
  const priceByPgNo = new Map(items.map((item) => [item.pgNo, item.purchasePrice]));
  const itemByPgNo = new Map(items.map((item) => [item.pgNo, item]));
  const orderByPgNo = new Map(items.map((item, index) => [item.pgNo, index]));
  const rateIds = items
    .map((item) => item.purchasePriceRateId)
    .filter((id): id is number => id !== null);
  const inboundIds = items.map((item) => item.expectedInboundId);
  const [rows, productModelRows, rates] = await Promise.all([
    client.devices.findMany({
      where: { pg_no: { in: pgNos } },
      include: {
        inbounds: {
          orderBy: { inbound_id: "desc" },
          take: 1,
          include: { inbound_batch: true },
        },
        inspections: {
          where: { inbound_id: { in: inboundIds } },
          orderBy: { inspection_id: "desc" },
        },
        inventory_sku: {
          select: {
            model_option_id: true,
            storage_option_id: true,
          },
        },
      },
    }),
    client.product_criteria_options.findMany({
      where: {
        category: "PRODUCT_MODEL",
        is_active: 1,
      },
      select: {
        option_key: true,
        label: true,
      },
    }),
    client.purchase_price_rates.findMany({
      where: { purchase_price_rate_id: { in: rateIds } },
      include: {
        model_option: true,
        storage_option: true,
        appearance_grade_option: true,
      },
    }),
  ]);
  const modelCodeByProduct = new Map(FALLBACK_MODEL_CODE_BY_PRODUCT);

  productModelRows.forEach((row) => {
    const label = row.label.trim();
    const modelCode = row.option_key.trim();

    if (label && modelCode) {
      modelCodeByProduct.set(label, modelCode);
    }
  });
  const missingPgNos = pgNos.filter(
    (pgNo) => !rows.some((row) => row.pg_no === pgNo)
  );

  if (missingPgNos.length > 0) {
    throw publicConflict(
      "PURCHASE_EXPORT_TARGET_CHANGED",
      "PURCHASE_EXPORT_TARGET_CHANGED"
    );
  }

  for (const device of rows) {
    const expected = itemByPgNo.get(device.pg_no);
    const inbound = device.inbounds[0] ?? null;
    if (
      !expected ||
      !inbound ||
      inbound.inbound_id !== expected.expectedInboundId ||
      inbound.revision !== expected.expectedInboundRevision ||
      inbound.inbound_status !== INBOUND_STATUS.inspected
    ) {
      throw publicConflict(
        "PURCHASE_EXPORT_TARGET_CHANGED",
        "PURCHASE_EXPORT_TARGET_CHANGED"
      );
    }
  }

  const rateById = new Map(
    rates.map((rate) => [rate.purchase_price_rate_id, rate])
  );

  for (const device of rows) {
    const item = itemByPgNo.get(device.pg_no);

    if (!item?.purchasePriceRateId) {
      continue;
    }

    const rate = rateById.get(item.purchasePriceRateId);
    const context = item.purchasePriceQueryContext;
    const exactInspections = device.inspections.filter(
      (inspection) => inspection.inbound_id === item.expectedInboundId
    );
    const latestAppearanceGrade = exactInspections.find(
      (inspection) =>
        inspection.inspection_type === INSPECTION_TYPE.appearance &&
        inspection.appearance_grade
    )?.appearance_grade;
    const identityMatches =
      Boolean(rate) &&
      (device.inventory_sku
        ? rate?.model_option_id === device.inventory_sku.model_option_id
        : device.model_code
          ? rate?.model_option.option_key === device.model_code
          : rate?.model_option.label === device.model) &&
      (device.inventory_sku
        ? rate?.storage_option_id === device.inventory_sku.storage_option_id
        : rate?.storage_option.option_key === device.storage ||
          rate?.storage_option.label === device.storage) &&
      (rate?.appearance_grade_option.option_key === latestAppearanceGrade ||
        rate?.appearance_grade_option.label === latestAppearanceGrade);

    if (
      !rate ||
      rate.revision !== item.purchasePriceRateRevision ||
      rate.price_date.toISOString().slice(0, 10) !== context.priceDate ||
      rate.note !== context.note ||
      !identityMatches
    ) {
      throw publicConflict(
        "PURCHASE_EXPORT_RATE_STALE",
        "PURCHASE_EXPORT_RATE_STALE"
      );
    }
  }

  return rows
    .sort(
      (left, right) =>
        (orderByPgNo.get(left.pg_no) ?? 0) - (orderByPgNo.get(right.pg_no) ?? 0)
    )
    .map((device, index) => {
      const inbound = device.inbounds[0] ?? null;
      const exactInspections = device.inspections.filter(
        (inspection) => inspection.inbound_id === inbound?.inbound_id
      );
      const latestAppearanceInspection = exactInspections.find(
        (inspection) =>
          inspection.inspection_type === INSPECTION_TYPE.appearance ||
          (!inspection.inspection_type &&
            (inspection.appearance_grade || inspection.appearance_checked_at))
      );
      const latestFunctionInspection = exactInspections.find(
        (inspection) =>
          inspection.inspection_type === INSPECTION_TYPE.function ||
          (!inspection.inspection_type &&
            (inspection.function_checked_at ||
              inspection.function_defect ||
              inspection.csc ||
              inspection.first_call_date))
      );
      const appearanceDefect = actualDefectText(
        latestAppearanceInspection?.appearance_defect ?? ""
      );
      const functionDefect = actualDefectText(
        latestFunctionInspection?.function_defect ?? ""
      );
      const memo = joinText([appearanceDefect, functionDefect]);
      const purchasePrice = priceByPgNo.get(device.pg_no) ?? 0;

      return {
        sequence: index + 1,
        pgNo: device.pg_no,
        batchNo: inbound?.inbound_batch?.batch_no ?? null,
        supplierName: inbound?.supplier_name ?? "",
        model: device.model,
        modelCode: modelCodeByProduct.get(device.model.trim()) ?? "",
        grade:
          latestAppearanceInspection?.appearance_grade ??
          device.sale_grade ??
          "",
        saleGrade: device.sale_grade ?? "",
        storage: device.storage ?? "",
        color: device.color ?? "",
        carrier: latestFunctionInspection?.csc ?? "",
        phoneState: joinText([appearanceDefect, functionDefect]),
        imei: device.imei ?? "",
        imei2: "",
        serial: "",
        refurbishUntil: "",
        fullChargeCount: "0",
        batteryHealth: "",
        returnYn: latestAppearanceInspection?.return_yn === "Y" ? "Y" : "N",
        basePrice: purchasePrice,
        deductionPrice: 0,
        additionalPrice: 0,
        purchasePrice,
        lossStatus: "정상",
        memo,
      };
    });
}

export function purchaseExportContentType() {
  return XLSX_CONTENT_TYPE;
}

export async function buildPurchaseExportWorkbook(
  client: PrismaClient,
  input: PurchaseExportInput
): Promise<PurchaseExportWorkbook> {
  const kind = parseKind(input.kind);
  const items = parseItems(input);
  const purchaseDate = normalizeDate(input.purchaseDate);

  if (items.length === 0) {
    throw publicBadRequest(
      "PURCHASE_EXPORT_INPUT_INVALID",
      "PURCHASE_EXPORT_INPUT_INVALID"
    );
  }

  const rows = await runMeasuredTransaction(
    client,
    "inbound.purchase-export.snapshot",
    (tx) => loadExportRows(tx, items),
    { isolationLevel: "RepeatableRead", timeout: 120_000 }
  );
  const supplierNames = [
    ...new Set(rows.map((row) => text(row.supplierName)).filter(Boolean)),
  ];
  const supplierName = text(input.supplierName) || supplierNames[0] || "거래처";

  if (kind === "purchase-statement") {
    return {
      buffer: buildPurchaseStatementWorkbook(rows, {
        purchaseDate,
        supplierName,
        batchNo: input.batchNo,
      }),
      filename: `${purchaseDate}_${safeFilePart(supplierName)}_매입명세표.xlsx`,
    };
  }

  return {
    buffer: buildJungabiWorkbook(rows),
    filename: `중가비대량등록_${compactDateForFilename(
      purchaseDate
    )}_${jungabiBatchLabel(input.batchNo, rows)}.xlsx`,
  };
}
