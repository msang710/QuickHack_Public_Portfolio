import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME } from "@/quickhack_shared/auth/auth-constants";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import { clientUpdateRequired, issueWorkflowAdmission, readClientCompatibilityPolicy, WORKFLOW_ADMISSION_COOKIE, WORKFLOW_ADMISSION_MAX_AGE_SECONDS, type WorkflowFamily } from "@/quickhack_shared/desktop/client-compatibility";

const FAMILIES = new Set<WorkflowFamily>(["INSPECTION", "INVENTORY", "SHIPMENT", "RETURNS", "MANUAL_MATCHING", "ACCOUNT"]);
export async function GET(request: NextRequest) {
  if (isClientRuntime()) return proxyToServer(request, "/api/auth/workflow-admission", { contentType: null });
  const policy = readClientCompatibilityPolicy();
  return NextResponse.json({ ok: true, policy });
}
export async function POST(request: NextRequest) {
  const bodyText = await request.text();
  if (isClientRuntime()) return proxyToServer(request, "/api/auth/workflow-admission", { method: "POST", body: bodyText });
  const { getAuthSessionFromRequest } = await import("@/quickhack_server/auth/auth-service");
  const session = await getAuthSessionFromRequest(request);
  const sessionToken = request.cookies.get(AUTH_COOKIE_NAME)?.value ?? "";
  if (!session || !sessionToken) return NextResponse.json({ ok: false, code: "AUTH_REQUIRED" }, { status: 401 });
  let body: { workflowFamily?: unknown } | null = null;
  try { body = JSON.parse(bodyText) as { workflowFamily?: unknown }; } catch { body = null; }
  const workflowFamily = String(body?.workflowFamily ?? "") as WorkflowFamily;
  if (!FAMILIES.has(workflowFamily)) return NextResponse.json({ ok: false, code: "WORKFLOW_SCOPE_INVALID" }, { status: 400 });
  const clientFamily = String(request.headers.get("x-quickhack-client-family") ?? "BROWSER_DEVELOPMENT");
  const clientVersion = String(request.headers.get("x-quickhack-client-version") ?? "0.0.0");
  const policy = { ...readClientCompatibilityPolicy(), clientFamily };
  if (clientFamily.startsWith("ELECTRON_") && clientUpdateRequired(policy, clientVersion)) return NextResponse.json({ ok: false, code: "CLIENT_UPDATE_REQUIRED",  policy }, { status: 426 });
  const token = issueWorkflowAdmission({ userId: session.user_id, sessionId: String(session.session_id), clientFamily, clientVersion, workflowFamily }, sessionToken);
  const response = NextResponse.json({ ok: true, workflowFamily, expiresInSeconds: WORKFLOW_ADMISSION_MAX_AGE_SECONDS, policy });
  response.cookies.set(WORKFLOW_ADMISSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: request.nextUrl.protocol === "https:", path: "/", maxAge: WORKFLOW_ADMISSION_MAX_AGE_SECONDS });
  return response;
}
