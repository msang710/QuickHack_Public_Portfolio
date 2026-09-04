// QuickHack note: 리더급 사용자가 직원 계정, 권한, 활성 상태를 관리하는 화면 초안입니다.
"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useLocale, useTranslations } from "next-intl";
import {
  CheckCircle2,
  CircleOff,
  KeyRound,
  RefreshCcw,
  Save,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  UserPlus,
  UsersRound,
} from "lucide-react";
import {
  ROLE_RANK,
  ROLES,
  type Role,
} from "@/quickhack_shared/auth/auth-constants";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { Input } from "@/quickhack_client/components/ui/input";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import {
  SummaryMetric as SummaryCard,
  SummaryStrip,
} from "@/quickhack_client/components/ui/summary-metric";
import {
  MasterDetailLayout,
  PanelToolbar,
  WorkspacePageFrame,
  WorkspacePanel,
} from "@/quickhack_client/components/ui/workspace-layout";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import {
  type DataGridColumn,
  VirtualizedDataGrid,
} from "@/quickhack_client/components/ui/virtualized-data-grid";
import { DetailRow, formatDate } from "@/quickhack_client/components/shared/device-detail-sheet";
import { cn } from "@/quickhack_shared/core/utils";
import { isAdbVirtualSerial } from "@/quickhack_shared/adb/adb-target-policy";
import { ADB_CLIENT_API_MESSAGE_KEYS, isAdbClientApiCode } from "@/quickhack_client/api/adb/client-api-codes";
import {
  AccountFieldLabel,
  AccountInformationFields,
} from "@/quickhack_client/components/user/account-information-fields";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";
import {
  applyAdbSuggestionAsCleanBaseline,
  emptyMobileRegistrationDraft,
  MOBILE_REGISTRATION_FORM_IDS,
  mobileRegistrationDraftsEqual,
  ONE_TIME_RESULT_FORM_IDS,
  oneTimeResultIsPending,
  type MobileRegistrationDraft,
} from "@/quickhack_client/components/user/mobile-registration-draft-state";

type UserAccountDto = {
  userId: number;
  username: string;
  displayName: string;
  phone: string;
  email: string;
  birthDate: string;
  hireDate: string;
  role: string;
  isDeveloper: boolean;
  mobilePackingEnabled: boolean;
  mustChangePassword: boolean;
  isActive: boolean;
  totpEnabled: boolean;
  totpVerifiedAt: string;
  totpLockedUntil: string;
  recoveryCodeCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type UserAccountsApiResponse = {
  ok: boolean;
  resultCode?:
    | "ACCOUNT_CREATED"
    | "ACCOUNT_AND_PASSWORD_SAVED"
    | "ACCOUNT_SAVED";
  message?: string;
  items?: UserAccountDto[];
  item?: UserAccountDto;
  recoveryCodes?: string[];
};

type MobileRegisteredDeviceDto = {
  deviceId: number;
  registrationRevision: number;
  registrationState: "PROVISIONING" | "ACTIVE" | "REAUTH_REQUIRED" | "REVOKED";
  userId: number;
  username: string;
  displayName: string;
  label: string;
  adbSerialPreview: string;
  publicKeyFingerprint: string;
  activatedAt: string;
  provisioningExpiresAt: string;
  lastSeenAt: string;
  revokedAt: string;
  createdAt: string;
  updatedAt: string;
};

type MobileDevicesApiResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  details?: string;
  items?: MobileRegisteredDeviceDto[];
  item?: MobileRegisteredDeviceDto;
  nextCursor?: string | null;
  hasMore?: boolean;
};

type AdbDeviceDto = {
  serial?: string;
  connectionState?: string;
  modelCode?: string;
};

type AdbDevicesApiResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  details?: string;
  devices?: AdbDeviceDto[];
};

type UserAccountDraft = {
  username: string;
  displayName: string;
  phone: string;
  email: string;
  birthDate: string;
  hireDate: string;
  role: Role;
  isDeveloper: boolean;
  mobilePackingEnabled: boolean;
  isActive: boolean;
  tempPassword: string;
};

type UserColumnKey =
  | "username"
  | "displayName"
  | "contact"
  | "role"
  | "status"
  | "otp"
  | "developer"
  | "updatedAt";

const emptyDraft: UserAccountDraft = {
  username: "",
  displayName: "",
  phone: "",
  email: "",
  birthDate: "",
  hireDate: "",
  role: "STAFF",
  isDeveloper: false,
  mobilePackingEnabled: false,
  isActive: true,
  tempPassword: "",
};
const USER_ACCOUNT_FORM_ID = "admin.user-account-draft";
const USER_ACCOUNT_TARGET_FORM_IDS = [
  USER_ACCOUNT_FORM_ID,
  MOBILE_REGISTRATION_FORM_IDS.admin,
  ONE_TIME_RESULT_FORM_IDS.adminRecoveryCodes,
] as const;
const userTableCellClassName = "flex h-full min-w-0 items-center px-3";

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

function normalizeRole(value: string): Role {
  return isRole(value) ? value : "VIEWER";
}

function roleLabel(role: string, labels: Record<Role, string>) {
  const normalized = normalizeRole(role);
  return labels[normalized] ?? normalized;
}

