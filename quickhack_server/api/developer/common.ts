import { NextRequest, NextResponse } from "next/server";
import { canAccessDeveloper } from "@/quickhack_shared/auth/auth-constants";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";

export type DeveloperAuthResult =
  | {
      ok: true;
      user: AuthUser;
    }
  | {
      ok: false;
      response: NextResponse;
    };

export async function requireDeveloper(request: NextRequest): Promise<DeveloperAuthResult> {
  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, message: "로그인이 필요합니다." },
        { status: 401 }
      ),
    };
  }

  if (!canAccessDeveloper(user)) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, message: "개발자 권한이 없습니다." },
        { status: 403 }
      ),
    };
  }

  return { ok: true, user };
}

export function parseJsonObject(text: string) {
  if (!text.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function bodyText(value: Record<string, unknown>, key: string) {
  const text = String(value[key] ?? "").trim();
  return text || "";
}

export function bodyBoolean(value: Record<string, unknown>, key: string) {
  return value[key] === true || String(value[key]).trim().toLowerCase() === "true";
}

export function publicUserDto(user: AuthUser) {
  return {
    userId: user.userId,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    isDeveloper: user.isDeveloper,
    mobilePackingEnabled: user.mobilePackingEnabled,
  };
}
