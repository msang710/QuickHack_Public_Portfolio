import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLIENT_RUNTIME_HOST,
  CLIENT_RUNTIME_PORT,
  clientRuntimePortForArtifact,
  normalizeServerUrl,
  resolveClientCaCertificateFile,
  resolveClientServerUrl,
  resolveClientTrustBundle,
} from "../../tools/client-runtime-config.mjs";
import { writeClientTrustBundleSync } from "../../tools/trust-bundle.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "quickhack-client-runtime-config-"));
const configDirectory = path.join(root, "config");

try {
  mkdirSync(configDirectory, { recursive: true });
  process.env.QUICKHACK_CLIENT_PORT = "65535";
  process.env.QUICKHACK_SERVER_URL = "https://attacker.invalid";
  process.env.QUICKHACK_CA_CERT_FILE = "C:\\attacker\\ca.pem";
  process.env.QUICKHACK_CLIENT_SERVER_ENTRY = "attacker.js";

  assert.equal(CLIENT_RUNTIME_HOST, "127.0.0.1");
  assert.equal(CLIENT_RUNTIME_PORT, 3001);
  assert.equal(clientRuntimePortForArtifact("DEMONSTRATION_CLIENT"), 3001);
  assert.equal(clientRuntimePortForArtifact("OPERATIONAL_CLIENT"), 3002);
  assert.throws(
    () => clientRuntimePortForArtifact("OPERATIONAL_SERVER"),
    (error) => error?.code === "PACKAGE_ARTIFACT_INVALID"
  );

  const sourceCa = readFileSync(
    "quickhack_android/app/src/test/resources/managed-ca-one.pem",
    "utf8"
  );
  writeClientTrustBundleSync(configDirectory, {
    origin: "https://quickhack.example:3443",
    currentCaPem: sourceCa,
    generatedAt: new Date().toISOString(),
  });
  assert.equal(
    resolveClientServerUrl(root),
    "https://quickhack.example:3443",
    "The trusted server-url.txt value was not used."
  );
  assert.equal(resolveClientTrustBundle(root).origin, "https://quickhack.example:3443");
  assert.equal(
    resolveClientCaCertificateFile(root),
    path.join(configDirectory, "quickhack-ca-bundle.pem")
  );

  assert.throws(() => normalizeServerUrl("http://quickhack.example:3443"), /https/i);
  assert.throws(
    () => normalizeServerUrl("https://user:password@quickhack.example:3443"),
    /HTTPS origin/
  );
  assert.throws(
    () => normalizeServerUrl("https://quickhack.example:3443/path"),
    /HTTPS origin/
  );

  const legacyRoot = path.join(root, "legacy");
  const legacyConfig = path.join(legacyRoot, "config");
  mkdirSync(legacyConfig, { recursive: true });
  writeFileSync(
    path.join(legacyConfig, "server-url.txt"),
    "https://legacy.example:3443\r\n",
    "utf8"
  );
  assert.throws(
    () => resolveClientServerUrl(legacyRoot),
    /trust-bundle\.json|Trust bundle file is missing/,
    "A legacy URL-only client configuration was still accepted."
  );

  writeFileSync(
    path.join(configDirectory, "server-url.txt"),
    "https://attacker.invalid\r\n",
    "utf8"
  );
  assert.throws(() => resolveClientTrustBundle(root), /does not match/);

  console.log("Client runtime file-owned configuration verified.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