function userSearchText(
  user: UserAccountDto,
  labels: Record<Role, string>,
  keywords: { developer: string; packing: string; active: string; inactive: string; passwordChange: string; otpConfigured: string; otpUnconfigured: string }
) {
  return [
    user.username,
    user.displayName,
    user.phone,
    user.email,
    user.birthDate,
    user.hireDate,
    roleLabel(user.role, labels),
    user.role,
    user.isDeveloper ? keywords.developer : "",
    user.mobilePackingEnabled ? keywords.packing : "",
    user.isActive ? keywords.active : keywords.inactive,
    user.mustChangePassword ? keywords.passwordChange : "",
    user.totpEnabled ? keywords.otpConfigured : keywords.otpUnconfigured,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function draftFromUser(user: UserAccountDto): UserAccountDraft {
  return {
    username: user.username,
    displayName: user.displayName,
    phone: user.phone ?? "",
    email: user.email ?? "",
    birthDate: user.birthDate ?? "",
    hireDate: user.hireDate ?? "",
    role: normalizeRole(user.role),
    isDeveloper: user.isDeveloper,
    mobilePackingEnabled: user.mobilePackingEnabled,
    isActive: user.isActive,
    tempPassword: "",
  };
}

function UserStatusBadge({ user }: { user: UserAccountDto }) {
  const t = useTranslations("admin.userAccount");
  return (
    <div className="flex items-center gap-1.5">
      <Badge variant={user.isActive ? "success" : "neutral"}>
        {user.isActive ? t("common.active") : t("common.inactive")}
      </Badge>
      {user.mustChangePassword ? (
        <Badge variant="warning">{t("common.passwordChange")}</Badge>
      ) : null}
    </div>
  );
}

function UserRoleBadge({ user }: { user: UserAccountDto }) {
  const t = useTranslations("admin.userAccount");
  const labels: Record<Role, string> = { LEADER: t("role.leader"), MANAGER: t("role.manager"), STAFF: t("role.staff"), VIEWER: t("role.viewer") };
  return (
    <div className="flex items-center gap-1.5">
      <Badge variant={user.role === "LEADER" ? "default" : "secondary"}>
        {roleLabel(user.role, labels)}
      </Badge>
      {user.isDeveloper ? <Badge variant="warning">{t("common.developer")}</Badge> : null}
      {user.mobilePackingEnabled ? (
        <Badge variant="success">{t("common.packing")}</Badge>
      ) : null}
    </div>
  );
}

export function UserAccountManagerView() {
  const t = useTranslations("admin.userAccount");
  const adbT = useTranslations("common.adbApi");
  const locale = useLocale();
  const roleLabels: Record<Role, string> = React.useMemo(() => ({ LEADER: t("role.leader"), MANAGER: t("role.manager"), STAFF: t("role.staff"), VIEWER: t("role.viewer") }), [t]);
  const roleDescriptions: Record<Role, string> = React.useMemo(() => ({ LEADER: t("role.leaderDescription"), MANAGER: t("role.managerDescription"), STAFF: t("role.staffDescription"), VIEWER: t("role.viewerDescription") }), [t]);
  const { runGuardedAction } = useUnsavedChanges();
  const [users, setUsers] = React.useState<UserAccountDto[]>([]);
  const [query, setQuery] = React.useState("");
  const [roleFilter, setRoleFilter] = React.useState<"ALL" | Role>("ALL");
  const [statusFilter, setStatusFilter] = React.useState<
    "ALL" | "ACTIVE" | "INACTIVE"
  >("ALL");
  const [selectedUserId, setSelectedUserId] = React.useState<number | "NEW" | null>(
    null
  );
  const selectedUserIdRef = React.useRef<number | "NEW" | null>(null);
  const [draft, setDraft] = React.useState<UserAccountDraft>(emptyDraft);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[]>([]);
  const [recoveryCodesAcknowledged, setRecoveryCodesAcknowledged] =
    React.useState(true);
  const [mobileDevices, setMobileDevices] = React.useState<MobileRegisteredDeviceDto[]>([]);
  const [mobileDevicesNextCursor, setMobileDevicesNextCursor] = React.useState<string | null>(null);
  const [adbDevices, setAdbDevices] = React.useState<AdbDeviceDto[]>([]);
  const [selectedAdbSerial, setSelectedAdbSerial] = React.useState("");
  const [mobileDeviceLabel, setMobileDeviceLabel] = React.useState("");
  const [mobileRegistrationBaseline, setMobileRegistrationBaseline] =
    React.useState<MobileRegistrationDraft>(emptyMobileRegistrationDraft);
  const [mobileDeviceMessage, setMobileDeviceMessage] = React.useState("");
  const [isMobileDeviceBusy, setIsMobileDeviceBusy] = React.useState(false);

  const selectedUser = React.useMemo(
    () => users.find((user) => user.userId === selectedUserId) ?? null,
    [selectedUserId, users]
  );
  const isNewDraft = selectedUserId === "NEW";
  const draftBaseline = React.useMemo(
    () => (selectedUser ? draftFromUser(selectedUser) : emptyDraft),
    [selectedUser]
  );
  const isDraftDirty =
    (selectedUser !== null || isNewDraft) &&
    !unsavedFormSnapshotsEqual(draftBaseline, draft);
  const discardDraft = React.useCallback(() => {
    setDraft({ ...draftBaseline });
    setMessage("");
  }, [draftBaseline]);

  useUnsavedForm({
    id: USER_ACCOUNT_FORM_ID,
    label: selectedUser
      ? `${selectedUser.displayName} · ${t("detail.title")}`
      : t("detail.newAccount"),
    enabled: selectedUser !== null || isNewDraft,
    isDirty: isDraftDirty,
    isBusy: isSaving,
    discard: discardDraft,
  });

  const mobileRegistrationDraft = React.useMemo(
    () => ({
      adbSerial: selectedAdbSerial,
      label: mobileDeviceLabel,
    }),
    [mobileDeviceLabel, selectedAdbSerial]
  );

  const discardMobileRegistrationDraft = React.useCallback(() => {
    setSelectedAdbSerial(mobileRegistrationBaseline.adbSerial);
    setMobileDeviceLabel(mobileRegistrationBaseline.label);
    setMobileDeviceMessage("");
  }, [mobileRegistrationBaseline]);

  const discardRecoveryCodes = React.useCallback(() => {
    setRecoveryCodes([]);
    setRecoveryCodesAcknowledged(true);
  }, []);

  useUnsavedForm({
    id: MOBILE_REGISTRATION_FORM_IDS.admin,
    label: selectedUser
      ? `${selectedUser.displayName} · ${t("mobile.title")}`
      : t("mobile.title"),
    enabled: selectedUser !== null,
    isDirty: !mobileRegistrationDraftsEqual(
      mobileRegistrationBaseline,
      mobileRegistrationDraft
    ),
    isBusy: isMobileDeviceBusy,
    discard: discardMobileRegistrationDraft,
  });

  useUnsavedForm({
    id: ONE_TIME_RESULT_FORM_IDS.adminRecoveryCodes,
    label: selectedUser
      ? `${selectedUser.displayName} · ${t("otp.issue")}`
      : t("otp.issue"),
    kind: "one-time-result",
    enabled: selectedUser !== null,
    isDirty: oneTimeResultIsPending(
      recoveryCodes,
      recoveryCodesAcknowledged
    ),
    discard: discardRecoveryCodes,
  });

  const loadMobileDevices = React.useCallback(async (
    userId: number,
    cursor?: string | null,
    append = false
  ) => {
    const query = new URLSearchParams({ userId: String(userId) });
    if (cursor) query.set("cursor", cursor);
    const response = await fetch(`/api/admin/mobile-devices?${query.toString()}`, {
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => null)) as
      | MobileDevicesApiResponse
      | null;

    if (!response.ok || !payload?.ok) {
      throw new Error(legacyApiMessage(payload, t("message.mobileDevicesLoadFailed")));
    }

    setMobileDevices((current) =>
      append ? [...current, ...(payload.items ?? [])] : payload.items ?? []
    );
    setMobileDevicesNextCursor(
      payload.hasMore ? payload.nextCursor ?? null : null
    );
  }, [t]);

  const loadUsers = React.useCallback(async () => {
    setIsLoading(true);
    setMessage("");

    try {
      const response = await fetch("/api/admin/users", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as
        | UserAccountsApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(legacyApiMessage(payload, t("message.usersLoadFailed")));
      }

      const items = payload.items ?? [];
      const currentSelectedUserId = selectedUserIdRef.current;
      const nextSelectedUserId =
        currentSelectedUserId === "NEW"
          ? "NEW"
          : currentSelectedUserId &&
              items.some((user) => user.userId === currentSelectedUserId)
            ? currentSelectedUserId
            : items[0]?.userId ?? null;
      const nextSelectedUser =
        typeof nextSelectedUserId === "number"
          ? items.find((user) => user.userId === nextSelectedUserId) ?? null
          : null;

      setUsers(items);
      selectedUserIdRef.current = nextSelectedUserId;
      setSelectedUserId(nextSelectedUserId);
      setDraft(
        nextSelectedUserId === "NEW"
          ? emptyDraft
          : nextSelectedUser
            ? draftFromUser(nextSelectedUser)
            : emptyDraft
      );
      if (nextSelectedUserId !== currentSelectedUserId) {
        const emptyMobileDraft = emptyMobileRegistrationDraft();
        setMobileDevices([]);
        setMobileDevicesNextCursor(null);
        setAdbDevices([]);
        setSelectedAdbSerial(emptyMobileDraft.adbSerial);
        setMobileDeviceLabel(emptyMobileDraft.label);
        setMobileRegistrationBaseline(emptyMobileDraft);
        setRecoveryCodes([]);
        setRecoveryCodesAcknowledged(true);
        setMobileDeviceMessage("");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadUsers();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [loadUsers]);

  React.useEffect(() => {
    if (typeof selectedUserId !== "number") {
      return;
    }

    const timerId = window.setTimeout(() => {
      void loadMobileDevices(selectedUserId).catch((error) => {
        setMobileDeviceMessage(error instanceof Error ? error.message : String(error));
      });
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [loadMobileDevices, selectedUserId]);

  const filteredUsers = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return users
      .filter((user) => {
        if (roleFilter !== "ALL" && normalizeRole(user.role) !== roleFilter) {
          return false;
        }

        if (statusFilter === "ACTIVE" && !user.isActive) {
          return false;
        }

        if (statusFilter === "INACTIVE" && user.isActive) {
          return false;
        }

        if (!normalizedQuery) {
          return true;
        }

        return userSearchText(user, roleLabels, {
          developer: t("searchKeyword.developer"), packing: t("searchKeyword.packing"),
          active: t("searchKeyword.active"), inactive: t("searchKeyword.inactive"),
          passwordChange: t("searchKeyword.passwordChange"), otpConfigured: t("searchKeyword.otpConfigured"),
          otpUnconfigured: t("searchKeyword.otpUnconfigured"),
        }).includes(normalizedQuery);
      })
      .sort((left, right) => {
        if (left.isActive !== right.isActive) {
          return left.isActive ? -1 : 1;
        }

        const roleResult =
          ROLE_RANK[normalizeRole(right.role)] - ROLE_RANK[normalizeRole(left.role)];

        if (roleResult !== 0) {
          return roleResult;
        }

        return left.username.localeCompare(right.username, locale, {
          numeric: true,
          sensitivity: "base",
        });
      });
  }, [locale, query, roleFilter, roleLabels, statusFilter, t, users]);

  const summary = React.useMemo(
    () => ({
      total: users.length,
      active: users.filter((user) => user.isActive).length,
      leader: users.filter((user) => user.role === "LEADER").length,
      developer: users.filter((user) => user.isDeveloper).length,
      mobilePacking: users.filter((user) => user.mobilePackingEnabled).length,
      otp: users.filter((user) => user.totpEnabled).length,
    }),
    [users]
  );

  const columns = React.useMemo<DataGridColumn<UserColumnKey, UserAccountDto>[]>(
    () => [
      {
        key: "username",
        label: t("columns.username"),
        width: "1.2fr",
        cellClassName: "flex h-full min-w-0 items-center pl-4 pr-3",
        text: (user) => user.username,
        render: (user) => (
          <div className="font-semibold tabular-nums">{user.username}</div>
        ),
      },
      {
        key: "displayName",
        label: t("columns.name"),
        width: "1.2fr",
        cellClassName: userTableCellClassName,
        text: (user) => user.displayName,
        render: (user) => <div>{user.displayName}</div>,
      },
      {
        key: "contact",
        label: t("columns.contact"),
        width: "1.5fr",
        cellClassName: userTableCellClassName,
        text: (user) => [user.phone, user.email].filter(Boolean).join(" "),
        render: (user) => (
          <div className="min-w-0 text-sm">
            <div className="truncate">{user.phone || "-"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {user.email || "-"}
            </div>
          </div>
        ),
      },
      {
        key: "role",
        label: t("columns.role"),
        width: "1.3fr",
        cellClassName: userTableCellClassName,
        text: (user) => `${roleLabel(user.role, roleLabels)} ${user.role}`,
        sortValue: (user) => ROLE_RANK[normalizeRole(user.role)],
        render: (user) => <UserRoleBadge user={user} />,
      },
      {
        key: "status",
        label: t("columns.status"),
        width: "0.8fr",
        cellClassName: userTableCellClassName,
        text: (user) => (user.isActive ? t("common.active") : t("common.inactive")),
        render: (user) => <UserStatusBadge user={user} />,
      },
      {
        key: "otp",
        label: "OTP",
        width: "0.9fr",
        cellClassName: userTableCellClassName,
        text: (user) => (user.totpEnabled ? t("searchKeyword.otpConfigured") : t("searchKeyword.otpUnconfigured")),
        render: (user) => (
          <Badge variant={user.totpEnabled ? "success" : "neutral"}>
            {user.totpEnabled ? t("common.configured") : t("common.unconfigured")}
          </Badge>
        ),
      },
      {
        key: "developer",
        label: t("columns.developer"),
        width: "0.8fr",
        cellClassName: userTableCellClassName,
        text: (user) => (user.isDeveloper ? t("searchKeyword.developer") : t("searchKeyword.regular")),
        render: (user) => (
          <span className="text-sm text-muted-foreground">
            {user.isDeveloper ? "Y" : "-"}
          </span>
        ),
      },
      {
        key: "updatedAt",
        label: t("columns.updated"),
        width: "1.2fr",
        cellClassName: "flex h-full min-w-0 items-center pl-3 pr-4",
        text: (user) => user.updatedAt,
        render: (user) => (
          <span className="text-sm text-muted-foreground">
            {formatDate(user.updatedAt)}
          </span>
        ),
      },
    ],
    [roleLabels, t]
  );

  function resetAccountTargetSecurityState() {
    const emptyMobileDraft = emptyMobileRegistrationDraft();
    setRecoveryCodes([]);
    setRecoveryCodesAcknowledged(true);
    setMobileDevices([]);
    setMobileDevicesNextCursor(null);
    setAdbDevices([]);
    setSelectedAdbSerial(emptyMobileDraft.adbSerial);
    setMobileDeviceLabel(emptyMobileDraft.label);
    setMobileRegistrationBaseline(emptyMobileDraft);
    setMobileDeviceMessage("");
  }

  function applyNewDraft() {
    selectedUserIdRef.current = "NEW";
    setSelectedUserId("NEW");
    setDraft(emptyDraft);
    resetAccountTargetSecurityState();
  }

  function startNewDraft() {
    if (selectedUserId === "NEW") {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: USER_ACCOUNT_TARGET_FORM_IDS,
      targetLabel: t("detail.newAccount"),
      action: applyNewDraft,
    });
  }

  function applySelectedUser(user: UserAccountDto) {
    selectedUserIdRef.current = user.userId;
    setSelectedUserId(user.userId);
    setDraft(draftFromUser(user));
    resetAccountTargetSecurityState();
  }

  function selectUser(user: UserAccountDto) {
    if (selectedUserId === user.userId) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: USER_ACCOUNT_TARGET_FORM_IDS,
      targetLabel: `${user.displayName} · ${t("detail.title")}`,
      action: () => applySelectedUser(user),
    });
  }

  function requestUserListReload() {
    runGuardedAction({
      intent: "internal-change",
      formIds: USER_ACCOUNT_TARGET_FORM_IDS,
      targetLabel: t("filter.refresh"),
      action: () => {
        void loadUsers();
      },
    });
  }

  function updateDraft<K extends keyof UserAccountDraft>(
    key: K,
    value: UserAccountDraft[K]
  ) {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function applySavedUser(user: UserAccountDto) {
    setUsers((current) => {
      const exists = current.some((item) => item.userId === user.userId);

      if (!exists) {
        return [...current, user];
      }

      return current.map((item) => (item.userId === user.userId ? user : item));
    });
    selectedUserIdRef.current = user.userId;
    setSelectedUserId(user.userId);
    setDraft(draftFromUser(user));
  }

  async function postUserAction(body: Record<string, unknown>) {
    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | UserAccountsApiResponse
      | null;

    if (!response.ok || !payload?.ok) {
      throw new Error(legacyApiMessage(payload, t("message.userActionFailed")));
    }

    return payload;
  }

  async function postMobileDeviceAction(body: Record<string, unknown>) {
    const response = await fetch("/api/admin/mobile-devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | MobileDevicesApiResponse
      | null;

    if (!response.ok || !payload?.ok) {
      throw new Error(legacyApiMessage(payload, t("message.mobileActionFailed")));
    }

    return payload;
  }

  async function postUsbProvision(device?: MobileRegisteredDeviceDto) {
    if (!selectedUser) {
      throw new Error(t("message.selectAccount"));
    }
    const response = await fetch("/api/adb/mobile-provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "ADMIN",
        userId: selectedUser.userId,
        adbSerial: selectedAdbSerial,
        label: mobileDeviceLabel,
        ...(device
          ? {
              deviceId: device.deviceId,
              expectedRegistrationRevision: device.registrationRevision,
            }
          : {}),
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | MobileDevicesApiResponse
      | null;
    if (!response.ok || !payload?.ok) {
      const localized = isAdbClientApiCode(payload?.code) ? adbT(ADB_CLIENT_API_MESSAGE_KEYS[payload.code]) : t("message.adbLoadFailed");
      throw new Error([localized || t("message.usbProvisionFailed"), payload?.details].filter(Boolean).join(" "));
    }
    return payload;
  }

  async function loadAdbDevices() {
    setIsMobileDeviceBusy(true);
    setMobileDeviceMessage("");

    try {
      const response = await fetch("/api/adb/devices", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as
        | AdbDevicesApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        const localized = isAdbClientApiCode(payload?.code) ? adbT(ADB_CLIENT_API_MESSAGE_KEYS[payload.code]) : t("message.usbProvisionFailed");
        throw new Error(localized || t("message.adbLoadFailed"));
      }

      const devices = (payload.devices ?? []).filter(
        (device) =>
          device.connectionState === "device" &&
          !isAdbVirtualSerial(device.serial)
      );
      const readySerial =
        devices.find((device) => device.connectionState === "device")?.serial ?? "";
      setAdbDevices(devices);
      const nextRegistrationState = applyAdbSuggestionAsCleanBaseline({
        baseline: mobileRegistrationBaseline,
        current: mobileRegistrationDraft,
        suggestedSerial: readySerial,
      });
      setSelectedAdbSerial(nextRegistrationState.current.adbSerial);
      setMobileDeviceLabel(nextRegistrationState.current.label);
      setMobileRegistrationBaseline(nextRegistrationState.baseline);
      setMobileDeviceMessage(
        devices.length ? t("message.adbUpdated") : t("message.adbEmpty")
      );
    } catch (error) {
      setMobileDeviceMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsMobileDeviceBusy(false);
    }
  }

  async function registerSelectedMobileDevice() {
    if (!selectedUser || isMobileDeviceBusy) {
      return;
    }

    if (!selectedUser.mobilePackingEnabled) {
      setMobileDeviceMessage(t("message.enablePackingFirst"));
      return;
    }

    if (!selectedAdbSerial.trim()) {
      setMobileDeviceMessage(t("message.selectUsbDevice"));
      return;
    }

    setIsMobileDeviceBusy(true);
    setMobileDeviceMessage("");

    try {
      const payload = await postUsbProvision();

      if (payload.item) {
        await loadMobileDevices(selectedUser.userId);
      }

      const emptyMobileDraft = emptyMobileRegistrationDraft();
      setSelectedAdbSerial(emptyMobileDraft.adbSerial);
      setMobileDeviceLabel(emptyMobileDraft.label);
      setMobileRegistrationBaseline(emptyMobileDraft);
      setMobileDeviceMessage(isAdbClientApiCode(payload.code) ? adbT(ADB_CLIENT_API_MESSAGE_KEYS[payload.code]) : t("message.usbProvisioned"));
    } catch (error) {
      setMobileDeviceMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsMobileDeviceBusy(false);
    }
  }

  async function renewMobileDevice(device: MobileRegisteredDeviceDto) {
    if (!selectedUser || isMobileDeviceBusy) {
      return;
    }

    setIsMobileDeviceBusy(true);
    setMobileDeviceMessage("");

    try {
      const payload = await postUsbProvision(device);
      await loadMobileDevices(selectedUser.userId);
      setMobileDeviceMessage(isAdbClientApiCode(payload.code) ? adbT(ADB_CLIENT_API_MESSAGE_KEYS[payload.code]) : t("message.usbReprovisioned"));
    } catch (error) {
      setMobileDeviceMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsMobileDeviceBusy(false);
    }
  }

  async function revokeMobileDevice(device: MobileRegisteredDeviceDto) {
    if (!selectedUser || isMobileDeviceBusy) {
      return;
    }

    setIsMobileDeviceBusy(true);
    setMobileDeviceMessage("");

    try {
      await postMobileDeviceAction({
        action: "revoke",
        deviceId: device.deviceId,
        expectedRegistrationRevision: device.registrationRevision,
      });
      await loadMobileDevices(selectedUser.userId);
      setMobileDeviceMessage(t("message.mobileRevoked"));
    } catch (error) {
      setMobileDeviceMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsMobileDeviceBusy(false);
    }
  }

  function requestRegisterSelectedMobileDevice() {
    void registerSelectedMobileDevice();
  }

  function requestRenewMobileDevice(device: MobileRegisteredDeviceDto) {
    void renewMobileDevice(device);
  }

  function requestRevokeMobileDevice(device: MobileRegisteredDeviceDto) {
    if (
      !window.confirm(
        t("mobile.revokeConfirm", { label: device.label || device.adbSerialPreview })
      )
    ) {
      return;
    }

    void revokeMobileDevice(device);
  }

  async function saveCurrentDraft() {
    if (isSaving) {
      return;
    }

    setIsSaving(true);
    setMessage("");

    try {
      const payload = await postUserAction({
        action: "saveUser",
        userId: typeof selectedUserId === "number" ? selectedUserId : null,
        expectedRevision:
          typeof selectedUserId === "number" ? selectedUser?.revision : null,
        username: draft.username,
        displayName: draft.displayName,
        phone: draft.phone,
        email: draft.email,
        birthDate: draft.birthDate,
        hireDate: draft.hireDate,
        role: draft.role,
        isDeveloper: draft.isDeveloper,
        mobilePackingEnabled: draft.mobilePackingEnabled,
        isActive: draft.isActive,
        tempPassword: draft.tempPassword,
      });

      if (payload.item) {
        applySavedUser(payload.item);
      }

      setMessage(
        payload.resultCode === "ACCOUNT_CREATED"
          ? t("message.accountCreated")
          : payload.resultCode === "ACCOUNT_AND_PASSWORD_SAVED"
            ? t("message.accountAndPasswordSaved")
            : t("message.accountSaved")
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function resetSelectedUserTotp() {
    if (!selectedUser || isSaving) {
      return;
    }

    setIsSaving(true);
    setMessage("");

    try {
      const payload = await postUserAction({
        action: "resetTotp",
        userId: selectedUser.userId,
        expectedRevision: selectedUser.revision,
      });

      if (payload.item) {
        applySavedUser(payload.item);
      }

      discardRecoveryCodes();
      setMessage(t("message.otpReset"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function generateSelectedUserRecoveryCodes() {
    if (!selectedUser || isSaving) {
      return;
    }

    setIsSaving(true);
    setMessage("");

    try {
      const payload = await postUserAction({
        action: "generateRecoveryCodes",
        userId: selectedUser.userId,
        expectedRevision: selectedUser.revision,
      });

      if (payload.item) {
        applySavedUser(payload.item);
      }

      setRecoveryCodes(payload.recoveryCodes ?? []);
      setRecoveryCodesAcknowledged(!(payload.recoveryCodes?.length));
      setMessage(t("message.recoveryIssued"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  function requestResetSelectedUserTotp() {
    if (
      !selectedUser ||
      !window.confirm(
        t("otp.resetConfirm", { name: selectedUser.displayName })
      )
    ) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [ONE_TIME_RESULT_FORM_IDS.adminRecoveryCodes],
      targetLabel: t("otp.reset"),
      action: () => {
        void resetSelectedUserTotp();
      },
    });
  }

  function requestGenerateSelectedUserRecoveryCodes() {
    if (
      !selectedUser ||
      !window.confirm(
        t("otp.issueConfirm", { name: selectedUser.displayName })
      )
    ) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [ONE_TIME_RESULT_FORM_IDS.adminRecoveryCodes],
      targetLabel: t("otp.issue"),
      action: () => {
        void generateSelectedUserRecoveryCodes();
      },
    });
  }

  async function deactivateSelectedUser() {
    if (!selectedUser || isSaving) {
      return;
    }

    if (!window.confirm(t("deactivateConfirm", { name: selectedUser.displayName }))) {
      return;
    }

    setIsSaving(true);
    setMessage("");

    try {
      const payload = await postUserAction({
        action: "deactivateUser",
        userId: selectedUser.userId,
        expectedRevision: selectedUser.revision,
      });

      if (payload.item) {
        applySavedUser(payload.item);
      }

      setMessage(t("message.accountDeactivated"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <WorkspacePageFrame className="gap-4 p-5">
      <SummaryStrip className="grid-cols-2 xl:grid-cols-6">
        <SummaryCard icon={UsersRound} label={t("summary.total")} value={summary.total} />
        <SummaryCard icon={ShieldCheck} label={t("summary.active")} value={summary.active} />
        <SummaryCard icon={UsersRound} label={t("summary.leaders")} value={summary.leader} />
        <SummaryCard icon={KeyRound} label={t("summary.otp")} value={summary.otp} />
        <SummaryCard icon={Smartphone} label={t("summary.packing")} value={summary.mobilePacking} />
        <SummaryCard icon={KeyRound} label={t("summary.developer")} value={summary.developer} />
      </SummaryStrip>

      <MasterDetailLayout className="grid-cols-[minmax(620px,1fr)_420px] gap-4">
        <WorkspacePanel>
          <PanelToolbar className="grid-cols-[minmax(240px,1fr)_160px_160px_auto]">
            <SearchInput
              aria-label={t("filter.search")}
              placeholder={t("filter.placeholder")}
              value={query}
              onValueChange={setQuery}
            />
            <Select
              value={roleFilter}
              onValueChange={(value) => setRoleFilter(value as "ALL" | Role)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("common.allRoles")}</SelectItem>
                {ROLES.map((role) => (
                  <SelectItem key={role} value={role}>
                    {roleLabels[role]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(value) =>
                setStatusFilter(value as "ALL" | "ACTIVE" | "INACTIVE")
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("common.allStatuses")}</SelectItem>
                <SelectItem value="ACTIVE">{t("common.active")}</SelectItem>
                <SelectItem value="INACTIVE">{t("common.inactive")}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={requestUserListReload}
              disabled={isLoading}
            >
              <RefreshCcw className="size-4" />
              {t("filter.refresh")}
            </Button>
          </PanelToolbar>

          {message ? (
            <FeedbackBanner tone="warning" className="m-3">
              {message}
            </FeedbackBanner>
          ) : null}

          <VirtualizedDataGrid
            rows={filteredUsers}
            columns={columns}
            rowKey={(user) => user.userId}
            emptyMessage={
              isLoading ? t("grid.loading") : t("grid.empty")
            }
            selectedRowKey={typeof selectedUserId === "number" ? selectedUserId : null}
            onRowClick={selectUser}
            getRowClassName={(user) =>
              cn(!user.isActive && "bg-zinc-50 text-muted-foreground")
            }
            minWidth="1080px"
          />
        </WorkspacePanel>

        <WorkspacePanel as="aside">
          <div className="flex shrink-0 items-center justify-between border-b p-4">
            <div>
              <h2 className="text-sm font-semibold">
                {isNewDraft ? t("detail.newDraft") : t("detail.title")}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("detail.subtitle")}
              </p>
            </div>
            <Button variant="outline" onClick={startNewDraft}>
              <UserPlus className="size-4" />
              {t("detail.newAccount")}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {!selectedUser && !isNewDraft ? (
              <div className="grid h-full place-items-center rounded-md border border-dashed text-sm text-muted-foreground">
                {t("detail.select")}
              </div>
            ) : (
              <div className="grid gap-4">
                <div className="grid gap-3 rounded-md border p-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{t("detail.basic")}</h3>
                    <div className="flex items-center gap-1.5">
                      <Badge variant={isNewDraft ? "warning" : "neutral"}>
                        {isNewDraft ? t("common.new") : t("common.edit")}
                      </Badge>
                      {selectedUser?.mustChangePassword ? (
                        <Badge variant="warning">{t("common.passwordChange")}</Badge>
                      ) : null}
                    </div>
                  </div>

                  <AccountInformationFields
                    value={draft}
                    onChange={updateDraft}
                  />

                  <div className="grid grid-cols-2 gap-3">
                    <AccountFieldLabel label={t("detail.role")}>
                      <Select
                        value={draft.role}
                        onValueChange={(value) =>
                          updateDraft("role", normalizeRole(value))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES.map((role) => (
                            <SelectItem key={role} value={role}>
                              {roleLabels[role]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </AccountFieldLabel>

                    <AccountFieldLabel label={t("detail.status")}>
                      <Select
                        value={draft.isActive ? "ACTIVE" : "INACTIVE"}
                        onValueChange={(value) =>
                          updateDraft("isActive", value === "ACTIVE")
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ACTIVE">{t("common.active")}</SelectItem>
                          <SelectItem value="INACTIVE">{t("common.inactive")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </AccountFieldLabel>
                  </div>

                  <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.isDeveloper}
                      onChange={(event) =>
                        updateDraft("isDeveloper", event.target.checked)
                      }
                    />
                    {t("detail.developerAccess")}
                  </label>

                  <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.mobilePackingEnabled}
                      onChange={(event) =>
                        updateDraft("mobilePackingEnabled", event.target.checked)
                      }
                    />
                    {t("detail.packingAccess")}
                  </label>
                </div>

                {selectedUser ? (
                  <div className="grid gap-3 rounded-md border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold">{t("otp.title")}</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("otp.subtitle")}
                        </p>
                      </div>
                      <Badge variant={selectedUser.totpEnabled ? "success" : "neutral"}>
                        {selectedUser.totpEnabled ? t("common.enabled") : t("common.unconfigured")}
                      </Badge>
                    </div>

                    <div className="grid gap-1 text-xs text-muted-foreground">
                      <DetailRow
                        label={t("otp.verifiedAt")}
                        value={formatDate(selectedUser.totpVerifiedAt)}
                      />
                      <DetailRow
                        label={t("otp.lockedUntil")}
                        value={formatDate(selectedUser.totpLockedUntil)}
                      />
                      <DetailRow
                        label={t("otp.remaining")}
                        value={t("common.count", { count: selectedUser.recoveryCodeCount })}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        variant="outline"
                        onClick={requestGenerateSelectedUserRecoveryCodes}
                        disabled={isSaving || !selectedUser.totpEnabled}
                      >
                        <ShieldCheck className="size-4" />
                        {t("otp.issue")}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={requestResetSelectedUserTotp}
                        disabled={isSaving || !selectedUser.totpEnabled}
                        className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                      >
                        <ShieldOff className="size-4" />
                        {t("otp.reset")}
                      </Button>
                    </div>

                    {recoveryCodes.length > 0 ? (
                      <div className="grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
                        <div className="text-xs font-semibold">
                          {t("otp.once")}
                        </div>
                        <div className="grid grid-cols-2 gap-1 font-mono text-xs">
                          {recoveryCodes.map((code) => (
                            <div key={code} className="rounded border bg-white px-2 py-1">
                              {code}
                            </div>
                          ))}
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="justify-self-start border-amber-300 bg-white"
                          disabled={recoveryCodesAcknowledged}
                          onClick={() => setRecoveryCodesAcknowledged(true)}
                        >
                          <CheckCircle2 className="size-4" />
                          {recoveryCodesAcknowledged ? t("otp.stored") : t("otp.store")}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {selectedUser ? (
                  <div className="grid gap-3 rounded-md border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold">{t("mobile.title")}</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("mobile.subtitle")}
                        </p>
                      </div>
                      <Badge variant={selectedUser.mobilePackingEnabled ? "success" : "neutral"}>
                        {selectedUser.mobilePackingEnabled ? t("common.permissionAllowed") : t("common.permissionDenied")}
                      </Badge>
                    </div>

                    {!selectedUser.mobilePackingEnabled ? (
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        {t("mobile.permissionRequired")}
                      </div>
                    ) : null}

                    {mobileDeviceMessage ? (
                      <div className="rounded-md border bg-secondary px-3 py-2 text-xs text-muted-foreground">
                        {mobileDeviceMessage}
                      </div>
                    ) : null}

                    <div className="grid grid-cols-[1fr_auto] gap-2">
                      <AccountFieldLabel label="ADB serial">
                        {adbDevices.length ? (
                          <Select
                            value={selectedAdbSerial || "NONE"}
                            disabled={isMobileDeviceBusy}
                            onValueChange={(value) =>
                              setSelectedAdbSerial(value === "NONE" ? "" : value)
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="NONE">{t("mobile.selectAdb")}</SelectItem>
                              {adbDevices
                                .filter((device) => String(device.serial ?? "").trim())
                                .map((device) => (
                                  <SelectItem
                                    key={String(device.serial)}
                                    value={String(device.serial)}
                                  >
                                    {String(device.serial)} / {String(device.connectionState ?? "-")}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input value="" placeholder={t("mobile.refreshFirst")} readOnly disabled />
                        )}
                      </AccountFieldLabel>
                      <Button
                        variant="outline"
                        className="self-end"
                        onClick={loadAdbDevices}
                        disabled={isMobileDeviceBusy}
                      >
                        <RefreshCcw className="size-4" />
                        ADB
                      </Button>
                    </div>

                    <AccountFieldLabel label={t("mobile.label")}>
                      <Input
                        value={mobileDeviceLabel}
                        placeholder={t("mobile.labelPlaceholder")}
                        onChange={(event) =>
                          setMobileDeviceLabel(event.target.value)
                        }
                        disabled={isMobileDeviceBusy}
                      />
                    </AccountFieldLabel>

                    <Button
                      variant="outline"
                      onClick={requestRegisterSelectedMobileDevice}
                      disabled={
                        isMobileDeviceBusy ||
                        !selectedUser.mobilePackingEnabled ||
                        !selectedAdbSerial
                      }
                    >
                      <Smartphone className="size-4" />
                      {t("mobile.register")}
                    </Button>

                    <div className="grid gap-2">
                      {mobileDevices.length ? (
                        mobileDevices.map((device) => (
                          <div
                            key={device.deviceId}
                            className="grid gap-2 rounded-md border px-3 py-2 text-xs"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate font-semibold">
                                  {device.label || device.adbSerialPreview}
                                </div>
                                <div className="font-mono text-muted-foreground">
                                  {device.adbSerialPreview}
                                </div>
                              </div>
                              <Badge
                                variant={
                                  device.registrationState === "ACTIVE"
                                    ? "success"
                                    : device.registrationState === "REVOKED"
                                      ? "neutral"
                                      : "warning"
                                }
                              >
                                {device.registrationState === "ACTIVE"
                                  ? t("common.active")
                                  : device.registrationState === "PROVISIONING"
                                    ? t("mobile.provisioning")
                                    : device.registrationState === "REAUTH_REQUIRED"
                                      ? t("mobile.reauth")
                                      : t("mobile.revoked")}
                              </Badge>
                            </div>
                            <div className="grid gap-1 text-muted-foreground">
                              <DetailRow
                                label={t("mobile.activated")}
                                value={formatDate(device.activatedAt)}
                              />
                              <DetailRow
                                label={t("mobile.lastSeen")}
                                value={formatDate(device.lastSeenAt)}
                              />
                            </div>
                            {device.registrationState !== "REVOKED" ? (
                              <div className="grid grid-cols-2 gap-2">
                                <Button
                                  variant="outline"
                                  onClick={() => requestRenewMobileDevice(device)}
                                  disabled={isMobileDeviceBusy || !selectedAdbSerial}
                                >
                                  {t("mobile.renew")}
                                </Button>
                                <Button
                                  variant="outline"
                                  className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                                  onClick={() => requestRevokeMobileDevice(device)}
                                  disabled={isMobileDeviceBusy}
                                >
                                  {t("mobile.revoke")}
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        ))
                      ) : (
                        <div className="rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
                          {t("mobile.empty")}
                        </div>
                      )}
                      {mobileDevicesNextCursor ? (
                        <Button
                          variant="outline"
                          disabled={isMobileDeviceBusy}
                          onClick={() =>
                            void loadMobileDevices(
                              selectedUser.userId,
                              mobileDevicesNextCursor,
                              true
                            )
                          }
                        >
                          {t("mobile.more")}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className="grid gap-3 rounded-md border p-3">
                  <h3 className="text-sm font-semibold">{t("password.title")}</h3>
                  <AccountFieldLabel label={t("password.temporary")}>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={draft.tempPassword}
                      placeholder={t("password.placeholder")}
                      onChange={(event) =>
                        updateDraft("tempPassword", event.target.value)
                      }
                    />
                  </AccountFieldLabel>
                  <Button variant="outline" disabled>
                    <KeyRound className="size-4" />
                    {t("password.note")}
                  </Button>
                </div>

                <div className="grid gap-2 rounded-md border p-3 text-sm">
                  <h3 className="font-semibold">{t("permission.title")}</h3>
                  <p className="text-muted-foreground">
                    {roleDescriptions[draft.role]}
                  </p>
                  {draft.isDeveloper ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                      {t("permission.developer")}
                    </div>
                  ) : null}
                  {draft.mobilePackingEnabled ? (
                    <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">
                      {t("permission.packing")}
                    </div>
                  ) : null}
                </div>

                {selectedUser ? (
                  <div className="grid gap-1 rounded-md border p-3">
                    <DetailRow label={t("detail.created")} value={formatDate(selectedUser.createdAt)} />
                    <DetailRow label={t("detail.updated")} value={formatDate(selectedUser.updatedAt)} />
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="grid shrink-0 grid-cols-2 gap-2 border-t p-4">
            <Button
              className="col-span-2"
              onClick={saveCurrentDraft}
              disabled={isSaving || (!selectedUser && !isNewDraft)}
            >
              <Save className="size-4" />
              {isSaving ? t("detail.saving") : t("detail.save")}
            </Button>
            <Button
              variant="outline"
              onClick={deactivateSelectedUser}
              disabled={isSaving || !selectedUser || !selectedUser.isActive}
            >
              <CircleOff className="size-4" />
              {t("detail.deactivate")}
            </Button>
            <Button variant="outline" disabled>
              <ShieldCheck className="size-4" />
              {t("detail.history")}
            </Button>
          </div>
        </WorkspacePanel>
      </MasterDetailLayout>
    </WorkspacePageFrame>
  );
}
