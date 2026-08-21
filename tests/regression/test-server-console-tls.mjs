import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import {
  getQuickHackTlsStatus,
  initializeQuickHackTls,
} from "../../tools/server-console-tls.mjs";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quickhack-native-tls-"));
const input = {
  dataDir,
  httpsPort: 3443,
  hostNames: ["localhost", "127.0.0.1"],
  primaryHost: "localhost",
  scriptPath: path.resolve("tools/initialize-https.ps1"),
};

async function probeTls(status, ca) {
  const server = https.createServer(
    {
      pfx: fs.readFileSync(status.paths.serverPfx),
      passphrase: fs.readFileSync(status.paths.serverPassphrase, "utf8").trim(),
    },
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    }
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    return await new Promise((resolve, reject) => {
      const request = https.get(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/",
          ca,
          rejectUnauthorized: true,
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        }
      );
      request.once("error", reject);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

try {
  const fresh = await initializeQuickHackTls(input);
  const originalCaPem = fresh.trustBundle.currentCaPem;
  const reinitialized = await initializeQuickHackTls(input);
  assert.equal(
    reinitialized.trustBundle.manifest.currentCaSha256,
    fresh.trustBundle.manifest.currentCaSha256
  );
  assert.notEqual(
    reinitialized.serverCertificate.fingerprintSha256,
    fresh.serverCertificate.fingerprintSha256
  );

  const rotated = await initializeQuickHackTls({ ...input, mode: "ROTATE" });
  assert.notEqual(
    rotated.trustBundle.manifest.currentCaSha256,
    fresh.trustBundle.manifest.currentCaSha256
  );
  assert.equal(
    rotated.trustBundle.manifest.previousCaSha256,
    fresh.trustBundle.manifest.currentCaSha256
  );
  assert.equal(await probeTls(rotated, originalCaPem), 200);
  assert.equal(await probeTls(rotated, rotated.trustBundle.currentCaPem), 200);
  const crossSignedPem = fs.readFileSync(rotated.paths.crossSignedCaPem, "utf8");
  fs.writeFileSync(rotated.paths.crossSignedCaPem, rotated.trustBundle.currentCaPem, "utf8");
  assert(
    getQuickHackTlsStatus(dataDir).errors.includes("TLS_CROSS_SIGNED_CA_INVALID")
  );
  fs.writeFileSync(rotated.paths.crossSignedCaPem, crossSignedPem, "utf8");
  assert.equal(getQuickHackTlsStatus(dataDir).ready, true);
  await assert.rejects(
    initializeQuickHackTls({ ...input, mode: "ROTATE" }),
    /Finalize|finalize|rotation/
  );

  const finalized = await initializeQuickHackTls({
    ...input,
    mode: "FINALIZE_ROTATION",
  });
  assert.equal(
    finalized.trustBundle.manifest.currentCaSha256,
    rotated.trustBundle.manifest.currentCaSha256
  );
  assert.equal(finalized.trustBundle.manifest.previousCaSha256, undefined);
  await assert.rejects(probeTls(finalized, originalCaPem));
  assert.equal(await probeTls(finalized, finalized.trustBundle.currentCaPem), 200);

  fs.writeFileSync(
    finalized.paths.clientConfig.serverUrl,
    "https://attacker.invalid\n",
    "utf8"
  );
  const tampered = getQuickHackTlsStatus(dataDir);
  assert.equal(tampered.ready, false);
  assert(tampered.errors.includes("TRUST_BUNDLE_INVALID"));
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`Native ${process.platform} TLS lifecycle verified.`);
