import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requestQuickHackLogout } from "../../quickhack_client/auth/logout.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function response(status, payload, raw = null) {
  return new Response(raw ?? JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let callCount = 0;
await requestQuickHackLogout(async (input, init) => {
  callCount += 1;
  assert.equal(input, "/api/auth/logout");
  assert.equal(init?.method, "POST");
  return response(200, { ok: true });
});
assert.equal(callCount, 1, "Logout helper sent more than one request.");

await assert.rejects(
  () =>
    requestQuickHackLogout(async () =>
      response(503, {
        ok: false,
        code: "SERVER_PROXY_UNAVAILABLE",
        message: "중앙 서버에 연결할 수 없습니다.",
      })
    ),
  /중앙 서버에 연결할 수 없습니다/
);

await assert.rejects(
  () =>
    requestQuickHackLogout(async () =>
      response(504, {
        ok: false,
        code: "SERVER_PROXY_TIMEOUT",
        uncertain: true,
        message: "요청이 적용됐는지 확인할 수 없습니다.",
      })
    ),
  /적용됐는지 확인할 수 없습니다/
);

await assert.rejects(
  () => requestQuickHackLogout(async () => response(200, null, "not-json")),
  /로그아웃하지 못했습니다/
);

const workspaceSource = fs.readFileSync(
  path.join(
    root,
    "quickhack_client",
    "components",
    "app-shell",
    "device-workspace.tsx"
  ),
  "utf8"
);
assert.match(
  workspaceSource,
  /await requestQuickHackLogout\(\);\s+allowNextBeforeUnload\(\);\s+window\.location\.reload\(\);/
);
assert.doesNotMatch(
  workspaceSource,
  /finally\s*\{\s*window\.location\.reload\(\)/
);

const guardSource = fs.readFileSync(
  path.join(
    root,
    "quickhack_client",
    "components",
    "app-shell",
    "unsaved-changes-provider.tsx"
  ),
  "utf8"
);
assert.doesNotMatch(
  guardSource,
  /options\.intent === "logout"[\s\S]{0,120}allowNextBeforeUnload/
);

console.log("Logout success and unsaved-change guard flow verified.");
