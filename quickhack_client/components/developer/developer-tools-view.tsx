// QuickHack note: 개발자 권한 전용 진단, API 샌드박스, ADB, DB, 개발 데이터 관리 화면입니다.
"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  ClipboardList,
  Database,
  LockKeyhole,
  Play,
  RefreshCcw,
  ServerCog,
  Smartphone,
  Wrench,
} from "lucide-react";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import type { MenuItemId } from "@/quickhack_client/components/app-shell/device-workspace-menu";
import { useUnsavedForm } from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { FormSection as Section } from "@/quickhack_client/components/ui/form-layout";
import { WorkspacePageFrame } from "@/quickhack_client/components/ui/workspace-layout";
import { Input } from "@/quickhack_client/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import { cn } from "@/quickhack_shared/core/utils";
import {
  API_SANDBOX_FORM_ID,
  apiSandboxDraftsEqual,
  createApiSandboxDraftSnapshot,
  defaultApiSandboxDraft,
} from "@/quickhack_client/components/developer/api-sandbox-draft-state";

type DeveloperMenuId = Extract<
  MenuItemId,
  | "developer-diagnostics"
  | "developer-api-sandbox"
  | "developer-adb-diagnostics"
  | "developer-db-migrations"
>;

type Tone = "success" | "warning" | "danger" | "neutral" | "purple" | "sky";

type InfoRow = {
  label: string;
  value: string;
  tone?: Tone;
  note?: string;
};

type ApiState<T> = {
  data: T | null;
  loading: boolean;
  error: string;
};

type DeveloperDiagnosticsPayload = {
  ok: boolean;
  checkedAt: string;
  runtime: {
    quickHackEnvironment: string;
    runtimeRole: string;
    nodeEnv: string;
    production: boolean;
    nodeVersion: string;
    platform: string;
    arch: string;
    pid: number;
    hostname: string;
    uptimeSeconds: number;
  };
  database: {
    provider: string;
    url: string;
    tableCounts: Record<string, number | null>;
  };
  workers: {
    manager: Record<string, unknown>;
    registeredCount: number;
    persistedCount: number;
    scheduledCount: number;
    runningCount: number;
    failedCount: number;
    failedWorkers: Array<{
      workerKey: string;
      workerName: string;
      status: string;
      lastRunAt: string | null;
      lastErrorMessage: string | null;
    }>;
  };
  environment: Record<string, unknown>;
};

type DbMigrationsPayload = {
  ok: boolean;
  checkedAt: string;
  database: {
    provider: string;
    url: string;
    path: string;
    exists: boolean;
    sizeBytes: number;
    integrity: {
      ok: boolean;
      values: string[];
      message?: string;
    };
  };
  prisma: {
    schemaPath: string;
    schemaExists: boolean;
    migrations: {
      migrationsDir: string;
      exists: boolean;
      items: Array<{
        name: string;
        hasSql: boolean;
        sqlSizeBytes: number;
      }>;
    };
    migrationTable: {
      exists: boolean;
      appliedCount: number;
      rows: Array<{
        migration_name: string;
        finished_at: string | null;
        rolled_back_at: string | null;
      }>;
      message?: string;
    };
  };
  tableCounts: Record<string, number | null>;
};

type AdbDevicesPayload = {
  ok: boolean;
  message?: string;
  devices?: Array<Record<string, unknown>>;
};

type DeveloperToolsTranslator = ReturnType<
  typeof useTranslations<"developer.tools">
>;

function adbWarningText(
  device: Record<string, unknown>,
  t: DeveloperToolsTranslator
) {
  const codes = Array.isArray(device.warningCodes)
    ? device.warningCodes.map(String)
    : [];
  if (codes.length === 0) return String(device.warning ?? "-");
  const detail = String(device.warningDetail ?? "-");
  return codes
    .map((code) => {
      if (code === "CARRIER_REVIEW") return t("adb.warningText.carrierReview");
      if (code === "ACCOUNT_REVIEW") return t("adb.warningText.accountReview");
      if (code === "ACCOUNT_QUERY_FAILED") return t("adb.warningText.accountQueryFailed");
      if (code === "ADB_OFFLINE") return t("adb.warningText.offline");
      if (code === "ADB_UNAUTHORIZED") return t("adb.warningText.unauthorized");
      if (code === "ADB_QUERY_FAILED") {
        return t("adb.warningText.queryFailed", { detail });
      }
      return t("adb.warningText.unknown", { state: detail });
    })
    .join("\n");
}

