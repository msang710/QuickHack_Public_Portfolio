import { runExactAdbCommand } from "@/quickhack_client/adb/adb";
import type { MobileManagedTrustBundlePayload } from "@/quickhack_client/security/mobile-trust-bundle";

export type MobileProvisioningBootstrap = {
  version: 1;
  deviceId: number;
  registrationRevision: number;
  provisioningToken: string;
  provisioningExpiresAt: string;
};

export async function deliverMobileProvisioningBootstrap(input: {
  serial: string;
  serverOrigin: string;
  bootstrap: MobileProvisioningBootstrap;
  trustBundle: MobileManagedTrustBundlePayload;
}) {
  const payload = Buffer.from(
    JSON.stringify({
      ...input.bootstrap,
      serverOrigin: input.serverOrigin,
      trustBundle: input.trustBundle,
    }),
    "utf8"
  ).toString("base64url");

  await runExactAdbCommand(input.serial, [
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "com.quickhack.mobile.action.PROVISION",
    "-n",
    "com.quickhack.mobile/.AdbProvisioningActivity",
    "--es",
    "quickhack_provisioning_payload",
    payload,
  ]);
}
