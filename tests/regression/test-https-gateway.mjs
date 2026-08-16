import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTrustedForwardingHeaders,
  hostAuthority,
  isLoopbackHost,
  normalizeHttpAuthority,
  normalizeRemoteAddress,
} from "../../tools/quickhack-https-forwarding.mjs";
import {
  QUICKHACK_AUTH_REQUEST_BODY_LIMIT_BYTES,
} from "../../quickhack_shared/http/request-body-policy.mjs";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDir, "..", "..");
const gatewayPath = path.join(projectRoot, "tools", "quickhack-https-gateway.mjs");
const stagingPackageSource = fs.readFileSync(
  path.join(projectRoot, "packaging", "create-staging-package.mjs"),
  "utf8"
);

function resolveOpenSslExecutable() {
  const configuredExecutable = String(
    process.env.QUICKHACK_TEST_OPENSSL || ""
  ).trim();
  const platformCandidates =
    process.platform === "win32"
      ? [
          path.join(
            String(process.env.ProgramFiles || "C:\\Program Files"),
            "Git",
            "usr",
            "bin",
            "openssl.exe"
          ),
          path.join(
            String(process.env.ProgramFiles || "C:\\Program Files"),
            "Git",
            "mingw64",
            "bin",
            "openssl.exe"
          ),
          "openssl.exe",
        ]
      : ["openssl"];
  const candidates = [configuredExecutable, ...platformCandidates].filter(
    Boolean
  );

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["version"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }

  throw new Error(
    "QuickHack HTTPS gateway tests require OpenSSL. Install it or set QUICKHACK_TEST_OPENSSL to its executable path."
  );
}

