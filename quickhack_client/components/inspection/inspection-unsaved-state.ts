import type { FunctionRow } from "@/quickhack_client/components/inspection/function-inspection-edit-table";
import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";
import {
  UPLOAD_STATUSES,
  UPLOAD_STATUS_COLUMN,
  type InspectionRecordWithStatus,
} from "@/quickhack_shared/inspection/inspection-schema";

export type AppearanceDraftSnapshot = {
  batchNo: string;
  pg: string;
  color: string;
  grade: string;
  defectText: string;
};

export type FunctionRowDraftSnapshot = {
  id: string;
  product: string;
  csc: string;
  storage: string;
  firstCallDate: string;
  pg: string;
  imei: string;
  functionDefect: string;
  returnYn: "Y" | "N";
};

export type FunctionRowDraftBaselines = Record<
  string,
  FunctionRowDraftSnapshot
>;

function normalizedText(value: unknown) {
  return String(value ?? "").trim();
}

export function createAppearanceDraftSnapshot({
  batchNo,
  pg,
  color,
  grade,
  defectText,
}: AppearanceDraftSnapshot): AppearanceDraftSnapshot {
  return {
    batchNo: normalizedText(batchNo),
    pg: normalizedText(pg).toUpperCase(),
    color: normalizedText(color),
    grade: normalizedText(grade),
    defectText: normalizedText(defectText),
  };
}

export function appearanceDraftSnapshotsEqual(
  baseline: AppearanceDraftSnapshot,
  current: AppearanceDraftSnapshot
) {
  return unsavedFormSnapshotsEqual(baseline, current);
}

export function createFunctionRowDraftSnapshot(
  row: FunctionRow
): FunctionRowDraftSnapshot {
  return {
    id: row.id,
    product: normalizedText(row.product),
    csc: normalizedText(row.csc),
    storage: normalizedText(row.storage),
    firstCallDate: normalizedText(row.firstCallDate),
    pg: normalizedText(row.pg).toUpperCase(),
    imei: normalizedText(row.imei),
    functionDefect: normalizedText(row.functionDefect),
    returnYn: row.returnYn === "Y" ? "Y" : "N",
  };
}

export function isFunctionRowDraftEmpty(
  snapshot: FunctionRowDraftSnapshot
) {
  return (
    !snapshot.product &&
    !snapshot.csc &&
    !snapshot.storage &&
    !snapshot.firstCallDate &&
    !snapshot.pg &&
    !snapshot.imei &&
    !snapshot.functionDefect &&
    snapshot.returnYn === "N"
  );
}

export function createFunctionRowDraftBaselines(
  rows: readonly FunctionRow[]
): FunctionRowDraftBaselines {
  return Object.fromEntries(
    rows
      .map((row) => ({
        row,
        snapshot: createFunctionRowDraftSnapshot(row),
      }))
      .filter(
        ({ row, snapshot }) =>
          Boolean(row.serial.trim()) || !isFunctionRowDraftEmpty(snapshot)
      )
      .map(({ snapshot }) => [snapshot.id, snapshot])
  );
}

export function advanceFunctionRowDraftBaseline(
  baselines: FunctionRowDraftBaselines,
  row: FunctionRow
): FunctionRowDraftBaselines {
  const snapshot = createFunctionRowDraftSnapshot(row);

  return {
    ...baselines,
    [snapshot.id]: snapshot,
  };
}

export function isFunctionDraftDirty({
  rows,
  baselines,
  selectedDefectText,
}: {
  rows: readonly FunctionRow[];
  baselines: FunctionRowDraftBaselines;
  selectedDefectText: string;
}) {
  if (normalizedText(selectedDefectText)) {
    return true;
  }

  return rows.some((row) => {
    const current = createFunctionRowDraftSnapshot(row);
    const baseline = baselines[current.id];

    if (!baseline) {
      return !isFunctionRowDraftEmpty(current);
    }

    return !unsavedFormSnapshotsEqual(baseline, current);
  });
}

export function restoreFunctionRowsFromBaselines(
  rows: readonly FunctionRow[],
  baselines: FunctionRowDraftBaselines
) {
  return rows.flatMap((row) => {
    const baseline = baselines[row.id];
    if (baseline) {
      return [
        {
          ...row,
          product: baseline.product,
          csc: baseline.csc,
          storage: baseline.storage,
          firstCallDate: baseline.firstCallDate,
          pg: baseline.pg,
          imei: baseline.imei,
          functionDefect: baseline.functionDefect,
          returnYn: baseline.returnYn,
        },
      ];
    }

    const current = createFunctionRowDraftSnapshot(row);
    return isFunctionRowDraftEmpty(current) ? [row] : [];
  });
}

export function hasPendingInspectionRecords(
  records: readonly InspectionRecordWithStatus[]
) {
  return records.some(
    (record) => record[UPLOAD_STATUS_COLUMN] !== UPLOAD_STATUSES.done
  );
}

export function discardPendingInspectionRecords(
  records: readonly InspectionRecordWithStatus[]
) {
  return records.filter(
    (record) => record[UPLOAD_STATUS_COLUMN] === UPLOAD_STATUSES.done
  );
}
