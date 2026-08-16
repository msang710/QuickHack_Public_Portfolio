import { NextResponse } from "next/server";
import {
  getRemoteServerUrl,
  getRuntimeRole,
  getRuntimeConfig,
  isClientRuntime,
} from "@/quickhack_shared/core/runtime";
import {
  QUICKHACK_RUNTIME_CONTRACT_VERSION,
  readPackageRuntimeIdentitySync,
} from "@/quickhack_shared/core/package-runtime-identity.mjs";
import {
  QUICKHACK_HTTPS_TERMINATION_ENV,
  QUICKHACK_PUBLIC_ORIGIN_ENV,
  resolveTransportSecurityPolicy,
} from "@/quickhack_shared/security/transport-security-policy.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const clientRuntime = isClientRuntime();
  const packageIdentity = readPackageRuntimeIdentitySync();
  const runtimeConfig = getRuntimeConfig();
  const transport = resolveTransportSecurityPolicy({
    runtimeRole: runtimeConfig.role,
    production: runtimeConfig.production,
    httpsTerminated: process.env[QUICKHACK_HTTPS_TERMINATION_ENV],
    publicOrigin: process.env[QUICKHACK_PUBLIC_ORIGIN_ENV],
  });

  return NextResponse.json({
    ok: true,
    runtimeContractVersion: QUICKHACK_RUNTIME_CONTRACT_VERSION,
    role: getRuntimeRole(),
    deploymentFlavor: packageIdentity?.deploymentFlavor ?? "",
    artifactKind: packageIdentity?.artifactKind ?? "",
    publicOrigin: clientRuntime ? "" : transport.publicOrigin,
    serverUrl: clientRuntime ? getRemoteServerUrl() : "",
    instanceId: clientRuntime
      ? String(process.env.QUICKHACK_CLIENT_INSTANCE_ID || "")
      : "",
  });
}
