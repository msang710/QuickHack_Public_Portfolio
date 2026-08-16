import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readClientTrustBundleSync,
  writeClientTrustBundleSync,
} from "../../tools/trust-bundle.mjs";

const currentCaPem = fs.readFileSync(
  "quickhack_android/app/src/test/resources/managed-ca-one.pem",
  "utf8"
);
const previousCaPem = fs.readFileSync(
  "quickhack_android/app/src/test/resources/managed-ca-two.pem",
  "utf8"
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "quickhack-trust-bundle-"));
const origin = "https://quickhack.example:3443";
const generatedAt = new Date().toISOString();

function directory(name) {
  return path.join(root, name);
}

try {
  const currentDirectory = directory("current");
  const current = writeClientTrustBundleSync(currentDirectory, {
    origin,
    currentCaPem,
    generatedAt,
  });
  const currentRead = readClientTrustBundleSync(currentDirectory);
  assert.equal(currentRead.origin, origin);
  assert.equal(currentRead.manifest.currentCaSha256, current.manifest.currentCaSha256);
  assert.equal(currentRead.previousCaPem, "");

  const rotationDirectory = directory("rotation");
  const rotated = writeClientTrustBundleSync(rotationDirectory, {
    origin,
    currentCaPem,
    previousCaPem,
    rotationNotBefore: generatedAt,
    generatedAt,
  });
  const rotationRead = readClientTrustBundleSync(rotationDirectory);
  assert.equal(rotationRead.manifest.previousCaSha256, rotated.manifest.previousCaSha256);
  assert.equal(rotationRead.identityDigestSha256, rotated.identityDigestSha256);

  fs.writeFileSync(path.join(currentDirectory, "server-url.txt"), "https://attacker.invalid\n");
  assert.throws(() => readClientTrustBundleSync(currentDirectory), /does not match/);

  fs.rmSync(path.join(rotationDirectory, "quickhack-previous-ca.pem"));
  assert.throws(
    () => readClientTrustBundleSync(rotationDirectory),
    (error) => error?.code === "TRUST_BUNDLE_INCOMPLETE"
  );

  const orderDirectory = directory("order");
  writeClientTrustBundleSync(orderDirectory, {
    origin,
    currentCaPem,
    previousCaPem,
    rotationNotBefore: generatedAt,
    generatedAt,
  });
  fs.writeFileSync(
    path.join(orderDirectory, "quickhack-ca-bundle.pem"),
    `${previousCaPem.trim()}\n${currentCaPem.trim()}\n`
  );
  assert.throws(() => readClientTrustBundleSync(orderDirectory), /order or contents/);

  const staleDirectory = directory("stale");
  writeClientTrustBundleSync(staleDirectory, { origin, currentCaPem, generatedAt });
  fs.writeFileSync(path.join(staleDirectory, "quickhack-previous-ca.pem"), previousCaPem);
  assert.throws(() => readClientTrustBundleSync(staleDirectory), /stale previous CA/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("Trust bundle current/rotation/tamper contract verified.");
