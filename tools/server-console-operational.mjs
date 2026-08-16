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
  renderHtml() {
    return `<section class="card"><h2>운영 연동 QHKEY</h2><p class="muted">실제 API key는 응답이나 로그에 다시 표시되지 않으며 선택한 QHKEY에 암호화해 저장합니다.</p>
<form id="coupang-key-form"><input name="root" placeholder="QHKEY volume"><input name="vendorId" placeholder="vendorId"><input name="accessKey" placeholder="Access Key"><input name="secretKey" type="password" placeholder="Secret Key"><input name="expiresOn" type="date"><input name="keyAlias" placeholder="별칭"><button type="submit">Coupang API 키 등록</button></form>
<form id="logen-key-form"><input name="root" placeholder="QHKEY volume"><input name="userId" placeholder="userId"><input name="customerCode" placeholder="customerCode"><input name="secretKey" type="password" placeholder="Secret Key"><input name="expiresOn" type="date"><input name="keyAlias" placeholder="별칭"><button type="submit">Logen API 키 등록</button></form>
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
