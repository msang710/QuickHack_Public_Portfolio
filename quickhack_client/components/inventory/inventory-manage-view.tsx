// QuickHack note: 재고 추가 / 삭제 메뉴의 수동 재고 생성과 민감 삭제 작업 UI입니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useLocale, useTranslations } from "next-intl";
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
  statusLabel,
  type DeviceStatusMessageKey,
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
import { POST_WRITE_REFRESH_WARNING_KEY } from "@/quickhack_client/lib/post-write-refresh";
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
const RETURN_YN_OPTIONS = [
  { value: "N", label: "N" },
  { value: "Y", label: "Y" },
];

function optionList(values: readonly string[]): InventoryEditOption[] {
  return values.map((value) => ({ value, label: value }));
}

function criteriaOptionList(
  criteria: ProductCriteriaPayload | null,
  category: ProductCriteriaCategory,
  locale: string
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
    .sort((a, b) => a.localeCompare(b, locale))
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

function deleteColumnText(device: DeviceListRow, key: DeleteColumnKey, translateStatus: (key: DeviceStatusMessageKey) => string) {
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
      return statusLabel(device.displayStatus, translateStatus);
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

function requiredCreateFields(
  form: InventoryCreateForm,
  labels: { model: string; reason: string }
) {
  return [
    ["PG", form.pgNo],
    [labels.model, form.model],
    [labels.reason, form.reason],
  ] as const;
}

export function InventoryManageView() {
  const feedbackT = useTranslations("common.feedback");
  const t = useTranslations("inventory.manage");
  const detailT = useTranslations("common.deviceDetail");
  const inventoryStatusEditOptions = React.useMemo(
    () => Object.values(INVENTORY_STATUS)
      .filter((value) =>
        MANUAL_INVENTORY_INITIAL_STATUSES.has(value as InventoryStatusCode)
      )
      .map((value) => ({ value, label: statusLabel(value, detailT) })),
    [detailT]
  );
  const locale = useLocale();
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
    label: t("unsaved.create"),
    isDirty: !unsavedFormSnapshotsEqual(emptyCreateForm(), createForm),
    isBusy: savingAction === "create",
    discard: discardCreateDraft,
  });
  useUnsavedForm({
    id: INVENTORY_DELETE_FORM_ID,
    label: deleteTarget
      ? t("unsaved.deleteTarget", { pg: deleteTarget.pgNo })
      : t("unsaved.delete"),
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
    () => criteriaOptionList(criteria, "APPEARANCE_DEFECT", locale),
    [criteria, locale]
  );
  const functionDefectOptions = React.useMemo(
    () => criteriaOptionList(criteria, "FUNCTION_DEFECT", locale),
    [criteria, locale]
  );
  const carrierOptions = React.useMemo(
    () => criteriaOptionList(criteria, "CARRIER", locale),
    [criteria, locale]
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
        placeholder: t("placeholders.pg"),
        text: (device) => deleteColumnText(device, "pgNo", detailT),
        cellClassName: "flex items-center px-3 font-semibold",
        render: (device) => device.pgNo,
      },
      {
        key: "model",
        label: t("columns.model"),
        width: "minmax(240px,1fr)",
        placeholder: t("placeholders.model"),
        text: (device) => deleteColumnText(device, "model", detailT),
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
        label: t("columns.modelSequence"),
        width: "130px",
        placeholder: "S24-345",
        text: (device) => deleteColumnText(device, "modelSeq", detailT),
        cellClassName: "flex items-center px-3",
        render: (device) => formatModelSeqLabel(device.model, device.modelSeq),
      },
      {
        key: "imei",
        label: "IMEI",
        width: "170px",
        placeholder: t("placeholders.imei"),
        text: (device) => deleteColumnText(device, "imei", detailT),
        cellClassName: "flex items-center px-3 font-mono text-xs",
        render: (device) => device.imei || "-",
      },
      {
        key: "saleGrade",
        label: t("columns.saleGrade"),
        width: "110px",
        placeholder: "A",
        text: (device) => deleteColumnText(device, "saleGrade", detailT),
        cellClassName: "flex items-center px-3",
        render: (device) => <SaleGradeBadge value={device.saleGrade} />,
      },
      {
        key: "status",
        label: t("columns.status"),
        width: "120px",
        placeholder: t("placeholders.sellable"),
        text: (device) => deleteColumnText(device, "status", detailT),
        cellClassName: "flex items-center px-3",
        render: (device) => statusBadge(device.displayStatus, detailT),
      },
      {
        key: "batchNo",
        label: t("columns.batch"),
        width: "100px",
        placeholder: t("columns.batch"),
        text: (device) => deleteColumnText(device, "batchNo", detailT),
        cellClassName: "flex items-center px-3",
        render: (device) => device.inbound?.batchNo ?? "-",
      },
      {
        key: "supplierName",
        label: t("columns.supplier"),
        width: "140px",
        placeholder: t("columns.supplier"),
        text: (device) => deleteColumnText(device, "supplierName", detailT),
        cellClassName: "flex items-center px-3",
        render: (device) => device.inbound?.supplierName || "-",
      },
      {
        key: "location",
        label: t("columns.location"),
        width: "130px",
        placeholder: t("columns.location"),
        text: (device) => deleteColumnText(device, "location", detailT),
        cellClassName: "flex items-center px-3",
        render: (device) => device.inventory?.location || "-",
      },
      {
        key: "delete",
        label: t("columns.delete"),
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
            {t("actions.delete")}
          </Button>
        ),
      },
    ],
    [detailT, t]
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

    const missingField = requiredCreateFields(createForm, {
      model: t("fields.model"),
      reason: t("fields.reason"),
    }).find(
      ([, value]) => !formValue(value)
    );

    if (missingField) {
      setMessage(t("message.required", { field: missingField[0] }));
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
        throw new Error(legacyApiMessage(payload, t("message.createFailed")));
      }

      setCreateForm(emptyCreateForm());
      setMessage(t("message.created"));
      setMessageTone("success");

      try {
        await deviceList.reload();
      } catch {
        setPostWriteRefreshWarning(feedbackT(POST_WRITE_REFRESH_WARNING_KEY));
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
      setMessage(t("message.deleteReasonRequired"));
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
        throw new Error(legacyApiMessage(payload, t("message.deleteFailed")));
      }

      setDeleteTarget(null);
      setDeleteReason("");
      setMessage(t("message.deleted"));
      setMessageTone("success");

      try {
        await deviceList.reload();
      } catch {
        setPostWriteRefreshWarning(feedbackT(POST_WRITE_REFRESH_WARNING_KEY));
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
        ? t("dialog.closeDeleteTarget", { pg: deleteTarget.pgNo })
        : t("dialog.closeDelete"),
      action: discardDeleteDraft,
    });
  }

  return (
    <WorkspacePageFrame className="px-5 py-4">
      <div className="mb-3 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="text-sm font-semibold">{t("title")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("description")}
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
        <FeedbackBanner tone="info">{t("loading")}</FeedbackBanner>
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="w-fit">
          <TabsTrigger value="add">{t("actions.add")}</TabsTrigger>
          <TabsTrigger value="delete">{t("actions.delete")}</TabsTrigger>
        </TabsList>

        <TabsContent
          value="add"
          className="min-h-0 flex-1 overflow-auto pb-8"
        >
          <div className="grid gap-4">
            <InventoryEditSection title={t("sections.device")}>
              {field("pgNo", "PG", { placeholder: "AA0000000000" })}
              {field("imei", "IMEI", { placeholder: t("placeholders.digits15") })}
              {field("adbSerial", "ADB Serial", { placeholder: t("placeholders.optional") })}
              {field("model", t("fields.model"), {
                mode: "datalist",
                choices: optionSets.models,
                allowEmpty: false,
                placeholder: t("placeholders.criteria"),
              })}
              {field("modelCode", t("fields.modelCode"), {
                mode: "datalist",
                choices: optionSets.modelCodes,
                placeholder: t("placeholders.criteria"),
              })}
              {field("modelSeq", t("fields.modelSequence"), { placeholder: "S24-345" })}
              {field("storage", t("fields.storage"), {
                mode: "datalist",
                choices: optionSets.storages,
                placeholder: t("placeholders.criteria"),
              })}
              {field("color", t("fields.color"), {
                mode: "datalist",
                choices: optionSets.colors,
                placeholder: t("placeholders.criteria"),
              })}
              {field("saleGrade", t("fields.saleGrade"), {
                mode: "select",
                choices: SALE_GRADE_EDIT_OPTIONS,
              })}
              {field("warranty", t("fields.warranty"), {
                mode: "select",
                choices: WARRANTY_EDIT_OPTIONS,
              })}
            </InventoryEditSection>

            <InventoryEditSection title={t("sections.inbound")}>
              {field("batchNo", t("fields.batch"), { placeholder: t("placeholders.number") })}
              {field("supplierName", t("fields.supplier"))}
              {field("purchasePrice", t("fields.purchasePrice"), { placeholder: t("placeholders.number") })}
              {field("receivedAt", t("fields.receivedAt"), {
                mode: "datetime-local",
                placeholder: t("placeholders.nowIfEmpty"),
              })}
              {field("priceAgreedAt", t("fields.priceAgreedAt"), {
                mode: "datetime-local",
              })}
              <InventoryEditField
                label={t("fields.inboundStatus")}
                value={t("value.purchased")}
                readOnly
                onChange={() => undefined}
              />
              {field("inboundNote", t("fields.inboundNote"))}
            </InventoryEditSection>

            <InventoryEditSection title={t("sections.appearance")}>
              {field("appearanceGrade", t("fields.appearanceGrade"), {
                mode: "select",
                choices: APPEARANCE_GRADE_EDIT_OPTIONS,
              })}
              {field("appearanceDefect", t("fields.appearanceDefect"), {
                mode: "datalist",
                choices: appearanceDefectOptions,
                placeholder: t("placeholders.defect"),
              })}
              {field("appearanceReturnYn", t("fields.supplierReturn"), {
                mode: "select",
                choices: RETURN_YN_OPTIONS,
                allowEmpty: false,
              })}
              {field("appearanceWorker", t("fields.appearanceWorker"))}
              {field("appearanceCheckedAt", t("fields.appearanceCheckedAt"), {
                mode: "datetime-local",
                placeholder: t("placeholders.nowIfEmpty"),
              })}
              {field("appearanceNote", t("fields.appearanceNote"))}
            </InventoryEditSection>

            <InventoryEditSection title={t("sections.function")}>
              {field("functionDefect", t("fields.functionDefect"), {
                mode: "datalist",
                choices: functionDefectOptions,
                placeholder: t("placeholders.defect"),
              })}
              {field("functionReturnYn", t("fields.supplierReturn"), {
                mode: "select",
                choices: RETURN_YN_OPTIONS,
                allowEmpty: false,
              })}
              {field("csc", t("fields.carrier"), {
                mode: "datalist",
                choices: carrierOptions,
                placeholder: t("placeholders.carrier"),
              })}
              {field("firstCallDate", t("fields.firstCallDate"), {
                mode: "date",
                placeholder: t("placeholders.date"),
              })}
              {field("functionWorker", t("fields.functionWorker"))}
              {field("functionCheckedAt", t("fields.functionCheckedAt"), {
                mode: "datetime-local",
                placeholder: t("placeholders.nowIfEmpty"),
              })}
              {field("functionNote", t("fields.functionNote"))}
            </InventoryEditSection>

            <InventoryEditSection title={t("sections.inventory")}>
              {field("inventoryStatus", t("fields.inventoryStatus"), {
                mode: "select",
                choices: inventoryStatusEditOptions,
                allowEmpty: false,
              })}
              {field("location", t("fields.location"))}
              {field("stockedAt", t("fields.stockedAt"), {
                mode: "datetime-local",
                placeholder: t("placeholders.nowIfEmpty"),
              })}
              {field("reason", t("fields.reason"), {
                placeholder: t("placeholders.reason"),
              })}
            </InventoryEditSection>

            <div className="flex justify-end">
              <Button onClick={createInventory} disabled={isSaving}>
                {isSaving ? (
                  <Save className="size-4 animate-pulse" />
                ) : (
                  <PackagePlus className="size-4" />
                )}
                {isSaving ? t("actions.saving") : t("actions.create")}
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="delete" className="min-h-0 flex-1">
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex flex-col gap-2 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <h3 className="text-sm font-semibold">{t("delete.target")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("delete.result", { count: filteredDeleteRows.length })}
                </p>
              </div>
              <SearchInput
                value={deleteQuery}
                onValueChange={setDeleteQuery}
                placeholder={t("delete.search")}
                wrapperClassName="w-full xl:w-[420px]"
              />
            </div>

            <VirtualizedDataGrid
              rows={filteredDeleteRows}
              columns={deleteColumns}
              rowKey={(device) => device.pgNo}
              emptyMessage={t("delete.empty")}
              minWidth="1410px"
            />
          </div>
        </TabsContent>

      </Tabs>

      <DangerousConfirmDialog
        open={Boolean(deleteTarget)}
        title={t("delete.title")}
        description={t("delete.description")}
        confirmLabel={t("actions.deleteExecute")}
        busyLabel={t("actions.deleting")}
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
                <span>{t("delete.reason")}</span>
                <Input
                  value={deleteReason}
                  autoComplete="off"
                  className="bg-background text-foreground"
                  placeholder={t("delete.reasonPlaceholder")}
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
