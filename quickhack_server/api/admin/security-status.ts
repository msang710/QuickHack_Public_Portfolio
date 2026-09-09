// QuickHack note: 보안 점검 메뉴에 환경, MFA, 백업, worker 보안 상태를 제공합니다.
import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import {
  getRuntimeRole,
  isClientRuntime,
} from "@/quickhack_shared/core/runtime";
import { runtimeConfigService } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { getBackupEncryptionState } from "@/quickhack_server/security/backup-encryption";
import { persistChannelCredentialStatus } from "@/quickhack_server/security/channel-credential-service";
import { getChannelAuthStatus } from "@/quickhack_server/security/channel-auth";
import { getLogenCredentialStatus } from "@/quickhack_server/security/logen-usb-qhkey-provider";
import { getTotpServerStatus } from "@/quickhack_server/auth/totp-service";
import {
  QUICKHACK_HTTPS_TERMINATION_ENV,
  QUICKHACK_PUBLIC_ORIGIN_ENV,
  resolveTransportSecurityPolicy,
} from "@/quickhack_shared/security/transport-security-policy.mjs";

export const runtime = "nodejs";

function checkStatus(ok: boolean, warning = false) {
  if (ok) {
    return "OK";
  }

  return warning ? "WARNING" : "FAIL";
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/admin/security-status", {
      method: "GET",
      contentType: null,
    });
  }

  const [{ getAuthUserFromRequest }, { prisma }] = await Promise.all([
    import("@/quickhack_server/auth/auth-service"),
    import("@/quickhack_server/core/prisma"),
  ]);
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, code: "AUTH_REQUIRED" },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "LEADER")) {
    return NextResponse.json(
      { ok: false, code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  const [
    activeUserCount,
    totpEnabledUserCount,
    latestBackupLog,
    securityWorkers,
  ] = await Promise.all([
    prisma.users.count({ where: { is_active: 1 } }),
    prisma.user_totp_credentials.count({
      where: {
        enabled: 1,
        users: {
          is_active: 1,
        },
      },
    }),
    prisma.server_job_logs.findFirst({
      where: {
        job_type: {
          in: ["DATABASE_BACKUP", "WORKER_DATABASE_BACKUP"],
        },
      },
      orderBy: { created_at: "desc" },
      select: {
        job_type: true,
        job_name: true,
        status: true,
        created_at: true,
        finished_at: true,
        error_message: true,
      },
    }),
    prisma.server_worker_jobs.findMany({
      where: {
        worker_key: {
          in: [
            "database-auto-backup",
            "backup-retention-and-integrity",
            "privacy-redact-expired-personal-data",
          ],
        },
      },
      orderBy: { worker_key: "asc" },
      select: {
        worker_key: true,
        worker_name: true,
        status: true,
        schedule_enabled: true,
        last_run_at: true,
        last_error_message: true,
      },
    }),
  ]);
  const runtimeConfig = runtimeConfigService.read();
  const environment = runtimeConfig.environment;
  const production = runtimeConfig.production;
  const runtimeRole = getRuntimeRole();
  const backupEncryption = await getBackupEncryptionState();
  const totpServer = await getTotpServerStatus();
  const [coupangAuth, logenAuth] = await Promise.all([
    getChannelAuthStatus("COUPANG"),
    getLogenCredentialStatus(),
  ]);
  let channelCredentialPersistenceError = "";

  try {
    await persistChannelCredentialStatus(coupangAuth);
  } catch {
    channelCredentialPersistenceError =
      "채널 인증 상태를 저장하지 못했습니다. 서버 로그를 확인하세요.";
  }

  const externalApiMode = runtimeConfig.endpoints.coupang.mode;
  const packageFlavor =
    runtimeConfig.role === "server"
      ? runtimeConfig.packageFlavor
      : "DEMONSTRATION";
  const transportSecurity = resolveTransportSecurityPolicy({
    runtimeRole: runtimeConfig.role,
    production: runtimeConfig.production,
    httpsTerminated: process.env[QUICKHACK_HTTPS_TERMINATION_ENV],
    publicOrigin: process.env[QUICKHACK_PUBLIC_ORIGIN_ENV],
  });
  const cookieSecure = transportSecurity.secureSessionCookie;
  const checks = [
    {
      key: "runtime",
      status: checkStatus(production, environment === "development"),
      value: `${environment} / ${runtimeRole}`,
      detail: "",
      detailCode: production ? "RUNTIME_PRODUCTION" : "RUNTIME_DEVELOPMENT",
    },
    {
      key: "coupang-write-api-policy",
      status: runtimeConfig.policies.coupangWriteApiEnabled ? "WARNING" : "OK",
      value: "",
      valueCode: runtimeConfig.policies.coupangWriteApiEnabled ? "ALLOWED" : "BLOCKED",
      detail: "",
      detailCode: runtimeConfig.policies.coupangWriteApiEnabled ? "COUPANG_WRITE_ALLOWED" : "COUPANG_WRITE_BLOCKED",
    },
    {
      key: "logen-write-api-policy",
      status: runtimeConfig.policies.logenWriteApiEnabled ? "WARNING" : "OK",
      value: "",
      valueCode: runtimeConfig.policies.logenWriteApiEnabled ? "ALLOWED" : "BLOCKED",
      detail: "",
      detailCode: runtimeConfig.policies.logenWriteApiEnabled ? "LOGEN_WRITE_ALLOWED" : "LOGEN_WRITE_BLOCKED",
    },
    {
      key: "totp-key",
      status: checkStatus(totpServer.configured),
      value: "",
      valueCode: totpServer.configured ? "AVAILABLE" : "UNAVAILABLE",
      detail: "",
      detailCode: totpServer.configured ? "TOTP_KEY_AVAILABLE" : "TOTP_KEY_UNAVAILABLE",
      messageArguments: totpServer.configured
        ? { protection: totpServer.protection ?? "OS protected credential" }
        : { state: totpServer.state },
    },
    {
      key: "totp-users",
      status: checkStatus(
        activeUserCount === 0 || totpEnabledUserCount > 0,
        activeUserCount > 0
      ),
      value: `${totpEnabledUserCount} / ${activeUserCount}`,
      detail: "",
      detailCode: "TOTP_USERS",
    },
    {
      key: "backup-encryption",
      status: checkStatus(backupEncryption.enabled),
      value: "",
      valueCode: backupEncryption.enabled ? "ENCRYPTED" : "UNAVAILABLE",
      detail: backupEncryption.message,
    },
    {
      key: "cookie-secure",
      status: checkStatus(!production || cookieSecure),
      value: "",
      valueCode: cookieSecure ? "SECURE" : "HTTP_ALLOWED",
      detail: "",
      detailCode: cookieSecure ? "COOKIE_SECURE" : "COOKIE_HTTP_ALLOWED",
    },
    {
      key: "coupang-auth",
      status: checkStatus(
        coupangAuth.status === "ACTIVE",
        coupangAuth.status === "WARNING"
      ),
      value: `${coupangAuth.providerType} / ${coupangAuth.status}`,
      detail:
        coupangAuth.errorMessage ||
        coupangAuth.warningMessage ||
        `fingerprint=${coupangAuth.keyFingerprint ?? "none"}`,
    },
    {
      key: "channel-credential-store",
      status: checkStatus(!channelCredentialPersistenceError),
      value: channelCredentialPersistenceError ? "failed" : "synced",
      detail:
        channelCredentialPersistenceError ||
        "Current Coupang credential status was saved to channel_credentials.",
    },
    {
      key: "logen-auth",
      status: checkStatus(
        logenAuth.status === "ACTIVE",
        logenAuth.status === "WARNING"
      ),
      value: `${logenAuth.providerType} / ${logenAuth.status}`,
      detail:
        logenAuth.errorMessage ||
        logenAuth.warningMessage ||
        `fingerprint=${logenAuth.keyFingerprint ?? "built-in-mock"}`,
    },
    {
      key: "external-api-destination",
      status: checkStatus(
        packageFlavor === "OPERATIONAL"
          ? externalApiMode === "live"
          : externalApiMode === "mock"
      ),
      value: externalApiMode,
      detail:
        externalApiMode === "mock"
          ? ""
          : "",
      detailCode: externalApiMode === "mock" ? "EXTERNAL_API_MOCK" : "EXTERNAL_API_LIVE",
    },
    {
      key: "latest-backup",
      status: checkStatus(latestBackupLog?.status === "SUCCESS", true),
      value: latestBackupLog
        ? `${latestBackupLog.status} / ${latestBackupLog.finished_at || latestBackupLog.created_at}`
        : "",
      valueCode: latestBackupLog ? undefined : "NO_RECORD",
      detail: latestBackupLog?.error_message || latestBackupLog?.job_name || "",
      detailCode: latestBackupLog?.error_message || latestBackupLog?.job_name ? undefined : "NO_BACKUP_HISTORY",
    },
  ];
  const warningCount = checks.filter((item) => item.status === "WARNING").length;
  const failCount = checks.filter((item) => item.status === "FAIL").length;

  return NextResponse.json({
    ok: true,
    summary: {
      total: checks.length,
      ok: checks.filter((item) => item.status === "OK").length,
      warning: warningCount,
      fail: failCount,
    },
    checks,
    workers: securityWorkers.map((worker) => ({
      workerKey: worker.worker_key,
      workerName: worker.worker_name,
      status: worker.status,
      scheduleEnabled: worker.schedule_enabled === 1,
      lastRunAt: worker.last_run_at,
      lastErrorMessage: worker.last_error_message,
    })),
  });
}
