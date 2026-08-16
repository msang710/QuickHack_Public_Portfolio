import { NextRequest, NextResponse } from "next/server";
import { authorizeSupervisorRequest } from "@/quickhack_server/admin/supervisor-auth";
import { apiErrorResponse, apiFailureResponse } from "@/quickhack_server/api/error-response";
import { prisma } from "@/quickhack_server/core/prisma";
import { runWorkerJobImmediately } from "@/quickhack_server/workers/worker-jobs";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authorizationFailure = authorizeSupervisorRequest(request);
  if (authorizationFailure) return authorizationFailure;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const expectedInstanceEpoch = Number(body.expectedInstanceEpoch);
    if (!Number.isSafeInteger(expectedInstanceEpoch) || expectedInstanceEpoch <= 0) {
      return apiFailureResponse({
        status: 400,
        code: "RESTORE_BARRIER_REQUEST_INVALID",
        message: "The restore security barrier epoch is invalid.",
      });
    }
    const state = await prisma.server_instance_state.findUnique({
      where: { singleton_key: "QUICKHACK" },
      select: { instance_epoch: true },
    });
    if (!state) throw new Error("QuickHack server security state is missing.");
    if (state.instance_epoch !== expectedInstanceEpoch) {
      return NextResponse.json({ ok: true, stale: true, completed: false });
    }
    const result = await runWorkerJobImmediately(
      "privacy-redact-expired-personal-data",
      null,
      { waitTimeoutMs: 60 * 60_000 }
    );
    return NextResponse.json({ ok: true, stale: false, completed: true, result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
