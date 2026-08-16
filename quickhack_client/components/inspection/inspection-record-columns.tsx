"use client";

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import { TableSelectCheckbox } from "@/quickhack_client/components/ui/table-select-checkbox";
import type { DataGridColumn } from "@/quickhack_client/components/ui/virtualized-data-grid";
import { statusBadge } from "@/quickhack_client/components/inspection/inspection-status-ui";
import {
  CLIENT_RECORD_ID,
  UPLOAD_STATUS_COLUMN,
  type InspectionRecordWithStatus,
} from "@/quickhack_shared/inspection/inspection-schema";

type RecordSelectionState = {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
};

type SelectableRecordColumnOptions = {
  renderSelectionCell: (record: InspectionRecordWithStatus) => React.ReactNode;
  setVisibleRecordsSelected: (
    records: InspectionRecordWithStatus[],
    checked: boolean
  ) => void;
  visibleRecordSelectionState: (
    records: InspectionRecordWithStatus[]
  ) => RecordSelectionState;
};

export function useAppearanceHistoryColumns({
  updateAppearanceReturnYn,
}: {
  updateAppearanceReturnYn: (recordId: string, value: "Y" | "N") => void;
}) {
  return React.useMemo<
    DataGridColumn<
      | "pg"
      | "color"
      | "grade"
      | "defect"
      | "returnYn"
      | "worker"
      | "inspectedAt",
      InspectionRecordWithStatus
    >[]
  >(
    () => [
      {
        key: "pg",
        label: "PG",
        width: "180px",
        placeholder: "PG",
        cellClassName: "flex items-center px-3 font-semibold",
        render: (record) => record.PG,
        text: (record) => record.PG,
      },
      {
        key: "color",
        label: "공식 색상명",
        width: "140px",
        placeholder: "색상",
        cellClassName: "flex items-center px-3",
        render: (record) => record.기기색상 || "-",
        text: (record) => record.기기색상 || "",
      },
      {
        key: "grade",
        label: "외관등급",
        width: "110px",
        placeholder: "등급",
        cellClassName: "flex items-center px-3",
        render: (record) => record.외관등급 || "-",
        text: (record) => record.외관등급 || "",
      },
      {
        key: "defect",
        label: "외관하자",
        width: "minmax(220px,1fr)",
        placeholder: "하자",
        cellClassName: "min-w-0 px-3 py-2",
        render: (record) => (
          <div className="truncate" title={record.외관하자 || undefined}>
            {record.외관하자 || "-"}
          </div>
        ),
        text: (record) => record.외관하자 || "",
      },
      {
        key: "returnYn",
        label: "매입처 반품",
        width: "120px",
        placeholder: "Y/N",
        cellClassName: "flex items-center px-3",
        render: (record) => (
          <Select
            value={(record.매입처반품유무 || "N") as "Y" | "N"}
            onValueChange={(value) =>
              updateAppearanceReturnYn(
                record[CLIENT_RECORD_ID],
                value as "Y" | "N"
              )
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="N">N</SelectItem>
              <SelectItem value="Y">Y</SelectItem>
            </SelectContent>
          </Select>
        ),
        text: (record) => record.매입처반품유무 || "N",
      },
      {
        key: "worker",
        label: "작업자",
        width: "120px",
        placeholder: "작업자",
        cellClassName: "flex items-center px-3",
        render: (record) => record.외관검수자 || "-",
        text: (record) => record.외관검수자 || "",
      },
      {
        key: "inspectedAt",
        label: "검수일시",
        width: "170px",
        placeholder: "검수일시",
        cellClassName: "flex items-center px-3",
        render: (record) => record.외관검수일시 || "-",
        text: (record) => record.외관검수일시 || "",
      },
    ],
    [updateAppearanceReturnYn]
  );
}

export function useAppearancePendingColumns({
  renderSelectionCell,
  setVisibleRecordsSelected,
  visibleRecordSelectionState,
}: SelectableRecordColumnOptions) {
  return React.useMemo<
    DataGridColumn<
      | "select"
      | "pg"
      | "color"
      | "grade"
      | "defect"
      | "returnYn"
      | "batchNo"
      | "worker"
      | "inspectedAt"
      | "uploadStatus",
      InspectionRecordWithStatus
    >[]
  >(
    () => [
      {
        key: "select",
        label: "",
        headerRender: ({ displayRows }) => {
          const selectionState = visibleRecordSelectionState(displayRows);

          return (
            <TableSelectCheckbox
              checked={selectionState.checked}
              indeterminate={selectionState.indeterminate}
              disabled={selectionState.disabled}
              ariaLabel="외관 검수 대기 행 전체 선택 또는 해제"
              onCheckedChange={(checked) =>
                setVisibleRecordsSelected(displayRows, checked)
              }
            />
          );
        },
        width: "54px",
        sortable: false,
        filterable: false,
        headerClassName: "justify-center",
        cellClassName: "flex items-center justify-center",
        render: renderSelectionCell,
      },
      {
        key: "pg",
        label: "PG",
        width: "180px",
        cellClassName: "flex items-center px-3 font-mono text-xs",
        render: (record) => record.PG || "-",
        text: (record) => record.PG || "",
      },
      {
        key: "color",
        label: "공식 색상명",
        width: "130px",
        cellClassName: "flex items-center px-3",
        render: (record) => record.기기색상 || "-",
        text: (record) => record.기기색상 || "",
      },
      {
        key: "grade",
        label: "외관등급",
        width: "100px",
        cellClassName: "flex items-center px-3",
        render: (record) => record.외관등급 || "-",
        text: (record) => record.외관등급 || "",
      },
      {
        key: "defect",
        label: "외관하자",
        width: "minmax(240px,1fr)",
        cellClassName: "min-w-0 px-3 py-2",
        render: (record) => (
          <div className="truncate" title={record.외관하자 || undefined}>
            {record.외관하자 || "-"}
          </div>
        ),
        text: (record) => record.외관하자 || "",
      },
      {
        key: "returnYn",
        label: "매입처 반품",
        width: "110px",
        cellClassName: "flex items-center px-3",
        render: (record) => record.매입처반품유무 || "N",
        text: (record) => record.매입처반품유무 || "N",
      },
      {
        key: "batchNo",
        label: "차수",
        width: "90px",
        cellClassName: "flex items-center px-3",
        render: (record) => record.차수 || "-",
        text: (record) => record.차수 || "",
      },
      {
        key: "worker",
        label: "작업자",
        width: "120px",
        cellClassName: "flex items-center px-3",
        render: (record) => record.외관검수자 || "-",
        text: (record) => record.외관검수자 || "",
      },
      {
        key: "inspectedAt",
        label: "검수일시",
        width: "170px",
        cellClassName: "flex items-center px-3",
        render: (record) => record.외관검수일시 || "-",
        text: (record) => record.외관검수일시 || "",
      },
      {
        key: "uploadStatus",
        label: "업로드상태",
        width: "120px",
        cellClassName: "flex items-center px-3",
        render: (record) => statusBadge(record[UPLOAD_STATUS_COLUMN]),
        text: (record) => record[UPLOAD_STATUS_COLUMN] || "",
      },
    ],
    [
      renderSelectionCell,
      setVisibleRecordsSelected,
      visibleRecordSelectionState,
    ]
  );
}

export function useFunctionPendingColumns({
  renderSelectionCell,
  setVisibleRecordsSelected,
  visibleRecordSelectionState,
}: SelectableRecordColumnOptions) {
  return React.useMemo<
    DataGridColumn<
      | "select"
      | "pg"
      | "imei"
      | "product"
      | "carrier"
      | "storage"
      | "firstCallDate"
      | "functionDefect"
      | "returnYn"
      | "worker"
      | "inspectedAt"
      | "uploadStatus",
      InspectionRecordWithStatus
    >[]
  >(
    () => [
      {
        key: "select",
        label: "",
        headerRender: ({ displayRows }) => {
          const selectionState = visibleRecordSelectionState(displayRows);

          return (
            <TableSelectCheckbox
              checked={selectionState.checked}
              indeterminate={selectionState.indeterminate}
              disabled={selectionState.disabled}
              ariaLabel="기능 검수 대기 행 전체 선택 또는 해제"
              onCheckedChange={(checked) =>
                setVisibleRecordsSelected(displayRows, checked)
              }
            />
          );
        },
        width: "54px",
        sortable: false,
        filterable: false,
        headerClassName: "justify-center",
        cellClassName: "flex items-center justify-center",
        render: renderSelectionCell,
      },
      {
        key: "pg",
        label: "PG",
        width: "170px",
        cellClassName: "flex items-center px-3 font-mono text-xs",
        render: (record) => record.PG || "-",
        text: (record) => record.PG || "",
      },
      {
        key: "imei",
        label: "IMEI",
        width: "180px",
        cellClassName: "flex items-center px-3 font-mono text-xs",
        render: (record) => record.IMEI || "-",
        text: (record) => record.IMEI || "",
      },
      {
        key: "product",
        label: "제품명",
        width: "160px",
        cellClassName: "flex items-center px-3",
        render: (record) => record.제품명 || "-",
        text: (record) => record.제품명 || "",
      },
      {
        key: "carrier",
        label: "통신사",
        width: "100px",
        cellClassName: "flex items-center px-3",
        render: (record) => record.통신사 || "-",
        text: (record) => record.통신사 || "",
      },
      {
        key: "storage",
        label: "저장공간",
        width: "110px",
        cellClassName: "flex items-center px-3",
        render: (record) => record.저장공간 || "-",
        text: (record) => record.저장공간 || "",
      },
      {
        key: "firstCallDate",
        label: "최초통화일",
        width: "130px",
        cellClassName: "flex items-center px-3",
        render: (record) => record.최초통화일 || "-",
        text: (record) => record.최초통화일 || "",
      },
      {
        key: "functionDefect",
        label: "기능하자",
        width: "minmax(260px,1fr)",
        cellClassName: "min-w-0 px-3 py-2",
        render: (record) => (
          <div className="truncate" title={record.기능하자 || undefined}>
            {record.기능하자 || "-"}
          </div>
        ),
        text: (record) => record.기능하자 || "",
      },
      {
        key: "returnYn",
        label: "매입처 반품",
        width: "110px",
        cellClassName: "flex items-center px-3",
        render: (record) => record.매입처반품유무 || "N",
        text: (record) => record.매입처반품유무 || "N",
      },
      {
        key: "worker",
        label: "작업자",
        width: "120px",
        cellClassName: "flex items-center px-3",
        render: (record) => record.기능검수자 || "-",
        text: (record) => record.기능검수자 || "",
      },
      {
        key: "inspectedAt",
        label: "검수일시",
        width: "170px",
        cellClassName: "flex items-center px-3",
        render: (record) => record.기능검수일시 || "-",
        text: (record) => record.기능검수일시 || "",
      },
      {
        key: "uploadStatus",
        label: "업로드상태",
        width: "120px",
        cellClassName: "flex items-center px-3",
        render: (record) => statusBadge(record[UPLOAD_STATUS_COLUMN]),
        text: (record) => record[UPLOAD_STATUS_COLUMN] || "",
      },
    ],
    [
      renderSelectionCell,
      setVisibleRecordsSelected,
      visibleRecordSelectionState,
    ]
  );
}
