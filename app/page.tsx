// QuickHack note: 로그인 상태에 따라 로그인 화면 또는 메인 ERP/WMS 작업 화면을 렌더링하는 앱 진입점입니다.
﻿import { DeviceWorkspace } from "@/quickhack_client/components/app-shell/device-workspace";
import { LoginScreen } from "@/quickhack_client/components/auth/login-screen";
import { PasswordChangeRequiredScreen } from "@/quickhack_client/components/auth/password-change-required-screen";
import { AUTH_COOKIE_NAME, type AuthUser } from "@/quickhack_shared/auth/auth-constants";
import {
  isClientRuntime,
  runtimeConfigService,
} from "@/quickhack_shared/core/runtime";
import {
  fetchServerJson,
  getServerProxyErrorMessage,
} from "@/quickhack_shared/core/server-proxy";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

type RemoteMeResponse = {
  ok: boolean;
  authenticated: boolean;
  user: AuthUser | null;
};

async function getLocalAuthUser(token?: string) {
  const { getPasswordChangeSessionFromToken, toAuthUser } = await import(
    "@/quickhack_server/auth/auth-service"
  );
  const session = await getPasswordChangeSessionFromToken(token);
  return session ? toAuthUser(session.users) : null;
}

async function tryFetchServerJson<T>(pathname: string, cookieHeader?: string) {
  try {
    const data = await fetchServerJson<T>(pathname, cookieHeader);

    if (!data) {
      return {
        data: null,
        error: "중앙 서버 응답이 올바르지 않습니다.",
      };
    }

    return { data, error: "" };
  } catch (error) {
    return {
      data: null,
      error: getServerProxyErrorMessage(error),
    };
  }
}

export default async function Home() {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value;
  const cookieHeader = token ? `${AUTH_COOKIE_NAME}=${token}` : undefined;
  const clientRuntime = isClientRuntime();
  const showTestCredentials = !runtimeConfigService.isProduction();

  const authResult = clientRuntime
    ? await tryFetchServerJson<RemoteMeResponse>("/api/auth/me", cookieHeader)
    : null;
  const authUser = clientRuntime
    ? authResult?.data?.user ?? null
    : await getLocalAuthUser(token);

  if (clientRuntime && authResult?.error) {
    return (
      <LoginScreen
        initialError={authResult.error}
        showTestCredentials={showTestCredentials}
      />
    );
  }

  if (!authUser) {
    return <LoginScreen showTestCredentials={showTestCredentials} />;
  }

  if (authUser.mustChangePassword) {
    return <PasswordChangeRequiredScreen currentUser={authUser} />;
  }

  return <DeviceWorkspace currentUser={authUser} />;
}
