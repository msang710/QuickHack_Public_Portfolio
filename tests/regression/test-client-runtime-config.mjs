import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLIENT_RUNTIME_HOST,
  CLIENT_RUNTIME_PORT,
  clientRuntimePortForArtifact,
  normalizeServerUrl,
  resolveClientServerUrl,
} from "../../tools/client-runtime-config.mjs";

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

  writeFileSync(
    path.join(configDirectory, "server-url.txt"),
    "https://quickhack.example:3443\r\n",
    "utf8"
  );
  assert.equal(
    resolveClientServerUrl(root),
    "https://quickhack.example:3443",
    "The trusted server-url.txt value was not used."
  );

  assert.throws(() => normalizeServerUrl("http://quickhack.example:3443"), /https/);
  assert.throws(
    () => normalizeServerUrl("https://user:password@quickhack.example:3443"),
    /protocol, host, and port/
  );
  assert.throws(
    () => normalizeServerUrl("https://quickhack.example:3443/path"),
    /protocol, host, and port/
  );

  rmSync(path.join(configDirectory, "server-url.txt"));
  writeFileSync(
    path.join(configDirectory, "client-url.txt"),
    "https://legacy.example:3443\r\n",
    "utf8"
  );
  assert.throws(
    () => resolveClientServerUrl(root),
    /server-url\.txt/,
    "The removed client-url.txt compatibility path was still accepted."
  );

  console.log("Client runtime file-owned configuration verified.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
