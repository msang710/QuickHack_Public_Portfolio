// QuickHack note: 로그인 후 보이는 메인 ERP/WMS 화면으로 메뉴, 재고, 매입가, 판매 상품 조합, 주문 매칭 UI를 통합합니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useLocale, useTranslations } from "next-intl";
import {
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Database,
  CalendarDays,
  LogOut,
  Mail,
  PackageCheck,
  PanelLeftClose,
  PanelLeftOpen,
  Phone,
  RefreshCcw,
  Settings2,
  ShieldCheck,
  Smartphone,
  Undo2,
  UserRound,
} from "lucide-react";
import type { DeviceListItem } from "@/quickhack_shared/device/types";
import {
  canAccessRole,
  type AuthUser,
} from "@/quickhack_shared/auth/auth-constants";
import {
  findMenuItem,
  findShortcutMenuGroup,
  getAllowedMenuGroups,
  localizeMenuGroups,
  menuGroups,
  sensitiveMenuIds,
  type MenuItem,
  type MenuItemId,
} from "@/quickhack_client/components/app-shell/device-workspace-menu";
import {
  UnsavedChangesProvider,
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { requestQuickHackLogout } from "@/quickhack_client/auth/logout";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { SimpleInboundBatchPlanView } from "@/quickhack_client/components/inbound/inbound-batch-plan-view";
import { DeveloperToolsView } from "@/quickhack_client/components/developer/developer-tools-view";
import { InspectionWorkspace } from "@/quickhack_client/components/inspection/inspection-workspace";
import { SensitiveMenuGate } from "@/quickhack_client/components/security/sensitive-action-guards";
import { ChannelProductsManagerView } from "@/quickhack_client/components/sales-channel/channel-products-manager-view";
import { ChannelOrderMatchingManagerView } from "@/quickhack_client/components/sales-channel/channel-order-matching-manager-view";
import { ManualOrderMatchView } from "@/quickhack_client/components/sales-channel/manual-order-match-view";
import { EmployeeActivityLogView } from "@/quickhack_client/components/admin/employee-activity-log-view";
import { InventoryAuditView } from "@/quickhack_client/components/inventory/inventory-audit-view";
import { InventoryEditView } from "@/quickhack_client/components/inventory/inventory-edit-view";
import { InventoryManageView } from "@/quickhack_client/components/inventory/inventory-manage-view";
import { InventorySearchView } from "@/quickhack_client/components/inventory/inventory-search-view";
import { InventoryQuantityLedgerView } from "@/quickhack_client/components/inventory/inventory-quantity-ledger-view";
import { OrderMatchingPolicyView } from "@/quickhack_client/components/sales-channel/order-matching-policy-view";
import { SalesOfferManagerView } from "@/quickhack_client/components/catalog/sales-offer-manager-view";
import { PurchasePendingListView } from "@/quickhack_client/components/inbound/purchase-pending-list-view";
import { PurchasePriceCriteriaRateView } from "@/quickhack_client/components/inbound/purchase-price-criteria-rate-view";
import { ProductCriteriaManagerView } from "@/quickhack_client/components/catalog/product-criteria-manager-view";
import { ResponsePerformanceView } from "@/quickhack_client/components/developer/response-performance-view";
import { SecurityStatusView } from "@/quickhack_client/components/admin/security-status-view";
import { ServerJobLogView } from "@/quickhack_client/components/admin/server-job-log-view";
import { SalesChannelSyncCheckView } from "@/quickhack_client/components/admin/sales-channel-sync-check-view";
import { ShipmentAddressChangeListView } from "@/quickhack_client/components/shipment/shipment-address-change-list-view";
import { ShipmentDeliverySearchView } from "@/quickhack_client/components/shipment/shipment-delivery-search-view";
import { ShipmentInTransitListView } from "@/quickhack_client/components/shipment/shipment-in-transit-list-view";
import { ShipmentOrderListView } from "@/quickhack_client/components/shipment/shipment-order-list-view";
import { ShipmentPrintedListView } from "@/quickhack_client/components/shipment/shipment-printed-list-view";
import type { ShipmentOutputFocus } from "@/quickhack_client/components/shipment/shipment-output-focus";
import { InvoiceIssueHistoryView } from "@/quickhack_client/components/invoice/invoice-issue-history-view";
import { InvoiceManualIssueView } from "@/quickhack_client/components/invoice/invoice-manual-issue-view";
import { InvoiceRegistrationFailureView } from "@/quickhack_client/components/invoice/invoice-registration-failure-view";
import { CarrierDispatchSettingsView } from "@/quickhack_client/components/invoice/carrier-dispatch-settings-view";
import { ReturnListView } from "@/quickhack_client/components/returns/return-list-view";
import { StatisticsView } from "@/quickhack_client/components/statistics/statistics-view";
import { SystemStatusView } from "@/quickhack_client/components/admin/system-status-view";
import { SuppliesManagementView } from "@/quickhack_client/components/supplies/supplies-management-view";
import { UserAccountManagerView } from "@/quickhack_client/components/admin/user-account-manager-view";
import { PersonalSettingsView } from "@/quickhack_client/components/user/personal-settings-view";
import { ShortcutGuideDialog } from "@/quickhack_client/components/user/shortcut-guide-dialog";
import type { EditableAccountInformation } from "@/quickhack_client/components/user/account-information-fields";
import type { AccountTotpStatus } from "@/quickhack_client/components/user/account-totp-panel";
import { DeviceSheet } from "@/quickhack_client/components/shared/device-detail-sheet";
import { requestDeviceDetail } from "@/quickhack_client/components/shared/device-list-query-client";
import {
  SummaryMetric as SummaryCell,
  SummaryStrip,
} from "@/quickhack_client/components/ui/summary-metric";
import type { InspectionRecordWithStatus } from "@/quickhack_shared/inspection/inspection-schema";
import type {
  DashboardBatchProgress,
  DashboardStatisticsApiResponse,
  DashboardStatisticsData,
} from "@/quickhack_shared/statistics/statistics";
import {
  DEFAULT_STATISTICS_PERIOD_SELECTION,
  type StatisticsPeriodSelection,
} from "@/quickhack_shared/statistics/statistics-period";
import { cn } from "@/quickhack_shared/core/utils";
import type { MutationReceipt } from "@/quickhack_shared/core/mutation-receipt";
import {
  clonePersonalSettings,
  createDefaultPersonalSettings,
  currentGroupShortcutIndex,
  matchesShortcutBinding,
  personalSettingsEqual,
  type PersonalSettings,
  type ShortcutActionCode,
  type UserPreferenceKey,
  type UserShortcutBinding,
} from "@/quickhack_shared/user/personal-settings";
import { DesktopCapabilityProvider, useDesktopCapability } from "@/quickhack_client/components/desktop/desktop-capability-provider";
import { DesktopCommandPalette } from "@/quickhack_client/components/desktop/desktop-command-palette";
import { DesktopNotificationCenter } from "@/quickhack_client/components/desktop/desktop-notification-center";
import { DesktopUpdateStatus } from "@/quickhack_client/components/desktop/desktop-update-status";
import { menuWorkflowFamily } from "@/quickhack_shared/desktop/workflow-family";
import {
  publishLocale,
} from "@/quickhack_client/i18n/locale-client";
import type { QuickHackLocale } from "@/quickhack_shared/i18n/locales";

// QuickHack object: 메인 ERP/WMS 화면은 로그인 사용자만 받고 메뉴 데이터는 필요할 때 조회합니다.
type DeviceWorkspaceProps = {
  currentUser: AuthUser;
};

type AccountProfile = {
  userId: number;
  username: string;
  displayName: string;
  phone: string;
  email: string;
  birthDate: string;
  isBirthdayToday: boolean;
  hireDate: string;
  role: string;
  isDeveloper: boolean;
  mobilePackingEnabled: boolean;
  isActive: boolean;
  totpEnabled: boolean;
  totpVerifiedAt: string;
  totpLockedUntil: string;
  recoveryCodeCount: number;
  activeMobileDeviceCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type AccountProfileResponse = {
  ok: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  profile: AccountProfile | null;
  personalSettings?: PersonalSettings;
  message?: string;
};

type AccountProfileUpdateResponse = {
  ok: boolean;
  message?: string;
  user?: AuthUser;
  profile?: AccountProfile;
  receipt?: MutationReceipt<{
    user: AuthUser;
    profile: Omit<
      AccountProfile,
      | "totpEnabled"
      | "totpVerifiedAt"
      | "totpLockedUntil"
      | "recoveryCodeCount"
      | "activeMobileDeviceCount"
    >;
  }>;
};

type PersonalSettingsResponse = {
  ok: boolean;
  message?: string;
  personalSettings?: PersonalSettings;
  actionCode?: ShortcutActionCode;
};

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true']")
  );
}

