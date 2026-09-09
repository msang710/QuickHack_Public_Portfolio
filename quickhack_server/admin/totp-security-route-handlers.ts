import { NextRequest, NextResponse } from "next/server";
import {
  apiErrorResponse,
  apiFailureResponse,
} from "@/quickhack_server/api/error-response";
import { authorizeSupervisorRequest } from "@/quickhack_server/admin/supervisor-auth";
import {
  readTotpSecurityRecoveryState,
  recoverTotpSecurity,
  TotpSecurityRecoveryError,
} from "@/quickhack_server/admin/totp-security-recovery-service";

type TotpSecurityRouteDependencies = {
  authorize?: typeof authorizeSupervisorRequest;
  readState?: typeof readTotpSecurityRecoveryState;
  recover?: typeof recoverTotpSecurity;
};

function recoveryErrorResponse(error: unknown) {
  if (error instanceof TotpSecurityRecoveryError) {
    return apiFailureResponse({
      status: error.statusCode,
      code: error.code,
      cause: error,
    });
  }

  return apiErrorResponse(error);
}

export function createTotpSecurityRouteHandlers(
  dependencies: TotpSecurityRouteDependencies = {}
) {
  const authorize =
    dependencies.authorize ?? authorizeSupervisorRequest;
  const readState =
    dependencies.readState ?? readTotpSecurityRecoveryState;
  const recover = dependencies.recover ?? recoverTotpSecurity;

  return {
    async GET(request: NextRequest) {
      const authorizationFailure = authorize(request);

      if (authorizationFailure) {
        return authorizationFailure;
      }

      try {
        return NextResponse.json({
          ok: true,
          state: await readState(),
        });
      } catch (error) {
        return recoveryErrorResponse(error);
      }
    },

    async POST(request: NextRequest) {
      const authorizationFailure = authorize(request);

      if (authorizationFailure) {
        return authorizationFailure;
      }

      try {
        const body = (await request.json()) as Record<string, unknown>;
        const result = await recover({
          confirmText: body.confirmText,
        });

        return NextResponse.json({ ok: true, ...result });
      } catch (error) {
        return recoveryErrorResponse(error);
      }
    },
  };
}
