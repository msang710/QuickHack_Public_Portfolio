// QuickHack note: 기능 검수 행의 대부분이 직접 편집 대상이라 전용 표 컴포넌트로 분리합니다.
"use client";

import { useTranslations } from "next-intl";

import { Badge } from "@/quickhack_client/components/ui/badge";
import { Input } from "@/quickhack_client/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/quickhack_client/components/ui/table";
import { SearchCombobox } from "@/quickhack_client/components/inspection/inspection-input-controls";
import {
  hasActualDefectText,
  normalizeFirstCallDate,
  normalizeInspectionField,
} from "@/quickhack_shared/inspection/inspection-schema";
import {
  getStorageOptionsForProduct,
  type ProductCriteriaPayload,
} from "@/quickhack_shared/catalog/product-criteria";
import { cn } from "@/quickhack_shared/core/utils";

// QuickHack object: 기능 검수 표의 한 행 상태이며 ADB 연결 행과 수동 행을 모두 표현합니다.
export type FunctionRow = {
  id: string;
  serial: string;
  connectionState: string;
  product: string;
  csc: string;
  storage: string;
  firstCallDate: string;
  account: string;
  accountStatus?: "UNKNOWN" | "NONE" | "PRESENT" | "QUERY_FAILED";
  cameraCheck: string;
  warning: string;
  warningCodes?: Array<
    | "CARRIER_REVIEW"
    | "ACCOUNT_REVIEW"
    | "ACCOUNT_QUERY_FAILED"
    | "ADB_OFFLINE"
    | "ADB_UNAUTHORIZED"
    | "ADB_CONNECTION_UNKNOWN"
    | "ADB_QUERY_FAILED"
  >;
  warningDetail?: string | null;
  pg: string;
  imei: string;
  functionDefect: string;
  returnYn: "Y" | "N";
};

// QuickHack object: 기준값 payload를 빠른 검증용 Set/Map으로 변환한 런타임 캐시입니다.
export type ProductCriteriaRuntime = {
  productValues: ReadonlySet<string>;
  carrierValues: ReadonlySet<string>;
  storageValues: ReadonlySet<string>;
  storageValuesByProduct: ReadonlyMap<string, ReadonlySet<string>>;
  colorValues: ReadonlySet<string>;
};

type FunctionInspectionEditTableProps = {
  functionRows: FunctionRow[];
  selectedFunctionRowId: string;
  productCriteria: ProductCriteriaPayload;
  criteriaRuntime: ProductCriteriaRuntime;
  setSelectedFunctionRowId: (rowId: string) => void;
  updateFunctionRow: (rowId: string, patch: Partial<FunctionRow>) => void;
  cameraCheckForProduct: (product: string) => string;
};

export function isOptionValue(value: string, options: ReadonlySet<string>) {
  return options.has(value.trim());
}

export function storageValuesForProduct(
  criteriaRuntime: ProductCriteriaRuntime,
  product: string
) {
  const productKey = product.trim();

  return (
    criteriaRuntime.storageValuesByProduct.get(productKey) ??
    criteriaRuntime.storageValues
  );
}

type EditTableTranslator = ReturnType<typeof useTranslations<"inspection.editTable">>;

function adbStateBadge(connectionState: string, t: EditTableTranslator) {
  if (connectionState === "device") {
    return <Badge variant="success">{t("connected")}</Badge>;
  }

  if (connectionState === "offline") {
    return <Badge variant="warning">{t("offline")}</Badge>;
  }

  if (connectionState === "unauthorized") {
    return <Badge variant="danger">{t("unauthorized")}</Badge>;
  }

  if (connectionState === "manual") {
    return <Badge variant="neutral">{t("manual")}</Badge>;
  }

  if (connectionState === "disconnected") {
    return <Badge variant="warning">{t("disconnected")}</Badge>;
  }

  return <Badge variant="warning">{connectionState || "-"}</Badge>;
}

