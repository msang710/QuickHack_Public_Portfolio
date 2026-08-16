// QuickHack note: 사용자 계정 관리 화면이 직원 계정 목록을 조회하는 서버 API입니다.
import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/quickhack_server/api/error-response";
import {
  publicBadRequest,
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";
import type { Prisma } from "@/generated/prisma/client";
import { ROLES, type AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { normalizeAccountUsername } from "@/quickhack_shared/auth/account-username";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { activityLogChangeData } from "@/quickhack_server/audit/structured-log-values";
import { passwordLengthError } from "@/quickhack_shared/auth/password-policy";
import {
  apiDate,
  apiDateTime,
  databaseDate,
  databaseNow,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import {
  accountAuditSnapshot,
  assertActiveLeaderRemains,
  authorizeAccountMutation,
  lockAccountTarget,
} from "@/quickhack_server/auth/account-security-aggregate";
import {
  createMutationReceipt,
  stableMutationOperationId,
} from "@/quickhack_server/api/mutation-receipt";

export const runtime = "nodejs";

type AdminUsersPostDependencies = {
  loadTotpService?: () => Promise<
    Pick<
      typeof import("@/quickhack_server/auth/totp-service"),
      | "replaceUserTotpRecoveryCodes"
      | "requireTotpKeyReady"
      | "resetUserTotpState"
    >
  >;
};

function parseJsonObject(text: string) {
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isRole(value: string) {
  return (ROLES as readonly string[]).includes(value);
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function cleanOptionalText(value: unknown) {
  const text = cleanText(value);
  return text || null;
}

function cleanOptionalDate(value: unknown, label: string) {
  const text = cleanText(value);

  if (!text) {
    return null;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw publicBadRequest(
      "INVALID_ACCOUNT_DATE",
      `${label}은 YYYY-MM-DD 형식으로 입력해야 합니다.`
    );
  }

  return text;
}

function requiredExpectedRevision(body: Record<string, unknown>) {
  const revision = Number(body.expectedRevision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw publicBadRequest(
      "EXPECTED_ACCOUNT_REVISION_REQUIRED",
      "대상 계정의 최신 revision이 필요합니다. 목록을 새로고침한 뒤 다시 시도하세요."
    );
  }
  return revision;
}

function userSnapshot(user: {
  user_id: number;
  username: string;
  role: string;
  is_developer: number;
  mobile_packing_enabled: number;
  must_change_password: number;
  is_active: number;
  revision: number;
  created_at?: Date;
  updated_at?: Date;
  user_totp_credentials?: {
    enabled: number;
    verified_at?: Date | null;
    locked_until?: Date | null;
  } | null;
  unusedRecoveryCodeCount?: number;
  employee_profiles?: {
    display_name: string;
    phone?: string | null;
    email?: string | null;
    birth_date?: Date | null;
    hire_date?: Date | null;
  } | null;
}) {
  const profile = user.employee_profiles;

  return {
    userId: user.user_id,
    username: user.username,
    displayName: profile?.display_name ?? user.username,
    phone: profile?.phone ?? "",
    email: profile?.email ?? "",
    birthDate: apiDate(profile?.birth_date) ?? "",
    hireDate: apiDate(profile?.hire_date) ?? "",
    role: user.role,
    isDeveloper: user.is_developer === 1,
    mobilePackingEnabled: user.mobile_packing_enabled === 1,
    mustChangePassword: user.must_change_password === 1,
    isActive: user.is_active === 1,
    revision: user.revision,
    totpEnabled: user.user_totp_credentials?.enabled === 1,
    totpVerifiedAt: apiDateTime(user.user_totp_credentials?.verified_at) ?? "",
    totpLockedUntil: apiDateTime(user.user_totp_credentials?.locked_until) ?? "",
    recoveryCodeCount: user.unusedRecoveryCodeCount ?? 0,
    createdAt: user.created_at
      ? requiredApiDateTime(user.created_at)
      : undefined,
    updatedAt: user.updated_at
      ? requiredApiDateTime(user.updated_at)
      : undefined,
  };
}

async function recoveryCodeCountsByUser(
  prisma: typeof import("@/quickhack_server/core/prisma").prisma
) {
  const rows = await prisma.user_totp_recovery_codes.groupBy({
    by: ["user_id"],
    where: { used_at: null },
    _count: { _all: true },
  });

  return new Map(rows.map((row) => [row.user_id, row._count._all]));
}

async function auth(request: NextRequest) {
  const [{ authorizeAccountManagement }, { prisma }] = await Promise.all([
    import("@/quickhack_server/auth/account-management-access"),
    import("@/quickhack_server/core/prisma"),
  ]);
  const authorization = await authorizeAccountManagement(request);

  return authorization.authorized
    ? {
        user: authorization.user,
        securityContext: authorization.securityContext,
        prisma,
      }
    : { response: authorization.response };
}

function validateUserInput(body: Record<string, unknown>) {
  const userIdValue = body.userId;
  const userId =
    userIdValue === null || userIdValue === undefined || userIdValue === ""
      ? null
      : Number(userIdValue);
  const username = normalizeAccountUsername(body.username);
  const displayName = cleanText(body.displayName);
  const phone = cleanOptionalText(body.phone);
  const email = cleanOptionalText(body.email);
  const birthDate = cleanOptionalDate(body.birthDate, "생일");
  const hireDate = cleanOptionalDate(body.hireDate, "입사일");
  const role = cleanText(body.role);
  const isDeveloper = Boolean(body.isDeveloper);
  const mobilePackingEnabled = Boolean(body.mobilePackingEnabled);
  const isActive = Boolean(body.isActive);
  const tempPassword = String(body.tempPassword ?? "");
  const expectedRevisionValue = body.expectedRevision;
  const expectedRevision =
    expectedRevisionValue === null ||
    expectedRevisionValue === undefined ||
    expectedRevisionValue === ""
      ? null
      : Number(expectedRevisionValue);

  if (userId !== null && (!Number.isInteger(userId) || userId <= 0)) {
    throw publicBadRequest(
      "INVALID_ACCOUNT_ID",
      "수정할 계정 정보가 올바르지 않습니다."
    );
  }

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw publicBadRequest(
      "INVALID_USERNAME",
      "아이디는 영문 소문자, 숫자, 점, 밑줄, 하이픈으로 3~32자만 입력할 수 있습니다."
    );
  }

  if (!displayName || displayName.length > 40) {
    throw publicBadRequest(
      "INVALID_DISPLAY_NAME",
      "직원 표시 이름은 1~40자로 입력해야 합니다."
    );
  }

  if (phone && !/^[0-9+\-()\s]{7,30}$/.test(phone)) {
    throw publicBadRequest(
      "INVALID_PHONE_NUMBER",
      "전화번호 형식이 올바르지 않습니다."
    );
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw publicBadRequest("INVALID_EMAIL", "이메일 형식이 올바르지 않습니다.");
  }

  if (!isRole(role)) {
    throw publicBadRequest("INVALID_ACCOUNT_ROLE", "권한 값이 올바르지 않습니다.");
  }

  const tempPasswordError = tempPassword
    ? passwordLengthError(tempPassword, "임시 비밀번호")
    : "";

  if (tempPasswordError) {
    throw publicBadRequest("INVALID_TEMP_PASSWORD", tempPasswordError);
  }

  if (!userId && !tempPassword) {
    throw publicBadRequest(
      "TEMP_PASSWORD_REQUIRED",
      "새 계정을 만들 때는 임시 비밀번호가 필요합니다."
    );
  }

  if (
    userId !== null &&
    (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0)
  ) {
    throw publicBadRequest(
      "EXPECTED_ACCOUNT_REVISION_REQUIRED",
      "수정할 계정의 최신 revision이 필요합니다. 목록을 새로고침한 뒤 다시 시도하세요."
    );
  }

  return {
    userId,
    username,
    displayName,
    phone,
    email,
    birthDate,
    hireDate,
    role,
    isDeveloper,
    mobilePackingEnabled,
    isActive,
    tempPassword,
    expectedRevision,
  };
}

async function writeActivityLog(
  tx: Prisma.TransactionClient,
  user: AuthUser,
  actionType: string,
  targetId: string,
  beforeValue: unknown,
  afterValue: unknown
) {
  await tx.employee_activity_logs.create({
    data: {
      user_id: user.userId,
      action_type: actionType,
      target_type: "USER",
      target_id: targetId,
      ...activityLogChangeData(beforeValue, afterValue),
      result: "SUCCESS",
      created_at: databaseNow(),
    },
  });
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/admin/users", {
      method: "GET",
      contentType: null,
    });
  }

  const authResult = await auth(request);

  if ("response" in authResult) {
    return authResult.response;
  }

  const [users, recoveryCounts] = await Promise.all([
    authResult.prisma.users.findMany({
      orderBy: [
        { is_active: "desc" },
        { role: "asc" },
        { username: "asc" },
      ],
      select: {
        user_id: true,
        username: true,
        role: true,
        is_developer: true,
        mobile_packing_enabled: true,
        must_change_password: true,
        is_active: true,
        revision: true,
        created_at: true,
        updated_at: true,
        user_totp_credentials: {
          select: {
            enabled: true,
            verified_at: true,
            locked_until: true,
          },
        },
        employee_profiles: {
          select: {
            display_name: true,
            phone: true,
            email: true,
            birth_date: true,
            hire_date: true,
          },
        },
      },
    }),
    recoveryCodeCountsByUser(authResult.prisma),
  ]);

  return NextResponse.json({
    ok: true,
    items: users.map((user) =>
      userSnapshot({
        ...user,
        unusedRecoveryCodeCount: recoveryCounts.get(user.user_id) ?? 0,
      })
    ),
  });
}

async function handleAdminUsersPost(
  request: NextRequest,
  dependencies: AdminUsersPostDependencies
) {
  const loadTotpService =
    dependencies.loadTotpService ??
    (() => import("@/quickhack_server/auth/totp-service"));
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/admin/users", {
      method: "POST",
      body: bodyText,
    });
  }

  const authResult = await auth(request);

  if ("response" in authResult) {
    return authResult.response;
  }

  const body = parseJsonObject(bodyText);

  if (!body) {
    return NextResponse.json(
      { ok: false, message: "요청 본문이 올바르지 않습니다." },
      { status: 400 }
    );
  }

  const action = cleanText(body.action);

  try {
    if (action === "saveUser") {
      const input = validateUserInput(body);
      const { hashPassword } = await import("@/quickhack_server/core/password");
      const timestamp = databaseNow();

      const saved = await authResult.prisma.$transaction(async (tx) => {
        await authorizeAccountMutation(tx, authResult.securityContext);
        const before = input.userId
          ? await lockAccountTarget(
              tx,
              input.userId,
              input.expectedRevision as number
            )
          : null;

        if (input.userId && !before) {
          throw publicNotFound(
            "ACCOUNT_NOT_FOUND",
            "수정할 계정을 찾을 수 없습니다."
          );
        }

        if (before && before.user_id === authResult.user.userId) {
          if (!input.isActive) {
            throw publicConflict(
              "SELF_DEACTIVATION_FORBIDDEN",
              "자기 자신의 계정은 비활성화할 수 없습니다."
            );
          }

          if (input.role !== before.role && input.role !== "LEADER") {
            throw publicConflict(
              "SELF_ROLE_DOWNGRADE_FORBIDDEN",
              "자기 자신의 리더급 권한은 낮출 수 없습니다."
            );
          }

          if (before.is_developer === 1 && !input.isDeveloper) {
            throw publicConflict(
              "SELF_DEVELOPER_REVOKE_FORBIDDEN",
              "자기 자신의 개발자 권한은 해제할 수 없습니다."
            );
          }
        }

        const duplicate = await tx.users.findUnique({
          where: { username: input.username },
        });

        if (duplicate && duplicate.user_id !== input.userId) {
          throw publicConflict(
            "USERNAME_ALREADY_EXISTS",
            "이미 사용 중인 아이디입니다."
          );
        }

        const passwordData = input.tempPassword
          ? {
              password_hash: await hashPassword(input.tempPassword),
              must_change_password: 1,
            }
          : {};
        const securityChanged = Boolean(
          before &&
            (before.username !== input.username ||
              before.role !== input.role ||
              before.is_developer !== (input.isDeveloper ? 1 : 0) ||
              before.mobile_packing_enabled !==
                (input.mobilePackingEnabled ? 1 : 0) ||
              before.is_active !== (input.isActive ? 1 : 0) ||
              input.tempPassword)
        );
        if (before) {
          await assertActiveLeaderRemains(tx, {
            targetUserId: before.user_id,
            nextRole: input.role,
            nextIsActive: input.isActive ? 1 : 0,
          });
        }
        const userData = {
          username: input.username,
          role: input.role,
          is_developer: input.isDeveloper ? 1 : 0,
          mobile_packing_enabled: input.mobilePackingEnabled ? 1 : 0,
          is_active: input.isActive ? 1 : 0,
          updated_at: timestamp,
          ...passwordData,
        };
        const profileData = {
          display_name: input.displayName,
          phone: input.phone,
          email: input.email,
          birth_date: input.birthDate ? databaseDate(input.birthDate) : null,
          hire_date: input.hireDate ? databaseDate(input.hireDate) : null,
          updated_at: timestamp,
        };
        const afterUser = input.userId
          ? await tx.users.update({
              where: { user_id: input.userId },
              data: {
                ...userData,
                revision: { increment: 1 },
                credential_revision: securityChanged
                  ? { increment: 1 }
                  : undefined,
              },
            })
          : await tx.users.create({
              data: {
                ...userData,
                password_hash: passwordData.password_hash!,
                created_at: timestamp,
              },
            });
        const afterProfile = await tx.employee_profiles.upsert({
          where: {
            user_id: afterUser.user_id,
          },
          update: profileData,
          create: {
            user_id: afterUser.user_id,
            ...profileData,
            created_at: timestamp,
          },
        });
        const after = {
          ...afterUser,
          employee_profiles: afterProfile,
        };

        if (securityChanged) {
          await tx.user_sessions.deleteMany({
            where: {
              user_id: afterUser.user_id,
            },
          });
        }

        await writeActivityLog(
          tx,
          authResult.user,
          before ? "USER_ACCOUNT_UPDATE" : "USER_ACCOUNT_CREATE",
          String(after.user_id),
          before ? accountAuditSnapshot(before) : null,
          {
            ...accountAuditSnapshot(after),
            passwordChanged: Boolean(input.tempPassword),
          }
        );

        const unusedRecoveryCodeCount = before
          ? await tx.user_totp_recovery_codes.count({
              where: { user_id: after.user_id, used_at: null },
            })
          : 0;

        return userSnapshot({
          ...after,
          user_totp_credentials: before?.user_totp_credentials ?? null,
          unusedRecoveryCodeCount,
        });
      });

      const receipt = createMutationReceipt(saved, {
        operationId: stableMutationOperationId("admin-account-save", [
          saved.userId,
          saved.revision,
        ]),
        committedAt: saved.updatedAt,
      });

      return NextResponse.json({
        ok: true,
        message: inputMessage(saved.userId === input.userId, Boolean(input.tempPassword)),
        item: saved,
        receipt,
      });
    }

    if (action === "deactivateUser") {
      const userId = Number(body.userId);
      const expectedRevision = requiredExpectedRevision(body);

      if (!Number.isInteger(userId) || userId <= 0) {
        throw publicBadRequest(
          "INVALID_ACCOUNT_ID",
          "비활성화할 계정 정보가 올바르지 않습니다."
        );
      }

      if (userId === authResult.user.userId) {
        throw publicConflict(
          "SELF_DEACTIVATION_FORBIDDEN",
          "자기 자신의 계정은 비활성화할 수 없습니다."
        );
      }

      const updated = await authResult.prisma.$transaction(async (tx) => {
        await authorizeAccountMutation(tx, authResult.securityContext);
        const before = await lockAccountTarget(tx, userId, expectedRevision);

        if (!before) {
          throw publicNotFound(
            "ACCOUNT_NOT_FOUND",
            "비활성화할 계정을 찾을 수 없습니다."
          );
        }

        await assertActiveLeaderRemains(tx, {
          targetUserId: userId,
          nextRole: before.role,
          nextIsActive: 0,
        });
        const after = await tx.users.update({
          where: { user_id: userId },
          data: {
            is_active: 0,
            revision: { increment: 1 },
            credential_revision: { increment: 1 },
            updated_at: databaseNow(),
          },
          include: { employee_profiles: true },
        });

        await tx.user_sessions.deleteMany({
          where: {
            user_id: userId,
          },
        });

        await writeActivityLog(
          tx,
          authResult.user,
          "USER_ACCOUNT_DEACTIVATE",
          String(userId),
          accountAuditSnapshot(before),
          accountAuditSnapshot(after)
        );

        const unusedRecoveryCodeCount = await tx.user_totp_recovery_codes.count({
          where: { user_id: after.user_id, used_at: null },
        });

        return userSnapshot({
          ...after,
          user_totp_credentials: before.user_totp_credentials,
          unusedRecoveryCodeCount,
        });
      });

      const receipt = createMutationReceipt(updated, {
        operationId: stableMutationOperationId("admin-account-deactivate", [
          updated.userId,
          updated.revision,
        ]),
        committedAt: updated.updatedAt,
      });

      return NextResponse.json({
        ok: true,
        message: "계정을 비활성화했습니다.",
        item: updated,
        receipt,
      });
    }

    if (action === "resetTotp") {
      const userId = Number(body.userId);
      const expectedRevision = requiredExpectedRevision(body);

      if (!Number.isInteger(userId) || userId <= 0) {
        throw publicBadRequest(
          "INVALID_ACCOUNT_ID",
          "OTP를 초기화할 계정 정보가 올바르지 않습니다."
        );
      }

      const { resetUserTotpState } = await loadTotpService();

      const updated = await authResult.prisma.$transaction(async (tx) => {
        await authorizeAccountMutation(tx, authResult.securityContext);
        const target = await lockAccountTarget(tx, userId, expectedRevision);

        if (!target) {
          throw publicNotFound(
            "ACCOUNT_NOT_FOUND",
            "OTP를 초기화할 계정을 찾을 수 없습니다."
          );
        }

        await resetUserTotpState(tx, userId);
        const after = await tx.users.update({
          where: { user_id: userId },
          data: {
            revision: { increment: 1 },
            credential_revision: { increment: 1 },
            updated_at: databaseNow(),
          },
        });
        await writeActivityLog(
          tx,
          authResult.user,
          "USER_TOTP_RESET",
          String(userId),
          {
            userId,
            username: target.username,
            totpEnabled: target.user_totp_credentials?.enabled === 1,
          },
          {
            userId,
            username: target.username,
            totpEnabled: false,
            recoveryCodeCount: 0,
          }
        );

        return userSnapshot({
          ...after,
          employee_profiles: target.employee_profiles,
          user_totp_credentials: null,
          unusedRecoveryCodeCount: 0,
        });
      });

      const receipt = createMutationReceipt(updated, {
        operationId: stableMutationOperationId("admin-account-reset-totp", [
          updated.userId,
          updated.revision,
        ]),
        committedAt: updated.updatedAt,
      });

      return NextResponse.json({
        ok: true,
        message: "OTP 설정을 초기화했습니다. 대상 계정은 다시 로그인해야 합니다.",
        item: updated,
        receipt,
      });
    }

    if (action === "generateRecoveryCodes") {
      const userId = Number(body.userId);
      const expectedRevision = requiredExpectedRevision(body);

      if (!Number.isInteger(userId) || userId <= 0) {
        throw publicBadRequest(
          "INVALID_ACCOUNT_ID",
          "복구코드를 발급할 계정 정보가 올바르지 않습니다."
        );
      }

      const { replaceUserTotpRecoveryCodes, requireTotpKeyReady } =
        await loadTotpService();
      await requireTotpKeyReady();
      const generated = await authResult.prisma.$transaction(async (tx) => {
        await authorizeAccountMutation(tx, authResult.securityContext);
        const target = await lockAccountTarget(tx, userId, expectedRevision);

        if (!target) {
          throw publicNotFound(
            "ACCOUNT_NOT_FOUND",
            "복구코드를 발급할 계정을 찾을 수 없습니다."
          );
        }

        if (target.user_totp_credentials?.enabled !== 1) {
          throw publicConflict(
            "TOTP_NOT_CONFIGURED",
            "OTP가 설정된 계정만 복구코드를 발급할 수 있습니다."
          );
        }

        const codes = await replaceUserTotpRecoveryCodes(tx, userId);
        const after = await tx.users.update({
          where: { user_id: userId },
          data: {
            revision: { increment: 1 },
            credential_revision: { increment: 1 },
            updated_at: databaseNow(),
          },
        });
        await tx.user_sessions.deleteMany({ where: { user_id: userId } });

        await writeActivityLog(
          tx,
          authResult.user,
          "USER_TOTP_RECOVERY_CODES_GENERATE",
          String(userId),
          {
            userId,
            username: target.username,
          },
          {
            userId,
            username: target.username,
            recoveryCodeCount: codes.length,
          }
        );

        return {
          recoveryCodes: codes,
          item: userSnapshot({
            ...after,
            employee_profiles: target.employee_profiles,
            user_totp_credentials: target.user_totp_credentials,
            unusedRecoveryCodeCount: codes.length,
          }),
        };
      });

      const receipt = createMutationReceipt(
        {
          item: generated.item,
          recoveryCodeCount: generated.recoveryCodes.length,
          oneTimeResultDelivered: true,
        },
        {
          operationId: stableMutationOperationId(
            "admin-account-recovery-codes",
            [generated.item.userId, generated.item.revision]
          ),
          committedAt: generated.item.updatedAt,
        }
      );

      return NextResponse.json({
        ok: true,
        message: "OTP 복구코드를 발급했습니다. 이 코드는 지금 한 번만 표시됩니다.",
        item: generated.item,
        recoveryCodes: generated.recoveryCodes,
        receipt,
      });
    }

    return NextResponse.json(
      { ok: false, message: "지원하지 않는 사용자 계정 관리 요청입니다." },
      { status: 400 }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export function createAdminUsersPostHandler(
  dependencies: AdminUsersPostDependencies = {}
) {
  return (request: NextRequest) =>
    handleAdminUsersPost(request, dependencies);
}

export const POST = createAdminUsersPostHandler();

function inputMessage(isUpdate: boolean, passwordChanged: boolean) {
  if (!isUpdate) {
    return "새 계정을 생성했습니다.";
  }

  if (passwordChanged) {
    return "계정 정보와 비밀번호를 저장했습니다.";
  }

  return "계정 정보를 저장했습니다.";
}
