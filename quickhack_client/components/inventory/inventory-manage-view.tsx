// QuickHack note: 재고 추가 / 삭제 메뉴의 수동 재고 생성과 민감 삭제 작업 UI입니다.
"use client";

import * as React from "react";
import { PackagePlus, Save, Trash2 } from "lucide-react";
import type { StatusTone } from "@/quickhack_shared/device/types";
import type { DeviceListRow } from "@/quickhack_shared/device/device-list-query";
import {
  DEVICE_WARRANTY_OPTIONS,
  formatModelSeqLabel,
} from "@/quickhack_shared/device/types";
import type { ProductCriteriaPayload } from "@/quickhack_shared/catalog/product-criteria";
import type { ProductCriteriaCategory } from "@/quickhack_shared/catalog/product-criteria";
import { GRADE_OPTIONS } from "@/quickhack_shared/inspection/inspection-schema";
import { INBOUND_STATUS } from "@/quickhack_shared/inbound/inbound-status";
import {
  INVENTORY_STATUS,
  INVENTORY_STATUS_LABELS,
  type InventoryStatusCode,
} from "@/quickhack_shared/inventory/inventory-status";
import { MANUAL_INVENTORY_INITIAL_STATUSES } from "@/quickhack_shared/inventory/inventory-write-rules";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { Input } from "@/quickhack_client/components/ui/input";
import { SaleGradeBadge } from "@/quickhack_client/components/ui/sale-grade-badge";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/quickhack_client/components/ui/tabs";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import {
  InventoryEditField,
  InventoryEditSection,
  type InventoryEditFieldMode,
  type InventoryEditOption,
} from "@/quickhack_client/components/inventory/inventory-edit-fields";
import { buildInventoryCorrectionOptionSets } from "@/quickhack_client/components/inventory/inventory-correction-records";
import {
  statusBadge,
  statusMap,
} from "@/quickhack_client/components/shared/device-detail-sheet";
import {
  DangerousConfirmDialog,
  dangerousActionButtonClassName,
} from "@/quickhack_client/components/security/sensitive-action-guards";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";
import { POST_WRITE_REFRESH_WARNING } from "@/quickhack_client/lib/post-write-refresh";
import { useDeviceListQuery } from "@/quickhack_client/components/shared/device-list-query-client";

type InventoryManageApiResponse = {
  ok: boolean;
  message?: string;
};

type ProductCriteriaApiResponse = {
  ok: boolean;
  message?: string;
  data?: ProductCriteriaPayload;
};

type InventoryCreateForm = {
  pgNo: string;
  imei: string;
  adbSerial: string;
  model: string;
  modelCode: string;
  modelSeq: string;
  storage: string;
  color: string;
  saleGrade: string;
  warranty: string;
  batchNo: string;
  supplierName: string;
  purchasePrice: string;
  receivedAt: string;
  priceAgreedAt: string;
  inboundNote: string;
  inventoryStatus: string;
  location: string;
  stockedAt: string;
  reason: string;
  appearanceGrade: string;
  appearanceDefect: string;
  appearanceReturnYn: string;
  appearanceWorker: string;
  appearanceCheckedAt: string;
  appearanceNote: string;
  functionDefect: string;
  functionReturnYn: string;
  csc: string;
  firstCallDate: string;
  functionWorker: string;
  functionCheckedAt: string;
  functionNote: string;
};

type DeleteColumnKey =
  | "pgNo"
  | "model"
  | "modelSeq"
  | "imei"
  | "saleGrade"
  | "status"
  | "batchNo"
  | "supplierName"
  | "location"
  | "delete";

const SALE_GRADE_OPTIONS = ["A", "A-", "B+", "B"];
const DEFAULT_INVENTORY_LOCATION = "상품화 대기";
const INVENTORY_CREATE_FORM_ID = "inventory.manage-create";
const INVENTORY_DELETE_FORM_ID = "inventory.manage-delete";

const SALE_GRADE_EDIT_OPTIONS = optionList(SALE_GRADE_OPTIONS);
const APPEARANCE_GRADE_EDIT_OPTIONS = optionList(GRADE_OPTIONS);
const WARRANTY_EDIT_OPTIONS = optionList(DEVICE_WARRANTY_OPTIONS);
const INVENTORY_STATUS_EDIT_OPTIONS = Object.entries(INVENTORY_STATUS_LABELS)
  .filter(([value]) =>
    MANUAL_INVENTORY_INITIAL_STATUSES.has(value as InventoryStatusCode)
  )
  .map(([value, label]) => ({ value, label }));
