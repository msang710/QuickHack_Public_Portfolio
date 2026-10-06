import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { activatePackageRuntimeIdentity } from "../quickhack_shared/core/package-runtime-identity.mjs";
import { runServerConsole } from "./server-console-core.mjs";
import { issueMockCoupangQhkey } from "./server-console-qhkey-demonstration.mjs";

const CHILDREN = Object.freeze([
  Object.freeze({ id: "coupang-simulator", relativeEntry: "mock_server/coupang-mock-server.mjs", port: 3100 }),
  Object.freeze({ id: "logen-simulator", relativeEntry: "mock_server/logen/server.mjs", port: 3200 }),
]);

async function probeMockHealth(port, expectedInstanceId = "") {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { cache: "no-store", signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.ok === true &&
      (payload.database === "postgresql" || payload.databaseProvider === "postgresql") &&
      (!expectedInstanceId || payload.instanceId === expectedInstanceId);
  } catch {
    return false;
  }
}

export const demonstrationConsoleIntegration = Object.freeze({
  flavor: "DEMONSTRATION",
  childIds: Object.freeze(CHILDREN.map((item) => item.id)),
  childPorts: Object.freeze(Object.fromEntries(CHILDREN.map((item) => [item.id, item.port]))),
  async probeChild(id, expectedInstanceId) {
    const item = CHILDREN.find((candidate) => candidate.id === id);
    return item ? probeMockHealth(item.port, expectedInstanceId) : false;
  },
  async startChild(id, { root, nodeExecutable, runtimeConfig, spawnOwned, childEnvironment, createCredentialHandoff }) {
    const item = CHILDREN.find((candidate) => candidate.id === id);
    if (!item) throw Object.assign(new Error("Unknown demonstration server."), { code: "SERVER_UNKNOWN" });
    const entry = path.join(root, ...item.relativeEntry.split("/"));
    const credentialName = item.id.startsWith("coupang")
      ? "quickhack.postgresql.coupang-mock"
      : "quickhack.postgresql.logen-mock";
    const credentialDirectory = createCredentialHandoff(item.id, [credentialName], runtimeConfig);
    try {
      const child = spawnOwned(
        item.id,
        { nodeExecutable, args: [entry], cwd: path.dirname(entry) },
        childEnvironment({ NODE_ENV: "production" }, false, credentialDirectory)
      );
      return { id: item.id, pid: child.pid, port: item.port };
    } catch (error) {
      if (credentialDirectory) fs.rmSync(credentialDirectory, { recursive: true, force: true });
      throw error;
    }
  },
  async status({ managed, ownedInstances, probeHealth = probeMockHealth }) {
    const children = await Promise.all(CHILDREN.map(async (item) => ({
      id: item.id,
      pid: managed.get(item.id)?.pid ?? null,
      port: item.port,
      healthy: managed.has(item.id) && (!ownedInstances || ownedInstances.has(item.id))
        ? await probeHealth(item.port, ownedInstances?.get(item.id) ?? "")
        : false,
    })));
    return { ready: children.every((item) => item.pid !== null && item.healthy), children };
  },
  renderHtml(t) {
    return `<section class="card"><h2>${t.demonstration}</h2><p class="muted">${t.demonstrationHelp}</p><form id="mock-key-form"><input name="root" placeholder="${t.qhkeyVolume}"><input name="keyAlias" placeholder="${t.alias}"><button type="submit">${t.issueDemo}</button></form><script>document.getElementById('mock-key-form').onsubmit=async(e)=>{e.preventDefault();await window.quickHackConsolePost('/api/qhkey/mock-issue',Object.fromEntries(new FormData(e.currentTarget)))}</script></section>`;
  },
  async handleAction(pathname, { config, payload }) {
    if (pathname !== "/api/qhkey/mock-issue") return null;
    const result = await issueMockCoupangQhkey({
      ...payload,
      dataDir: config.dataDirectory,
      production: false,
      environment: "mock",
      mockServerUrl: "http://127.0.0.1:3100",
      replaceExisting: payload.replaceExisting === true || payload.replaceExisting === "1" || payload.replaceExisting === "on",
    });
    return { status: 202, payload: { ok: true, ...result } };
  },
});

function isMainModule() {
  return path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  activatePackageRuntimeIdentity({
    artifactKind: "DEMONSTRATION_SERVER",
    runtimeRole: "SERVER",
    deploymentFlavor: "DEMONSTRATION",
  });
  await runServerConsole({ flavor: "DEMONSTRATION", integration: demonstrationConsoleIntegration });
}
