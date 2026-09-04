import { fileURLToPath } from "node:url";
import path from "node:path";
import { activatePackageRuntimeIdentity } from "../quickhack_shared/core/package-runtime-identity.mjs";
import { runServerConsole } from "./server-console-core.mjs";
import { importQhkeyMasterKey } from "./server-console-qhkey-common.mjs";
import {
  rotateCoupangQhkey,
  rotateLogenQhkey,
} from "./server-console-qhkey-operational.mjs";

function enabled(value) {
  return value === true || value === "true" || value === "1" || value === "on";
}

export const operationalConsoleIntegration = Object.freeze({
  flavor: "OPERATIONAL",
  childIds: Object.freeze([]),
  async startChildren() { return []; },
  async status() { return { ready: true, provider: "EXTERNAL" }; },
  renderHtml(t) {
    return `<section class="card"><h2>${t.operational}</h2><p class="muted">${t.operationalHelp}</p>
<form id="coupang-key-form"><input name="root" placeholder="${t.qhkeyVolume}"><input name="vendorId" placeholder="${t.vendorId}"><input name="accessKey" placeholder="${t.accessKey}"><input name="secretKey" type="password" placeholder="${t.secretKey}"><input name="expiresOn" type="date"><input name="keyAlias" placeholder="${t.alias}"><button type="submit">${t.registerCoupang}</button></form>
<form id="logen-key-form"><input name="root" placeholder="${t.qhkeyVolume}"><input name="userId" placeholder="${t.userId}"><input name="customerCode" placeholder="${t.customerCode}"><input name="secretKey" type="password" placeholder="${t.secretKey}"><input name="expiresOn" type="date"><input name="keyAlias" placeholder="${t.alias}"><button type="submit">${t.registerLogen}</button></form>
<script>for(const [id,url] of [['coupang-key-form','/api/qhkey/rotate'],['logen-key-form','/api/qhkey/logen/rotate']])document.getElementById(id).onsubmit=async(e)=>{e.preventDefault();await window.quickHackConsolePost(url,Object.fromEntries(new FormData(e.currentTarget)))}</script></section>`;
  },
  async handleAction(pathname, { config, payload }) {
    const common = {
      ...payload,
      dataDir: config.dataDirectory,
      production: config.environment === "production",
      replaceExisting: enabled(payload.replaceExisting),
    };
    if (pathname === "/api/qhkey/rotate") {
      return { status: 202, payload: { ok: true, ...(await rotateCoupangQhkey({ ...common, environment: "live" })) } };
    }
    if (pathname === "/api/qhkey/logen/rotate") {
      return { status: 202, payload: { ok: true, ...(await rotateLogenQhkey({ ...common, environment: "live" })) } };
    }
    if (pathname === "/api/qhkey/import-master") {
      return { status: 200, payload: { ok: true, ...(await importQhkeyMasterKey(common)) } };
    }
    return null;
  },
});

function isMainModule() {
  return path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  activatePackageRuntimeIdentity({
    artifactKind: "OPERATIONAL_SERVER",
    runtimeRole: "SERVER",
    deploymentFlavor: "OPERATIONAL",
  });
  await runServerConsole({ flavor: "OPERATIONAL", integration: operationalConsoleIntegration });
}
