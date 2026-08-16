// QuickHack note: 개발자 권한 전용 진단, API 샌드박스, ADB, DB, 개발 데이터 관리 화면입니다.
"use client";

import * as React from "react";
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
import { ROLE_LABELS, type AuthUser } from "@/quickhack_shared/auth/auth-constants";
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

function numberText(value: number | null | undefined) {
  return typeof value === "number" ? value.toLocaleString("ko-KR") : "-";
}

function boolText(value: unknown) {
  return value ? "예" : "아니오";
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

async function fetchJson<T>(url: string, init?: RequestInit) {
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
    throw new Error(text || `응답을 JSON으로 읽지 못했습니다. (${response.status})`);
  }

  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "message" in payload &&
      typeof (payload as { message?: unknown }).message === "string"
        ? (payload as { message: string }).message
        : `API 요청에 실패했습니다. (${response.status})`;

    throw new Error(message);
  }

  return payload as T;
}

function useApiResource<T>(url: string): ApiState<T> & { reload: () => Promise<void> } {
  const [state, setState] = React.useState<ApiState<T>>({
    data: null,
    loading: true,
    error: "",
  });

  const reload = React.useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: "" }));

    try {
      const data = await fetchJson<T>(url);
      setState({ data, loading: false, error: "" });
    } catch (error) {
      setState({
        data: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [url]);

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
            <Badge variant={toneBadgeVariant(row.tone)}>{row.note ?? "확인"}</Badge>
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
      {action ?? <Badge variant={toneBadgeVariant(tone)}>확인</Badge>}
    </div>
  );
}