type ApiSandboxResponse = {
  ok: boolean;
  message?: string;
  request?: {
    method: string;
    path: string;
    bodySent: boolean;
  };
  response?: {
    ok: boolean;
    status: number;
    statusText: string;
    contentType: string;
    durationMs: number;
    text: string;
    truncated: boolean;
    originalLength: number;
    json: unknown;
    jsonParseError: string;
  };
};

function toneBadgeVariant(tone: Tone = "neutral") {
  switch (tone) {
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "danger":
      return "danger";
    case "purple":
      return "purple";
    case "sky":
      return "sky";
    default:
      return "neutral";
  }
}

function numberText(value: number | null | undefined, locale: string) {
  return typeof value === "number" ? value.toLocaleString(locale) : "-";
}

function boolText(value: unknown, yes: string, no: string) {
  return value ? yes : no;
}

function bytesText(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

type FetchJsonFallbacks = {
  invalidJson: (status: number) => string;
  requestFailed: (status: number) => string;
};

function useFetchJsonFallbacks(): FetchJsonFallbacks {
  const t = useTranslations("developer.tools.common");
  return React.useMemo(
    () => ({
      invalidJson: (status: number) => t("invalidJson", { status }),
      requestFailed: (status: number) => t("requestFailed", { status }),
    }),
    [t]
  );
}

async function fetchJson<T>(
  url: string,
  fallbacks: FetchJsonFallbacks,
  init?: RequestInit
) {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let payload: unknown = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(text || fallbacks.invalidJson(response.status));
  }

  if (!response.ok) {
    throw new Error(
      legacyApiMessage(payload, fallbacks.requestFailed(response.status))
    );
  }

  return payload as T;
}

