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
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "LEADER")) {
    return NextResponse.json(
      { ok: false, message: "보안 점검 권한이 없습니다." },
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
      label: "실행 모드",
      status: checkStatus(production, environment === "development"),
      value: `${environment} / ${runtimeRole}`,
      detail: production
        ? "운영 모드로 실행 중입니다."
        : "개발 모드입니다. 운영 배포 전 서버 콘솔의 런타임 설정을 확인하세요.",
    },
    {
      key: "coupang-write-api-policy",
      label: "Coupang 쓰기 API 정책",
      status: runtimeConfig.policies.coupangWriteApiEnabled ? "WARNING" : "OK",
      value: runtimeConfig.policies.coupangWriteApiEnabled ? "허용" : "금지",
      detail: runtimeConfig.policies.coupangWriteApiEnabled
        ? "Coupang 쓰기 API가 허용되어 있습니다."
        : "Coupang 쓰기 API가 차단되어 있습니다.",
    },
    {
      key: "logen-write-api-policy",
      label: "Logen 쓰기 API 정책",
      status: runtimeConfig.policies.logenWriteApiEnabled ? "WARNING" : "OK",
      value: runtimeConfig.policies.logenWriteApiEnabled ? "허용" : "금지",
      detail: runtimeConfig.policies.logenWriteApiEnabled
        ? "Logen 쓰기 API가 허용되어 있습니다."
        : "Logen 쓰기 API가 차단되어 있습니다.",
    },
    {
      key: "totp-key",
      label: "OTP 암호화 키",
      status: checkStatus(totpServer.configured),
      value: totpServer.configured ? "사용 가능" : "사용 불가",
      detail: totpServer.configured
        ? `QuickHack 본서버가 ${totpServer.protection ?? "OS protected credential"}로 보호된 OTP 키를 사용하고 있습니다.`
        : `OTP 키 상태가 ${totpServer.state}이므로 보호된 작업이 차단됩니다.`,
    },
    {
      key: "totp-users",
      label: "OTP 적용 계정",
      status: checkStatus(
        activeUserCount === 0 || totpEnabledUserCount > 0,
        activeUserCount > 0
      ),
      value: `${totpEnabledUserCount} / ${activeUserCount}`,
      detail: "활성 계정 중 OTP가 설정된 계정 수입니다.",
    },
    {
      key: "backup-encryption",
      label: "백업 암호화",
      status: checkStatus(backupEncryption.enabled),
      value: backupEncryption.enabled ? "암호화 적용" : "사용 불가",
      detail: backupEncryption.message,
    },
    {
      key: "cookie-secure",
      label: "보안 쿠키",
      status: checkStatus(!production || cookieSecure),
      value: cookieSecure ? "Secure" : "HTTP 허용",
      detail: cookieSecure
        ? "서버 전송 정책이 HTTPS session cookie를 강제합니다."
        : "직접 HTTP 개발 런타임에서는 Secure 속성을 사용하지 않습니다.",
    },
    {
      key: "coupang-auth",
      label: "Coupang API credential",
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
      label: "Channel credential status store",
      status: checkStatus(!channelCredentialPersistenceError),
      value: channelCredentialPersistenceError ? "failed" : "synced",
      detail:
        channelCredentialPersistenceError ||
        "Current Coupang credential status was saved to channel_credentials.",
    },
    {
      key: "logen-auth",
      label: "Logen API credential",
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
      label: "외부 API 연결 대상",
      status: checkStatus(
        packageFlavor === "OPERATIONAL"
          ? externalApiMode === "live"
          : externalApiMode === "mock"
      ),
      value: externalApiMode,
      detail:
        externalApiMode === "mock"
          ? "시연용 package이며 Coupang과 Logen 모두 Mock API를 사용합니다."
          : "운영용 package이며 Coupang과 Logen 모두 공식 Live API를 사용합니다.",
    },
    {
      key: "latest-backup",
      label: "최근 백업",
      status: checkStatus(latestBackupLog?.status === "SUCCESS", true),
      value: latestBackupLog
        ? `${latestBackupLog.status} / ${latestBackupLog.finished_at || latestBackupLog.created_at}`
        : "기록 없음",
      detail: latestBackupLog?.error_message || latestBackupLog?.job_name || "최근 백업 이력이 없습니다.",
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
