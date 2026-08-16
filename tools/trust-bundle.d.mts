import type crypto from "node:crypto";

export type TrustBundleManifest = Readonly<{
  version: 1;
  origin: string;
  currentCaSha256: string;
  previousCaSha256?: string;
  rotationNotBefore?: string;
  generatedAt: string;
}>;
export const TRUST_BUNDLE_VERSION: 1;
export const TRUST_BUNDLE_FILENAMES: Readonly<Record<string, string>>;
export function certificateSha256(certificate: crypto.X509Certificate | string | Buffer): string;
export function inspectCaCertificate(pem: string | Buffer, options?: { now?: number; label?: string }): Readonly<{
  certificate: crypto.X509Certificate;
  fingerprintSha256: string;
  validFrom: string;
  validTo: string;
}>;
export function trustBundleIdentityDigest(manifest: TrustBundleManifest): string;
export function createTrustBundle(input: {
  origin: string;
  currentCaPem: string;
  previousCaPem?: string;
  rotationNotBefore?: string;
  generatedAt?: string;
  now?: number;
}): Readonly<{
  manifest: TrustBundleManifest;
  manifestText: string;
  origin: string;
  currentCaPem: string;
  previousCaPem: string;
  combinedCaPem: string;
  identityDigestSha256: string;
}>;
export function trustBundlePaths(directory: string): Readonly<Record<string, string>>;
export function writeClientTrustBundleSync(directory: string, input: Parameters<typeof createTrustBundle>[0]): ReturnType<typeof createTrustBundle> & { paths: Readonly<Record<string, string>> };
export function readClientTrustBundleSync(directory: string, options?: { now?: number }): Readonly<{
  manifest: TrustBundleManifest;
  origin: string;
  currentCaPem: string;
  previousCaPem: string;
  combinedCaPem: string;
  identityDigestSha256: string;
  currentCertificate: crypto.X509Certificate;
  previousCertificate: crypto.X509Certificate | null;
  paths: Readonly<Record<string, string>>;
}>;