function hasVisibleDialog() {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"]')
  ).some(
    (dialog) =>
      dialog.getClientRects().length > 0 &&
      dialog.getAttribute("aria-hidden") !== "true"
  );
}

function findVisibleSearchInput() {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[data-quickhack-search-input="true"]'
    )
  );

  return inputs
    .filter(
      (input) =>
        !input.disabled &&
        !input.readOnly &&
        input.getClientRects().length > 0 &&
        input.getAttribute("aria-hidden") !== "true"
    )
    .at(-1);
}

function findVisibleListRefreshButton(labels: readonly string[]) {
  const content = document.querySelector<HTMLElement>(
    '[data-quickhack-active-content="true"]'
  );

  if (!content) {
    return null;
  }

  const buttons = Array.from(content.querySelectorAll<HTMLButtonElement>("button"))
    .filter(
      (button) =>
        !button.disabled &&
        button.getClientRects().length > 0 &&
        button.getAttribute("aria-hidden") !== "true"
    );
  const buttonLabel = (button: HTMLButtonElement) =>
    (
      button.getAttribute("aria-label") ||
      button.getAttribute("title") ||
      button.textContent ||
      ""
    ).trim();

  return (
    buttons.find((button) => labels.includes(buttonLabel(button))) ??
    null
  );
}

function accountProfileFromUser(user: AuthUser): AccountProfile {
  return {
    userId: user.userId,
    username: user.username,
    displayName: user.displayName,
    phone: "",
    email: "",
    birthDate: "",
    isBirthdayToday: false,
    hireDate: "",
    role: user.role,
    isDeveloper: user.isDeveloper,
    mobilePackingEnabled: user.mobilePackingEnabled,
    isActive: true,
    totpEnabled: false,
    totpVerifiedAt: "",
    totpLockedUntil: "",
    recoveryCodeCount: 0,
    activeMobileDeviceCount: 0,
    revision: 0,
    createdAt: "",
    updatedAt: "",
  };
}

const editableAccountProfileKeys: (keyof EditableAccountInformation)[] = [
  "username",
  "displayName",
  "phone",
  "email",
  "birthDate",
  "hireDate",
];

function editableAccountProfilesEqual(
  left: AccountProfile | null,
  right: AccountProfile | null
) {
  if (!left || !right) {
    return left === right;
  }

  return editableAccountProfileKeys.every((key) => left[key] === right[key]);
}

function formatAccountDate(value: string | null | undefined) {
  const text = String(value ?? "").trim();

  if (!text) {
    return "-";
  }

  return text.replace("T", " ").slice(0, 19);
}

function AccountInfoRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-3 text-sm">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0 break-words text-foreground">{value || "-"}</div>
    </div>
  );
}

function DashboardProgressBar({
  label,
  value,
  count,
  total,
  tone,
}: {
  label: string;
  value: number;
  count: number;
  total: number;
  tone: "primary" | "sky" | "warning";
}) {
  const locale = useLocale();
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 tabular-nums">
          {count.toLocaleString(locale)} / {total.toLocaleString(locale)} ·{" "}
          {value}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn(
            "h-full rounded-full",
            tone === "primary" && "bg-primary",
            tone === "sky" && "bg-sky-600",
            tone === "warning" && "bg-amber-500"
          )}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
    </div>
  );
}

function DashboardBatchCard({ batch }: { batch: DashboardBatchProgress }) {
  const t = useTranslations("navigation.workspace");
  const locale = useLocale();
  const differenceLabel =
    batch.arrivalDifference === 0
      ? t("dashboard.match")
      : batch.arrivalDifference < 0
        ? t("dashboard.shortage", { count: batch.shortageQuantity })
        : t("dashboard.excess", { count: batch.excessQuantity });

  return (
    <article className="grid min-h-[220px] gap-4 rounded-md border bg-popover p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">
            {t("dashboard.batch", { date: batch.batchDate, batch: batch.batchNo })}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("dashboard.batchSummary", {
              expected: batch.expectedQuantity,
              linked: batch.linkedQuantity,
              inspected: batch.inspectedToday,
            })}
          </p>
        </div>
        <div
          className={cn(
            "rounded-md border px-2.5 py-1 text-xs font-medium tabular-nums",
            batch.arrivalDifference === 0 &&
              "border-emerald-200 bg-emerald-50 text-emerald-700",
            batch.arrivalDifference < 0 &&
              "border-red-200 bg-red-50 text-red-700",
            batch.arrivalDifference > 0 &&
              "border-amber-200 bg-amber-50 text-amber-700"
          )}
        >
          {differenceLabel}
        </div>
      </div>

      <div className="grid grid-cols-3 overflow-hidden rounded-md border bg-background">
        <div className="border-r p-3">
          <div className="text-xs text-muted-foreground">{t("dashboard.normalInbound")}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {batch.normalInboundTargetQuantity.toLocaleString(locale)}
          </div>
        </div>
        <div className="border-r p-3">
          <div className="text-xs text-muted-foreground">{t("dashboard.supplierReturn")}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {batch.supplierReturnQuantity.toLocaleString(locale)}
          </div>
        </div>
        <div className="p-3">
          <div className="text-xs text-muted-foreground">{t("dashboard.arrivalDifference")}</div>
          <div
            className={cn(
              "mt-1 text-2xl font-semibold tabular-nums",
              batch.arrivalDifference < 0 && "text-red-700",
              batch.arrivalDifference > 0 && "text-amber-700"
            )}
          >
            {batch.arrivalDifference > 0 ? "+" : ""}
            {batch.arrivalDifference.toLocaleString(locale)}
          </div>
        </div>
      </div>

      <div className="grid gap-3">
        <DashboardProgressBar
          label={t("dashboard.appearanceComplete")}
          value={batch.appearancePercent}
          count={batch.appearanceCompletedCount}
          total={batch.expectedQuantity}
          tone="primary"
        />
        <DashboardProgressBar
          label={t("dashboard.functionComplete")}
          value={batch.functionPercent}
          count={batch.functionCompletedCount}
          total={batch.expectedQuantity}
          tone="sky"
        />
        <DashboardProgressBar
          label={t("dashboard.purchasePending")}
          value={batch.purchasePendingPercent}
          count={batch.purchasePendingCount}
          total={batch.expectedQuantity}
          tone="warning"
        />
      </div>
    </article>
  );
}

