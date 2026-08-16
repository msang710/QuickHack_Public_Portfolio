import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";

function text(value: unknown) {
  return String(value ?? "").trim();
}

function tokenMatches(received: string, expected: string) {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);

  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export function authorizeSupervisorRequest(request: NextRequest) {
  if (isClientRuntime()) {
    return NextResponse.json(
      { ok: false, message: "Not found." },
      { status: 404 }
    );
  }

  const expectedToken = text(process.env.QUICKHACK_SUPERVISOR_TOKEN);
  const receivedToken = text(
    request.headers.get("x-quickhack-supervisor-token")
  );

  if (
    !expectedToken ||
    !receivedToken ||
    !tokenMatches(receivedToken, expectedToken)
  ) {
    return NextResponse.json(
      { ok: false, message: "Supervisor authorization failed." },
      { status: 403 }
    );
  }

  return null;
}
