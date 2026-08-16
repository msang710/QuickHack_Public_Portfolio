import type { prisma as PrismaService } from "@/quickhack_server/core/prisma";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { replaceUserSessionsInTransaction } from "@/quickhack_server/auth/auth-service";
import { lockServerSecurityState } from "@/quickhack_server/auth/security-state";
import { hashPassword, verifyPassword } from "@/quickhack_server/core/password";
import { databaseNow } from "@/quickhack_server/core/database/time-boundary";
import { passwordChangeValidationError } from "@/quickhack_shared/auth/password-policy";

type PrismaServiceClient = typeof PrismaService;

export class PasswordChangeError extends Error {
  readonly status: 400 | 403 | 409;

  constructor(message: string, status: 400 | 403 | 409) {
    super(message);
    this.name = "PasswordChangeError";
    this.status = status;
  }
}

export async function changeUserPassword(
  prisma: PrismaServiceClient,
  input: {
    userId: number;
    currentPasswordHash: string;
    expectedCredentialRevision: number;
    mustChangePassword: boolean;
    currentPassword: string;
    newPassword: string;
    newPasswordConfirm: string;
  }
) {
  const validationError = passwordChangeValidationError(input);
  if (validationError) throw new PasswordChangeError(validationError, 400);

  if (!(await verifyPassword(input.currentPassword, input.currentPasswordHash))) {
    throw new PasswordChangeError("현재 비밀번호가 올바르지 않습니다.", 403);
  }

  const nextPasswordHash = await hashPassword(input.newPassword);
  const timestamp = databaseNow();

  return prisma.$transaction(async (tx) => {
    const serverState = await lockServerSecurityState(tx);
    const lockedRows = await tx.$queryRaw<
      Array<{
        password_hash: string;
        credential_revision: number;
        revision: number;
        is_active: number;
      }>
    >`
      SELECT password_hash, credential_revision, revision, is_active
      FROM users
      WHERE user_id = ${input.userId}
      FOR UPDATE
    `;
    const lockedUser = lockedRows[0];

    if (
      !lockedUser ||
      lockedUser.is_active !== 1 ||
      lockedUser.password_hash !== input.currentPasswordHash ||
      lockedUser.credential_revision !== input.expectedCredentialRevision
    ) {
      throw new PasswordChangeError(
        "다른 요청에서 계정 보안 정보가 먼저 변경되었습니다. 다시 로그인한 뒤 시도하세요.",
        409
      );
    }

    const nextCredentialRevision = lockedUser.credential_revision + 1;
    await tx.users.update({
      where: { user_id: input.userId },
      data: {
        password_hash: nextPasswordHash,
        must_change_password: 0,
        revision: { increment: 1 },
        credential_revision: nextCredentialRevision,
        updated_at: timestamp,
      },
    });

    const replacement = await replaceUserSessionsInTransaction(tx, {
      userId: input.userId,
      credentialRevision: nextCredentialRevision,
      instanceEpoch: serverState.instance_epoch,
    });

    await tx.employee_activity_logs.create({
      data: {
        user_id: input.userId,
        action_type: "USER_PASSWORD_CHANGE",
        target_type: "USER",
        target_id: String(input.userId),
        ...activityLogChangeData(
          { mustChangePassword: input.mustChangePassword },
          {
            mustChangePassword: false,
            revokedSessionCount: replacement.revokedSessionCount,
          }
        ),
        result: "SUCCESS",
        created_at: timestamp,
      },
    });

    return {
      token: replacement.token,
      revokedSessionCount: replacement.revokedSessionCount,
      credentialRevision: nextCredentialRevision,
      revision: lockedUser.revision + 1,
    };
  });
}
