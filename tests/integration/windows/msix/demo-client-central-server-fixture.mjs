import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { initializeQuickHackTls } from "../../../../tools/server-console-tls.mjs";
import { QUICKHACK_RUNTIME_CONTRACT_VERSION } from "../../../../quickhack_shared/core/package-runtime-identity.mjs";

function argumentsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new TypeError("QuickHack demo-client fixture arguments are incomplete.");
    }
    result[name.slice(2)] = ["deployment-flavor", "artifact-kind"].includes(name.slice(2))
      ? value.toUpperCase()
      : path.resolve(value);
  }
  for (const required of ["config-dir", "work-dir", "ready-file", "stop-file"]) {
    if (!result[required]) throw new TypeError(`--${required} is required.`);
  }
  result["deployment-flavor"] ??= "DEMONSTRATION";
  result["artifact-kind"] ??= `${result["deployment-flavor"]}_SERVER`;
  if (
    !["DEMONSTRATION", "OPERATIONAL"].includes(result["deployment-flavor"]) ||
    result["artifact-kind"] !== `${result["deployment-flavor"]}_SERVER`
  ) {
    throw new TypeError("QuickHack client fixture flavor and server artifact kind must match.");
  }
  return result;
}

async function reservePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Unable to reserve a fixture port.");
  return address.port;
}

const input = argumentsFrom(process.argv.slice(2));
const tlsDataDir = path.join(input["work-dir"], "tls-data");
const httpsPort = await reservePort();
fs.mkdirSync(input["work-dir"], { recursive: true });
const status = await initializeQuickHackTls({
  dataDir: tlsDataDir,
  httpsPort,
  hostNames: ["127.0.0.1", "localhost"],
  primaryHost: "127.0.0.1",
  scriptPath: path.resolve("tools/initialize-https.ps1"),
});
if (fs.existsSync(input["config-dir"])) {
  throw new Error("The QuickHack demo-client fixture refuses to overwrite an existing config root.");
}
fs.cpSync(status.paths.clientConfigDir, input["config-dir"], {
  recursive: true,
  force: false,
  errorOnExist: true,
});

const origin = `https://127.0.0.1:${httpsPort}`;
const payload = JSON.stringify({
  ok: true,
  runtimeContractVersion: QUICKHACK_RUNTIME_CONTRACT_VERSION,
  role: "server",
  deploymentFlavor: input["deployment-flavor"],
  artifactKind: input["artifact-kind"],
  publicOrigin: origin,
  serverUrl: "",
  instanceId: "",
});
const server = https.createServer({
  pfx: fs.readFileSync(status.paths.serverPfx),
  passphrase: fs.readFileSync(status.paths.serverPassphrase, "utf8").trim(),
}, (request, response) => {
  if (request.method === "GET" && request.url === "/api/runtime") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(httpsPort, "127.0.0.1", resolve);
});
fs.writeFileSync(input["ready-file"], `${JSON.stringify({
  schemaVersion: 1,
  status: "READY",
  origin,
  pid: process.pid,
})}\n`, "utf8");

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise((resolve) => server.close(resolve));
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
while (!stopping && !fs.existsSync(input["stop-file"])) {
  await new Promise((resolve) => setTimeout(resolve, 200));
}
await stop();