function useApiResource<T>(
  url: string,
  fallbacks: FetchJsonFallbacks
): ApiState<T> & { reload: () => Promise<void> } {
  const [state, setState] = React.useState<ApiState<T>>({
    data: null,
    loading: true,
    error: "",
  });

  const reload = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: "" }));

    try {
      const data = await fetchJson<T>(url, fallbacks);
      setState({ data, loading: false, error: "" });
    } catch (error) {
      setState({
        data: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [fallbacks, url]);

  React.useEffect(() => {
    const timerId = window.setTimeout(() => {
      void reload();
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [reload]);

  return { ...state, reload };
}

function StatusTile({
  icon: Icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <div className="flex min-h-[72px] items-center gap-3 rounded-md border bg-popover px-4">
      <div
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-md",
          tone === "success" && "bg-emerald-50 text-emerald-700",
          tone === "warning" && "bg-amber-50 text-amber-800",
          tone === "danger" && "bg-red-50 text-red-700",
          tone === "purple" && "bg-purple-50 text-purple-700",
          tone === "sky" && "bg-sky-50 text-sky-700",
          tone === "neutral" && "bg-secondary text-primary"
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate text-base font-semibold">{value}</div>
      </div>
    </div>
  );
}

function InfoTable({ rows }: { rows: InfoRow[] }) {
  const t = useTranslations("developer.tools");
  return (
    <div className="overflow-hidden rounded-md border bg-background">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[180px_minmax(0,1fr)_140px] items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0"
        >
          <div className="text-xs font-medium text-muted-foreground">
            {row.label}
          </div>
          <div className="min-w-0 truncate font-medium">{row.value}</div>
          <div className="flex justify-end">
            <Badge variant={toneBadgeVariant(row.tone)}>{row.note ?? t("common.check")}</Badge>
          </div>
        </div>
      ))}
    </div>
  );
}

function ActionRow({
  icon: Icon,
  title,
  description,
  tone = "neutral",
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  tone?: Tone;
  action?: React.ReactNode;
}) {
  const t = useTranslations("developer.tools");
  return (
    <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-2 last:border-b-0">
      <div className="flex size-8 items-center justify-center rounded-md bg-secondary text-primary">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="truncate text-xs text-muted-foreground">
          {description}
        </div>
      </div>
      {action ?? <Badge variant={toneBadgeVariant(tone)}>{t("common.check")}</Badge>}
    </div>
  );
}

function LoadingBox({ text }: { text?: string }) {
  const t = useTranslations("developer.tools");
  return (
    <div className="grid min-h-32 place-items-center rounded-md border border-dashed bg-background text-sm text-muted-foreground">
      {text ?? t("common.loading")}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {message}
    </div>
  );
}

function DiagnosticsView({ currentUser }: { currentUser: AuthUser }) {
  const t = useTranslations("developer.tools");
  const systemT = useTranslations("admin.systemStatus");
  const fetchFallbacks = useFetchJsonFallbacks();
  const locale = useLocale();
  const roleLabels: Record<AuthUser["role"], string> = {
    VIEWER: t("roles.viewer"), STAFF: t("roles.staff"),
    MANAGER: t("roles.manager"), LEADER: t("roles.leader"),
  };
  const { data, loading, error, reload } =
    useApiResource<DeveloperDiagnosticsPayload>(
      "/api/developer/diagnostics",
      fetchFallbacks
    );
  const counts = data?.database.tableCounts ?? {};
  const rows: InfoRow[] = data
    ? [
        {
          label: t("diagnostics.user"),
          value: `${currentUser.displayName} / ${roleLabels[currentUser.role]}`,
          tone: currentUser.isDeveloper ? "success" : "danger",
          note: currentUser.isDeveloper ? t("common.developer") : t("common.blocked"),
        },
        {
          label: t("diagnostics.environment"),
          value: `${data.runtime.quickHackEnvironment} / ${data.runtime.runtimeRole} / ${data.runtime.nodeEnv}`,
          tone: data.runtime.production ? "warning" : "sky",
          note: data.runtime.production ? t("diagnostics.production") : t("diagnostics.development"),
        },
        {
          label: t("diagnostics.node"),
          value: `${data.runtime.nodeVersion} / ${data.runtime.platform}-${data.runtime.arch} / pid ${data.runtime.pid}`,
          tone: "neutral",
          note: data.runtime.hostname,
        },
        {
          label: "DB",
          value: `${data.database.provider} / ${data.database.url}`,
          tone: "purple",
          note: t("diagnostics.connected"),
        },
        {
          label: "worker",
          value: t("diagnostics.workerSummary", { registered: data.workers.registeredCount, persisted: data.workers.persistedCount, running: data.workers.runningCount }),
          tone: data.workers.failedCount > 0 ? "warning" : "success",
          note: data.workers.failedCount > 0 ? t("diagnostics.hasErrors") : t("common.normal"),
        },
      ]
    : [
        {
          label: t("diagnostics.user"),
          value: `${currentUser.displayName} / ${roleLabels[currentUser.role]}`,
          tone: currentUser.isDeveloper ? "success" : "danger",
          note: currentUser.isDeveloper ? t("common.developer") : t("common.blocked"),
        },
      ];

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatusTile
          icon={CheckCircle2}
          label={t("diagnostics.menuAccess")}
          value={currentUser.isDeveloper ? t("common.allowed") : t("common.blocked")}
          tone={currentUser.isDeveloper ? "success" : "danger"}
        />
        <StatusTile
          icon={Database}
          label={t("diagnostics.devices")}
          value={numberText(counts.devices, locale)}
          tone="purple"
        />
        <StatusTile
          icon={ServerCog}
          label={t("diagnostics.workerFailures")}
          value={numberText(data?.workers.failedCount, locale)}
          tone={data && data.workers.failedCount > 0 ? "warning" : "success"}
        />
        <StatusTile
          icon={LockKeyhole}
          label={t("diagnostics.otpKey")}
          value={boolText(data?.environment.hasTotpEncryptionKey, t("common.yes"), t("common.no"))}
          tone={data?.environment.hasTotpEncryptionKey ? "success" : "warning"}
        />
      </div>

      <Section
        title={t("diagnostics.title")}
        description={data ? t("diagnostics.checkedAt", { date: data.checkedAt }) : t("diagnostics.description")}
        action={
          <Button size="sm" variant="outline" onClick={() => void reload()} disabled={loading}>
            <RefreshCcw className="size-4" />
            {t("diagnostics.refresh")}
          </Button>
        }
      >
        {error ? <ErrorBox message={error} /> : null}
        {loading && !data ? <LoadingBox /> : <InfoTable rows={rows} />}
      </Section>

      <Section title={t("diagnostics.tableCounts")}>
        {data ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {Object.entries(data.database.tableCounts).map(([key, value]) => (
              <div key={key} className="rounded-md border bg-background px-3 py-2">
                <div className="truncate text-xs text-muted-foreground">{key}</div>
                <div className="mt-1 text-lg font-semibold">{numberText(value, locale)}</div>
              </div>
            ))}
          </div>
        ) : (
          <LoadingBox />
        )}
      </Section>

      {data?.workers.failedWorkers.length ? (
        <Section title={t("diagnostics.workerErrors")}>
          <div className="overflow-hidden rounded-md border bg-background">
            {data.workers.failedWorkers.map((worker) => (
              <ActionRow
                key={worker.workerKey}
                icon={AlertTriangle}
                title={`${worker.workerName} (${({
                  IDLE: systemT("status.idle"),
                  RUNNING: systemT("status.running"),
                  SUCCESS: systemT("status.success"),
                  FAILED: systemT("status.failed"),
                  RETRY: systemT("status.retry"),
                  DISABLED: systemT("status.disabled"),
                  STARTING: systemT("status.starting"),
                  STOPPED: systemT("status.stopped"),
                }[worker.status] ?? systemT("status.unknown", { code: worker.status }))})`}
                description={worker.lastErrorMessage || worker.workerKey}
                tone="warning"
              />
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

function ApiSandboxView() {
  const t = useTranslations("developer.tools");
  const fetchFallbacks = useFetchJsonFallbacks();
  const [draft, setDraft] = React.useState(defaultApiSandboxDraft);
  const [baseline, setBaseline] = React.useState(defaultApiSandboxDraft);
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<ApiSandboxResponse | null>(null);
  const [error, setError] = React.useState("");

  const discardDraft = React.useCallback(() => {
    setDraft(baseline);
    setError("");
  }, [baseline]);

  useUnsavedForm({
    id: API_SANDBOX_FORM_ID,
    label: t("sandbox.form"),
    isDirty: !apiSandboxDraftsEqual(baseline, draft),
    isBusy: loading,
    discard: discardDraft,
  });

  async function runRequest() {
    const submittedDraft = createApiSandboxDraftSnapshot(draft);
    setLoading(true);
    setError("");

    try {
      const payload = await fetchJson<ApiSandboxResponse>(
        "/api/developer/api-sandbox",
        fetchFallbacks,
        {
          method: "POST",
          body: JSON.stringify(submittedDraft),
        }
      );
      setResult(payload);
      setBaseline(submittedDraft);
    } catch (runError) {
      setResult(null);
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setLoading(false);
    }
  }

  const responsePreview = result?.response?.json ?? result?.response?.text ?? result;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Section
        title={t("sandbox.title")}
        description={t("sandbox.description")}
        action={
          <Badge variant={draft.allowWrite ? "warning" : "success"}>
            {draft.allowWrite ? t("sandbox.writeAllowed") : t("sandbox.readFirst")}
          </Badge>
        }
      >
        <div className="grid gap-3">
          <div className="grid gap-2 md:grid-cols-[140px_minmax(0,1fr)_auto]">
            <Select
              value={draft.method}
              onValueChange={(method) =>
                setDraft((current) => ({ ...current, method }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="GET">GET</SelectItem>
                <SelectItem value="HEAD">HEAD</SelectItem>
                <SelectItem value="POST">POST</SelectItem>
                <SelectItem value="PUT">PUT</SelectItem>
                <SelectItem value="PATCH">PATCH</SelectItem>
                <SelectItem value="DELETE">DELETE</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={draft.path}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  path: event.target.value,
                }))
              }
              placeholder="/api/..."
              autoComplete="off"
              spellCheck={false}
            />
            <Button onClick={() => void runRequest()} disabled={loading}>
              <Play className="size-4" />
              {t("sandbox.run")}
            </Button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.allowWrite}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  allowWrite: event.target.checked,
                }))
              }
              className="size-4"
            />
            {t("sandbox.allowWrite")}
          </label>
          <div className="grid gap-2 md:grid-cols-2">
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              {t("sandbox.requestJson")}
              <textarea
                className="min-h-64 rounded-md border bg-background p-3 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={draft.body}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    body: event.target.value,
                  }))
                }
                spellCheck={false}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              {t("sandbox.response")}
              <textarea
                className="min-h-64 rounded-md border bg-secondary/30 p-3 font-mono text-xs text-foreground outline-none"
                value={
                  result
                    ? JSON.stringify(responsePreview, null, 2)
                    : error || t("sandbox.responsePlaceholder")
                }
                readOnly
              />
            </label>
          </div>
        </div>
      </Section>

      <Section title={t("sandbox.rules")}>
        <div className="overflow-hidden rounded-md border bg-background">
          <ActionRow
            icon={ClipboardList}
            title={t("sandbox.internalOnly")}
            description={t("sandbox.internalOnlyDescription")}
            tone="success"
          />
          <ActionRow
            icon={LockKeyhole}
            title={t("sandbox.authBlocked")}
            description={t("sandbox.authBlockedDescription")}
            tone="warning"
          />
          <ActionRow
            icon={AlertTriangle}
            title={t("sandbox.writeConfirm")}
            description={t("sandbox.writeConfirmDescription")}
            tone="danger"
          />
        </div>
      </Section>
    </div>
  );
}

