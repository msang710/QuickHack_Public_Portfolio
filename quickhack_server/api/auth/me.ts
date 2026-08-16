// QuickHack note: 요청 쿠키 기준 현재 인증 사용자를 반환하는 서버 API 핸들러입니다.
﻿import { NextRequest, NextResponse } from "next/server";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { normalizeAccountUsername } from "@/quickhack_shared/auth/account-username";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { todayKstDate } from "@/quickhack_shared/core/time";
import { isBirthdayOnDate } from "@/quickhack_server/user/birthday";
import {
  apiDate,
  apiDateTime,
  databaseDate,
  databaseNow,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import { lockServerSecurityState } from "@/quickhack_server/auth/security-state";
import {
  createMutationReceipt,
  settleOptionalMutationRefresh,
  stableMutationOperationId,
} from "@/quickhack_server/api/mutation-receipt";

export const runtime = "nodejs";

const ACCOUNT_PROFILE_UPDATE_KEYS = new Set([
  "username",
  "displayName",
  "phone",
  "email",
  "birthDate",
  "hireDate",
  "expectedRevision",
]);

class AccountProfileUpdateError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AccountProfileUpdateError";
    this.status = status;
  }
}

type AccountProfileSecurityEnrichment = readonly [
  {
    enabled: number;
    verified_at: Date | null;
    locked_until: Date | null;
  } | null,
  number,
  number,
];

type AccountProfilePatchDependencies = {
  loadSecurityEnrichment?: (
    prisma: typeof import("@/quickhack_server/core/prisma").prisma,
    userId: number
  ) => Promise<AccountProfileSecurityEnrichment>;
};

async function loadAccountProfileSecurityEnrichment(
  prisma: typeof import("@/quickhack_server/core/prisma").prisma,
  userId: number
): Promise<AccountProfileSecurityEnrichment> {
  return Promise.all([
    prisma.user_totp_credentials.findUnique({
      where: { user_id: userId },
      select: {
        enabled: true,
        verified_at: true,
        locked_until: true,
      },
    }),
    prisma.user_totp_recovery_codes.count({
      where: { user_id: userId, used_at: null },
    }),
    prisma.mobile_registered_devices.count({
      where: {
        user_id: userId,
        enabled: 1,
        revoked_at: null,
      },
    }),
  ]);
}

function parseJsonObject(text: string) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
    throw new AccountProfileUpdateError(
      `${label}은 YYYY-MM-DD 형식으로 입력해야 합니다.`
    );
  }

  return text;
}

function validateAccountProfileUpdate(body: Record<string, unknown>) {
  const unsupportedKey = Object.keys(body).find(
    (key) => !ACCOUNT_PROFILE_UPDATE_KEYS.has(key)
  );

  if (unsupportedKey) {
    throw new AccountProfileUpdateError(
      `현재 사용자가 변경할 수 없는 항목입니다: ${unsupportedKey}`
    );
  }

  const username = normalizeAccountUsername(body.username);
  const displayName = cleanText(body.displayName);
  const phone = cleanOptionalText(body.phone);
  const email = cleanOptionalText(body.email);
  const birthDate = cleanOptionalDate(body.birthDate, "생일");
  const hireDate = cleanOptionalDate(body.hireDate, "입사일");
  const expectedRevision = Number(body.expectedRevision);

  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new AccountProfileUpdateError(
      "아이디는 영문 소문자, 숫자, 점, 밑줄, 하이픈으로 3~32자만 입력할 수 있습니다."
    );
  }

  if (!displayName || displayName.length > 40) {
    throw new AccountProfileUpdateError(
      "직원 표시 이름은 1~40자로 입력해야 합니다."
    );
  }

  if (phone && !/^[0-9+\-()\s]{7,30}$/.test(phone)) {
    throw new AccountProfileUpdateError("전화번호 형식이 올바르지 않습니다.");
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AccountProfileUpdateError("이메일 형식이 올바르지 않습니다.");
  }

  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new AccountProfileUpdateError(
      "계정 정보의 수정 기준 시각이 없습니다. 화면을 새로고침한 뒤 다시 시도하세요."
    );
  }

  return {
    username,
    displayName,
    phone,
    email,
    birthDate,
    hireDate,
    expectedRevision,
  };
}

