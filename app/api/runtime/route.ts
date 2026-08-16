import { NextResponse } from "next/server";
import {
  getRemoteServerUrl,
  getRuntimeRole,
  isClientRuntime,
} from "@/quickhack_shared/core/runtime";
import {
  QUICKHACK_RUNTIME_CONTRACT_VERSION,
  readPackageRuntimeIdentitySync,
} from "@/quickhack_shared/core/package-runtime-identity.mjs";

export const runtime = "nodejs";

export async function GET() {
  const clientRuntime = isClientRuntime();
  const packageIdentity = readPackageRuntimeIdentitySync();

  return NextResponse.json({
    ok: true,
    runtimeContractVersion: QUICKHACK_RUNTIME_CONTRACT_VERSION,
    role: getRuntimeRole(),
    deploymentFlavor: packageIdentity?.deploymentFlavor ?? "",
    artifactKind: packageIdentity?.artifactKind ?? "",
    serverUrl: clientRuntime ? getRemoteServerUrl() : "",
    instanceId: clientRuntime
      ? String(process.env.QUICKHACK_CLIENT_INSTANCE_ID || "")
      : "",
  });
}
