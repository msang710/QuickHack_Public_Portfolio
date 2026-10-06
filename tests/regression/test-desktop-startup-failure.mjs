import assert from "node:assert/strict";
import { describeDesktopStartupFailure } from "../../quickhack_desktop/main/startup-failure.ts";

const missing = describeDesktopStartupFailure(
  new Error("Client runtime start failed (1): [QuickHack Client] TRUST_BUNDLE_INCOMPLETE: Trust bundle file is missing: /home/example/.config/quickhack/demonstration-client/trust-bundle.json"),
  "CLIENT_RUNTIME"
);
assert.match(missing, /로컬 클라이언트 실행/u);
assert.match(missing, /TRUST_BUNDLE_INCOMPLETE/u);
assert.match(missing, /\/home\/example\/\.config\/quickhack\/demonstration-client/u);
assert.match(missing, /클라이언트 설정 경로/u);
assert.match(missing, /client-config 폴더 안 파일 전체/u);
assert.doesNotMatch(missing, /설정 경로가 없으면/u);
assert.doesNotMatch(missing, /설정 경로: .*trust-bundle\.json/u);

const unavailable = describeDesktopStartupFailure(
  new Error("Client runtime start failed (1): [QuickHack Client] ECONNREFUSED: connect ECONNREFUSED 192.0.2.1:3443"),
  "CLIENT_RUNTIME"
);
assert.match(unavailable, /중앙 서버에 연결할 수 없습니다/u);
assert.doesNotMatch(unavailable, /192\.0\.2\.1/u);

const unknown = describeDesktopStartupFailure(
  Object.assign(new Error("secretKey=do-not-display"), { code: "WINDOW_CREATION_FAILED" }),
  "MAIN_WINDOW"
);
assert.match(unknown, /데스크톱 창 생성/u);
assert.match(unknown, /WINDOW_CREATION_FAILED/u);
assert.doesNotMatch(unknown, /do-not-display/u);

console.log("Desktop startup failure reports stage, safe code, and deployment configuration action.");