export async function GET(request: NextRequest) {
  if (isClientRuntime()) {
    return proxyToServer(request, "/api/auth/me", {
      method: "GET",
      contentType: null,
    });
  }

  const [{ getPasswordChangeSessionFromRequest, toAuthUser }, { prisma }] =
    await Promise.all([
      import("@/quickhack_server/auth/auth-service"),
      import("@/quickhack_server/core/prisma"),
    ]);
  const session = await getPasswordChangeSessionFromRequest(request);

  if (!session) {
    return NextResponse.json({
      ok: true,
      authenticated: false,
      user: null,
      profile: null,
    });
  }

  if (session.users.must_change_password === 1) {
    return NextResponse.json({
      ok: true,
      authenticated: true,
      mustChangePassword: true,
      user: toAuthUser(session.users),
      profile: null,
    });
  }

  const [
    user,
    activeMobileDeviceCount,
    recoveryCodeCount,
    personalSettings,
  ] = await Promise.all([
    prisma.users.findUnique({
      where: { user_id: session.users.user_id },
      select: {
        user_id: true,
        username: true,
        role: true,
        is_developer: true,
        mobile_packing_enabled: true,
        is_active: true,
        revision: true,
        created_at: true,
        updated_at: true,
        employee_profiles: {
          select: {
            display_name: true,
            phone: true,
            email: true,
            birth_date: true,
            hire_date: true,
          },
        },
        user_totp_credentials: {
          select: {
            enabled: true,
            verified_at: true,
            locked_until: true,
          },
        },
      },
    }),
    prisma.mobile_registered_devices.count({
      where: {
        user_id: session.users.user_id,
        enabled: 1,
        revoked_at: null,
      },
    }),
    prisma.user_totp_recovery_codes.count({
      where: {
        user_id: session.users.user_id,
        used_at: null,
      },
    }),
    import("@/quickhack_server/user/personal-settings-service").then(
      ({ getPersonalSettings }) =>
        getPersonalSettings(prisma, session.users.user_id)
    ),
  ]);

  if (!user) {
    return NextResponse.json({
      ok: true,
      authenticated: false,
      user: null,
      profile: null,
    });
  }

  const profile = user.employee_profiles;

  return NextResponse.json({
    ok: true,
    authenticated: true,
    mustChangePassword: false,
    user: toAuthUser(user),
    personalSettings,
    profile: {
      userId: user.user_id,
      username: user.username,
      displayName: profile?.display_name ?? user.username,
      phone: profile?.phone ?? "",
      email: profile?.email ?? "",
      birthDate: apiDate(profile?.birth_date) ?? "",
      isBirthdayToday: isBirthdayOnDate(
        apiDate(profile?.birth_date),
        todayKstDate()
      ),
      hireDate: apiDate(profile?.hire_date) ?? "",
      role: user.role,
      isDeveloper: user.is_developer === 1,
      mobilePackingEnabled: user.mobile_packing_enabled === 1,
      isActive: user.is_active === 1,
      totpEnabled: user.user_totp_credentials?.enabled === 1,
      totpVerifiedAt: apiDateTime(user.user_totp_credentials?.verified_at) ?? "",
      totpLockedUntil: apiDateTime(user.user_totp_credentials?.locked_until) ?? "",
      recoveryCodeCount,
      activeMobileDeviceCount,
      revision: user.revision,
      createdAt: requiredApiDateTime(user.created_at),
      updatedAt: requiredApiDateTime(user.updated_at),
    },
  });
}