const RETURN_YN_OPTIONS = [
  { value: "N", label: "N" },
  { value: "Y", label: "Y" },
];

function optionList(values: readonly string[]): InventoryEditOption[] {
  return values.map((value) => ({ value, label: value }));
}

function criteriaOptionList(
  criteria: ProductCriteriaPayload | null,
  category: ProductCriteriaCategory
): InventoryEditOption[] {
  if (!criteria) {
    return [];
  }

  return criteria.rawOptions
    .filter(
      (option) =>
        option.isActive &&
        option.category === category &&
        option.label.trim() !== ""
    )
    .map((option) => option.label.trim())
    .filter((value, index, list) => list.indexOf(value) === index)
    .sort((a, b) => a.localeCompare(b, "ko-KR"))
    .map((value) => ({ value, label: value }));
}

function emptyCreateForm(): InventoryCreateForm {
  return {
    pgNo: "",
    imei: "",
    adbSerial: "",
    model: "",
    modelCode: "",
    modelSeq: "",
    storage: "",
    color: "",
    saleGrade: "",
    warranty: "",
    batchNo: "",
    supplierName: "",
    purchasePrice: "",
    receivedAt: "",
    priceAgreedAt: "",
    inboundNote: "",
    inventoryStatus: INVENTORY_STATUS.sellable,
    location: DEFAULT_INVENTORY_LOCATION,
    stockedAt: "",
    reason: "",
    appearanceGrade: "",
    appearanceDefect: "",
    appearanceReturnYn: "N",
    appearanceWorker: "",
    appearanceCheckedAt: "",
    appearanceNote: "",
    functionDefect: "",
    functionReturnYn: "N",
    csc: "",
    firstCallDate: "",
    functionWorker: "",
    functionCheckedAt: "",
    functionNote: "",
  };
}

function deleteColumnText(device: DeviceListRow, key: DeleteColumnKey) {
  switch (key) {
    case "pgNo":
      return device.pgNo;
    case "model":
      return [device.model, device.storage, device.color].filter(Boolean).join(" ");
    case "modelSeq":
      return formatModelSeqLabel(device.model, device.modelSeq);
    case "imei":
      return device.imei;
    case "saleGrade":
      return device.saleGrade;
    case "status":
      return statusMap[device.displayStatus]?.label ?? device.displayStatus;
    case "batchNo":
      return device.inbound?.batchNo;
    case "supplierName":
      return device.inbound?.supplierName;
    case "location":
      return device.inventory?.location;
    case "delete":
      return "";
  }
}

function formValue(value: unknown) {
  return String(value ?? "").trim();
}

function requiredCreateFields(form: InventoryCreateForm) {
  return [
    ["PG", form.pgNo],
    ["모델", form.model],
    ["추가 사유", form.reason],
  ] as const;
}

