import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function source(relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

const sensitiveAuth = source(
  "quickhack_shared/auth/sensitive-auth.ts"
);
const workspace = source(
  "quickhack_client/components/app-shell/device-workspace.tsx"
);
const page = source("app/page.tsx");
const forcedScreen = source(
  "quickhack_client/components/auth/password-change-required-screen.tsx"
);
const personalSettings = source(
  "quickhack_client/components/user/personal-settings-view.tsx"
);
const requestAuth = source("quickhack_client/auth/request-auth.ts");
const logoutHelper = source("quickhack_client/auth/logout.ts");
const accountTotpPanel = source(
  "quickhack_client/components/user/account-totp-panel.tsx"
);
const sensitiveActionGuards = source(
  "quickhack_client/components/security/sensitive-action-guards.tsx"
);
const recoveryCodeResult = source(
  "quickhack_client/components/security/recovery-code-result.tsx"
);
const accountManager = source(
  "quickhack_client/components/admin/user-account-manager-view.tsx"
);

assert.match(
  sensitiveAuth,
  /accountManagement:\s*"USER_ACCOUNT_MANAGEMENT"/
);
assert.match(
  sensitiveAuth,
  /case\s+"admin-users":\s*return\s+SENSITIVE_ACTIONS\.accountManagement/
);
assert.match(
  workspace,
  /selectedMenuId === "admin-users"[\s\S]*?<SensitiveMenuGate item=\{activeMenu\}>[\s\S]*?<UserAccountManagerView \/>/
);

const forcedBranch = page.indexOf("if (authUser.mustChangePassword)");
const workspaceRender = page.indexOf("return <DeviceWorkspace");
assert.ok(forcedBranch >= 0, "Root page must branch on mustChangePassword.");
assert.ok(
  workspaceRender >= 0 && forcedBranch < workspaceRender,
  "Forced password change must happen before workspace rendering."
);
assert.doesNotMatch(
  page,
  /const deviceResult|\/api\/devices/,
  "Root page must not load device workspace data before the password gate."
);
assert.match(accountTotpPanel, /enrollmentToken:\s*setup\?\.enrollmentToken/);
assert.match(sensitiveActionGuards, /enrollmentToken:\s*totpSetup\?\.enrollmentToken/);
assert.match(accountTotpPanel, /<RecoveryCodeResult/);
assert.match(sensitiveActionGuards, /<RecoveryCodeResult/);
assert.match(recoveryCodeResult, /kind:\s*"one-time-result"/);
assert.match(recoveryCodeResult, /보관 완료/);
assert.match(accountManager, /expectedRevision:\s*selectedUser\.revision/);
assert.match(workspace, /expectedRevision:\s*accountProfile\.revision/);
assert.match(
  forcedScreen,
  /<AccountPasswordPanel[\s\S]*?forced[\s\S]*?onChanged/
);
assert.match(
  forcedScreen,
  /import\s+\{\s*requestQuickHackLogout\s*\}\s+from\s+"@\/quickhack_client\/auth\/logout"/
);
assert.match(forcedScreen, /await requestQuickHackLogout\(\)/);
assert.match(logoutHelper, /fetchImplementation\("\/api\/auth\/logout"/);
assert.doesNotMatch(forcedScreen, /DeviceWorkspace/);
assert.match(
  personalSettings,
  /<AccountPasswordPanel \/>[\s\S]*?<AccountTotpPanel/
);
assert.match(
  requestAuth,
  /response\.user\?\.mustChangePassword[\s\S]*?\?\s*null/
);
assert.match(
  accountTotpPanel,
  /OTP 보안 서비스를 사용할 수 없어 OTP 등록과 보호된 작업이 차단되었습니다/
);
assert.match(
  sensitiveActionGuards,
  /OTP 보안 서비스를 사용할 수 없어 보호된 작업이 차단되었습니다/
);
assert.doesNotMatch(
  sensitiveActionGuards,
  /비밀번호 확인만 사용할 수 있습니다/,
  "An unavailable OTP key must never advertise a password-only fallback."
);

console.log("Account security UI contract tests passed.");