function adbAccountText(row: FunctionRow, t: EditTableTranslator) {
  if (row.accountStatus === "NONE") return t("account.none");
  if (row.accountStatus === "PRESENT") return t("account.present");
  if (row.accountStatus === "QUERY_FAILED") return t("account.queryFailed");
  return row.account || t("unconnected");
}

function adbWarningText(row: FunctionRow, t: EditTableTranslator) {
  const codes = row.warningCodes ?? [];
  if (codes.length === 0) {
    return row.warning || "-";
  }

  return codes
    .map((code) => {
      if (code === "CARRIER_REVIEW") return t("warning.carrierReview");
      if (code === "ACCOUNT_REVIEW") return t("warning.accountReview");
      if (code === "ACCOUNT_QUERY_FAILED") return t("warning.accountQueryFailed");
      if (code === "ADB_OFFLINE") return t("warning.adbOffline");
      if (code === "ADB_UNAUTHORIZED") return t("warning.adbUnauthorized");
      if (code === "ADB_QUERY_FAILED") {
        return t("warning.adbQueryFailed", { detail: row.warningDetail ?? "-" });
      }
      return t("warning.adbConnectionUnknown", {
        state: row.warningDetail ?? "unknown",
      });
    })
    .join("\n");
}

function adbRowHasWarning(row: FunctionRow) {
  return (row.warningCodes?.length ?? 0) > 0 || Boolean(row.warning);
}

function isManualFunctionRow(row: FunctionRow) {
  return row.connectionState === "manual";
}

