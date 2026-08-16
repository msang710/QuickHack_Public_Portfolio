import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import {
  BACKUP_CONSOLE_WORKER,
} from "@/quickhack_server/admin/backup-worker-policy";
import { runBackupWorkerNow } from "@/quickhack_server/admin/backup-console-service";
import { prisma } from "@/quickhack_server/core/prisma";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import {
  getTotpKeyStatus,
  recoverTotpKeyAfterCredentialsCleared,
  type TotpKeyStatus,
} from "@/quickhack_server/security/totp-key-provider";
import { lockAndAdvanceServerSecurityState } from "@/quickhack_server/auth/security-state";

export const TOTP_SECURITY_RESET_CONFIRM_TEXT = "OTP 초기화";

export class TotpSecurityRecoveryError extends Error {
  readonly code: string;
  readonly statusCode: 400 | 409 | 503;

  constructor(
    code: string,
    message: string,
    statusCode: 400 | 409 | 503
  ) {
    super(message);
    this.name = "TotpSecurityRecoveryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type TotpSecurityRecoveryDependencies = {
  prismaClient?: typeof prisma;
  getKeyStatus?: () => Promise<TotpKeyStatus>;
  recoverKeyAfterCredentialsCleared?: () => Promise<TotpKeyStatus>;
  runSafetyBackup?: () => Promise<unknown>;
};

function recoveryAllowed(status: TotpKeyStatus) {
  return !status.configured && status.state !== "UNSUPPORTED_PLATFORM";
}

export function createTotpSecurityRecoveryService(
  dependencies: TotpSecurityRecoveryDependencies = {}
) {
  const prismaClient = dependencies.prismaClient ?? prisma;
  const getKeyStatus = dependencies.getKeyStatus ?? getTotpKeyStatus;
  const recoverKeyAfterCredentialsCleared =
    dependencies.recoverKeyAfterCredentialsCleared ??
    recoverTotpKeyAfterCredentialsCleared;
  const runSafetyBackup =
    dependencies.runSafetyBackup ??
    (() => runBackupWorkerNow(BACKUP_CONSOLE_WORKER.automaticBackup));
  let recoveryRunning = false;

  async function readState() {
    const [key, credentialRows, recoveryCodeCount] = await Promise.all([
      getKeyStatus(),
      prismaClient.user_totp_credentials.findMany({
        select: { user_id: true, enabled: true },
      }),
      prismaClient.user_totp_recovery_codes.count(),
    ]);
    const affectedUserIds = credentialRows.map((row) => row.user_id);
    const sessionCount = affectedUserIds.length
      ? await prismaClient.user_sessions.count({
          where: { user_id: { in: affectedUserIds } },
        })
      : 0;

    return {
      key,
      credentialCount: credentialRows.length,
      enabledCredentialCount: credentialRows.filter(
        (row) => row.enabled === 1
      ).length,
      recoveryCodeCount,
      affectedSessionCount: sessionCount,
      recovery: {
        allowed: recoveryAllowed(key),
        running: recoveryRunning,
        requiresReset: !key.configured && credentialRows.length > 0,
        confirmText:
          !key.configured && credentialRows.length > 0
            ? TOTP_SECURITY_RESET_CONFIRM_TEXT
            : null,
      },
    };
  }

  async function resetCredentialState() {
    return prismaClient.$transaction(async (tx) => {
      await lockAndAdvanceServerSecurityState(tx);
      const credentials = await tx.user_totp_credentials.findMany({
        select: { user_id: true, enabled: true },
      });
      const affectedUserIds = credentials.map((row) => row.user_id);

      if (affectedUserIds.length === 0) {
        return {
          credentialCount: 0,
          enabledCredentialCount: 0,
          recoveryCodeCount: 0,
          invalidatedSessionCount: 0,
        };
      }

      await tx.$queryRaw`
        SELECT user_id
        FROM users
        WHERE user_id = ANY(${affectedUserIds}::int[])
        ORDER BY user_id
        FOR UPDATE
      `;

      const [recoveryCodeCount, sessionCount] = await Promise.all([
        tx.user_totp_recovery_codes.count({
          where: { user_id: { in: affectedUserIds } },
        }),
        tx.user_sessions.count({
          where: { user_id: { in: affectedUserIds } },
        }),
      ]);
      const enabledCredentialCount = credentials.filter(
        (row) => row.enabled === 1
      ).length;

      await tx.user_totp_recovery_codes.deleteMany({
        where: { user_id: { in: affectedUserIds } },
      });
      await tx.user_totp_credentials.deleteMany({
        where: { user_id: { in: affectedUserIds } },
      });
      await tx.user_sessions.deleteMany({
        where: { user_id: { in: affectedUserIds } },
      });
      await tx.users.updateMany({
        where: { user_id: { in: affectedUserIds } },
        data: {
          revision: { increment: 1 },
          credential_revision: { increment: 1 },
          updated_at: databaseNow(),
        },
      });
      await tx.employee_activity_logs.create({
        data: {
          user_id: null,
          action_type: "SYSTEM_TOTP_SECURITY_RESET",
          target_type: "SECURITY",
          target_id: "TOTP_MASTER_KEY",
          ...activityLogChangeData(
            {
              credentialCount: credentials.length,
              enabledCredentialCount,
              recoveryCodeCount,
              affectedSessionCount: sessionCount,
            },
            {
              credentialCount: 0,
              enabledCredentialCount: 0,
              recoveryCodeCount: 0,
              affectedSessionCount: 0,
              registrationRequired: true,
            }
          ),
          result: "SUCCESS",
          created_at: databaseNow(),
        },
      });

      return {
        credentialCount: credentials.length,
        enabledCredentialCount,
        recoveryCodeCount,
        invalidatedSessionCount: sessionCount,
      };
    });
  }

  async function recover(input: { confirmText?: unknown }) {
    if (recoveryRunning) {
      throw new TotpSecurityRecoveryError(
        "TOTP_SECURITY_RECOVERY_RUNNING",
        "OTP 보안 복구가 이미 진행 중입니다.",
        409
      );
    }

    recoveryRunning = true;

    try {
      const before = await readState();

      if (before.key.configured) {
        throw new TotpSecurityRecoveryError(
          "TOTP_SECURITY_ALREADY_READY",
          "OTP 보안 서비스가 정상 상태이므로 전역 초기화를 실행하지 않았습니다.",
          409
        );
      }

      if (!before.recovery.allowed) {
        throw new TotpSecurityRecoveryError(
          "TOTP_SECURITY_RECOVERY_UNAVAILABLE",
          "현재 서버 환경에서는 OTP 보안 서비스를 복구할 수 없습니다.",
          503
        );
      }

      if (
        before.credentialCount > 0 &&
        String(input.confirmText ?? "").trim() !==
          TOTP_SECURITY_RESET_CONFIRM_TEXT
      ) {
        throw new TotpSecurityRecoveryError(
          "TOTP_SECURITY_RESET_CONFIRMATION_REQUIRED",
          `전역 OTP 초기화를 실행하려면 '${TOTP_SECURITY_RESET_CONFIRM_TEXT}'를 정확히 입력하세요.`,
          400
        );
      }

      let backupCreated = false;
      let reset = {
        credentialCount: 0,
        enabledCredentialCount: 0,
        recoveryCodeCount: 0,
        invalidatedSessionCount: 0,
      };

      if (before.credentialCount > 0) {
        await runSafetyBackup();
        backupCreated = true;
        reset = await resetCredentialState();
      }

      let key: TotpKeyStatus;

      try {
        key = await recoverKeyAfterCredentialsCleared();
      } catch {
        key = await getKeyStatus();
      }

      return {
        recovered: key.configured,
        backupCreated,
        reset,
        key,
        registrationRequired: reset.credentialCount > 0,
        message: key.configured
          ? reset.credentialCount > 0
            ? "OTP 보안 정보를 초기화했습니다. 영향받은 사용자는 다시 로그인해 OTP를 재등록해야 합니다."
            : "OTP 보안 키를 다시 점검하고 사용할 수 있는 상태로 복구했습니다."
          : reset.credentialCount > 0
            ? "OTP 등록 정보는 안전하게 초기화했지만 새 키를 만들지 못했습니다. 서버 콘솔에서 복구를 다시 시도하세요."
            : "OTP 보안 키를 다시 만들지 못했습니다. 서버 환경을 확인한 뒤 복구를 다시 시도하세요.",
      };
    } finally {
      recoveryRunning = false;
    }
  }

  return { readState, recover };
}

const totpSecurityRecoveryService = createTotpSecurityRecoveryService();

export function readTotpSecurityRecoveryState() {
  return totpSecurityRecoveryService.readState();
}

export function recoverTotpSecurity(input: { confirmText?: unknown }) {
  return totpSecurityRecoveryService.recover(input);
}
