// QuickHack note: 리더급 사용자가 직원 계정, 권한, 활성 상태를 관리하는 화면 초안입니다.
"use client";

import * as React from "react";
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
  ROLE_LABELS,
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
  message?: string;
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
  message?: string;
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

const roleDescriptions: Record<Role, string> = {
  LEADER: "전체 관리 메뉴와 주요 운영 설정을 다룰 수 있습니다.",
  MANAGER: "매입가, 재고 수정, 출고 관리 등 관리자 업무를 처리합니다.",
  STAFF: "검수, 업로드 대기 목록, 출고 확인 같은 실무 메뉴를 사용합니다.",
  VIEWER: "조회 중심 메뉴만 접근하는 계정입니다.",
};

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

function normalizeRole(value: string): Role {
  return isRole(value) ? value : "VIEWER";
}

function roleLabel(role: string) {
  const normalized = normalizeRole(role);
  return ROLE_LABELS[normalized] ?? normalized;
}

function userSearchText(user: UserAccountDto) {
  return [
    user.username,
    user.displayName,
    user.phone,
    user.email,
    user.birthDate,
    user.hireDate,
    roleLabel(user.role),
    user.role,
    user.isDeveloper ? "개발자" : "",
    user.mobilePackingEnabled ? "포장검수 모바일 packing mobile" : "",
    user.isActive ? "활성" : "비활성",
    user.mustChangePassword ? "비밀번호 변경 필요 임시 비밀번호" : "",
    user.totpEnabled ? "OTP 설정" : "OTP 미설정",
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
  return (
    <div className="flex items-center gap-1.5">
      <Badge variant={user.isActive ? "success" : "neutral"}>
        {user.isActive ? "활성" : "비활성"}
      </Badge>
      {user.mustChangePassword ? (
        <Badge variant="warning">비밀번호 변경 필요</Badge>
      ) : null}
    </div>
  );
}

function UserRoleBadge({ user }: { user: UserAccountDto }) {
  return (
    <div className="flex items-center gap-1.5">
      <Badge variant={user.role === "LEADER" ? "default" : "secondary"}>
        {roleLabel(user.role)}
      </Badge>
      {user.isDeveloper ? <Badge variant="warning">개발자</Badge> : null}
      {user.mobilePackingEnabled ? (
        <Badge variant="success">포장검수</Badge>
      ) : null}
    </div>
  );
}

export function UserAccountManagerView() {
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
      ? `${selectedUser.displayName} 계정 정보`
      : "새 사용자 계정",
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
      ? `${selectedUser.displayName} 모바일 기기 등록`
      : "사용자 모바일 기기 등록",
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
      ? `${selectedUser.displayName} OTP 복구코드`
      : "사용자 OTP 복구코드",
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
      throw new Error(payload?.message || "모바일 등록기기 목록을 불러오지 못했습니다.");
    }

    setMobileDevices((current) =>
      append ? [...current, ...(payload.items ?? [])] : payload.items ?? []
    );
    setMobileDevicesNextCursor(
      payload.hasMore ? payload.nextCursor ?? null : null
    );
  }, []);

  const loadUsers = React.useCallback(async () => {
    setIsLoading(true);
    setMessage("");

    try {
      const response = await fetch("/api/admin/users", { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as
        | UserAccountsApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "사용자 계정 목록을 불러오지 못했습니다.");
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
  }, []);

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

        return userSearchText(user).includes(normalizedQuery);
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

        return left.username.localeCompare(right.username, "ko-KR", {
          numeric: true,
          sensitivity: "base",
        });
      });
  }, [query, roleFilter, statusFilter, users]);

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
        label: "아이디",
        width: "1.2fr",
        cellClassName: "flex h-full min-w-0 items-center pl-4 pr-3",
        text: (user) => user.username,
        render: (user) => (
          <div className="font-semibold tabular-nums">{user.username}</div>
        ),
      },
      {
        key: "displayName",
        label: "이름",
        width: "1.2fr",
        cellClassName: userTableCellClassName,
        text: (user) => user.displayName,
        render: (user) => <div>{user.displayName}</div>,
      },
      {
        key: "contact",
        label: "연락처",
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
        label: "권한",
        width: "1.3fr",
        cellClassName: userTableCellClassName,
        text: (user) => `${roleLabel(user.role)} ${user.role}`,
        sortValue: (user) => ROLE_RANK[normalizeRole(user.role)],
        render: (user) => <UserRoleBadge user={user} />,
      },
      {
        key: "status",
        label: "상태",
        width: "0.8fr",
        cellClassName: userTableCellClassName,
        text: (user) => (user.isActive ? "활성" : "비활성"),
        render: (user) => <UserStatusBadge user={user} />,
      },
      {
        key: "otp",
        label: "OTP",
        width: "0.9fr",
        cellClassName: userTableCellClassName,
        text: (user) => (user.totpEnabled ? "OTP 설정" : "OTP 미설정"),
        render: (user) => (
          <Badge variant={user.totpEnabled ? "success" : "neutral"}>
            {user.totpEnabled ? "설정" : "미설정"}
          </Badge>
        ),
      },
      {
        key: "developer",
        label: "개발자",
        width: "0.8fr",
        cellClassName: userTableCellClassName,
        text: (user) => (user.isDeveloper ? "개발자" : "일반"),
        render: (user) => (
          <span className="text-sm text-muted-foreground">
            {user.isDeveloper ? "Y" : "-"}
          </span>
        ),
      },
      {
        key: "updatedAt",
        label: "수정일시",
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
    []
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
      targetLabel: "새 사용자 계정 작성",
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
      targetLabel: `${user.displayName} 계정 열기`,
      action: () => applySelectedUser(user),
    });
  }

  function requestUserListReload() {
    runGuardedAction({
      intent: "internal-change",
      formIds: USER_ACCOUNT_TARGET_FORM_IDS,
      targetLabel: "사용자 계정 목록 새로고침",
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
      throw new Error(payload?.message || "사용자 계정 작업에 실패했습니다.");
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
      throw new Error(payload?.message || "모바일 기기 등록 작업에 실패했습니다.");
    }

    return payload;
  }

  async function postUsbProvision(device?: MobileRegisteredDeviceDto) {
    if (!selectedUser) {
      throw new Error("기기를 등록할 계정을 선택하세요.");
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
      throw new Error(payload?.message || "USB 기기 등록에 실패했습니다.");
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
        throw new Error(payload?.message || "ADB 기기 목록을 불러오지 못했습니다.");
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
        devices.length ? "ADB 기기 목록을 갱신했습니다." : "연결된 ADB 기기가 없습니다."
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
      setMobileDeviceMessage("먼저 계정 저장으로 포장 검수 앱 접근 권한을 켜야 합니다.");
      return;
    }

    if (!selectedAdbSerial.trim()) {
      setMobileDeviceMessage("ADB 목록을 갱신하고 실제 USB 기기를 선택하세요.");
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
      setMobileDeviceMessage(payload.message || "선택한 USB 기기로 등록 정보를 전달했습니다.");
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
      setMobileDeviceMessage(payload.message || "선택한 USB 기기로 재등록 정보를 전달했습니다.");
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
      const payload = await postMobileDeviceAction({
        action: "revoke",
        deviceId: device.deviceId,
        expectedRegistrationRevision: device.registrationRevision,
      });
      await loadMobileDevices(selectedUser.userId);
      setMobileDeviceMessage(payload.message || "모바일 기기 등록을 폐기했습니다.");
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
        `${device.label || device.adbSerialPreview} 등록을 폐기할까요?`
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

      setMessage(payload.message || "계정 정보를 저장했습니다.");
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
      setMessage(payload.message || "OTP 설정을 초기화했습니다.");
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
      setMessage(payload.message || "OTP 복구코드를 발급했습니다.");
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
        `${selectedUser.displayName} 계정의 OTP와 복구코드를 초기화할까요?\n대상 계정의 로그인 세션도 종료됩니다.`
      )
    ) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [ONE_TIME_RESULT_FORM_IDS.adminRecoveryCodes],
      targetLabel: "사용자 OTP 초기화",
      action: () => {
        void resetSelectedUserTotp();
      },
    });
  }

  function requestGenerateSelectedUserRecoveryCodes() {
    if (
      !selectedUser ||
      !window.confirm(
        `${selectedUser.displayName} 계정의 기존 복구코드를 폐기하고 새 복구코드를 발급할까요?\n새 코드는 지금 화면에서 한 번만 표시됩니다.`
      )
    ) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [ONE_TIME_RESULT_FORM_IDS.adminRecoveryCodes],
      targetLabel: "사용자 OTP 복구코드 재발급",
      action: () => {
        void generateSelectedUserRecoveryCodes();
      },
    });
  }

  async function deactivateSelectedUser() {
    if (!selectedUser || isSaving) {
      return;
    }

    if (!window.confirm(`${selectedUser.displayName} 계정을 비활성화할까요?`)) {
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

      setMessage(payload.message || "계정을 비활성화했습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <WorkspacePageFrame className="gap-4 p-5">
      <SummaryStrip className="grid-cols-2 xl:grid-cols-6">
        <SummaryCard icon={UsersRound} label="전체 계정" value={summary.total} />
        <SummaryCard icon={ShieldCheck} label="활성 계정" value={summary.active} />
        <SummaryCard icon={UsersRound} label="리더급" value={summary.leader} />
        <SummaryCard icon={KeyRound} label="OTP 설정" value={summary.otp} />
        <SummaryCard icon={Smartphone} label="포장검수 앱" value={summary.mobilePacking} />
        <SummaryCard icon={KeyRound} label="개발자 권한" value={summary.developer} />
      </SummaryStrip>

      <MasterDetailLayout className="grid-cols-[minmax(620px,1fr)_420px] gap-4">
        <WorkspacePanel>
          <PanelToolbar className="grid-cols-[minmax(240px,1fr)_160px_160px_auto]">
            <SearchInput
              aria-label="사용자 검색"
              placeholder="아이디, 이름, 연락처, 권한 검색"
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
                <SelectItem value="ALL">전체 권한</SelectItem>
                {ROLES.map((role) => (
                  <SelectItem key={role} value={role}>
                    {ROLE_LABELS[role]}
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
                <SelectItem value="ALL">전체 상태</SelectItem>
                <SelectItem value="ACTIVE">활성</SelectItem>
                <SelectItem value="INACTIVE">비활성</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={requestUserListReload}
              disabled={isLoading}
            >
              <RefreshCcw className="size-4" />
              새로고침
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
              isLoading ? "사용자 계정 목록을 불러오는 중입니다." : "조회된 계정이 없습니다."
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
                {isNewDraft ? "새 계정 초안" : "계정 상세"}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                계정 생성, 권한 변경, 비밀번호 초기화를 처리합니다.
              </p>
            </div>
            <Button variant="outline" onClick={startNewDraft}>
              <UserPlus className="size-4" />
              새 계정
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {!selectedUser && !isNewDraft ? (
              <div className="grid h-full place-items-center rounded-md border border-dashed text-sm text-muted-foreground">
                왼쪽 목록에서 계정을 선택하세요.
              </div>
            ) : (
              <div className="grid gap-4">
                <div className="grid gap-3 rounded-md border p-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">기본 정보</h3>
                    <div className="flex items-center gap-1.5">
                      <Badge variant={isNewDraft ? "warning" : "neutral"}>
                        {isNewDraft ? "신규" : "편집"}
                      </Badge>
                      {selectedUser?.mustChangePassword ? (
                        <Badge variant="warning">비밀번호 변경 필요</Badge>
                      ) : null}
                    </div>
                  </div>

                  <AccountInformationFields
                    value={draft}
                    onChange={updateDraft}
                  />

                  <div className="grid grid-cols-2 gap-3">
                    <AccountFieldLabel label="권한">
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
                              {ROLE_LABELS[role]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </AccountFieldLabel>

                    <AccountFieldLabel label="계정 상태">
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
                          <SelectItem value="ACTIVE">활성</SelectItem>
                          <SelectItem value="INACTIVE">비활성</SelectItem>
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
                    개발자 메뉴 접근 허용
                  </label>

                  <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.mobilePackingEnabled}
                      onChange={(event) =>
                        updateDraft("mobilePackingEnabled", event.target.checked)
                      }
                    />
                    포장 검수 앱 접근 허용
                  </label>
                </div>

                {selectedUser ? (
                  <div className="grid gap-3 rounded-md border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold">OTP 2차 인증</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          휴대폰 교체, 앱 삭제, 분실 시 초기화하거나 복구코드를 발급합니다.
                        </p>
                      </div>
                      <Badge variant={selectedUser.totpEnabled ? "success" : "neutral"}>
                        {selectedUser.totpEnabled ? "설정됨" : "미설정"}
                      </Badge>
                    </div>

                    <div className="grid gap-1 text-xs text-muted-foreground">
                      <DetailRow
                        label="OTP 등록일시"
                        value={formatDate(selectedUser.totpVerifiedAt)}
                      />
                      <DetailRow
                        label="잠금 만료"
                        value={formatDate(selectedUser.totpLockedUntil)}
                      />
                      <DetailRow
                        label="남은 복구코드"
                        value={`${selectedUser.recoveryCodeCount}개`}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        variant="outline"
                        onClick={requestGenerateSelectedUserRecoveryCodes}
                        disabled={isSaving || !selectedUser.totpEnabled}
                      >
                        <ShieldCheck className="size-4" />
                        복구코드 발급
                      </Button>
                      <Button
                        variant="outline"
                        onClick={requestResetSelectedUserTotp}
                        disabled={isSaving || !selectedUser.totpEnabled}
                        className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                      >
                        <ShieldOff className="size-4" />
                        OTP 초기화
                      </Button>
                    </div>

                    {recoveryCodes.length > 0 ? (
                      <div className="grid gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
                        <div className="text-xs font-semibold">
                          복구코드는 지금 한 번만 표시됩니다.
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
                          {recoveryCodesAcknowledged ? "보관 완료됨" : "보관 완료"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {selectedUser ? (
                  <div className="grid gap-3 rounded-md border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold">포장 검수 USB 기기 등록</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          현재 연결된 실제 USB 기기에만 보안 등록 정보를 전달합니다.
                        </p>
                      </div>
                      <Badge variant={selectedUser.mobilePackingEnabled ? "success" : "neutral"}>
                        {selectedUser.mobilePackingEnabled ? "권한 허용" : "권한 없음"}
                      </Badge>
                    </div>

                    {!selectedUser.mobilePackingEnabled ? (
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        먼저 위의 `포장 검수 앱 접근 허용`을 켜고 계정을 저장해야 기기를 등록할 수 있습니다.
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
                              <SelectItem value="NONE">ADB 기기 선택</SelectItem>
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
                          <Input value="" placeholder="ADB 목록을 먼저 갱신하세요" readOnly disabled />
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

                    <AccountFieldLabel label="기기 라벨">
                      <Input
                        value={mobileDeviceLabel}
                        placeholder="예: 포장라인 1번 휴대폰"
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
                      선택한 USB 기기 등록
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
                                  ? "활성"
                                  : device.registrationState === "PROVISIONING"
                                    ? "앱 로그인 대기"
                                    : device.registrationState === "REAUTH_REQUIRED"
                                      ? "재등록 필요"
                                      : "폐기됨"}
                              </Badge>
                            </div>
                            <div className="grid gap-1 text-muted-foreground">
                              <DetailRow
                                label="활성화"
                                value={formatDate(device.activatedAt)}
                              />
                              <DetailRow
                                label="마지막 호출"
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
                                  선택 USB로 재등록
                                </Button>
                                <Button
                                  variant="outline"
                                  className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                                  onClick={() => requestRevokeMobileDevice(device)}
                                  disabled={isMobileDeviceBusy}
                                >
                                  폐기
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        ))
                      ) : (
                        <div className="rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
                          이 계정에 등록된 포장 검수 앱 기기가 없습니다.
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
                          다음 등록 불러오기
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className="grid gap-3 rounded-md border p-3">
                  <h3 className="text-sm font-semibold">비밀번호</h3>
                  <AccountFieldLabel label="임시 비밀번호">
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={draft.tempPassword}
                      placeholder="초기화 시 새 비밀번호 입력"
                      onChange={(event) =>
                        updateDraft("tempPassword", event.target.value)
                      }
                    />
                  </AccountFieldLabel>
                  <Button variant="outline" disabled>
                    <KeyRound className="size-4" />
                    비밀번호는 계정 저장 시 함께 초기화됩니다.
                  </Button>
                </div>

                <div className="grid gap-2 rounded-md border p-3 text-sm">
                  <h3 className="font-semibold">권한 설명</h3>
                  <p className="text-muted-foreground">
                    {roleDescriptions[draft.role]}
                  </p>
                  {draft.isDeveloper ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                      개발자 권한은 일반 업무 권한과 별개로 개발자 메뉴를 표시합니다.
                    </div>
                  ) : null}
                  {draft.mobilePackingEnabled ? (
                    <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">
                      포장 검수 앱 권한은 일반 업무 권한과 별개로 모바일 검수 API 호출만 허용합니다.
                    </div>
                  ) : null}
                </div>

                {selectedUser ? (
                  <div className="grid gap-1 rounded-md border p-3">
                    <DetailRow label="생성일시" value={formatDate(selectedUser.createdAt)} />
                    <DetailRow label="수정일시" value={formatDate(selectedUser.updatedAt)} />
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
              {isSaving ? "저장 중" : "계정 저장"}
            </Button>
            <Button
              variant="outline"
              onClick={deactivateSelectedUser}
              disabled={isSaving || !selectedUser || !selectedUser.isActive}
            >
              <CircleOff className="size-4" />
              비활성화
            </Button>
            <Button variant="outline" disabled>
              <ShieldCheck className="size-4" />
              권한 이력
            </Button>
          </div>
        </WorkspacePanel>
      </MasterDetailLayout>
    </WorkspacePageFrame>
  );
}