async function handleAccountProfilePatch(
  request: NextRequest,
  dependencies: AccountProfilePatchDependencies
) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/auth/me", {
      method: "PATCH",
      body: bodyText,
    });
  }

  const [
    {
      getAuthSessionFromRequest,
      replaceUserSessionsInTransaction,
      setSessionCookie,
      toAuthUser,
    },
    { prisma },
  ] =
    await Promise.all([
      import("@/quickhack_server/auth/auth-service"),
      import("@/quickhack_server/core/prisma"),
    ]);
  const session = await getAuthSessionFromRequest(request);

  if (!session) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }

  const body = parseJsonObject(bodyText);

  if (!body) {
    return NextResponse.json(
      { ok: false, message: "계정 정보 저장 요청 형식이 올바르지 않습니다." },
      { status: 400 }
    );
  }

  try {
    const input = validateAccountProfileUpdate(body);
    const timestamp = databaseNow();
    const updated = await prisma.$transaction(async (tx) => {
      const serverState = await lockServerSecurityState(tx);
      const locked = await tx.$queryRaw<Array<{ revision: number }>>`
        SELECT revision
        FROM users
        WHERE user_id = ${session.users.user_id}
        FOR UPDATE
      `;
      const before = await tx.users.findUnique({
        where: { user_id: session.users.user_id },
        include: { employee_profiles: true },
      });

      if (!before) {
        throw new AccountProfileUpdateError("계정을 찾을 수 없습니다.", 404);
      }

      if (
        locked[0]?.revision !== input.expectedRevision ||
        before.credential_revision !== session.credential_revision
      ) {
        throw new AccountProfileUpdateError(
          "다른 화면에서 계정 정보가 먼저 변경되었습니다. 화면을 새로고침한 뒤 다시 입력하세요.",
          409
        );
      }

      const duplicate = await tx.users.findUnique({
        where: { username: input.username },
        select: { user_id: true },
      });

      if (duplicate && duplicate.user_id !== before.user_id) {
        throw new AccountProfileUpdateError("이미 사용 중인 아이디입니다.", 409);
      }

      const user = await tx.users.update({
        where: { user_id: before.user_id },
        data: {
          username: input.username,
          revision: { increment: 1 },
          credential_revision:
            before.username !== input.username ? { increment: 1 } : undefined,
          updated_at: timestamp,
        },
      });
      const profile = await tx.employee_profiles.upsert({
        where: { user_id: before.user_id },
        update: {
          display_name: input.displayName,
          phone: input.phone,
          email: input.email,
          birth_date: input.birthDate ? databaseDate(input.birthDate) : null,
          hire_date: input.hireDate ? databaseDate(input.hireDate) : null,
          updated_at: timestamp,
        },
        create: {
          user_id: before.user_id,
          display_name: input.displayName,
          phone: input.phone,
          email: input.email,
          birth_date: input.birthDate ? databaseDate(input.birthDate) : null,
          hire_date: input.hireDate ? databaseDate(input.hireDate) : null,
          created_at: timestamp,
          updated_at: timestamp,
        },
      });

      const replacement =
        before.username !== input.username
          ? await replaceUserSessionsInTransaction(tx, {
              userId: user.user_id,
              credentialRevision: user.credential_revision,
              instanceEpoch: serverState.instance_epoch,
            })
          : null;

      return {
        ...user,
        employee_profiles: profile,
        replacementToken: replacement?.token ?? null,
      };
    });
    const user = toAuthUser(updated);
    const baseProfile = {
      userId: updated.user_id,
      username: updated.username,
      displayName: updated.employee_profiles.display_name,
      phone: updated.employee_profiles.phone ?? "",
      email: updated.employee_profiles.email ?? "",
      birthDate: apiDate(updated.employee_profiles.birth_date) ?? "",
      isBirthdayToday: isBirthdayOnDate(
        apiDate(updated.employee_profiles.birth_date),
        todayKstDate()
      ),
      hireDate: apiDate(updated.employee_profiles.hire_date) ?? "",
      role: updated.role,
      isDeveloper: updated.is_developer === 1,
      mobilePackingEnabled: updated.mobile_packing_enabled === 1,
      isActive: updated.is_active === 1,
      revision: updated.revision,
      createdAt: requiredApiDateTime(updated.created_at),
      updatedAt: requiredApiDateTime(updated.updated_at),
    };
    const receipt = createMutationReceipt(
      { user, profile: baseProfile },
      {
        operationId: stableMutationOperationId("account-profile", [
          updated.user_id,
          updated.revision,
        ]),
        committedAt: updated.updated_at,
      }
    );
    const loadSecurityEnrichment =
      dependencies.loadSecurityEnrichment ??
      loadAccountProfileSecurityEnrichment;
    const enrichment = await settleOptionalMutationRefresh(receipt, () =>
      loadSecurityEnrichment(prisma, updated.user_id)
    );
    const profile = enrichment.completed
      ? {
          ...baseProfile,
          totpEnabled: enrichment.value[0]?.enabled === 1,
          totpVerifiedAt:
            apiDateTime(enrichment.value[0]?.verified_at) ?? "",
          totpLockedUntil:
            apiDateTime(enrichment.value[0]?.locked_until) ?? "",
          recoveryCodeCount: enrichment.value[1],
          activeMobileDeviceCount: enrichment.value[2],
        }
      : undefined;

    const response = NextResponse.json({
      ok: true,
      message: "계정 정보를 저장했습니다.",
      user,
      profile,
      receipt: enrichment.receipt,
    });
    if (updated.replacementToken) {
      setSessionCookie(response, updated.replacementToken);
    }
    return response;
  } catch (error) {
    const updateError =
      error instanceof AccountProfileUpdateError ? error : null;

    if (updateError) {
      const status =
        updateError.status === 404 || updateError.status === 409
          ? updateError.status
          : 400;
      return apiFailureResponse({
        status,
        code:
          status === 404
            ? "ACCOUNT_PROFILE_NOT_FOUND"
            : status === 409
              ? "ACCOUNT_PROFILE_CONFLICT"
              : "INVALID_ACCOUNT_PROFILE",
        message: updateError.message,
        cause: updateError,
      });
    }

    return apiErrorResponse(error);
  }
}

export function createAccountProfilePatchHandler(
  dependencies: AccountProfilePatchDependencies = {}
) {
  return (request: NextRequest) =>
    handleAccountProfilePatch(request, dependencies);
}

export const PATCH = createAccountProfilePatchHandler();
