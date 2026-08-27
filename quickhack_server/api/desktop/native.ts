import { NextRequest, NextResponse } from "next/server";
import { requestNativeBroker, NativeBrokerClientError } from "@/quickhack_client/native/native-broker-client";
import type { NativeBrokerCommand } from "@/quickhack_desktop/shared/native-broker-contract";
import { fetchServerJson } from "@/quickhack_shared/core/server-proxy";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { canAccessRole, type AuthUser } from "@/quickhack_shared/auth/auth-constants";

const ALLOWED = new Set<NativeBrokerCommand>(["printer.list", "printer.print", "printer.secure-spool", "adb.list", "adb.action", "adb.provision"]);

export async function POST(request: NextRequest) {
  if (!isClientRuntime()) return NextResponse.json({ ok: false, code: "NATIVE_ADAPTER_UNAVAILABLE", message: "데스크톱 로컬 런타임에서만 사용할 수 있습니다." }, { status: 503 });
  const auth = await fetchServerJson<{ authenticated?: boolean; user?: AuthUser | null }>("/api/auth/me", request.headers.get("cookie") ?? undefined).catch(() => null);
  if (!auth?.authenticated || !auth.user) return NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 });
  if (!canAccessRole(auth.user.role, "STAFF")) return NextResponse.json({ ok: false, message: "로컬 장치 작업 권한이 없습니다." }, { status: 403 });
  const body = await request.json().catch(() => null) as { command?: unknown; payload?: unknown } | null;
  const command = String(body?.command ?? "") as NativeBrokerCommand;
  if (!ALLOWED.has(command)) return NextResponse.json({ ok: false, code: "BROKER_COMMAND_REJECTED", message: "허용되지 않은 로컬 작업입니다." }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, result: await requestNativeBroker(command, body?.payload) });
  } catch (error) {
    const code = error instanceof NativeBrokerClientError ? error.code : "NATIVE_ADAPTER_FAILED";
    return NextResponse.json({ ok: false, code, message: error instanceof Error ? error.message : "로컬 작업에 실패했습니다." }, { status: code === "NATIVE_ADAPTER_UNAVAILABLE" ? 503 : 409 });
  }
}