function DashboardView() {
  const t = useTranslations("navigation.workspace");
  const [data, setData] = React.useState<DashboardStatisticsData | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [errorMessage, setErrorMessage] = React.useState("");

  React.useEffect(() => {
    const controller = new AbortController();
    const timerId = window.setTimeout(() => {
      setIsLoading(true);
      setErrorMessage("");

      fetch("/api/statistics/dashboard", {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = (await response.json().catch(() => null)) as
            | DashboardStatisticsApiResponse
            | null;

          if (!response.ok || !payload?.ok || !payload.data) {
            throw new Error(
              t("dashboard.loadFailed")
            );
          }

          setData(payload.data);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }

          setErrorMessage(
            error instanceof Error ? error.message : String(error)
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setIsLoading(false);
          }
        });
    }, 0);

    return () => {
      window.clearTimeout(timerId);
      controller.abort();
    };
  }, [t]);

  return (
    <section className="flex h-full min-h-0 w-full flex-1 flex-col gap-4 overflow-auto p-5">
      <SummaryStrip className="grid-cols-2 md:grid-cols-4">
        <SummaryCell
          icon={Database}
          label={t("dashboard.expectedToday")}
          value={data?.summary.expectedQuantity ?? "–"}
        />
        <SummaryCell
          icon={ClipboardCheck}
          label={t("dashboard.currentlyLinked")}
          value={data?.summary.linkedQuantity ?? "–"}
        />
        <SummaryCell
          icon={PackageCheck}
          label={t("dashboard.normalInbound")}
          value={data?.summary.normalInboundTargetQuantity ?? "–"}
        />
        <SummaryCell
          icon={Undo2}
          label={t("dashboard.supplierReturn")}
          value={data?.summary.supplierReturnQuantity ?? "–"}
        />
      </SummaryStrip>

      {isLoading ? (
        <FeedbackBanner tone="info">
          {t("dashboard.loading")}
        </FeedbackBanner>
      ) : null}

      {errorMessage ? (
        <FeedbackBanner tone="danger">
          {errorMessage}
        </FeedbackBanner>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t("dashboard.title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("dashboard.basis", { date: data?.today ?? "-" })}
          </p>
        </div>
      </div>

      {data && data.batches.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {data.batches.map((batch) => (
            <DashboardBatchCard
              key={batch.inboundBatchId}
              batch={batch}
            />
          ))}
        </div>
      ) : !isLoading && !errorMessage && data ? (
        <div className="grid min-h-72 place-items-center rounded-md border border-dashed bg-background text-sm text-muted-foreground">
          {t("dashboard.empty")}
        </div>
      ) : null}
    </section>
  );
}

function PendingMenuView({ item }: { item: MenuItem }) {
  const t = useTranslations("navigation.workspace");
  const Icon = item.icon;

  return (
    <section className="flex h-full min-h-0 w-full flex-1 items-start overflow-auto p-5">
      <div className="grid w-full max-w-xl gap-3 rounded-md border border-dashed bg-background p-8 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-secondary text-primary">
          <Icon className="size-5" />
        </div>
        <div>
          <h2 className="text-base font-semibold">{item.label}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {item.description}
          </p>
        </div>
        <Badge className="mx-auto" variant="neutral">
          {t("pending")}
        </Badge>
      </div>
    </section>
  );
}

// QuickHack object: 로그인 후 QuickHack의 모든 업무 메뉴와 주요 화면을 조립하는 최상위 컴포넌트입니다.
export function DeviceWorkspace({
  currentUser,
}: DeviceWorkspaceProps) {
  return (
    <DesktopCapabilityProvider>
      <UnsavedChangesProvider>
        <DeviceWorkspaceContent currentUser={currentUser} />
      </UnsavedChangesProvider>
    </DesktopCapabilityProvider>
  );
}

function DeviceWorkspaceContent({
  currentUser,
}: DeviceWorkspaceProps) {
  const navigation = useTranslations("navigation");
  const workspace = useTranslations("navigation.workspace");
  const deviceQuery = useTranslations("common.deviceQuery");
  const roleLabels: Record<string, string> = {
    VIEWER: workspace("roles.viewer"),
    STAFF: workspace("roles.staff"),
    MANAGER: workspace("roles.manager"),
    LEADER: workspace("roles.leader"),
  };
  const { allowNextBeforeUnload, runGuardedAction } = useUnsavedChanges();
  const { api: desktopApi } = useDesktopCapability();
  const [selectedDevice, setSelectedDevice] =
    React.useState<DeviceListItem | null>(null);
  const [requestedDevicePgNo, setRequestedDevicePgNo] = React.useState("");
  const [isDeviceDetailLoading, setIsDeviceDetailLoading] =
    React.useState(false);
  const [deviceDetailError, setDeviceDetailError] = React.useState("");
  const [inspectionRecords, setInspectionRecords] = React.useState<
    InspectionRecordWithStatus[]
  >([]);
  const [selectedInspectionRecordIds, setSelectedInspectionRecordIds] =
    React.useState<Set<string>>(new Set());
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  const [accountCardOpen, setAccountCardOpen] = React.useState(false);
  const [shortcutGuideOpen, setShortcutGuideOpen] = React.useState(false);
  const [accountProfile, setAccountProfile] =
    React.useState<AccountProfile | null>(null);
  const [accountProfileDraft, setAccountProfileDraft] =
    React.useState<AccountProfile | null>(null);
  const [isSavingAccountProfile, setIsSavingAccountProfile] =
    React.useState(false);
  const [accountSettingsMessage, setAccountSettingsMessage] =
    React.useState("");
  const [accountSettingsError, setAccountSettingsError] = React.useState("");
  const [accountPersonalSettings, setAccountPersonalSettings] =
    React.useState<PersonalSettings>(() => createDefaultPersonalSettings());
  const [personalSettingsDraft, setPersonalSettingsDraft] =
    React.useState<PersonalSettings>(() => createDefaultPersonalSettings());
  const [accountPreferencesLoaded, setAccountPreferencesLoaded] =
    React.useState(false);
  const [isSavingPersonalSettings, setIsSavingPersonalSettings] =
    React.useState(false);
  const [accountPreferencesMessage, setAccountPreferencesMessage] =
    React.useState("");
  const [accountPreferencesError, setAccountPreferencesError] =
    React.useState("");
  const [accountPreferencesErrorAction, setAccountPreferencesErrorAction] =
    React.useState<ShortcutActionCode | undefined>(undefined);
  const [isAccountProfileLoading, setIsAccountProfileLoading] =
    React.useState(false);
  const [accountProfileError, setAccountProfileError] = React.useState("");
  const [isRefreshingWorkspace, setIsRefreshingWorkspace] =
    React.useState(false);
  const [contentRefreshRevision, setContentRefreshRevision] =
    React.useState(0);
  const [statisticsPeriodSelection, setStatisticsPeriodSelection] =
    React.useState<StatisticsPeriodSelection>(
      DEFAULT_STATISTICS_PERIOD_SELECTION
    );
  const [workspaceError, setWorkspaceError] =
    React.useState("");
  const [activeMenuId, setActiveMenuId] =
    React.useState<MenuItemId>("dashboard");
  const [
    salesChannelSyncCheckUnresolvedCount,
    setSalesChannelSyncCheckUnresolvedCount,
  ] = React.useState(0);
  const [
    focusedSyncCheckWriteRequestId,
    setFocusedSyncCheckWriteRequestId,
  ] = React.useState<number | null>(null);
  const [focusedInvoiceRecoverySearch, setFocusedInvoiceRecoverySearch] =
    React.useState("");
  const [focusedShipmentOutput, setFocusedShipmentOutput] =
    React.useState<ShipmentOutputFocus | null>(null);
  const consumeFocusedShipmentOutput = React.useCallback(
    () => setFocusedShipmentOutput(null),
    []
  );
  const [focusedInventoryEditPgNo, setFocusedInventoryEditPgNo] =
    React.useState<string | null>(null);
  const consumeFocusedInventoryEditPgNo = React.useCallback(
    () => setFocusedInventoryEditPgNo(null),
    []
  );
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [openGroupIds, setOpenGroupIds] = React.useState<Set<string>>(
    () => new Set(menuGroups.map((group) => group.id))
  );
  const [sidebarScrollRequest, setSidebarScrollRequest] = React.useState<{
    menuId: MenuItemId;
  } | null>(null);
  const sidebarNavRef = React.useRef<HTMLElement | null>(null);
  const accountButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const accountCardRef = React.useRef<HTMLDivElement | null>(null);
  const deviceDetailAbortRef = React.useRef<AbortController | null>(null);
  const closeWorkspaceWindowRef = React.useRef<() => void>(() => undefined);
  const requestMenuChangeRef = React.useRef<
    (nextMenuId: MenuItemId, onCommitted?: () => void) => void
  >(() => undefined);
  const workspaceRefreshOperationCountRef = React.useRef(0);
  const activeMenuReloadInFlightRef = React.useRef(false);
  const menuNavigationRevisionRef = React.useRef(0);
  const localeBroadcastSourceId = React.useId();
  const localeBroadcastSourceRef = React.useRef(
    `workspace-${localeBroadcastSourceId}`
  );

  const personalSettingsDirty = React.useMemo(
    () =>
      !personalSettingsEqual(accountPersonalSettings, personalSettingsDraft),
    [accountPersonalSettings, personalSettingsDraft]
  );
  const accountSettingsDirty = React.useMemo(
    () => !editableAccountProfilesEqual(accountProfile, accountProfileDraft),
    [accountProfile, accountProfileDraft]
  );
  const discardAccountProfileChanges = React.useCallback(() => {
    setAccountProfileDraft(accountProfile ? { ...accountProfile } : null);
    setAccountSettingsError("");
    setAccountSettingsMessage("");
  }, [accountProfile]);
  const discardPersonalSettingsChanges = React.useCallback(() => {
    setPersonalSettingsDraft(clonePersonalSettings(accountPersonalSettings));
    setAccountPreferencesError("");
    setAccountPreferencesErrorAction(undefined);
    setAccountPreferencesMessage("");
  }, [accountPersonalSettings]);
  const effectiveCurrentUser = React.useMemo<AuthUser>(
    () => ({
      ...currentUser,
      username: accountProfile?.username ?? currentUser.username,
      displayName: accountProfile?.displayName ?? currentUser.displayName,
    }),
    [accountProfile, currentUser]
  );

  React.useEffect(() => {
    if (!canAccessRole(effectiveCurrentUser.role, "STAFF")) {
      return;
    }

    let canceled = false;
    async function refreshSalesChannelSyncCheckCount() {
      try {
        const response = await fetch(
          "/api/admin/sales-channel-sync-checks?kind=ALL&status=UNRESOLVED&limit=1",
          { cache: "no-store" }
        );
        const payload = (await response.json()) as {
          ok?: boolean;
          unresolvedCount?: number;
        };

        if (!canceled && response.ok && payload.ok) {
          setSalesChannelSyncCheckUnresolvedCount(payload.unresolvedCount ?? 0);
        }
      } catch {
        // The menu badge is informational; the review screen shows fetch errors.
      }
    }

    void refreshSalesChannelSyncCheckCount();
    const timer = window.setInterval(
      refreshSalesChannelSyncCheckCount,
      60_000
    );

    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [effectiveCurrentUser.role]);

  const localizedMenuGroups = React.useMemo(
    () => localizeMenuGroups((key) => navigation(key as never)),
    [navigation]
  );
  const allowedMenuGroups = React.useMemo(
    () => getAllowedMenuGroups(effectiveCurrentUser, localizedMenuGroups),
    [effectiveCurrentUser, localizedMenuGroups]
  );

  const selectedMenuId =
    activeMenuId === "personal-settings" ||
    allowedMenuGroups.some((group) =>
      group.items.some((item) => item.id === activeMenuId)
    )
      ? activeMenuId
      : allowedMenuGroups[0]?.items[0]?.id ?? "dashboard";
  const selectedMenuIdRef = React.useRef(selectedMenuId);
  const activeMenu = findMenuItem(
    selectedMenuId,
    localizedMenuGroups,
    (key) => navigation(key as never)
  );

  useUnsavedForm({
    id: "personal-settings.account",
    label: workspace("forms.account"),
    enabled: selectedMenuId === "personal-settings",
    isDirty: accountSettingsDirty,
    isBusy: isSavingAccountProfile,
    discard: discardAccountProfileChanges,
  });
  useUnsavedForm({
    id: "personal-settings.preferences",
    label: workspace("forms.preferences"),
    enabled: selectedMenuId === "personal-settings",
    isDirty: personalSettingsDirty,
    isBusy: isSavingPersonalSettings,
    discard: discardPersonalSettingsChanges,
  });

  React.useEffect(() => {
    if (selectedMenuIdRef.current !== selectedMenuId) {
      menuNavigationRevisionRef.current += 1;
    }
    selectedMenuIdRef.current = selectedMenuId;
  }, [selectedMenuId]);

  React.useEffect(() => {
    if (!accountCardOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;

      if (!(target instanceof Node)) {
        return;
      }

      if (
        accountButtonRef.current?.contains(target) ||
        accountCardRef.current?.contains(target)
      ) {
        return;
      }

      setAccountCardOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAccountCardOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountCardOpen]);

  React.useEffect(() => {
    if (accountProfile) {
      return;
    }

    const controller = new AbortController();
    const timerId = window.setTimeout(() => {
      setIsAccountProfileLoading(true);
      setAccountProfileError("");

      fetch("/api/auth/me", {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = (await response.json().catch(() => null)) as
            | AccountProfileResponse
            | null;

          if (!response.ok || !payload?.ok || !payload.authenticated) {
            throw new Error(
              workspace("account.loadFailed")
            );
          }

          const nextProfile =
            payload.profile ?? accountProfileFromUser(currentUser);
          setAccountProfile(nextProfile);
          setAccountProfileDraft({ ...nextProfile });
          const nextPersonalSettings =
            payload.personalSettings ?? createDefaultPersonalSettings();
          setAccountPersonalSettings(
            clonePersonalSettings(nextPersonalSettings)
          );
          setPersonalSettingsDraft(clonePersonalSettings(nextPersonalSettings));
          setAccountPreferencesLoaded(true);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }

          const fallbackProfile = accountProfileFromUser(currentUser);
          setAccountProfile(fallbackProfile);
          setAccountProfileDraft({ ...fallbackProfile });
          setAccountProfileError(
            error instanceof Error ? error.message : String(error)
          );
        })
        .finally(() => setIsAccountProfileLoading(false));
    }, 0);

    return () => {
      window.clearTimeout(timerId);
      controller.abort();
    };
  }, [accountProfile, currentUser, workspace]);

  React.useEffect(() => {
    function handleWorkspaceShortcut(event: KeyboardEvent) {
      if (
        !accountPreferencesLoaded ||
        !accountPersonalSettings.preferences.keyboardShortcutsEnabled ||
        event.repeat ||
        (event.target instanceof HTMLElement &&
          event.target.closest('[data-quickhack-shortcut-capture="true"]'))
      ) {
        return;
      }

      const binding = accountPersonalSettings.shortcutBindings.find(
        (candidate) => matchesShortcutBinding(event, candidate)
      );

      if (!binding) {
        return;
      }

      if (binding.actionCode === "FOCUS_SEARCH") {
        const searchInput = findVisibleSearchInput();

        if (!searchInput) {
          return;
        }

        event.preventDefault();
        searchInput.focus();
        searchInput.select();
        return;
      }

      if (hasVisibleDialog()) {
        return;
      }

      if (binding.actionCode === "CLOSE_WINDOW") {
        if (isEditableKeyboardTarget(event.target)) {
          return;
        }

        event.preventDefault();

        if (accountCardOpen) {
          setAccountCardOpen(false);
          return;
        }

        runGuardedAction({
          intent: "close-window",
          action: () => closeWorkspaceWindowRef.current(),
        });
        return;
      }

      if (binding.actionCode === "REFRESH_LIST") {
        event.preventDefault();
        const refreshButton =
          findVisibleListRefreshButton([workspace("header.listRefresh"), workspace("header.refresh")]) ??
          document.querySelector<HTMLButtonElement>(
            '[data-quickhack-global-refresh="true"]'
          );
        refreshButton?.click();
        return;
      }

      if (binding.actionCode === "OPEN_PERSONAL_SETTINGS") {
        event.preventDefault();
        requestMenuChangeRef.current("personal-settings", () => {
          setAccountCardOpen(false);
        });
        return;
      }

      if (binding.actionCode === "OPEN_SHORTCUT_GUIDE") {
        event.preventDefault();
        setShortcutGuideOpen(true);
        setAccountCardOpen(false);
        return;
      }

      if (
        isEditableKeyboardTarget(event.target) &&
        !binding.keyCode?.startsWith("F")
      ) {
        return;
      }

      event.preventDefault();

      const currentGroupItemIndex = currentGroupShortcutIndex(
        binding.actionCode
      );
      const targetGroup =
        currentGroupItemIndex >= 0
          ? allowedMenuGroups.find((group) =>
              group.items.some((item) => item.id === selectedMenuId)
            )
          : findShortcutMenuGroup(allowedMenuGroups, binding.actionCode);
      const targetMenu =
        currentGroupItemIndex >= 0
          ? targetGroup?.items[currentGroupItemIndex]
          : targetGroup?.items[0];

      if (!targetGroup || !targetMenu) {
        return;
      }

      requestMenuChangeRef.current(targetMenu.id, () => {
        setOpenGroupIds((current) => {
          if (current.has(targetGroup.id)) {
            return current;
          }

          const next = new Set(current);
          next.add(targetGroup.id);
          return next;
        });
        setSidebarScrollRequest({ menuId: targetMenu.id });
        setAccountCardOpen(false);
      });
    }

    document.addEventListener("keydown", handleWorkspaceShortcut);

    return () => {
      document.removeEventListener("keydown", handleWorkspaceShortcut);
    };
  }, [
    accountPersonalSettings,
    accountPreferencesLoaded,
    accountCardOpen,
    allowedMenuGroups,
    runGuardedAction,
    selectedMenuId,
    workspace,
  ]);

  React.useEffect(() => {
    if (!sidebarScrollRequest) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const targetButton = Array.from(
        sidebarNavRef.current?.querySelectorAll<HTMLButtonElement>(
          "[data-quickhack-menu-id]"
        ) ?? []
      ).find(
        (button) =>
          button.dataset.quickhackMenuId === sidebarScrollRequest.menuId
      );

      targetButton?.scrollIntoView({
        block: "center",
        inline: "nearest",
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [sidebarScrollRequest]);

  const openDevice = React.useCallback(async (pgNo: string) => {
    const normalizedPgNo = pgNo.trim().toUpperCase();
    if (!normalizedPgNo) return;

    deviceDetailAbortRef.current?.abort();
    const controller = new AbortController();
    deviceDetailAbortRef.current = controller;
    setRequestedDevicePgNo(normalizedPgNo);
    setSelectedDevice(null);
    setDeviceDetailError("");
    setIsDeviceDetailLoading(true);
    setSheetOpen(true);

    try {
      const detail = await requestDeviceDetail(
        normalizedPgNo,
        deviceQuery("detailFailed"),
        controller.signal
      );
      if (!controller.signal.aborted) setSelectedDevice(detail);
    } catch (error) {
      if (!controller.signal.aborted) {
        setDeviceDetailError(
          error instanceof Error ? error.message : String(error)
        );
      }
    } finally {
      if (!controller.signal.aborted) setIsDeviceDetailLoading(false);
    }
  }, [deviceQuery]);

  const beginWorkspaceRefresh = React.useCallback(() => {
    workspaceRefreshOperationCountRef.current += 1;
    setIsRefreshingWorkspace(true);
  }, []);

  const finishWorkspaceRefresh = React.useCallback(() => {
    workspaceRefreshOperationCountRef.current = Math.max(
      0,
      workspaceRefreshOperationCountRef.current - 1
    );
    if (workspaceRefreshOperationCountRef.current === 0) {
      setIsRefreshingWorkspace(false);
    }
  }, []);

  function resetActiveMenuState(menuId: MenuItemId) {
    switch (menuId) {
      case "inventory-search":
        setSelectedDevice(null);
        setRequestedDevicePgNo("");
        setSheetOpen(false);
        break;
      case "inbound-appearance":
      case "inbound-function":
      case "inbound-upload-pending":
        setInspectionRecords([]);
        setSelectedInspectionRecordIds(new Set());
        break;
      case "admin-sales-channel-sync-check":
        setFocusedSyncCheckWriteRequestId(null);
        break;
      case "invoice-registration-failures":
        setFocusedInvoiceRecoverySearch("");
        break;
      case "shipment-matched":
        setFocusedShipmentOutput(null);
        break;
      case "inventory-edit":
        setFocusedInventoryEditPgNo(null);
        break;
      default:
        break;
    }
  }

  function reloadActiveMenuContent() {
    runGuardedAction({
      intent: "refresh",
      targetLabel: activeMenu.label,
      action: () => {
        void performActiveMenuReload();
      },
    });
  }

  async function performActiveMenuReload() {
    if (activeMenuReloadInFlightRef.current) {
      return;
    }

    const targetMenuId = selectedMenuId;
    const targetNavigationRevision = menuNavigationRevisionRef.current;

    activeMenuReloadInFlightRef.current = true;
    beginWorkspaceRefresh();

    try {
      if (
        selectedMenuIdRef.current !== targetMenuId ||
        menuNavigationRevisionRef.current !== targetNavigationRevision
      ) {
        return;
      }

      resetActiveMenuState(targetMenuId);
      setContentRefreshRevision((current) => current + 1);
    } finally {
      activeMenuReloadInFlightRef.current = false;
      finishWorkspaceRefresh();
    }
  }

  function handleLogout() {
    runGuardedAction({
      intent: "logout",
      action: () => {
        void performLogout();
      },
    });
  }

  async function performLogout() {
    if (isLoggingOut) {
      return;
    }

    setIsLoggingOut(true);
    setWorkspaceError("");

    try {
      await requestQuickHackLogout(fetch, workspace("message.logoutFailed"));
      allowNextBeforeUnload();
      window.location.reload();
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : workspace("message.logoutFailed")
      );
      setIsLoggingOut(false);
    }
  }

  function closeWorkspaceWindow() {
    if (desktopApi) {
      void desktopApi.closeWindow();
      return;
    }
    window.close();
    window.setTimeout(() => {
      if (!window.closed) {
        setWorkspaceError(
          workspace("message.windowCloseBlocked")
        );
      }
    }, 100);
  }

  function changePersonalPreference(key: UserPreferenceKey, checked: boolean) {
    setPersonalSettingsDraft((current) => ({
      ...current,
      preferences: {
        ...current.preferences,
        [key]: checked,
      },
    }));
    setAccountPreferencesError("");
    setAccountPreferencesErrorAction(undefined);
    setAccountPreferencesMessage("");
  }

  function changePersonalLocale(locale: QuickHackLocale) {
    setPersonalSettingsDraft((current) => ({ ...current, locale }));
    setAccountPreferencesError("");
    setAccountPreferencesErrorAction(undefined);
    setAccountPreferencesMessage("");
  }

  function changeAccountProfile<K extends keyof EditableAccountInformation>(
    key: K,
    value: EditableAccountInformation[K]
  ) {
    setAccountProfileDraft((current) =>
      current ? { ...current, [key]: value } : current
    );
    setAccountSettingsError("");
    setAccountSettingsMessage("");
  }

  const applyTotpStatus = React.useCallback((status: AccountTotpStatus) => {
    const updateProfile = (current: AccountProfile | null) =>
      current
        ? {
            ...current,
            totpEnabled: status.enabled,
            totpVerifiedAt: status.verifiedAt ?? "",
            totpLockedUntil: status.lockedUntil ?? "",
            recoveryCodeCount: status.unusedRecoveryCodeCount,
          }
        : current;
    setAccountProfile(updateProfile);
    setAccountProfileDraft(updateProfile);
  }, []);

  const applyMobileActiveCount = React.useCallback((count: number) => {
    const updateProfile = (current: AccountProfile | null) =>
      current ? { ...current, activeMobileDeviceCount: count } : current;
    setAccountProfile(updateProfile);
    setAccountProfileDraft(updateProfile);
  }, []);

  function changeShortcutBinding(
    actionCode: ShortcutActionCode,
    change: Partial<Pick<UserShortcutBinding, "modifier" | "keyCode">>
  ) {
    setPersonalSettingsDraft((current) => ({
      ...current,
      shortcutBindings: current.shortcutBindings.map((binding) =>
        binding.actionCode === actionCode ? { ...binding, ...change } : binding
      ),
    }));
    setAccountPreferencesError("");
    setAccountPreferencesErrorAction(undefined);
    setAccountPreferencesMessage("");
  }

  function resetPersonalSettingsDefaults() {
    const defaults = createDefaultPersonalSettings();
    setPersonalSettingsDraft({
      ...defaults,
      revision: accountPersonalSettings.revision,
    });
    setAccountPreferencesError("");
    setAccountPreferencesErrorAction(undefined);
    setAccountPreferencesMessage("");
  }

  function commitMenuChange(
    nextMenuId: MenuItemId,
    onCommitted?: () => void
  ) {
    menuNavigationRevisionRef.current += 1;
    selectedMenuIdRef.current = nextMenuId;
    setActiveMenuId(nextMenuId);
    onCommitted?.();
  }

  function requestMenuChange(
    nextMenuId: MenuItemId,
    onCommitted?: () => void
  ) {
    if (nextMenuId === selectedMenuId) {
      onCommitted?.();
      return;
    }

    runGuardedAction({
      intent: "menu-change",
      targetLabel: findMenuItem(
        nextMenuId,
        localizedMenuGroups,
        (key) => navigation(key as never)
      ).label,
      action: () => {
        const workflowFamily = menuWorkflowFamily(nextMenuId);
        if (!workflowFamily) {
          commitMenuChange(nextMenuId, onCommitted);
          return;
        }

        void fetch("/api/auth/workflow-admission", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workflowFamily }),
        })
          .then(async (response) => {
            const payload = (await response.json().catch(() => null)) as
              | { ok?: boolean; message?: string }
              | null;
            if (!response.ok || !payload?.ok) {
              throw new Error(
                workspace("message.workflowBlocked")
              );
            }
            setWorkspaceError("");
            commitMenuChange(nextMenuId, onCommitted);
          })
          .catch((error: unknown) => {
            setWorkspaceError(
              error instanceof Error
                ? error.message
                : workspace("message.workflowCheckFailed")
            );
          });
      },
    });
  }

  React.useEffect(() => {
    closeWorkspaceWindowRef.current = closeWorkspaceWindow;
    requestMenuChangeRef.current = requestMenuChange;
  });

  async function saveAccountProfile() {
    if (
      isSavingAccountProfile ||
      !accountSettingsDirty ||
      !accountProfile ||
      !accountProfileDraft
    ) {
      return;
    }

    setIsSavingAccountProfile(true);
    setAccountSettingsError("");
    setAccountSettingsMessage("");

    try {
      const response = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: accountProfileDraft.username,
          displayName: accountProfileDraft.displayName,
          phone: accountProfileDraft.phone,
          email: accountProfileDraft.email,
          birthDate: accountProfileDraft.birthDate,
          hireDate: accountProfileDraft.hireDate,
          expectedRevision: accountProfile.revision,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | AccountProfileUpdateResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(
          legacyApiMessage(payload, workspace("message.accountSaveFailed"))
        );
      }

      let nextProfile = payload.profile;
      let refreshDeferred = false;

      if (!nextProfile && payload.receipt?.refreshRequired) {
        try {
          const refreshResponse = await fetch("/api/auth/me", {
            cache: "no-store",
          });
          const refreshPayload = (await refreshResponse
            .json()
            .catch(() => null)) as AccountProfileResponse | null;
          if (
            !refreshResponse.ok ||
            !refreshPayload?.ok ||
            !refreshPayload.authenticated ||
            !refreshPayload.profile
          ) {
            throw new Error(
              legacyApiMessage(
                refreshPayload,
                workspace("message.accountRefreshDeferred")
              )
            );
          }
          nextProfile = refreshPayload.profile;
        } catch {
          refreshDeferred = true;
          if (accountProfile && payload.receipt.result.profile) {
            nextProfile = {
              ...accountProfile,
              ...payload.receipt.result.profile,
            };
          }
        }
      }

      if (!nextProfile) {
        throw new Error(workspace("message.accountVerifyFailed"));
      }

      setAccountProfile(nextProfile);
      setAccountProfileDraft({ ...nextProfile });
      setAccountProfileError("");
      setAccountSettingsMessage(
        refreshDeferred
          ? workspace("message.accountSavedRefresh", { message: workspace("message.accountSaved") })
          : workspace("message.accountSaved")
      );
    } catch (error) {
      setAccountSettingsError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setIsSavingAccountProfile(false);
    }
  }

  async function saveAccountPersonalSettings() {
    if (isSavingPersonalSettings || !personalSettingsDirty) {
      return;
    }

    if (
      !accountPersonalSettings.preferences.windowsNotificationsEnabled &&
      personalSettingsDraft.preferences.windowsNotificationsEnabled &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      const permission = await Notification.requestPermission();

      if (permission !== "granted") {
        setAccountPreferencesError(
          workspace("message.notificationPermissionDenied")
        );
        return;
      }
    }

    setIsSavingPersonalSettings(true);
    setAccountPreferencesError("");
    setAccountPreferencesErrorAction(undefined);
    setAccountPreferencesMessage("");

    try {
      const response = await fetch("/api/auth/personal-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: accountPersonalSettings.revision,
          locale: personalSettingsDraft.locale,
          preferences: personalSettingsDraft.preferences,
          shortcutBindings: personalSettingsDraft.shortcutBindings,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | PersonalSettingsResponse
        | null;

      if (!response.ok || !payload?.ok || !payload.personalSettings) {
        setAccountPreferencesErrorAction(payload?.actionCode);
        throw new Error(
          legacyApiMessage(payload, workspace("message.preferencesSaveFailed"))
        );
      }

      const savedSettings = clonePersonalSettings(payload.personalSettings);
      setAccountPersonalSettings(savedSettings);
      setPersonalSettingsDraft(clonePersonalSettings(savedSettings));
      setAccountPreferencesLoaded(true);
      setAccountPreferencesMessage(workspace("message.preferencesSaved"));
      publishLocale({
        locale: savedSettings.locale,
        revision: savedSettings.revision,
        source: localeBroadcastSourceRef.current,
      });
    } catch (error) {
      setAccountPreferencesError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setIsSavingPersonalSettings(false);
    }
  }

  function renderAccountCard() {
    if (!accountCardOpen) {
      return null;
    }

    const profile = accountProfile ?? accountProfileFromUser(currentUser);

    return (
      <div
        ref={accountCardRef}
        className="absolute right-0 top-11 z-50 max-h-[calc(100vh-4.5rem)] w-[420px] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-md border bg-popover shadow-lg"
      >
        <div className="border-b p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary">
                  <UserRound className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    {profile.displayName}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    @{profile.username}
                  </div>
                </div>
              </div>
            </div>
            <Badge variant={profile.isActive ? "success" : "neutral"}>
              {profile.isActive
                ? workspace("account.active")
                : workspace("account.inactive")}
            </Badge>
          </div>
        </div>

        <div className="grid gap-3 p-4">
          {isAccountProfileLoading ? (
            <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
              {workspace("account.loading")}
            </div>
          ) : null}

          {accountProfileError ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {accountProfileError}
            </div>
          ) : null}

          <div className="grid gap-2">
            <AccountInfoRow
              label={workspace("account.role")}
              value={
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary">{roleLabels[profile.role] ?? profile.role}</Badge>
                  {profile.isDeveloper ? (
                    <Badge variant="warning">{workspace("account.developer")}</Badge>
                  ) : null}
                </div>
              }
            />
            <AccountInfoRow
              label={workspace("account.contact")}
              value={
                <div className="grid gap-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Phone className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{profile.phone || "-"}</span>
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Mail className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{profile.email || "-"}</span>
                  </span>
                </div>
              }
            />
            <AccountInfoRow
              label={workspace("account.employment")}
              value={
                <div className="grid gap-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
                    <span>{workspace("account.birthday", { date: formatAccountDate(profile.birthDate).slice(0, 10) })}</span>
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
                    <span>{workspace("account.hireDate", { date: formatAccountDate(profile.hireDate).slice(0, 10) })}</span>
                  </span>
                </div>
              }
            />
            <AccountInfoRow
              label={workspace("account.security")}
              value={
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant={profile.totpEnabled ? "success" : "neutral"}>
                    <ShieldCheck className="mr-1 size-3" />
                    {profile.totpEnabled
                      ? workspace("account.otpEnabled")
                      : workspace("account.otpDisabled")}
                  </Badge>
                  {profile.totpEnabled ? (
                    <Badge variant="neutral">
                      {workspace("account.recoveryCodes", { count: profile.recoveryCodeCount })}
                    </Badge>
                  ) : null}
                </div>
              }
            />
            <AccountInfoRow
              label={workspace("account.mobile")}
              value={
                <div className="flex flex-wrap gap-1.5">
                  <Badge
                    variant={
                      profile.mobilePackingEnabled ? "success" : "neutral"
                    }
                  >
                    <Smartphone className="mr-1 size-3" />
                    {profile.mobilePackingEnabled
                      ? workspace("account.packingAllowed")
                      : workspace("account.packingDenied")}
                  </Badge>
                  <Badge variant="neutral">
                    {workspace("account.registeredDevices", { count: profile.activeMobileDeviceCount })}
                  </Badge>
                </div>
              }
            />
            <AccountInfoRow
              label={workspace("account.created")}
              value={formatAccountDate(profile.createdAt)}
            />
            <AccountInfoRow
              label={workspace("account.updated")}
              value={formatAccountDate(profile.updatedAt)}
            />
          </div>
        </div>

        <div className="border-t p-3">
          <Button
            className="w-full justify-between"
            type="button"
            variant="outline"
            onClick={() => {
              requestMenuChange("personal-settings", () => {
                setAccountCardOpen(false);
              });
            }}
          >
            <span className="flex items-center gap-2">
              <Settings2 className="size-4 text-muted-foreground" />
              {workspace("account.personalSettings")}
            </span>
            <ChevronRight className="size-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
    );
  }

  function toggleGroup(groupId: string) {
    setOpenGroupIds((current) => {
      const next = new Set(current);

      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }

      return next;
    });
  }

  function renderContent() {
    const inspectionWorkspaceProps = {
      currentUser: effectiveCurrentUser,
      records: inspectionRecords,
      setRecords: setInspectionRecords,
      selectedRecordIds: selectedInspectionRecordIds,
      setSelectedRecordIds: setSelectedInspectionRecordIds,
      onUploadComplete: () => undefined,
    };

    if (selectedMenuId === "personal-settings") {
      return (
        <PersonalSettingsView
          account={accountProfileDraft}
          accountLoaded={Boolean(
            accountProfile?.updatedAt && accountProfileDraft
          )}
          accountSaving={isSavingAccountProfile}
          accountDirty={accountSettingsDirty}
          accountMessage={accountSettingsMessage}
          accountError={accountSettingsError || accountProfileError}
          onAccountChange={changeAccountProfile}
          onAccountCancel={discardAccountProfileChanges}
          onAccountSave={() => void saveAccountProfile()}
          onTotpStatusChange={applyTotpStatus}
          onMobileActiveCountChange={applyMobileActiveCount}
          settings={personalSettingsDraft}
          loaded={accountPreferencesLoaded}
          saving={isSavingPersonalSettings}
          dirty={personalSettingsDirty}
          message={accountPreferencesMessage}
          error={
            accountPreferencesError ||
            (!accountPreferencesLoaded ? accountProfileError : "")
          }
          errorActionCode={accountPreferencesErrorAction}
          onPreferenceChange={changePersonalPreference}
          onLocaleChange={changePersonalLocale}
          onShortcutChange={changeShortcutBinding}
          onCancel={discardPersonalSettingsChanges}
          onResetDefaults={resetPersonalSettingsDefaults}
          onSave={() => void saveAccountPersonalSettings()}
        />
      );
    }

    if (selectedMenuId === "dashboard") {
      return <DashboardView />;
    }

    if (selectedMenuId === "inventory-search") {
      return (
        <InventorySearchView
          selectedPgNo={selectedDevice?.pgNo ?? requestedDevicePgNo}
          onOpenDevice={(pgNo) => void openDevice(pgNo)}
        />
      );
    }

    if (selectedMenuId === "inventory-audit") {
      return <InventoryAuditView />;
    }

    if (selectedMenuId === "inventory-quantity-ledger") {
      return (
        <InventoryQuantityLedgerView
          onOpenInventoryEdit={(pgNo) => {
            requestMenuChange("inventory-edit", () => {
              setFocusedInventoryEditPgNo(pgNo);
            });
          }}
        />
      );
    }

    if (selectedMenuId === "inventory-edit") {
      return (
        <InventoryEditView
          initialPgNo={focusedInventoryEditPgNo}
          isWorkspaceRefreshing={isRefreshingWorkspace}
          onInitialPgNoConsumed={consumeFocusedInventoryEditPgNo}
        />
      );
    }

    if (selectedMenuId === "inventory-manage") {
      return <InventoryManageView />;
    }

    if (selectedMenuId === "supplies-inventory") {
      return <SuppliesManagementView mode="inventory" />;
    }

    if (selectedMenuId === "supplies-forecast") {
      return <SuppliesManagementView mode="forecast" />;
    }

    if (selectedMenuId === "supplies-repurchase") {
      return <SuppliesManagementView mode="reorder" />;
    }

    if (selectedMenuId === "shipment-all-orders") {
      return (
        <ShipmentOrderListView
          mode="all"
          onOpenPreShipmentReturns={() =>
            requestMenuChange("return-before-shipment")
          }
          onOpenWriteReview={(requestId) => {
            requestMenuChange("admin-sales-channel-sync-check", () => {
              setFocusedSyncCheckWriteRequestId(requestId);
            });
          }}
        />
      );
    }

    if (selectedMenuId === "shipment-matched") {
      return (
        <ShipmentOrderListView
          mode="matched"
          focusedOutput={focusedShipmentOutput}
          onFocusedOutputConsumed={consumeFocusedShipmentOutput}
          onReturnFromFocusedOutput={(menuId) =>
            requestMenuChange(menuId as MenuItemId)
          }
          onOpenPreShipmentReturns={() =>
            requestMenuChange("return-before-shipment")
          }
          onOpenWriteReview={(requestId) => {
            requestMenuChange("admin-sales-channel-sync-check", () => {
              setFocusedSyncCheckWriteRequestId(requestId);
            });
          }}
        />
      );
    }

    if (selectedMenuId === "shipment-delivery-changes") {
      return (
        <ShipmentAddressChangeListView
          canManage={canAccessRole(effectiveCurrentUser.role, "MANAGER")}
          onOpenSourceMenu={(menuId, search) => {
            requestMenuChange(menuId as MenuItemId, () => {
              if (menuId === "invoice-registration-failures") {
                setFocusedInvoiceRecoverySearch(search ?? "");
              }
            });
          }}
          onOpenShipmentOutput={(focus) => {
            requestMenuChange("shipment-matched", () => {
              setFocusedShipmentOutput(focus);
            });
          }}
        />
      );
    }

    if (selectedMenuId === "shipment-today") {
      return <ShipmentPrintedListView />;
    }

    if (selectedMenuId === "shipment-in-transit") {
      return <ShipmentInTransitListView />;
    }

    if (selectedMenuId === "shipment-delivery-search") {
      return <ShipmentDeliverySearchView />;
    }

    if (selectedMenuId === "invoice-issue-history") {
      return <InvoiceIssueHistoryView />;
    }

    if (selectedMenuId === "invoice-manual-issue") {
      return (
        <InvoiceManualIssueView
          onOpenWriteReview={(requestId) => {
            requestMenuChange("admin-sales-channel-sync-check", () => {
              setFocusedSyncCheckWriteRequestId(requestId);
            });
          }}
          onOpenSourceMenu={(menuId, search) => {
            requestMenuChange(menuId as MenuItemId, () => {
              if (menuId === "invoice-registration-failures") {
                setFocusedInvoiceRecoverySearch(search ?? "");
              }
            });
          }}
          onOpenShipmentOutput={(focus) => {
            requestMenuChange("shipment-matched", () => {
              setFocusedShipmentOutput(focus);
            });
          }}
        />
      );
    }

    if (selectedMenuId === "invoice-registration-failures") {
      return (
        <InvoiceRegistrationFailureView
          initialSearch={focusedInvoiceRecoverySearch}
          onOpenSourceMenu={(menuId) => {
            requestMenuChange(menuId as MenuItemId, () => {
              setFocusedInvoiceRecoverySearch("");
            });
          }}
        />
      );
    }

    if (selectedMenuId === "invoice-carrier-dispatch-settings") {
      return <CarrierDispatchSettingsView />;
    }

    if (selectedMenuId === "return-before-shipment") {
      return (
        <ReturnListView
          phase="before"
          onOpenWriteReview={(requestId) => {
            requestMenuChange("admin-sales-channel-sync-check", () => {
              setFocusedSyncCheckWriteRequestId(requestId);
            });
          }}
        />
      );
    }

    if (selectedMenuId === "return-after-shipment") {
      return (
        <ReturnListView
          phase="after"
          onOpenWriteReview={(requestId) => {
            requestMenuChange("admin-sales-channel-sync-check", () => {
              setFocusedSyncCheckWriteRequestId(requestId);
            });
          }}
        />
      );
    }

    if (selectedMenuId === "inbound-batch") {
      return <SimpleInboundBatchPlanView />;
    }

    if (selectedMenuId === "inbound-purchase-price") {
      return <PurchasePriceCriteriaRateView />;
    }

    if (selectedMenuId === "inbound-purchase-pending") {
      return (
        <PurchasePendingListView
          onOpenDevice={(pgNo) => void openDevice(pgNo)}
        />
      );
    }

    if (selectedMenuId === "admin-product-criteria") {
      return <ProductCriteriaManagerView />;
    }

    if (selectedMenuId === "admin-users") {
      return (
        <SensitiveMenuGate item={activeMenu}>
          <UserAccountManagerView />
        </SensitiveMenuGate>
      );
    }

    if (selectedMenuId === "admin-sales-product-combinations") {
      return <SalesOfferManagerView />;
    }

    if (selectedMenuId === "admin-channel-products") {
      return (
        <SensitiveMenuGate item={activeMenu}>
          <ChannelProductsManagerView />
        </SensitiveMenuGate>
      );
    }

    if (selectedMenuId === "admin-channel-order-matching") {
      return (
        <SensitiveMenuGate item={activeMenu}>
          <ChannelOrderMatchingManagerView />
        </SensitiveMenuGate>
      );
    }

    if (selectedMenuId === "sales-channel-manual-order-match") {
      return <ManualOrderMatchView user={effectiveCurrentUser} />;
    }

    if (selectedMenuId === "admin-order-matching-policy") {
      return (
        <SensitiveMenuGate item={activeMenu}>
          <OrderMatchingPolicyView />
        </SensitiveMenuGate>
      );
    }

    if (selectedMenuId === "admin-staff-work-history") {
      return <EmployeeActivityLogView />;
    }

    if (selectedMenuId === "admin-server-logs") {
      return <ServerJobLogView />;
    }

    if (selectedMenuId === "admin-sales-channel-sync-check") {
      return (
        <SalesChannelSyncCheckView
          initialWriteRequestId={focusedSyncCheckWriteRequestId}
          onOpenSourceMenu={(menuId) => {
            requestMenuChange(menuId as MenuItemId, () => {
              setFocusedSyncCheckWriteRequestId(null);
            });
          }}
          onUnresolvedCountChange={setSalesChannelSyncCheckUnresolvedCount}
        />
      );
    }

    if (selectedMenuId === "admin-system-status") {
      return <SystemStatusView />;
    }

    if (selectedMenuId === "developer-response-performance") {
      return <ResponsePerformanceView />;
    }

    if (selectedMenuId === "admin-security-status") {
      return <SecurityStatusView />;
    }

    if (selectedMenuId === "statistics-purchase") {
      return (
        <StatisticsView
          mode="purchase"
          periodSelection={statisticsPeriodSelection}
          onPeriodSelectionChange={setStatisticsPeriodSelection}
        />
      );
    }

    if (selectedMenuId === "statistics-inventory") {
      return (
        <StatisticsView
          mode="inventory"
          periodSelection={statisticsPeriodSelection}
          onPeriodSelectionChange={setStatisticsPeriodSelection}
        />
      );
    }

    if (selectedMenuId === "statistics-sales") {
      return (
        <StatisticsView
          mode="sales"
          periodSelection={statisticsPeriodSelection}
          onPeriodSelectionChange={setStatisticsPeriodSelection}
        />
      );
    }

    if (selectedMenuId === "statistics-returns") {
      return (
        <StatisticsView
          mode="returns"
          periodSelection={statisticsPeriodSelection}
          onPeriodSelectionChange={setStatisticsPeriodSelection}
        />
      );
    }

    if (
      selectedMenuId === "developer-diagnostics" ||
      selectedMenuId === "developer-api-sandbox" ||
      selectedMenuId === "developer-adb-diagnostics" ||
      selectedMenuId === "developer-db-migrations"
    ) {
      return (
        <DeveloperToolsView
          currentUser={effectiveCurrentUser}
          mode={selectedMenuId}
        />
      );
    }

    if (sensitiveMenuIds.has(selectedMenuId)) {
      return (
        <SensitiveMenuGate item={activeMenu}>
          <PendingMenuView item={activeMenu} />
        </SensitiveMenuGate>
      );
    }

    if (selectedMenuId === "inbound-appearance") {
      return (
        <InspectionWorkspace
          {...inspectionWorkspaceProps}
          defaultTab="appearance"
        />
      );
    }

    if (selectedMenuId === "inbound-function") {
      return (
        <InspectionWorkspace
          {...inspectionWorkspaceProps}
          defaultTab="function"
        />
      );
    }

    if (selectedMenuId === "inbound-upload-pending") {
      return (
        <InspectionWorkspace
          {...inspectionWorkspaceProps}
          defaultTab="records"
        />
      );
    }

    return <PendingMenuView item={activeMenu} />;
  }

  const activeGroup = allowedMenuGroups.find((group) =>
    group.items.some((item) => item.id === selectedMenuId)
  );
  const activeAreaLabel =
    selectedMenuId === "personal-settings"
      ? workspace("area.account")
      : activeGroup?.label ?? workspace("area.menu");

  return (
    <main className="flex h-screen min-h-screen overflow-hidden bg-background">
      <DesktopCommandPalette groups={allowedMenuGroups} onNavigate={(menuId) => requestMenuChange(menuId)} />
      <aside
        className={cn(
          "flex shrink-0 flex-col border-r bg-popover transition-[width]",
          sidebarCollapsed ? "w-[72px]" : "w-[280px]"
        )}
      >
        <div
          className={cn(
            "flex h-14 items-center border-b px-3",
            sidebarCollapsed ? "justify-center" : "justify-between"
          )}
        >
          {!sidebarCollapsed ? (
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Database className="size-4" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold">QuickHack</h1>
                <p className="truncate text-xs text-muted-foreground">
                  ERP/WMS
                </p>
              </div>
            </div>
          ) : null}
          <Button
            aria-label={sidebarCollapsed ? workspace("sidebar.expand") : workspace("sidebar.collapse")}
            size="icon"
            title={sidebarCollapsed ? workspace("sidebar.expand") : workspace("sidebar.collapse")}
            variant="ghost"
            onClick={() => setSidebarCollapsed((current) => !current)}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </Button>
        </div>

        <nav
          ref={sidebarNavRef}
          className="min-h-0 flex-1 overflow-y-auto p-2"
        >
          <div className="grid gap-2">
            {allowedMenuGroups.map((group) => {
              const GroupIcon = group.icon;
              const isOpen = sidebarCollapsed || openGroupIds.has(group.id);

              return (
                <div key={group.id} className="grid gap-1">
                  {!sidebarCollapsed ? (
                    <button
                      className="flex h-8 items-center gap-2 rounded-md px-2 text-xs font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground"
                      type="button"
                      onClick={() => toggleGroup(group.id)}
                    >
                      <GroupIcon className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-left">
                        {group.label}
                      </span>
                      {isOpen ? (
                        <ChevronDown className="size-4" />
                      ) : (
                        <ChevronRight className="size-4" />
                      )}
                    </button>
                  ) : null}

                  {isOpen ? (
                    <div
                      className={cn(
                        "grid gap-1",
                        !sidebarCollapsed && "pl-2"
                      )}
                    >
                      {group.items.map((item) => {
                        const Icon = item.icon;
                        const isActive = item.id === selectedMenuId;

                        return (
                          <button
                            key={item.id}
                            data-quickhack-menu-id={item.id}
                            className={cn(
                              "relative flex h-9 min-w-0 items-center rounded-md text-sm transition-colors",
                              sidebarCollapsed
                                ? "justify-center px-0"
                                : "gap-2 px-2",
                              isActive
                                ? "bg-primary text-primary-foreground"
                                : "text-foreground hover:bg-secondary"
                            )}
                            title={item.label}
                            type="button"
                            onClick={() => {
                              requestMenuChange(item.id, () => {
                                if (
                                  item.id ===
                                  "admin-sales-channel-sync-check"
                                ) {
                                  setFocusedSyncCheckWriteRequestId(null);
                                }
                                if (item.id === "inventory-edit") {
                                  setFocusedInventoryEditPgNo(null);
                                }
                              });
                            }}
                          >
                            <Icon className="size-4 shrink-0" />
                            {!sidebarCollapsed ? (
                              <span className="min-w-0 flex-1 truncate text-left">
                                {item.label}
                              </span>
                            ) : null}
                            {item.id === "admin-sales-channel-sync-check" &&
                            salesChannelSyncCheckUnresolvedCount > 0 ? (
                              <Badge
                                className={cn(
                                  "h-5 min-w-5 justify-center px-1 text-[10px]",
                                  sidebarCollapsed && "absolute right-0 top-0"
                                )}
                                variant="danger"
                              >
                                {salesChannelSyncCheckUnresolvedCount > 99
                                  ? "99+"
                                  : salesChannelSyncCheckUnresolvedCount}
                              </Badge>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </nav>

      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center justify-between gap-4 border-b bg-popover px-5 py-2">
          <div className="min-w-0">
            <div className="text-xs font-medium text-muted-foreground">
              {activeAreaLabel}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-base font-semibold">
                {activeMenu.label}
              </h1>
              <span className="hidden min-w-0 truncate text-xs text-muted-foreground lg:block">
                {activeMenu.description}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DesktopNotificationCenter
              enabled={accountPersonalSettings.preferences.windowsNotificationsEnabled}
              onNavigate={(menuId) => requestMenuChange(menuId as MenuItemId)}
            />
            {accountProfile?.isBirthdayToday ? (
              <span className="whitespace-nowrap rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700">
                {workspace("header.birthday")}{" "}
                <span aria-hidden="true">🥳🎉🎁</span>
              </span>
            ) : null}
            <div className="relative">
              <button
                ref={accountButtonRef}
                type="button"
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md border bg-background px-2.5 text-sm transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  accountCardOpen && "bg-secondary"
                )}
                aria-expanded={accountCardOpen}
                aria-haspopup="dialog"
                title={workspace("header.account")}
                onClick={() => setAccountCardOpen((open) => !open)}
              >
                <UserRound className="size-4 text-muted-foreground" />
                <div className="hidden min-w-0 leading-tight md:block">
                  <div className="max-w-36 truncate text-left font-medium">
                    {effectiveCurrentUser.displayName}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span>{roleLabels[effectiveCurrentUser.role]}</span>
                    {effectiveCurrentUser.isDeveloper ? (
                      <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                        {workspace("account.developer")}
                      </span>
                    ) : null}
                  </div>
                </div>
              </button>
              {renderAccountCard()}
            </div>
            <Button
              variant="outline"
              size="sm"
              data-quickhack-global-refresh="true"
              onClick={() => {
                void reloadActiveMenuContent();
              }}
              disabled={isRefreshingWorkspace}
              title={workspace("header.refreshTitle")}
            >
              <RefreshCcw
                className={cn("size-4", isRefreshingWorkspace && "animate-spin")}
              />
              {isRefreshingWorkspace
                ? workspace("header.refreshing")
                : workspace("header.refresh")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleLogout}
              disabled={isLoggingOut}
              title={workspace("header.logout")}
            >
              <LogOut className="size-4" />
              {workspace("header.logout")}
            </Button>
          </div>
        </header>

        {workspaceError ? (
          <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-700">
            {workspaceError}
          </div>
        ) : null}
        <DesktopUpdateStatus />

        <div
          key={`${selectedMenuId}:${contentRefreshRevision}`}
          className="flex min-h-0 flex-1 overflow-hidden"
          data-quickhack-active-content="true"
        >
          {renderContent()}
        </div>
      </section>

      <DeviceSheet
        device={selectedDevice}
        requestedPgNo={requestedDevicePgNo}
        loading={isDeviceDetailLoading}
        error={deviceDetailError}
        onRetry={() => void openDevice(requestedDevicePgNo)}
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open);
          if (!open) deviceDetailAbortRef.current?.abort();
        }}
      />
      <ShortcutGuideDialog
        bindings={accountPersonalSettings.shortcutBindings}
        open={shortcutGuideOpen}
        onOpenChange={setShortcutGuideOpen}
      />
    </main>
  );
}