function AdbDiagnosticsView() {
  const t = useTranslations("developer.tools");
  const fetchFallbacks = useFetchJsonFallbacks();
  const locale = useLocale();
  const { data, loading, error, reload } =
    useApiResource<AdbDevicesPayload>("/api/adb/devices", fetchFallbacks);
  const devices = data?.devices ?? [];
  const offlineCount = devices.filter((device) =>
    ["offline", "unauthorized"].includes(String(device.connectionState ?? ""))
  ).length;
  const emulatorCount = devices.filter((device) =>
    String(device.serial ?? "").startsWith("emulator-")
  ).length;

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatusTile icon={Wrench} label={t("adb.api")} value={data?.ok ? t("adb.apiReady") : t("adb.apiWaiting")} tone={data?.ok ? "success" : "neutral"} />
        <StatusTile icon={Smartphone} label={t("adb.connected")} value={numberText(devices.length, locale)} tone="sky" />
        <StatusTile icon={AlertTriangle} label={t("adb.unavailable")} value={numberText(offlineCount, locale)} tone={offlineCount ? "warning" : "success"} />
        <StatusTile icon={Bug} label={t("adb.emulator")} value={numberText(emulatorCount, locale)} tone={emulatorCount ? "warning" : "neutral"} />
      </div>

      <Section
        title={t("adb.title")}
        description={t("adb.description")}
        action={
          <Button size="sm" variant="outline" onClick={() => void reload()} disabled={loading}>
            <RefreshCcw className="size-4" />
            {t("adb.refresh")}
          </Button>
        }
      >
        {error ? <ErrorBox message={error} /> : null}
        {loading && !data ? <LoadingBox /> : null}
        {devices.length ? (
          <div className="overflow-auto rounded-md border bg-background">
            <table className="min-w-[980px] w-full text-sm">
              <thead className="bg-secondary text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">{t("adb.serial")}</th>
                  <th className="px-3 py-2 text-left">{t("adb.status")}</th>
                  <th className="px-3 py-2 text-left">{t("adb.model")}</th>
                  <th className="px-3 py-2 text-left">{t("adb.carrier")}</th>
                  <th className="px-3 py-2 text-left">{t("adb.storage")}</th>
                  <th className="px-3 py-2 text-left">{t("adb.firstCall")}</th>
                  <th className="px-3 py-2 text-left">{t("adb.camera")}</th>
                  <th className="px-3 py-2 text-left">{t("adb.warning")}</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device, index) => (
                  <tr key={`${device.serial}-${index}`} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">{String(device.serial ?? "-")}</td>
                    <td className="px-3 py-2">{String(device.connectionState ?? "-")}</td>
                    <td className="px-3 py-2">{String(device.modelCode ?? "-")}</td>
                    <td className="px-3 py-2">{String(device.csc ?? "-")}</td>
                    <td className="px-3 py-2">{String(device.storage ?? "-")}</td>
                    <td className="px-3 py-2">{String(device.firstCallDate ?? "-")}</td>
                    <td className="px-3 py-2">{String(device.cameraCheck ?? "-")}</td>
                    <td className="px-3 py-2 whitespace-pre-line">{adbWarningText(device, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !loading ? (
          <LoadingBox text={t("adb.empty")} />
        ) : null}
      </Section>
    </div>
  );
}

function DbMigrationView() {
  const t = useTranslations("developer.tools");
  const fetchFallbacks = useFetchJsonFallbacks();
  const locale = useLocale();
  const { data, loading, error, reload } =
    useApiResource<DbMigrationsPayload>(
      "/api/developer/db-migrations",
      fetchFallbacks
    );
  const migrationItems = data?.prisma.migrations.items ?? [];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Section
        title={t("database.title")}
        description={data ? t("database.checkedAt", { date: data.checkedAt }) : t("database.description")}
        action={
          <Button size="sm" variant="outline" onClick={() => void reload()} disabled={loading}>
            <RefreshCcw className="size-4" />
            {t("database.refresh")}
          </Button>
        }
      >
        {error ? <ErrorBox message={error} /> : null}
        {loading && !data ? (
          <LoadingBox />
        ) : data ? (
          <InfoTable
            rows={[
              {
                label: t("database.file"),
                value: data.database.path || data.database.url,
                tone: data.database.exists ? "success" : "danger",
                note: data.database.exists ? bytesText(data.database.sizeBytes) : t("common.missing"),
              },
              {
                label: t("database.integrity"),
                value: data.database.integrity.values.join(", ") || data.database.integrity.message || "-",
                tone: data.database.integrity.ok ? "success" : "danger",
                note: data.database.integrity.ok ? t("common.normal") : t("common.check"),
              },
              {
                label: "Prisma schema",
                value: data.prisma.schemaPath,
                tone: data.prisma.schemaExists ? "success" : "danger",
                note: data.prisma.schemaExists ? t("common.exists") : t("common.missing"),
              },
              {
                label: "_prisma_migrations",
                value: data.prisma.migrationTable.exists
                  ? t("database.applied", { count: data.prisma.migrationTable.appliedCount })
                  : data.prisma.migrationTable.message || t("database.tableMissing"),
                tone: data.prisma.migrationTable.exists ? "success" : "warning",
                note: data.prisma.migrationTable.exists ? t("database.queried") : t("database.caution"),
              },
            ]}
          />
        ) : null}
      </Section>

      <Section title={t("database.migrations")}>
        {migrationItems.length ? (
          <div className="max-h-[360px] overflow-auto rounded-md border bg-background">
            {migrationItems.map((item) => (
              <div key={item.name} className="grid grid-cols-[minmax(0,1fr)_90px] gap-2 border-b px-3 py-2 text-sm last:border-b-0">
                <div className="min-w-0 truncate font-mono text-xs">{item.name}</div>
                <Badge variant={item.hasSql ? "success" : "warning"}>
                  {item.hasSql ? bytesText(item.sqlSizeBytes) : t("database.noSql")}
                </Badge>
              </div>
            ))}
          </div>
        ) : (
          <LoadingBox text={t("database.noMigrations")} />
        )}
      </Section>

      <Section title={t("database.tables")}>
        {data ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(data.tableCounts).map(([key, value]) => (
              <div key={key} className="rounded-md border bg-background px-3 py-2">
                <div className="truncate text-xs text-muted-foreground">{key}</div>
                <div className="mt-1 text-base font-semibold">{numberText(value, locale)}</div>
              </div>
            ))}
          </div>
        ) : (
          <LoadingBox />
        )}
      </Section>
    </div>
  );
}

export function DeveloperToolsView({
  currentUser,
  mode,
}: {
  currentUser: AuthUser;
  mode: DeveloperMenuId;
}) {
  return (
    <WorkspacePageFrame className="px-5 py-4">
      <div className="min-h-0 flex-1 overflow-auto pb-8">
        {mode === "developer-diagnostics" ? (
          <DiagnosticsView currentUser={currentUser} />
        ) : null}
        {mode === "developer-api-sandbox" ? <ApiSandboxView /> : null}
        {mode === "developer-adb-diagnostics" ? <AdbDiagnosticsView /> : null}
        {mode === "developer-db-migrations" ? <DbMigrationView /> : null}
      </div>
    </WorkspacePageFrame>
  );
}
