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

export const demonstrationConsoleIntegration = Object.freeze({
  flavor: "DEMONSTRATION",
  childIds: Object.freeze(CHILDREN.map((item) => item.id)),
  async startChildren({ root, nodeExecutable, runtimeConfig, spawnOwned, childEnvironment, createCredentialHandoff }) {
    return CHILDREN.map((item) => {
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
    });
  },
  async status({ managed }) {
    const children = CHILDREN.map((item) => ({ id: item.id, pid: managed.get(item.id)?.pid ?? null, port: item.port }));
    return { ready: children.every((item) => item.pid !== null), children };
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
