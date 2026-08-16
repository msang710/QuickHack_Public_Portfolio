import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OFFICIAL_LIVE_API_HOSTS,
  resolveOfficialLiveApiHost,
} from "../../quickhack_shared/core/external-api-destination-policy.ts";
import {
  activateTestServerRuntimeConfig,
  writeTestServerRuntimeConfig,
} from "../support/runtime-config-file.mjs";

const temporaryDirectory = mkdtempSync(
  path.join(os.tmpdir(), "quickhack-external-destination-")
);
activateTestServerRuntimeConfig(
  writeTestServerRuntimeConfig(temporaryDirectory)
);

try {
const { runtimeConfigService } = await import(
  "../../quickhack_shared/core/runtime.ts"
);
const { getCoupangRuntimeConfig } = await import(
  "../../quickhack_server/sales-channel/coupang/config.ts"
);
const { getLogenRuntimeConfig } = await import(
  "../../quickhack_server/shipment/carrier-integration/logen/config.ts"
);

const hostileValues = [
  "http://attacker.invalid",
  "https://attacker.invalid",
  "https://operator:secret@attacker.invalid",
  "not-a-url",
];

for (const [provider, officialHost] of Object.entries(OFFICIAL_LIVE_API_HOSTS)) {
  assert.equal(resolveOfficialLiveApiHost(provider), officialHost);
  for (const hostile of hostileValues) {
    assert.equal(
      resolveOfficialLiveApiHost(provider, { API_HOST: hostile }),
      officialHost,
      `${provider} live destination changed through an untrusted value.`
    );
  }
}

const hostileEnvironment = {
  COUPANG_API_MODE: "live",
  COUPANG_API_HOST: "https://attacker.invalid/coupang",
  COUPANG_MOCK_SERVER_URL: "http://127.0.0.1:3310/",
  LOGEN_API_MODE: "live",
  LOGEN_API_HOST: "https://attacker.invalid/logen",
  LOGEN_MOCK_SERVER_URL: "http://127.0.0.1:3320/",
  QUICKHACK_WRITE_API_ENABLED: "false",
};
const runtime = runtimeConfigService.read(hostileEnvironment);
assert.equal(runtime.endpoints.coupang.apiHost, OFFICIAL_LIVE_API_HOSTS.COUPANG);
assert.equal(runtime.endpoints.logen.apiHost, OFFICIAL_LIVE_API_HOSTS.LOGEN);

const previous = Object.fromEntries(
  Object.keys(hostileEnvironment).map((name) => [name, process.env[name]])
);
try {
  Object.assign(process.env, hostileEnvironment);
  const coupang = getCoupangRuntimeConfig();
  const logen = getLogenRuntimeConfig();
  assert.equal(coupang.mode, runtime.endpoints.coupang.mode);
  assert.equal(coupang.apiHost, runtime.endpoints.coupang.apiHost);
  assert.equal(coupang.mockServerUrl, runtime.endpoints.coupang.mockServerUrl);
  assert.equal(logen.mode, runtime.endpoints.logen.mode);
  assert.equal(logen.apiHost, runtime.endpoints.logen.mockServerUrl);
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log("External live API destination policy verified.");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
