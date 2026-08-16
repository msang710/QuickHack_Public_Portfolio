// QuickHack note: 브라우저 요청에서 현재 로그인 사용자를 확인하기 위한 클라이언트 인증 헬퍼입니다.
﻿import type { NextRequest } from "next/server";
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { fetchServerJson } from "@/quickhack_shared/core/server-proxy";

type RemoteMeResponse = {
  ok: boolean;
  authenticated: boolean;
  user: AuthUser | null;
};

export async function getRuntimeAuthUser(request: NextRequest) {
  if (isClientRuntime()) {
    const cookie = request.headers.get("cookie") || undefined;
    const response = await fetchServerJson<RemoteMeResponse>(
      "/api/auth/me",
      cookie
    );
    return response.user?.mustChangePassword
      ? null
      : response.user ?? null;
  }

  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
  return getAuthUserFromRequest(request);
}
