"use client";

import * as React from "react";
import {
  Bell,
  ChevronDown,
  Keyboard,
  PackageCheck,
  PanelRightOpen,
  RotateCcw,
  Save,
  Search,
  Undo2,
  X,
} from "lucide-react";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FormActionBar } from "@/quickhack_client/components/ui/form-layout";
import { Input } from "@/quickhack_client/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/quickhack_client/components/ui/tabs";
import { cn } from "@/quickhack_shared/core/utils";
import {
  ROLE_LABELS,
  type Role,
} from "@/quickhack_shared/auth/auth-constants";
import {
  AccountFieldLabel,
  AccountInformationFields,
  type EditableAccountInformation,
} from "@/quickhack_client/components/user/account-information-fields";
import {
  AccountTotpPanel,
  type AccountTotpStatus,
} from "@/quickhack_client/components/user/account-totp-panel";
import { AccountMobileAppPanel } from "@/quickhack_client/components/user/account-mobile-app-panel";
import { AccountPasswordPanel } from "@/quickhack_client/components/user/account-password-panel";
import {
  SHORTCUT_ACTION_LABELS,
  SHORTCUT_MODIFIER_LABELS,
} from "@/quickhack_client/components/user/shortcut-presenter";
import {
  COMMON_SHORTCUT_ACTION_CODES,
  CURRENT_GROUP_SHORTCUT_ACTION_CODES,
  SHORTCUT_MODIFIERS,
  TOP_LEVEL_SHORTCUT_ACTION_CODES,
  formatShortcutKeyCode,
  isReservedShortcut,
  isShortcutModifier,
  isSupportedShortcutKeyCode,
  shortcutCombinationKey,
  type PersonalSettings,
  type ShortcutActionCode,
  type UserPreferenceKey,
  type UserShortcutBinding,
} from "@/quickhack_shared/user/personal-settings";
import { DesktopAppearanceSettings } from "@/quickhack_client/components/desktop/desktop-appearance-settings";

type ShortcutBindingChange = Partial<
  Pick<UserShortcutBinding, "modifier" | "keyCode">
>;

type PersonalSettingsViewProps = {
  account: (EditableAccountInformation & {
    role: string;
    createdAt: string;
    mobilePackingEnabled: boolean;
  }) | null;
  accountLoaded: boolean;
  accountSaving: boolean;
  accountDirty: boolean;
  accountMessage?: string;
  accountError?: string;
  onAccountChange: <K extends keyof EditableAccountInformation>(
    key: K,
    value: EditableAccountInformation[K]
  ) => void;
  onAccountCancel: () => void;
  onAccountSave: () => void;
  onTotpStatusChange: (status: AccountTotpStatus) => void;
  onMobileActiveCountChange: (count: number) => void;
  settings: PersonalSettings;
  loaded: boolean;
  saving: boolean;
  dirty: boolean;
  message?: string;
  error?: string;
  errorActionCode?: ShortcutActionCode;
  onPreferenceChange: (key: UserPreferenceKey, checked: boolean) => void;
  onShortcutChange: (
    actionCode: ShortcutActionCode,
    change: ShortcutBindingChange
  ) => void;
  onCancel: () => void;
  onResetDefaults: () => void;
  onSave: () => void;
};

function PreferenceSwitch({
  icon: Icon,
  label,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "flex min-h-14 items-center gap-3 px-4 py-3",
        disabled && "opacity-50"
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-sm font-medium">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
          checked ? "border-primary bg-primary" : "border-border bg-muted"
        )}
        onClick={() => onCheckedChange(!checked)}
      >
        <span
          className={cn(
            "absolute left-px top-px size-5 rounded-full bg-background shadow-sm transition-transform",
            checked ? "translate-x-5" : "translate-x-0"
          )}
        />
      </button>
    </div>
  );
}

function bindingErrors(bindings: UserShortcutBinding[]) {
  const errors = new Map<ShortcutActionCode, string>();
  const combinationActions = new Map<string, ShortcutActionCode[]>();

  for (const binding of bindings) {
    if (!binding.keyCode) {
      continue;
    }

    if (!isSupportedShortcutKeyCode(binding.keyCode)) {
      errors.set(binding.actionCode, "지원하지 않는 키입니다.");
      continue;
    }

    if (isReservedShortcut(binding.modifier, binding.keyCode)) {
      errors.set(
        binding.actionCode,
        "Windows 또는 브라우저의 기본 동작과 충돌합니다."
      );
      continue;
    }

    const combination = shortcutCombinationKey(
      binding.modifier,
      binding.keyCode
    );
    const actions = combinationActions.get(combination) ?? [];
    actions.push(binding.actionCode);
    combinationActions.set(combination, actions);
  }

  for (const actions of combinationActions.values()) {
    if (actions.length < 2) {
      continue;
    }
    for (const actionCode of actions) {
      errors.set(actionCode, "다른 동작과 같은 단축키가 지정되어 있습니다.");
    }
  }

  return errors;
}

