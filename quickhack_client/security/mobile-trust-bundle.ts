import path from "node:path";
import { readClientTrustBundleSync } from "@/tools/trust-bundle.mjs";
import { normalizePublicHttpsOrigin } from "@/quickhack_shared/security/transport-security-policy.mjs";

export type MobileManagedTrustBundlePayload = {
  version: 1;
  origin: string;
  currentCaSha256: string;
  previousCaSha256?: string;
  rotationNotBefore?: string;
  generatedAt: string;
  currentCaPem: string;
  previousCaPem?: string;
  identityDigestSha256: string;
};

function configuredBundleDirectory() {
  const configured = String(process.env.QUICKHACK_CLIENT_TRUST_BUNDLE_DIR ?? "").trim();
  return path.resolve(configured || path.join(process.cwd(), "config"));
}

export function loadMobileManagedTrustBundle(
  expectedOrigin: string
): MobileManagedTrustBundlePayload {
  const expected = normalizePublicHttpsOrigin(expectedOrigin);
  const bundle = readClientTrustBundleSync(configuredBundleDirectory());
  if (bundle.origin !== expected) {
    const error = new Error("The client trust bundle origin does not match the central server.");
    (error as Error & { code?: string }).code = "TRUST_BUNDLE_ORIGIN_MISMATCH";
    throw error;
  }
  return {
    ...bundle.manifest,
    currentCaPem: bundle.currentCaPem,
    ...(bundle.previousCaPem ? { previousCaPem: bundle.previousCaPem } : {}),
    identityDigestSha256: bundle.identityDigestSha256,
  };
}
