import assert from "node:assert/strict";
import fs from "node:fs";

const consoleSource = fs.readFileSync("tools/server-console-core.mjs", "utf8");
const routeSource = fs.readFileSync(
  "app/api/internal/supervisor/totp-security/route.ts",
  "utf8"
);
const routeHandlersSource = fs.readFileSync(
  "quickhack_server/admin/totp-security-route-handlers.ts",
  "utf8"
);
const recoveryServiceSource = fs.readFileSync(
  "quickhack_server/admin/totp-security-recovery-service.ts",
  "utf8"
);
const accountPanelSource = fs.readFileSync(
  "quickhack_client/components/user/account-totp-panel.tsx",
  "utf8"
);
const sensitiveGuardSource = fs.readFileSync(
  "quickhack_client/components/security/sensitive-action-guards.tsx",
  "utf8"
);

assert.match(
  routeHandlersSource,
  /dependencies\.authorize \?\? authorizeSupervisorRequest/,
  "The OTP recovery route is not protected by the supervisor token."
);
assert.equal(
  routeHandlersSource.match(/authorize\(request\)/g)?.length,
  2,
  "The OTP recovery GET and POST handlers do not both enforce authorization."
);
assert.match(routeHandlersSource, /readTotpSecurityRecoveryState/);
assert.match(routeHandlersSource, /recoverTotpSecurity/);
assert.match(routeSource, /createTotpSecurityRouteHandlers\(\)/);
assert.match(routeSource, /export const GET = handlers\.GET/);
assert.match(routeSource, /export const POST = handlers\.POST/);
assert.match(
  consoleSource,
  /\/api\/internal\/supervisor\/totp-security/,
  "The server console does not call the server-owned OTP recovery API."
);
assert.match(
  consoleSource,
  /"X-QuickHack-Supervisor-Token": actionToken/,
  "The server console omitted supervisor authentication."
);
assert.match(consoleSource, /id="otp-security-state"/);
assert.match(consoleSource, /id="otp-security-confirm"/);
assert.match(consoleSource, /id="otp-security-recover"/);
assert.match(consoleSource, /키나 암호를 입력받지 않습니다/);
assert.match(consoleSource, /confirmText: String\(payload\.confirmText/);
assert.doesNotMatch(
  consoleSource,
  /otp-security-(?:key|secret|ciphertext|payload)/,
  "The OTP console UI introduced a key or secret input."
);
assert.match(recoveryServiceSource, /runSafetyBackup\(\)/);
assert.match(recoveryServiceSource, /prismaClient\.\$transaction/);
assert.match(recoveryServiceSource, /SYSTEM_TOTP_SECURITY_RESET/);
assert.match(recoveryServiceSource, /TOTP_SECURITY_ALREADY_READY/);
assert.match(recoveryServiceSource, /TOTP_SECURITY_RESET_CONFIRMATION_REQUIRED/);
assert.match(
  accountPanelSource,
  /QuickHack 본서버 콘솔에서 OTP 보안 상태를 확인해야 합니다/
);
assert.match(
  sensitiveGuardSource,
  /QuickHack 본서버 콘솔에서 OTP 보안 상태를 확인해야 합니다/
);

console.log(
  "Server-owned OTP recovery route, console confirmation UI, and no-secret-input contract verified."
);