function ShortcutBindingRow({
  binding,
  disabled,
  error,
  capturing,
  onCapturingChange,
  onChange,
}: {
  binding: UserShortcutBinding;
  disabled: boolean;
  error?: string;
  capturing: boolean;
  onCapturingChange: (capturing: boolean) => void;
  onChange: (change: ShortcutBindingChange) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  function captureKey(event: React.KeyboardEvent<HTMLInputElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (["Alt", "Control", "Meta", "Shift"].includes(event.key)) {
      return;
    }

    if (!isSupportedShortcutKeyCode(event.code)) {
      return;
    }

    onChange({ keyCode: event.code });
    inputRef.current?.blur();
  }

  return (
    <div
      className={cn(
        "grid grid-cols-[120px_minmax(140px,1fr)_36px] items-start gap-2 px-4 py-3 min-[860px]:grid-cols-[minmax(0,1fr)_120px_minmax(140px,190px)_36px]",
        error && "bg-destructive/5"
      )}
    >
      <div className="col-span-3 flex min-h-9 items-center gap-2 min-[860px]:col-span-1">
        {binding.actionCode === "FOCUS_SEARCH" ? (
          <Search className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <Keyboard className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 text-sm font-medium">
          {SHORTCUT_ACTION_LABELS[binding.actionCode]}
        </span>
      </div>

      <Select
        value={binding.modifier}
        disabled={disabled}
        onValueChange={(value) => {
          if (isShortcutModifier(value)) {
            onChange({ modifier: value });
          }
        }}
      >
        <SelectTrigger
          aria-label={`${SHORTCUT_ACTION_LABELS[binding.actionCode]} 보조키`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SHORTCUT_MODIFIERS.map((modifier) => (
            <SelectItem key={modifier} value={modifier}>
              {SHORTCUT_MODIFIER_LABELS[modifier]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="min-w-0">
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={capturing ? "" : formatShortcutKeyCode(binding.keyCode)}
          placeholder={capturing ? "키를 누르세요" : "미지정"}
          aria-label={`${SHORTCUT_ACTION_LABELS[binding.actionCode]} 키`}
          data-quickhack-shortcut-capture="true"
          disabled={disabled}
          className={cn(
            "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            error && "border-destructive focus:ring-destructive/30"
          )}
          onFocus={() => onCapturingChange(true)}
          onBlur={() => onCapturingChange(false)}
          onKeyDown={captureKey}
        />
        {error ? (
          <p className="mt-1 text-xs text-destructive">{error}</p>
        ) : null}
      </div>

      <Button
        type="button"
        size="icon"
        variant="outline"
        title="단축키 지우기"
        aria-label={`${SHORTCUT_ACTION_LABELS[binding.actionCode]} 단축키 지우기`}
        disabled={disabled || binding.keyCode === null}
        onClick={() => onChange({ keyCode: null })}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

export function PersonalSettingsView({
  account,
  accountLoaded,
  accountSaving,
  accountDirty,
  accountMessage = "",
  accountError = "",
  onAccountChange,
  onAccountCancel,
  onAccountSave,
  onTotpStatusChange,
  onMobileActiveCountChange,
  settings,
  loaded,
  saving,
  dirty,
  message = "",
  error = "",
  errorActionCode,
  onPreferenceChange,
  onShortcutChange,
  onCancel,
  onResetDefaults,
  onSave,
}: PersonalSettingsViewProps) {
  const [activeSettingsTab, setActiveSettingsTab] = React.useState("account");
  const [capturingAction, setCapturingAction] =
    React.useState<ShortcutActionCode | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(true);
  const [notificationsOpen, setNotificationsOpen] = React.useState(true);
  const shortcutErrors = React.useMemo(
    () => bindingErrors(settings.shortcutBindings),
    [settings.shortcutBindings]
  );

  if (errorActionCode && error) {
    shortcutErrors.set(errorActionCode, error);
  }

  const bindingByAction = new Map(
    settings.shortcutBindings.map((binding) => [binding.actionCode, binding])
  );
  const topLevelBindings = TOP_LEVEL_SHORTCUT_ACTION_CODES.map((actionCode) =>
    bindingByAction.get(actionCode)
  ).filter((binding): binding is UserShortcutBinding => Boolean(binding));
  const currentGroupBindings = CURRENT_GROUP_SHORTCUT_ACTION_CODES.map(
    (actionCode) => bindingByAction.get(actionCode)
  ).filter((binding): binding is UserShortcutBinding => Boolean(binding));
  const commonBindings = COMMON_SHORTCUT_ACTION_CODES.map((actionCode) =>
    bindingByAction.get(actionCode)
  ).filter((binding): binding is UserShortcutBinding => Boolean(binding));

  function renderBinding(binding: UserShortcutBinding) {
    return (
      <ShortcutBindingRow
        key={binding.actionCode}
        binding={binding}
        disabled={!loaded || saving}
        error={shortcutErrors.get(binding.actionCode)}
        capturing={capturingAction === binding.actionCode}
        onCapturingChange={(capturing) =>
          setCapturingAction(capturing ? binding.actionCode : null)
        }
        onChange={(change) => onShortcutChange(binding.actionCode, change)}
      />
    );
  }

  const accountRoleLabel = account
    ? ROLE_LABELS[account.role as Role] ?? account.role
    : "-";
  const accountCreatedAt = account?.createdAt
    ? account.createdAt.replace("T", " ").slice(0, 19)
    : "-";

  return (
    <Tabs
      value={activeSettingsTab}
      onValueChange={setActiveSettingsTab}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0 border-b bg-background px-5 py-3">
        <TabsList>
          <TabsTrigger value="account">계정 설정</TabsTrigger>
          <TabsTrigger value="personal">개인 설정</TabsTrigger>
          <TabsTrigger value="appearance">화면</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent
        value="account"
        className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4">
            {!accountLoaded ? (
              <div className="border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
                계정 정보를 불러오는 중입니다.
              </div>
            ) : null}

            {accountError ? (
              <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {accountError}
              </div>
            ) : null}

            {accountMessage ? (
              <div className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                {accountMessage}
              </div>
            ) : null}

            <section className="grid gap-3 rounded-md border bg-popover p-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">기본 정보</h2>
                <Badge variant="neutral">내 계정</Badge>
              </div>

              {account ? (
                <>
                  <AccountInformationFields
                    value={account}
                    disabled={!accountLoaded || accountSaving}
                    onChange={onAccountChange}
                  />

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <AccountFieldLabel label="권한">
                      <Input
                        value={accountRoleLabel}
                        readOnly
                        aria-readonly="true"
                        className="bg-secondary/40"
                      />
                    </AccountFieldLabel>

                    <AccountFieldLabel label="계정 생성일">
                      <Input
                        value={accountCreatedAt}
                        readOnly
                        aria-readonly="true"
                        className="bg-secondary/40 tabular-nums"
                      />
                    </AccountFieldLabel>
                  </div>
                </>
              ) : (
                <div className="h-48 animate-pulse rounded-md bg-secondary/50" />
              )}
            </section>

            <AccountPasswordPanel />

            <AccountTotpPanel onStatusChange={onTotpStatusChange} />

            <AccountMobileAppPanel
              permissionEnabled={Boolean(account?.mobilePackingEnabled)}
              onActiveCountChange={onMobileActiveCountChange}
            />
          </div>
        </div>

        <FormActionBar
          status={
            accountDirty
              ? "저장하지 않은 계정 정보 변경사항이 있습니다."
              : "저장된 상태입니다."
          }
        >
          <Button
            type="button"
            variant="outline"
            disabled={!accountDirty || accountSaving}
            onClick={onAccountCancel}
          >
            변경 취소
          </Button>
          <Button
            type="button"
            disabled={!accountLoaded || !accountDirty || accountSaving}
            onClick={onAccountSave}
          >
            <Save className="size-4" />
            {accountSaving ? "저장 중" : "계정 저장"}
          </Button>
        </FormActionBar>
      </TabsContent>

      <TabsContent value="appearance" className="mt-0 min-h-0 flex-1 overflow-auto p-5 data-[state=inactive]:hidden">
        <div className="mx-auto w-full max-w-[760px]"><DesktopAppearanceSettings /></div>
      </TabsContent>

      <TabsContent
        value="personal"
        className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
        {!loaded ? (
          <div className="border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
            개인 설정을 불러오는 중입니다.
          </div>
        ) : null}

        {error && !errorActionCode ? (
          <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {error}
          </div>
        ) : null}

        {message ? (
          <div className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {message}
          </div>
        ) : null}

          <section className="overflow-hidden rounded-md border bg-popover">
            <button
              type="button"
              aria-expanded={shortcutsOpen}
              aria-controls="personal-settings-shortcuts-panel"
              className={cn(
                "flex h-12 w-full items-center gap-2 px-4 text-left hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                shortcutsOpen && "border-b"
              )}
              onClick={() => {
                if (shortcutsOpen) {
                  setCapturingAction(null);
                }
                setShortcutsOpen((current) => !current);
              }}
            >
              <Keyboard className="size-4 text-muted-foreground" />
              <h2 className="min-w-0 flex-1 text-sm font-semibold">단축키</h2>
              <ChevronDown
                className={cn(
                  "size-4 text-muted-foreground transition-transform",
                  !shortcutsOpen && "-rotate-90"
                )}
              />
            </button>

            {shortcutsOpen ? (
              <div id="personal-settings-shortcuts-panel">
                <PreferenceSwitch
                  icon={Keyboard}
                  label="단축키 사용"
                  checked={settings.preferences.keyboardShortcutsEnabled}
                  disabled={!loaded || saving}
                  onCheckedChange={(checked) =>
                    onPreferenceChange("keyboardShortcutsEnabled", checked)
                  }
                />
                <div className="border-t bg-secondary/15 p-3">
                  <Tabs defaultValue="top-level">
                    <TabsList>
                      <TabsTrigger value="top-level">상위 메뉴 이동</TabsTrigger>
                      <TabsTrigger value="current-group">
                        현재 메뉴 내부
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent
                      className="mt-3 divide-y overflow-hidden rounded-md border bg-background"
                      value="top-level"
                    >
                      {topLevelBindings.map(renderBinding)}
                    </TabsContent>
                    <TabsContent
                      className="mt-3 divide-y overflow-hidden rounded-md border bg-background"
                      value="current-group"
                    >
                      {currentGroupBindings.map(renderBinding)}
                    </TabsContent>
                  </Tabs>

                  {commonBindings.length ? (
                    <div className="mt-3 overflow-hidden rounded-md border bg-background">
                      <div className="border-b px-4 py-2 text-xs font-semibold text-muted-foreground">
                        공통 작업
                      </div>
                      <div className="divide-y">
                        {commonBindings.map(renderBinding)}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>

          <section className="overflow-hidden rounded-md border bg-popover">
            <button
              type="button"
              aria-expanded={notificationsOpen}
              aria-controls="personal-settings-notifications-panel"
              className={cn(
                "flex h-12 w-full items-center gap-2 px-4 text-left hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                notificationsOpen && "border-b"
              )}
              onClick={() => setNotificationsOpen((current) => !current)}
            >
              <Bell className="size-4 text-muted-foreground" />
              <h2 className="min-w-0 flex-1 text-sm font-semibold">알림</h2>
              <ChevronDown
                className={cn(
                  "size-4 text-muted-foreground transition-transform",
                  !notificationsOpen && "-rotate-90"
                )}
              />
            </button>

            {notificationsOpen ? (
              <div
                id="personal-settings-notifications-panel"
                className="divide-y"
              >
                <PreferenceSwitch
                  icon={Bell}
                  label="윈도우 알림"
                  checked={settings.preferences.windowsNotificationsEnabled}
                  disabled={!loaded || saving}
                  onCheckedChange={(checked) =>
                    onPreferenceChange("windowsNotificationsEnabled", checked)
                  }
                />
                <div className="divide-y bg-secondary/25 pl-6">
                  <PreferenceSwitch
                    icon={PackageCheck}
                    label="검수 완료"
                    checked={
                      settings.preferences
                        .inspectionCompleteNotificationEnabled
                    }
                    disabled={
                      !loaded ||
                      saving ||
                      !settings.preferences.windowsNotificationsEnabled
                    }
                    onCheckedChange={(checked) =>
                      onPreferenceChange(
                        "inspectionCompleteNotificationEnabled",
                        checked
                      )
                    }
                  />
                  <PreferenceSwitch
                    icon={PanelRightOpen}
                    label="배송정보 변경"
                    checked={
                      settings.preferences.shipmentChangeNotificationEnabled
                    }
                    disabled={
                      !loaded ||
                      saving ||
                      !settings.preferences.windowsNotificationsEnabled
                    }
                    onCheckedChange={(checked) =>
                      onPreferenceChange(
                        "shipmentChangeNotificationEnabled",
                        checked
                      )
                    }
                  />
                  <PreferenceSwitch
                    icon={Undo2}
                    label="반품 접수"
                    checked={settings.preferences.returnNotificationEnabled}
                    disabled={
                      !loaded ||
                      saving ||
                      !settings.preferences.windowsNotificationsEnabled
                    }
                    onCheckedChange={(checked) =>
                      onPreferenceChange("returnNotificationEnabled", checked)
                    }
                  />
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>

      <FormActionBar
        status={
          dirty
            ? "저장하지 않은 변경사항이 있습니다."
            : "저장된 상태입니다."
        }
      >
        <Button
          type="button"
          variant="outline"
          disabled={!loaded || saving}
          onClick={onResetDefaults}
        >
          <RotateCcw className="size-4" />
          기본값
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!dirty || saving}
          onClick={onCancel}
        >
          변경 취소
        </Button>
        <Button
          type="button"
          disabled={!loaded || !dirty || saving || shortcutErrors.size > 0}
          onClick={onSave}
        >
          <Save className="size-4" />
          {saving ? "저장 중" : "저장"}
        </Button>
      </FormActionBar>
      </div>
      </TabsContent>
    </Tabs>
  );
}