function LoadingBox({ text = "조회 중입니다." }: { text?: string }) {
  return (
    <div className="grid min-h-32 place-items-center rounded-md border border-dashed bg-background text-sm text-muted-foreground">
      {text}
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
  const { data, loading, error, reload } =
    useApiResource<DeveloperDiagnosticsPayload>("/api/developer/diagnostics");
  const counts = data?.database.tableCounts ?? {};
  const rows: InfoRow[] = data
    ? [
        {
          label: "로그인 사용자",
          value: `${currentUser.displayName} / ${ROLE_LABELS[currentUser.role]}`,
          tone: currentUser.isDeveloper ? "success" : "danger",
          note: currentUser.isDeveloper ? "개발자" : "차단",
        },
        {
          label: "실행 환경",
          value: `${data.runtime.quickHackEnvironment} / ${data.runtime.runtimeRole} / ${data.runtime.nodeEnv}`,
          tone: data.runtime.production ? "warning" : "sky",
          note: data.runtime.production ? "운영" : "개발",
        },
        {
          label: "Node 런타임",
          value: `${data.runtime.nodeVersion} / ${data.runtime.platform}-${data.runtime.arch} / pid ${data.runtime.pid}`,
          tone: "neutral",
          note: data.runtime.hostname,
        },
        {
          label: "DB",
          value: `${data.database.provider} / ${data.database.url}`,
          tone: "purple",
          note: "연결",
        },
        {
          label: "worker",
          value: `등록 ${data.workers.registeredCount} / DB ${data.workers.persistedCount} / 실행 ${data.workers.runningCount}`,
          tone: data.workers.failedCount > 0 ? "warning" : "success",
          note: data.workers.failedCount > 0 ? "오류 있음" : "정상",
        },
      ]
    : [
        {
          label: "로그인 사용자",
          value: `${currentUser.displayName} / ${ROLE_LABELS[currentUser.role]}`,
          tone: currentUser.isDeveloper ? "success" : "danger",
          note: currentUser.isDeveloper ? "개발자" : "차단",
        },
      ];

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatusTile
          icon={CheckCircle2}
          label="메뉴 접근"
          value={currentUser.isDeveloper ? "허용" : "차단"}
          tone={currentUser.isDeveloper ? "success" : "danger"}
        />
        <StatusTile
          icon={Database}
          label="기기 데이터"
          value={numberText(counts.devices)}
          tone="purple"
        />
        <StatusTile
          icon={ServerCog}
          label="worker 실패"
          value={numberText(data?.workers.failedCount)}
          tone={data && data.workers.failedCount > 0 ? "warning" : "success"}
        />
        <StatusTile
          icon={LockKeyhole}
          label="OTP 키"
          value={boolText(data?.environment.hasTotpEncryptionKey)}
          tone={data?.environment.hasTotpEncryptionKey ? "success" : "warning"}
        />
      </div>

      <Section
        title="현재 런타임 상태"
        description={data ? `최종 조회: ${data.checkedAt}` : "서버 진단 API를 호출합니다."}
        action={
          <Button size="sm" variant="outline" onClick={() => void reload()} disabled={loading}>
            <RefreshCcw className="size-4" />
            진단 새로고침
          </Button>
        }
      >
        {error ? <ErrorBox message={error} /> : null}
        {loading && !data ? <LoadingBox /> : <InfoTable rows={rows} />}
      </Section>

      <Section title="주요 테이블 카운트">
        {data ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {Object.entries(data.database.tableCounts).map(([key, value]) => (
              <div key={key} className="rounded-md border bg-background px-3 py-2">
                <div className="truncate text-xs text-muted-foreground">{key}</div>
                <div className="mt-1 text-lg font-semibold">{numberText(value)}</div>
              </div>
            ))}
          </div>
        ) : (
          <LoadingBox />
        )}
      </Section>

      {data?.workers.failedWorkers.length ? (
        <Section title="worker 오류">
          <div className="overflow-hidden rounded-md border bg-background">
            {data.workers.failedWorkers.map((worker) => (
              <ActionRow
                key={worker.workerKey}
                icon={AlertTriangle}
                title={`${worker.workerName} (${worker.status})`}
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
    label: "개발자 API 샌드박스 요청",
    isDirty: !apiSandboxDraftsEqual(baseline, draft),
    isBusy: loading,
    discard: discardDraft,
  });

  async function runRequest() {
    const submittedDraft = createApiSandboxDraftSnapshot(draft);
    setLoading(true);
    setError("");

    try {
      const payload = await fetchJson<ApiSandboxResponse>("/api/developer/api-sandbox", {
        method: "POST",
        body: JSON.stringify(submittedDraft),
      });
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
        title="요청 작성"
        description="내부 API만 호출할 수 있고, 보호 API와 재귀 호출은 서버에서 차단합니다."
        action={
          <Badge variant={draft.allowWrite ? "warning" : "success"}>
            {draft.allowWrite ? "쓰기 허용" : "읽기 우선"}
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
              요청 실행
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
            POST/PATCH/DELETE 같은 쓰기 요청 실행을 허용합니다.
          </label>
          <div className="grid gap-2 md:grid-cols-2">
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              Request JSON
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
              Response
              <textarea
                className="min-h-64 rounded-md border bg-secondary/30 p-3 font-mono text-xs text-foreground outline-none"
                value={
                  result
                    ? JSON.stringify(responsePreview, null, 2)
                    : error || "응답 결과가 여기에 표시됩니다."
                }
                readOnly
              />
            </label>
          </div>
        </div>
      </Section>

      <Section title="샌드박스 보호 규칙">
        <div className="overflow-hidden rounded-md border bg-background">
          <ActionRow
            icon={ClipboardList}
            title="/api 내부 경로만 허용"
            description="외부 URL 호출과 SSRF 위험을 차단합니다."
            tone="success"
          />
          <ActionRow
            icon={LockKeyhole}
            title="인증/OTP API 차단"
            description="로그인, 로그아웃, OTP 등록/검증 API는 직접 호출할 수 없습니다."
            tone="warning"
          />
          <ActionRow
            icon={AlertTriangle}
            title="쓰기 요청 확인"
            description="쓰기 method는 체크박스를 켜야 서버가 실행합니다."
            tone="danger"
          />
        </div>
      </Section>
    </div>
  );
}

function AdbDiagnosticsView() {
  const { data, loading, error, reload } =
    useApiResource<AdbDevicesPayload>("/api/adb/devices");
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
        <StatusTile icon={Wrench} label="ADB API" value={data?.ok ? "응답" : "대기"} tone={data?.ok ? "success" : "neutral"} />
        <StatusTile icon={Smartphone} label="연결 기기" value={numberText(devices.length)} tone="sky" />
        <StatusTile icon={AlertTriangle} label="offline/unauthorized" value={numberText(offlineCount)} tone={offlineCount ? "warning" : "success"} />
        <StatusTile icon={Bug} label="emulator" value={numberText(emulatorCount)} tone={emulatorCount ? "warning" : "neutral"} />
      </div>

      <Section
        title="ADB 기기 조회"
        description={data?.message || "현재 실행 환경에서 ADB 연결 기기를 조회합니다."}
        action={
          <Button size="sm" variant="outline" onClick={() => void reload()} disabled={loading}>
            <RefreshCcw className="size-4" />
            ADB 새로고침
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
                  <th className="px-3 py-2 text-left">Serial</th>
                  <th className="px-3 py-2 text-left">상태</th>
                  <th className="px-3 py-2 text-left">모델코드</th>
                  <th className="px-3 py-2 text-left">통신사</th>
                  <th className="px-3 py-2 text-left">용량</th>
                  <th className="px-3 py-2 text-left">최초 통화일</th>
                  <th className="px-3 py-2 text-left">카메라</th>
                  <th className="px-3 py-2 text-left">경고</th>
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
                    <td className="px-3 py-2 whitespace-pre-line">{String(device.warning ?? "-")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !loading ? (
          <LoadingBox text="표시할 ADB 기기가 없습니다." />
        ) : null}
      </Section>
    </div>
  );
}

function DbMigrationView() {
  const { data, loading, error, reload } =
    useApiResource<DbMigrationsPayload>("/api/developer/db-migrations");
  const migrationItems = data?.prisma.migrations.items ?? [];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Section
        title="DB 상태"
        description={data ? `최종 조회: ${data.checkedAt}` : "PostgreSQL과 Prisma 기준 상태를 조회합니다."}
        action={
          <Button size="sm" variant="outline" onClick={() => void reload()} disabled={loading}>
            <RefreshCcw className="size-4" />
            상태 조회
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
                label: "DB 파일",
                value: data.database.path || data.database.url,
                tone: data.database.exists ? "success" : "danger",
                note: data.database.exists ? bytesText(data.database.sizeBytes) : "없음",
              },
              {
                label: "PostgreSQL 제약 무결성",
                value: data.database.integrity.values.join(", ") || data.database.integrity.message || "-",
                tone: data.database.integrity.ok ? "success" : "danger",
                note: data.database.integrity.ok ? "정상" : "확인 필요",
              },
              {
                label: "Prisma schema",
                value: data.prisma.schemaPath,
                tone: data.prisma.schemaExists ? "success" : "danger",
                note: data.prisma.schemaExists ? "존재" : "없음",
              },
              {
                label: "_prisma_migrations",
                value: data.prisma.migrationTable.exists
                  ? `${data.prisma.migrationTable.appliedCount}건 적용`
                  : data.prisma.migrationTable.message || "테이블 없음",
                tone: data.prisma.migrationTable.exists ? "success" : "warning",
                note: data.prisma.migrationTable.exists ? "조회" : "주의",
              },
            ]}
          />
        ) : null}
      </Section>

      <Section title="마이그레이션 파일">
        {migrationItems.length ? (
          <div className="max-h-[360px] overflow-auto rounded-md border bg-background">
            {migrationItems.map((item) => (
              <div key={item.name} className="grid grid-cols-[minmax(0,1fr)_90px] gap-2 border-b px-3 py-2 text-sm last:border-b-0">
                <div className="min-w-0 truncate font-mono text-xs">{item.name}</div>
                <Badge variant={item.hasSql ? "success" : "warning"}>
                  {item.hasSql ? bytesText(item.sqlSizeBytes) : "SQL 없음"}
                </Badge>
              </div>
            ))}
          </div>
        ) : (
          <LoadingBox text="마이그레이션 파일이 없거나 아직 조회되지 않았습니다." />
        )}
      </Section>

      <Section title="주요 테이블">
        {data ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(data.tableCounts).map(([key, value]) => (
              <div key={key} className="rounded-md border bg-background px-3 py-2">
                <div className="truncate text-xs text-muted-foreground">{key}</div>
                <div className="mt-1 text-base font-semibold">{numberText(value)}</div>
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