// QuickHack object: 기능 검수 행의 대부분이 직접 편집 대상이라 목록형 그리드와 분리한 전용 편집 표입니다.
export function FunctionInspectionEditTable({
  functionRows,
  selectedFunctionRowId,
  productCriteria,
  criteriaRuntime,
  setSelectedFunctionRowId,
  updateFunctionRow,
  cameraCheckForProduct,
}: FunctionInspectionEditTableProps) {
  const t = useTranslations("inspection.editTable");

  return (
    <div className="min-w-[1660px]">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-secondary">
          <TableRow>
            <TableHead className="w-[70px]">{t("columns.number")}</TableHead>
            <TableHead className="w-[150px]">{t("columns.adbSerial")}</TableHead>
            <TableHead className="w-[100px]">{t("columns.status")}</TableHead>
            <TableHead className="w-[160px]">{t("columns.product")}</TableHead>
            <TableHead className="w-[110px]">{t("columns.carrier")}</TableHead>
            <TableHead className="w-[110px]">{t("columns.storage")}</TableHead>
            <TableHead className="w-[130px]">{t("columns.firstCallDate")}</TableHead>
            <TableHead className="w-[100px]">{t("columns.account")}</TableHead>
            <TableHead className="w-[170px]">{t("columns.cameraCheck")}</TableHead>
            <TableHead className="w-[170px]">{t("columns.warning")}</TableHead>
            <TableHead className="w-[170px]">PG</TableHead>
            <TableHead className="w-[180px]">IMEI</TableHead>
            <TableHead className="w-[230px]">{t("columns.functionDefect")}</TableHead>
            <TableHead className="w-[100px]">{t("columns.supplierReturn")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {functionRows.map((row, index) => (
            <TableRow
              key={row.id}
              className={cn(
                "cursor-pointer",
                selectedFunctionRowId === row.id && "bg-secondary"
              )}
              onClick={() => setSelectedFunctionRowId(row.id)}
            >
              <TableCell>{index + 1}</TableCell>
              <TableCell className="font-mono text-xs">
                {isManualFunctionRow(row) ? (
                  <Badge variant="neutral" className="font-sans">
                    {t("manual")}
                  </Badge>
                ) : (
                  row.serial || "-"
                )}
              </TableCell>
              <TableCell>{adbStateBadge(row.connectionState, t)}</TableCell>
              <TableCell>
                <SearchCombobox
                  value={row.product}
                  options={productCriteria.products}
                  isValidValue={(value) =>
                    isOptionValue(value, criteriaRuntime.productValues)
                  }
                  placeholder={t("placeholders.product")}
                  searchPlaceholder={t("placeholders.productSearch")}
                  onValueChange={(product) => {
                    updateFunctionRow(row.id, {
                      product,
                      cameraCheck: cameraCheckForProduct(product),
                    });
                  }}
                />
              </TableCell>
              <TableCell>
                <Select
                  value={
                    isOptionValue(row.csc, criteriaRuntime.carrierValues)
                      ? row.csc
                      : ""
                  }
                  onValueChange={(value) =>
                    updateFunctionRow(row.id, {
                      csc: value,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("placeholders.carrier")} />
                  </SelectTrigger>
                  <SelectContent>
                    {productCriteria.carriers.map((carrier) => (
                      <SelectItem key={carrier} value={carrier}>
                        {carrier}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell>
                {(() => {
                  const storageOptions = getStorageOptionsForProduct(
                    productCriteria,
                    row.product
                  );
                  const storageValues = storageValuesForProduct(
                    criteriaRuntime,
                    row.product
                  );

                  return (
                    <Select
                      value={
                        isOptionValue(row.storage, storageValues)
                          ? row.storage
                          : ""
                      }
                      onValueChange={(value) =>
                        updateFunctionRow(row.id, {
                          storage: value,
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t("placeholders.storage")} />
                      </SelectTrigger>
                      <SelectContent>
                        {storageOptions.map((storage) => (
                          <SelectItem key={storage} value={storage}>
                            {storage}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  );
                })()}
              </TableCell>
              <TableCell>
                <Input
                  value={row.firstCallDate}
                  onChange={(event) =>
                    updateFunctionRow(row.id, {
                      firstCallDate: event.target.value,
                    })
                  }
                  onBlur={() => {
                    const normalized = normalizeFirstCallDate(row.firstCallDate);

                    if (normalized) {
                      updateFunctionRow(row.id, {
                        firstCallDate: normalized,
                      });
                    }
                  }}
                />
              </TableCell>
              <TableCell>
                <div className="flex min-h-9 items-center whitespace-nowrap rounded-md border border-transparent px-2 py-2 text-sm">
                  {isManualFunctionRow(row) ? (
                    <Badge variant="neutral">{t("manual")}</Badge>
                  ) : (
                    adbAccountText(row, t)
                  )}
                </div>
              </TableCell>
              <TableCell>
                <div className="min-h-9 whitespace-pre-wrap rounded-md border border-transparent px-3 py-2 text-sm">
                  {row.cameraCheck || "-"}
                </div>
              </TableCell>
              <TableCell
                className={cn(
                  "whitespace-pre-wrap text-xs",
                  adbRowHasWarning(row) && "font-semibold text-red-600"
                )}
              >
                {adbWarningText(row, t)}
              </TableCell>
              <TableCell>
                <Input
                  value={row.pg}
                  onChange={(event) =>
                    updateFunctionRow(row.id, {
                      pg: event.target.value.toUpperCase(),
                    })
                  }
                  onBlur={() =>
                    updateFunctionRow(row.id, {
                      pg: normalizeInspectionField("PG", row.pg),
                    })
                  }
                />
              </TableCell>
              <TableCell>
                <Input
                  value={row.imei}
                  onChange={(event) =>
                    updateFunctionRow(row.id, {
                      imei: event.target.value,
                    })
                  }
                  onBlur={() =>
                    updateFunctionRow(row.id, {
                      imei: normalizeInspectionField("IMEI", row.imei),
                    })
                  }
                />
              </TableCell>
              <TableCell>
                <Input
                  value={row.functionDefect}
                  onChange={(event) =>
                    updateFunctionRow(row.id, {
                      functionDefect: event.target.value,
                      returnYn: hasActualDefectText(event.target.value)
                        ? "Y"
                        : "N",
                    })
                  }
                />
              </TableCell>
              <TableCell>
                <Select
                  value={row.returnYn}
                  onValueChange={(value) =>
                    updateFunctionRow(row.id, {
                      returnYn: value as "Y" | "N",
                    })
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
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
