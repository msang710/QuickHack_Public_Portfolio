import { createTotpSecurityRouteHandlers } from "@/quickhack_server/admin/totp-security-route-handlers";

export const runtime = "nodejs";

const handlers = createTotpSecurityRouteHandlers();

export const GET = handlers.GET;
export const POST = handlers.POST;