function runOpenSsl(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`OpenSSL failed to start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `OpenSSL exited with code ${result.status}.${output ? `\n${output}` : ""}`
    );
  }
}

function prepareTlsFixture() {
  const configuredTlsDir = String(process.env.QUICKHACK_TLS_DIR || "").trim();

  if (configuredTlsDir) {
    const temporaryDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "quickhack-https-gateway-test-")
    );
    const tlsDir = path.join(temporaryDataDir, "security", "tls");

    try {
      fs.mkdirSync(tlsDir, { recursive: true });
      for (const fileName of [
        "server.pfx",
        "server-pfx-passphrase.txt",
        "quickhack-ca.pem",
      ]) {
        fs.copyFileSync(
          path.join(path.resolve(configuredTlsDir), fileName),
          path.join(tlsDir, fileName)
        );
      }
    } catch (error) {
      fs.rmSync(temporaryDataDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      throw error;
    }

    return {
      tlsDir,
      cleanup() {
        fs.rmSync(temporaryDataDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      },
    };
  }

  const temporaryDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "quickhack-https-gateway-test-")
  );
  const tlsDir = path.join(temporaryDataDir, "security", "tls");

  try {
    fs.mkdirSync(tlsDir, { recursive: true });

    const openSslExecutable = resolveOpenSslExecutable();
    const rootKeyPath = path.join(tlsDir, "root-ca-private.key");
    const rootCaPath = path.join(tlsDir, "quickhack-ca.pem");
    const serverKeyPath = path.join(tlsDir, "server-private.key");
    const serverRequestPath = path.join(tlsDir, "server.csr");
    const serverCertificatePath = path.join(tlsDir, "server-certificate.pem");
    const serverExtensionsPath = path.join(tlsDir, "server-extensions.cnf");
    const serverPfxPath = path.join(tlsDir, "server.pfx");
    const serverPassphrasePath = path.join(
      tlsDir,
      "server-pfx-passphrase.txt"
    );
    const passphrase = randomBytes(32).toString("base64url");

    fs.writeFileSync(
      serverExtensionsPath,
      [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "",
      ].join("\n"),
      "utf8"
    );

    runOpenSsl(openSslExecutable, [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=QuickHack Test Root CA",
      "-keyout",
      rootKeyPath,
      "-out",
      rootCaPath,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    runOpenSsl(openSslExecutable, [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-keyout",
      serverKeyPath,
      "-out",
      serverRequestPath,
    ]);
    runOpenSsl(openSslExecutable, [
      "x509",
      "-req",
      "-in",
      serverRequestPath,
      "-CA",
      rootCaPath,
      "-CAkey",
      rootKeyPath,
      "-CAcreateserial",
      "-out",
      serverCertificatePath,
      "-days",
      "1",
      "-sha256",
      "-extfile",
      serverExtensionsPath,
    ]);
    runOpenSsl(openSslExecutable, [
      "pkcs12",
      "-export",
      "-out",
      serverPfxPath,
      "-inkey",
      serverKeyPath,
      "-in",
      serverCertificatePath,
      "-passout",
      `pass:${passphrase}`,
    ]);
    fs.writeFileSync(serverPassphrasePath, `${passphrase}\n`, "utf8");
  } catch (error) {
    fs.rmSync(temporaryDataDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
    throw error;
  }

  return {
    tlsDir,
    cleanup() {
      fs.rmSync(temporaryDataDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    },
  };
}

const tlsFixture = prepareTlsFixture();
const tlsDir = tlsFixture.tlsDir;
let tlsFixtureCleaned = false;

function cleanupTlsFixture() {
  if (tlsFixtureCleaned) {
    return;
  }

  tlsFixture.cleanup();
  tlsFixtureCleaned = true;
}

process.once("exit", cleanupTlsFixture);

const pfxPath = path.join(tlsDir, "server.pfx");
const passphrasePath = path.join(tlsDir, "server-pfx-passphrase.txt");
const caPath = path.join(tlsDir, "quickhack-ca.pem");
const metadataPath = path.join(tlsDir, "metadata.json");
const supervisorToken = "test-supervisor-token";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function httpsCall(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: options.method || "GET",
        headers: options.headers,
        servername: options.servername || "localhost",
        ca: fs.readFileSync(caPath),
        timeout: 1500,
      },
      (response) => {
        const chunks = [];
        const authorized = response.socket?.authorized === true;
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            authorized,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    request.on("timeout", () => request.destroy(new Error("HTTPS request timed out.")));
    request.on("error", reject);
    request.end(options.body);
  });
}

assert(
  stagingPackageSource.includes(
    'path.join(rootDir, "quickhack_shared", "http", "request-body-policy.mjs")'
  ),
  "The packaged HTTPS gateway is missing its request body policy dependency."
);

function httpsGet(port, pathname, headers = {}) {
  return httpsCall(port, pathname, { headers });
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("HTTPS gateway did not exit after drain."));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForGateway(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await httpsGet(port, "/__quickhack_tls_health");
      if (response.status === 200 && response.authorized) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error("HTTPS gateway did not become ready.");
}

function waitForProcessExit(child, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("HTTPS gateway did not reject the invalid configuration."));
    }, timeoutMs);

    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

for (const filename of [
  gatewayPath,
  pfxPath,
  passphrasePath,
  caPath,
]) {
  if (!fs.existsSync(filename)) {
    throw new Error(`HTTPS gateway test prerequisite is missing: ${filename}`);
  }
}

assert(normalizeRemoteAddress("127.0.0.1") === "127.0.0.1", "IPv4 changed.");
assert(
  normalizeRemoteAddress("::ffff:127.0.0.1") === "127.0.0.1",
  "IPv4-mapped IPv6 was not normalized."
);
assert(normalizeRemoteAddress("::1") === "::1", "IPv6 loopback changed.");
assert(isLoopbackHost("127.0.0.1"), "IPv4 loopback host was rejected.");
assert(isLoopbackHost("::1"), "IPv6 loopback host was rejected.");
assert(isLoopbackHost("localhost"), "localhost was rejected.");
assert(!isLoopbackHost("192.0.2.10"), "A non-loopback upstream was accepted.");
assert(
  (() => {
    try {
      normalizeRemoteAddress("not-an-ip");
      return false;
    } catch {
      return true;
    }
  })(),
  "A malformed remote address was accepted."
);
assert(
  normalizeHttpAuthority("LOCALHOST:3443") === "localhost:3443",
  "HTTP authority was not canonicalized."
);
assert(
  hostAuthority("::1", 3443) === "[::1]:3443",
  "IPv6 authority was not bracketed."
);

const trustedHeaders = buildTrustedForwardingHeaders(
  {
    Host: "quickhack.example",
    Forwarded: "for=203.0.113.10",
    "X-Forwarded-For": "203.0.113.11",
    "X-Forwarded-Client-Cert": "spoofed",
    "X-Real-IP": "203.0.113.12",
  },
  "::ffff:127.0.0.1",
  {
    publicAuthority: "localhost:3443",
    upstreamAuthority: "127.0.0.1:3000",
  }
);
assert(trustedHeaders.forwarded === undefined, "RFC Forwarded was preserved.");
assert(
  trustedHeaders["x-forwarded-client-cert"] === undefined,
  "An untrusted X-Forwarded header was preserved."
);
assert(
  trustedHeaders["x-forwarded-for"] === "127.0.0.1",
  "The trusted client address was not rebuilt."
);
assert(
  trustedHeaders["x-real-ip"] === "127.0.0.1",
  "X-Real-IP does not match the trusted client address."
);
assert(trustedHeaders.host === "127.0.0.1:3000", "Internal Host was not canonicalized.");
assert(
  trustedHeaders["x-forwarded-host"] === "localhost:3443",
  "Validated public authority was not forwarded."
);

let backendRequestCount = 0;
const backend = http.createServer((request, response) => {
  backendRequestCount += 1;
  const delay = request.url?.startsWith("/slow") ? 300 : 0;
  if (request.url?.includes("early=1")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ early: true }));
    return;
  }
  let requestBodyBytes = 0;
  request.on("data", (chunk) => {
    requestBodyBytes += chunk.length;
  });
  request.on("end", () => {
    const body = JSON.stringify({
      method: request.method,
      url: request.url,
      host: request.headers.host,
      forwarded: request.headers.forwarded,
      forwardedFor: request.headers["x-forwarded-for"],
      forwardedProto: request.headers["x-forwarded-proto"],
      forwardedHost: request.headers["x-forwarded-host"],
      forwardedClientCert: request.headers["x-forwarded-client-cert"],
      realIp: request.headers["x-real-ip"],
      requestBodyBytes,
    });
    setTimeout(() => {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
    }, delay);
  });
});
let gateway = null;

try {
  const backendPort = await listen(backend);
  const gatewayPortProbe = http.createServer();
  const gatewayPort = await listen(gatewayPortProbe);
  await close(gatewayPortProbe);
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify({
      hostNames: ["127.0.0.1", "localhost"],
      primaryHost: "127.0.0.1",
      httpsPort: gatewayPort,
      serverUrl: `https://127.0.0.1:${gatewayPort}`,
    })}\n`,
    "utf8"
  );

  const invalidGateway = spawn(process.execPath, [gatewayPath], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      QUICKHACK_HTTPS_HOST: "127.0.0.1",
      QUICKHACK_HTTPS_PORT: String(gatewayPort),
      QUICKHACK_UPSTREAM_HOST: "192.0.2.10",
      QUICKHACK_UPSTREAM_PORT: String(backendPort),
      QUICKHACK_TLS_PFX_FILE: pfxPath,
      QUICKHACK_TLS_PFX_PASSPHRASE_FILE: passphrasePath,
      QUICKHACK_SUPERVISOR_TOKEN: supervisorToken,
    },
  });
  let invalidGatewayError = "";
  invalidGateway.stderr.on("data", (chunk) => {
    invalidGatewayError += chunk.toString();
  });
  const invalidExitCode = await waitForProcessExit(invalidGateway);
  assert(invalidExitCode !== 0, "A non-loopback upstream started successfully.");
  assert(
    invalidGatewayError.includes("must be a loopback host"),
    `Unexpected non-loopback startup error: ${invalidGatewayError}`
  );

  gateway = spawn(process.execPath, [gatewayPath], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      QUICKHACK_HTTPS_HOST: "127.0.0.1",
      QUICKHACK_HTTPS_PORT: String(gatewayPort),
      QUICKHACK_UPSTREAM_HOST: "127.0.0.1",
      QUICKHACK_UPSTREAM_PORT: String(backendPort),
      QUICKHACK_TLS_PFX_FILE: pfxPath,
      QUICKHACK_TLS_PFX_PASSPHRASE_FILE: passphrasePath,
      QUICKHACK_SUPERVISOR_TOKEN: supervisorToken,
    },
  });
  let gatewayError = "";
  gateway.stderr.on("data", (chunk) => {
    gatewayError += chunk.toString();
  });

  await waitForGateway(gatewayPort);
  const response = await httpsGet(gatewayPort, "/probe?value=1", {
    forwarded: "for=203.0.113.10",
    "x-forwarded-for": "203.0.113.11, 203.0.113.12",
    "x-forwarded-client-cert": "spoofed",
    "x-real-ip": "203.0.113.13",
  });
  const payload = JSON.parse(response.body);

  assert(response.status === 200, `Unexpected HTTPS status: ${response.status}`);
  assert(response.authorized, "TLS peer was not authorized by the QuickHack CA.");
  assert(payload.method === "GET", "The proxy changed the HTTP method.");
  assert(payload.url === "/probe?value=1", "The proxy changed the request URL.");
  assert(payload.forwarded === undefined, "RFC Forwarded reached the backend.");
  assert(
    payload.forwardedFor === "127.0.0.1",
    `Unexpected trusted client address: ${payload.forwardedFor}`
  );
  assert(
    payload.realIp === payload.forwardedFor,
    "X-Real-IP and X-Forwarded-For do not match."
  );
  assert(
    !payload.forwardedFor.includes(","),
    "The backend received a forwarding chain."
  );
  assert(
    payload.forwardedClientCert === undefined,
    "An unsupported X-Forwarded header reached the backend."
  );
  assert(payload.forwardedProto === "https", "Forwarded HTTPS protocol is missing.");
  assert(
    payload.forwardedHost === `127.0.0.1:${gatewayPort}`,
    "Validated forwarded host is incorrect."
  );
  assert(
    payload.host === `127.0.0.1:${backendPort}`,
    "The backend Host was not replaced with the loopback upstream."
  );

  const beforeSpoof = backendRequestCount;
  const spoofedHost = await httpsGet(gatewayPort, "/host-spoof", {
    host: "attacker.example:8443",
  });
  assert(spoofedHost.status === 400, "A spoofed Host reached the gateway.");
  assert(
    backendRequestCount === beforeSpoof,
    "A spoofed Host reached the backend."
  );

  const oversizedBody = Buffer.alloc(
    QUICKHACK_AUTH_REQUEST_BODY_LIMIT_BYTES + 1,
    "x"
  );
  const beforeFixedOversize = backendRequestCount;
  const fixedOversize = await httpsCall(gatewayPort, "/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(oversizedBody.length),
    },
    body: oversizedBody,
  });
  assert(fixedOversize.status === 413, "Oversized Content-Length was accepted.");
  assert(
    backendRequestCount === beforeFixedOversize,
    "Known oversized content reached the backend."
  );

  const chunkedOversize = await httpsCall(gatewayPort, "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversizedBody,
  });
  assert(chunkedOversize.status === 413, "Oversized chunked content was accepted.");

  const earlyUpstreamOversize = await httpsCall(
    gatewayPort,
    "/api/auth/login?early=1",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversizedBody,
    }
  );
  assert(
    earlyUpstreamOversize.status === 413,
    `An early upstream response bypassed the chunked body limit: ${earlyUpstreamOversize.status}`
  );

  const boundaryBody = Buffer.alloc(QUICKHACK_AUTH_REQUEST_BODY_LIMIT_BYTES, "x");
  const boundaryResponse = await httpsCall(gatewayPort, "/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(boundaryBody.length),
    },
    body: boundaryBody,
  });
  assert(boundaryResponse.status === 200, "The exact body boundary was rejected.");
  assert(
    JSON.parse(boundaryResponse.body).requestBodyBytes === boundaryBody.length,
    "The exact body boundary was not delivered once."
  );
  const blockedInternal = await httpsGet(
    gatewayPort,
    "/api/internal/supervisor/shutdown"
  );
  assert(
    blockedInternal.status === 404,
    "The gateway exposed the backend supervisor route."
  );
  const blockedBackupSupervisor = await httpsGet(
    gatewayPort,
    "/api/internal/supervisor/backups"
  );
  assert(
    blockedBackupSupervisor.status === 404,
    "The gateway exposed the backup supervisor route."
  );
  const rejectedShutdown = await httpsCall(
    gatewayPort,
    "/__quickhack_gateway_shutdown",
    {
      method: "POST",
      headers: { "X-QuickHack-Supervisor-Token": "wrong-token" },
    }
  );
  assert(
    rejectedShutdown.status === 404,
    "The gateway disclosed its shutdown route to an invalid token."
  );

  const slowResponsePromise = httpsGet(gatewayPort, "/slow");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const acceptedShutdown = await httpsCall(
    gatewayPort,
    "/__quickhack_gateway_shutdown",
    {
      method: "POST",
      headers: { "X-QuickHack-Supervisor-Token": supervisorToken },
    }
  );
  assert(
    acceptedShutdown.status === 202,
    `Gateway shutdown was not accepted: ${acceptedShutdown.status}`
  );
  const slowResponse = await slowResponsePromise;
  assert(
    slowResponse.status === 200,
    "An in-flight HTTPS request was cut off during gateway drain."
  );
  await waitForExit(gateway);
  assert(!gatewayError, `HTTPS gateway wrote an error: ${gatewayError}`);

  console.log(
    "QuickHack HTTPS proxy, supervisor isolation, and graceful drain verified."
  );
} finally {
  if (gateway && gateway.exitCode === null) {
    gateway.kill();
  }
  await close(backend);
  cleanupTlsFixture();
}
