import { createHmac, timingSafeEqual } from "node:crypto";

const HEX_256 = /^[a-f0-9]{64}$/u;

export function packageReadinessDigest(secret, nonce) {
  if (!HEX_256.test(String(secret)) || !HEX_256.test(String(nonce))) throw new TypeError("Invalid package readiness proof input.");
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update("quickhack-package-readiness-v1\0")
    .update(Buffer.from(nonce, "hex"))
    .digest("hex");
}

export function verifyPackageReadinessDigest(secret, nonce, candidate) {
  if (!HEX_256.test(String(candidate))) return false;
  const expected = Buffer.from(packageReadinessDigest(secret, nonce), "hex");
  return timingSafeEqual(expected, Buffer.from(candidate, "hex"));
}