export function InventoryManageView() {
  const [activeTab, setActiveTab] = React.useState("add");
  const [criteria, setCriteria] = React.useState<ProductCriteriaPayload | null>(
    null
  );
  const [createForm, setCreateForm] = React.useState<InventoryCreateForm>(
    emptyCreateForm
  );
  const [deleteQuery, setDeleteQuery] = React.useState("");
  const [deleteTarget, setDeleteTarget] = React.useState<DeviceListRow | null>(
    null
  );
  const [deleteReason, setDeleteReason] = React.useState("");
  const [savingAction, setSavingAction] = React.useState<
    "create" | "delete" | null
  >(null);
  const [message, setMessage] = React.useState("");
  const [messageTone, setMessageTone] = React.useState<StatusTone>("neutral");
  const [postWriteRefreshWarning, setPostWriteRefreshWarning] =
    React.useState("");
  const { runGuardedAction } = useUnsavedChanges();
  const isSaving = savingAction !== null;
  const deferredDeleteQuery = React.useDeferredValue(deleteQuery);
  const listQueryString = React.useMemo(() => {
    const params = new URLSearchParams({
      context: "INVENTORY",
      inventoryOnly: "true",
      limit: "100",
    });
    if (activeTab === "delete" && deferredDeleteQuery.trim()) {
      params.set("q", deferredDeleteQuery.trim());
    }
    return params.toString();
  }, [activeTab, deferredDeleteQuery]);
  const deviceList = useDeviceListQuery({
    endpoint: "/api/inventory/devices",
    queryString: listQueryString,
    autoLoadAll: true,
  });
  const devices = deviceList.items;

  const discardCreateDraft = React.useCallback(() => {
    setCreateForm(emptyCreateForm());
    setMessage("");
    setPostWriteRefreshWarning("");
  }, []);
  const discardDeleteDraft = React.useCallback(() => {
    setDeleteTarget(null);
    setDeleteReason("");
    setMessage("");
    setPostWriteRefreshWarning("");
  }, []);

  useUnsavedForm({
    id: INVENTORY_CREATE_FORM_ID,
    label: "재고 추가",
    isDirty: !unsavedFormSnapshotsEqual(emptyCreateForm(), createForm),
    isBusy: savingAction === "create",
    discard: discardCreateDraft,
  });
  useUnsavedForm({
    id: INVENTORY_DELETE_FORM_ID,
    label: deleteTarget ? `${deleteTarget.pgNo} 재고 삭제` : "재고 삭제",
    enabled: Boolean(deleteTarget),
    isDirty: deleteReason.trim().length > 0,
    isBusy: savingAction === "delete",
    discard: discardDeleteDraft,
  });

  React.useEffect(() => {
    let ignore = false;

    async function loadCriteria() {
      try {
        const response = await fetch("/api/product-criteria", {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as
          | ProductCriteriaApiResponse
          | null;

        if (!ignore && response.ok && payload?.ok && payload.data) {
          setCriteria(payload.data);
        }
      } catch {
        if (!ignore) {
          setCriteria(null);
        }
      }
    }

    void loadCriteria();

    return () => {
      ignore = true;
    };
  }, []);

  const optionSets = React.useMemo(
    () => buildInventoryCorrectionOptionSets(criteria, devices),
    [criteria, devices]
  );
  const appearanceDefectOptions = React.useMemo(
    () => criteriaOptionList(criteria, "APPEARANCE_DEFECT"),
    [criteria]
  );
  const functionDefectOptions = React.useMemo(
    () => criteriaOptionList(criteria, "FUNCTION_DEFECT"),
    [criteria]
  );
  const carrierOptions = React.useMemo(
    () => criteriaOptionList(criteria, "CARRIER"),
    [criteria]
  );
  const filteredDeleteRows = devices;

  const deleteColumns = React.useMemo<
    DataGridColumn<DeleteColumnKey, DeviceListRow>[]
  >(
    () => [
      {
        key: "pgNo",
        label: "PG",
        width: "150px",
        placeholder: "PG 검색",
        text: (device) => deleteColumnText(device, "pgNo"),
        cellClassName: "flex items-center px-3 font-semibold",
        render: (device) => device.pgNo,
      },
      {
        key: "model",
        label: "모델",
        width: "minmax(240px,1fr)",
        placeholder: "기종/용량/색상",
        text: (device) => deleteColumnText(device, "model"),
        cellClassName: "min-w-0 px-3 py-2",
        render: (device) => (
          <>
            <div className="font-medium">{device.model}</div>
            <div className="text-xs text-muted-foreground">
              {[device.storage, device.color].filter(Boolean).join(" / ") ||
                "-"}
            </div>
          </>
        ),
      },
      {
        key: "modelSeq",
        label: "고유번호",
        width: "130px",
        placeholder: "S24-345",
        text: (device) => deleteColumnText(device, "modelSeq"),
        cellClassName: "flex items-center px-3",
        render: (device) => formatModelSeqLabel(device.model, device.modelSeq),
      },
      {
        key: "imei",
        label: "IMEI",
        width: "170px",
        placeholder: "IMEI 검색",
        text: (device) => deleteColumnText(device, "imei"),
        cellClassName: "flex items-center px-3 font-mono text-xs",
        render: (device) => device.imei || "-",
      },
      {
        key: "saleGrade",
        label: "판매등급",
        width: "110px",
        placeholder: "A",
        text: (device) => deleteColumnText(device, "saleGrade"),
        cellClassName: "flex items-center px-3",
        render: (device) => <SaleGradeBadge value={device.saleGrade} />,
      },
      {
        key: "status",
        label: "상태",
        width: "120px",
        placeholder: "판매가능",
        text: (device) => deleteColumnText(device, "status"),
        cellClassName: "flex items-center px-3",
        render: (device) => statusBadge(device.displayStatus),
      },
      {
        key: "batchNo",
        label: "차수",
        width: "100px",
        placeholder: "차수",
        text: (device) => deleteColumnText(device, "batchNo"),
        cellClassName: "flex items-center px-3",
        render: (device) => device.inbound?.batchNo ?? "-",
      },
      {
        key: "supplierName",
        label: "매입처",
        width: "140px",
        placeholder: "매입처",
        text: (device) => deleteColumnText(device, "supplierName"),
        cellClassName: "flex items-center px-3",
        render: (device) => device.inbound?.supplierName || "-",
      },
      {
        key: "location",
        label: "위치",
        width: "130px",
        placeholder: "위치",
        text: (device) => deleteColumnText(device, "location"),
        cellClassName: "flex items-center px-3",
        render: (device) => device.inventory?.location || "-",
      },
      {
        key: "delete",
        label: "삭제",
        width: "110px",
        sortable: false,
        filterable: false,
        headerClassName: "justify-end",
        cellClassName: "flex items-center justify-end px-3",
        render: (device) => (
          <Button
            size="sm"
            variant="outline"
            className={dangerousActionButtonClassName}
            onClick={() => {
              setDeleteTarget(device);
              setDeleteReason("");
              setMessage("");
            }}
          >
            <Trash2 className="size-4" />
            삭제
          </Button>
        ),
      },
    ],
    []
  );

  function updateCreateForm(key: keyof InventoryCreateForm, value: string) {
    setCreateForm((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function field(
    key: keyof InventoryCreateForm,
    label: string,
    options?: {
      placeholder?: string;
      mode?: InventoryEditFieldMode;
      choices?: InventoryEditOption[];
      allowEmpty?: boolean;
    }
  ) {
    return (
      <InventoryEditField
        label={label}
        value={createForm[key]}
        placeholder={options?.placeholder}
        mode={options?.mode}
        options={options?.choices}
        allowEmpty={options?.allowEmpty}
        onChange={(value) => updateCreateForm(key, value)}
      />
    );
  }

  async function createInventory() {
    if (isSaving) {
      return;
    }

    const missingField = requiredCreateFields(createForm).find(
      ([, value]) => !formValue(value)
    );

    if (missingField) {
      setMessage(`${missingField[0]} 값을 입력해야 재고를 추가할 수 있습니다.`);
      setMessageTone("warning");
      setActiveTab("add");
      return;
    }

    setSavingAction("create");
    setMessage("");
    setPostWriteRefreshWarning("");

    try {
      const response = await fetch("/api/inventory/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...createForm, inboundStatus: INBOUND_STATUS.purchased }),
      });
      const payload = (await response.json().catch(() => null)) as
        | InventoryManageApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "재고를 추가하지 못했습니다.");
      }

      setCreateForm(emptyCreateForm());
      setMessage(payload.message || "재고를 추가했습니다.");
      setMessageTone("success");

      try {
        await deviceList.reload();
      } catch {
        setPostWriteRefreshWarning(POST_WRITE_REFRESH_WARNING);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setSavingAction(null);
    }
  }

  async function deleteInventory() {
    if (!deleteTarget || isSaving) {
      return;
    }

    if (!deleteReason.trim()) {
      setMessage("삭제 사유를 입력해야 재고를 삭제할 수 있습니다.");
      setMessageTone("warning");
      return;
    }

    setSavingAction("delete");
    setMessage("");
    setPostWriteRefreshWarning("");

    try {
      const response = await fetch(
        `/api/inventory/devices/${encodeURIComponent(deleteTarget.pgNo)}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reason: deleteReason,
            expectedRevision: deleteTarget.revision,
          }),
        }
      );
      const payload = (await response.json().catch(() => null)) as
        | InventoryManageApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "재고를 삭제하지 못했습니다.");
      }

      setDeleteTarget(null);
      setDeleteReason("");
      setMessage(payload.message || "재고를 삭제했습니다.");
      setMessageTone("success");

      try {
        await deviceList.reload();
      } catch {
        setPostWriteRefreshWarning(POST_WRITE_REFRESH_WARNING);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setSavingAction(null);
    }
  }

  function requestCloseDeleteDialog() {
    runGuardedAction({
      intent: "dialog-close",
      formIds: [INVENTORY_DELETE_FORM_ID],
      targetLabel: deleteTarget
        ? `${deleteTarget.pgNo} 재고 삭제 창 닫기`
        : "재고 삭제 창 닫기",
      action: discardDeleteDraft,
    });
  }

  return (
    <WorkspacePageFrame className="px-5 py-4">
      <div className="mb-3 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="text-sm font-semibold">재고 추가 / 삭제</h2>
          <p className="text-xs text-muted-foreground">
            실무 예외 상황에서 재고 데이터를 수동으로 추가하거나 삭제합니다.
          </p>
        </div>
        {message ? (
          <FeedbackBanner
            tone={
              messageTone === "success"
                ? "success"
                : messageTone === "danger" || messageTone === "warning"
                  ? "warning"
                  : "neutral"
            }
          >
            {message}
          </FeedbackBanner>
        ) : null}
      </div>

      {postWriteRefreshWarning ? (
        <FeedbackBanner tone="warning">
          {postWriteRefreshWarning}
        </FeedbackBanner>
      ) : null}

      {deviceList.error ? (
        <FeedbackBanner tone="danger">{deviceList.error}</FeedbackBanner>
      ) : null}
      {deviceList.isLoading ? (
        <FeedbackBanner tone="info">재고 목록을 불러오는 중입니다.</FeedbackBanner>
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="w-fit">
          <TabsTrigger value="add">추가</TabsTrigger>
          <TabsTrigger value="delete">삭제</TabsTrigger>
        </TabsList>

        <TabsContent
          value="add"
          className="min-h-0 flex-1 overflow-auto pb-8"
        >
          <div className="grid gap-4">
            <InventoryEditSection title="기기 기본 정보">
              {field("pgNo", "PG", { placeholder: "AA0000000000" })}
              {field("imei", "IMEI", { placeholder: "숫자 15자리" })}
              {field("adbSerial", "ADB Serial", { placeholder: "선택 입력" })}
              {field("model", "모델", {
                mode: "datalist",
                choices: optionSets.models,
                allowEmpty: false,
                placeholder: "상품 기준값에서 선택",
              })}
              {field("modelCode", "모델 코드", {
                mode: "datalist",
                choices: optionSets.modelCodes,
                placeholder: "상품 기준값에서 선택",
              })}
              {field("modelSeq", "고유번호", { placeholder: "S24-345" })}
              {field("storage", "저장공간", {
                mode: "datalist",
                choices: optionSets.storages,
                placeholder: "상품 기준값에서 선택",
              })}
              {field("color", "공식 색상명", {
                mode: "datalist",
                choices: optionSets.colors,
                placeholder: "상품 기준값에서 선택",
              })}
              {field("saleGrade", "판매등급", {
                mode: "select",
                choices: SALE_GRADE_EDIT_OPTIONS,
              })}
              {field("warranty", "보증서", {
                mode: "select",
                choices: WARRANTY_EDIT_OPTIONS,
              })}
            </InventoryEditSection>

            <InventoryEditSection title="입고 기록">
              {field("batchNo", "차수", { placeholder: "숫자" })}
              {field("supplierName", "매입처")}
              {field("purchasePrice", "매입가", { placeholder: "숫자" })}
              {field("receivedAt", "입고일시", {
                mode: "datetime-local",
                placeholder: "비우면 현재 시각",
              })}
              {field("priceAgreedAt", "가격협의일시", {
                mode: "datetime-local",
              })}
              <InventoryEditField
                label="입고상태"
                value="매입 완료"
                readOnly
                onChange={() => undefined}
              />
              {field("inboundNote", "입고 메모")}
            </InventoryEditSection>

            <InventoryEditSection title="외관검수 기록">
              {field("appearanceGrade", "외관등급", {
                mode: "select",
                choices: APPEARANCE_GRADE_EDIT_OPTIONS,
              })}
              {field("appearanceDefect", "외관하자", {
                mode: "datalist",
                choices: appearanceDefectOptions,
                placeholder: "하자 없음 또는 기준값에서 선택",
              })}
              {field("appearanceReturnYn", "매입처 반품 여부", {
                mode: "select",
                choices: RETURN_YN_OPTIONS,
                allowEmpty: false,
              })}
              {field("appearanceWorker", "외관 작업자")}
              {field("appearanceCheckedAt", "외관 검수일시", {
                mode: "datetime-local",
                placeholder: "비우면 현재 시각",
              })}
              {field("appearanceNote", "외관 비고")}
            </InventoryEditSection>

            <InventoryEditSection title="기능검수 기록">
              {field("functionDefect", "기능하자", {
                mode: "datalist",
                choices: functionDefectOptions,
                placeholder: "하자 없음 또는 기준값에서 선택",
              })}
              {field("functionReturnYn", "매입처 반품 여부", {
                mode: "select",
                choices: RETURN_YN_OPTIONS,
                allowEmpty: false,
              })}
              {field("csc", "통신사", {
                mode: "datalist",
                choices: carrierOptions,
                placeholder: "자급제 / SKT / KT / LG U+",
              })}
              {field("firstCallDate", "최초통화일", {
                mode: "date",
                placeholder: "YYYY-MM-DD 또는 0000-00-00",
              })}
              {field("functionWorker", "기능 작업자")}
              {field("functionCheckedAt", "기능 검수일시", {
                mode: "datetime-local",
                placeholder: "비우면 현재 시각",
              })}
              {field("functionNote", "기능 비고")}
            </InventoryEditSection>

            <InventoryEditSection title="재고 상태">
              {field("inventoryStatus", "재고상태", {
                mode: "select",
                choices: INVENTORY_STATUS_EDIT_OPTIONS,
                allowEmpty: false,
              })}
              {field("location", "위치")}
              {field("stockedAt", "재고등록일시", {
                mode: "datetime-local",
                placeholder: "비우면 현재 시각",
              })}
              {field("reason", "추가 사유", {
                placeholder: "수동 추가가 필요한 이유",
              })}
            </InventoryEditSection>

            <div className="flex justify-end">
              <Button onClick={createInventory} disabled={isSaving}>
                {isSaving ? (
                  <Save className="size-4 animate-pulse" />
                ) : (
                  <PackagePlus className="size-4" />
                )}
                {isSaving ? "저장중" : "재고 추가"}
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="delete" className="min-h-0 flex-1">
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex flex-col gap-2 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <h3 className="text-sm font-semibold">삭제 대상 재고</h3>
                <p className="text-xs text-muted-foreground">
                  {filteredDeleteRows.length.toLocaleString("ko-KR")}건 표시
                </p>
              </div>
              <SearchInput
                value={deleteQuery}
                onValueChange={setDeleteQuery}
                placeholder="PG, IMEI, 모델, 위치 검색"
                wrapperClassName="w-full xl:w-[420px]"
              />
            </div>

            <VirtualizedDataGrid
              rows={filteredDeleteRows}
              columns={deleteColumns}
              rowKey={(device) => device.pgNo}
              emptyMessage="삭제할 재고가 없습니다."
              minWidth="1410px"
            />
          </div>
        </TabsContent>

      </Tabs>

      <DangerousConfirmDialog
        open={Boolean(deleteTarget)}
        title="재고 삭제"
        description="이 작업은 기기, 입고, 검수, 재고 기록을 삭제합니다. 주문/출고/반품/채널 매칭 이력이 있으면 서버에서 삭제를 차단합니다."
        confirmLabel="삭제 실행"
        busyLabel="삭제중"
        isBusy={savingAction === "delete"}
        onCancel={requestCloseDeleteDialog}
        onConfirm={() => void deleteInventory()}
        detail={
          deleteTarget ? (
            <div className="grid gap-2 text-sm font-normal text-red-900">
              <div className="font-bold">
                {deleteTarget.pgNo} / {deleteTarget.model}
              </div>
              <label className="grid gap-1">
                <span>삭제 사유</span>
                <Input
                  value={deleteReason}
                  autoComplete="off"
                  className="bg-background text-foreground"
                  placeholder="삭제 사유를 입력하세요"
                  onChange={(event) => setDeleteReason(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void deleteInventory();
                    }
                  }}
                />
              </label>
            </div>
          ) : null
        }
      />
    </WorkspacePageFrame>
  );
}
