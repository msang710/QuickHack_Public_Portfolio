import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (relativePath) => readFileSync(path.join(process.cwd(), relativePath), "utf8");
const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20260811010000_postgresql_baseline/migration.sql");
const auth = read("quickhack_server/auth/auth-service.ts");
const password = read("quickhack_server/auth/password-change-service.ts");
const account = read("quickhack_server/auth/account-security-aggregate.ts");
const admin = read("quickhack_server/api/admin/users.ts");
const totp = read("quickhack_server/auth/totp-service.ts");
const sensitive = read("quickhack_server/api/auth/sensitive-verify.ts");
const settings = read("quickhack_server/user/personal-settings-service.ts");

assert.match(schema, /model user_sessions[\s\S]*?credential_revision\s+Int[\s\S]*?instance_epoch\s+Int/);
assert.match(schema, /model user_sensitive_auth_grants[\s\S]*?credential_revision\s+Int[\s\S]*?totp_credential_id\s+Int/);
assert.match(migration, /INSERT INTO "server_instance_state"[\s\S]*?'QUICKHACK', 1, 0/);
assert.match(auth, /session\.credential_revision !== session\.users\.credential_revision/);
assert.match(auth, /session\.instance_epoch !== serverState\.instance_epoch/);
assert.doesNotMatch(auth, /markSensitiveSessionVerified/);
assert.match(auth, /expectedCredentialRevision[\s\S]*?SessionGenerationChangedError/);
assert.match(password, /lockServerSecurityState\(tx\)[\s\S]*?FOR UPDATE[\s\S]*?replaceUserSessionsInTransaction/);
assert.match(account, /lockAndAdvanceServerSecurityState\(tx\)[\s\S]*?ACCOUNT_AUTHORIZATION_CHANGED/);
assert.match(account, /ACTIVE_LEADER_REQUIRED/);
assert.match(admin, /lockAccountTarget\([\s\S]*?expectedRevision/);
assert.match(admin, /accountAuditSnapshot/);
assert.doesNotMatch(admin, /writeActivityLog\([\s\S]{0,300}?userSnapshot\(/);
assert.match(totp, /enrollmentToken[\s\S]*?secret_ciphertext[\s\S]*?secret_iv[\s\S]*?secret_auth_tag/);
assert.match(totp, /confirmEnrollment[\s\S]*?replaceUserTotpRecoveryCodes[\s\S]*?replaceUserSessionsInTransaction/);
assert.match(totp, /verifySensitiveSession[\s\S]*?verifyUserTotpCodeInTransaction[\s\S]*?user_sensitive_auth_grants\.upsert/);
assert.match(sensitive, /verifySensitiveSession\(\{ sessionToken, code, sensitiveAction \}\)/);
assert.doesNotMatch(sensitive, /markSensitiveSessionVerified|verifyUserTotpCode/);
assert.match(settings, /createMany\([\s\S]*?skipDuplicates:\s*true[\s\S]*?updateMany/);
assert.match(settings, /if \(claimed\.count !== 1\)/);

console.log("Account, OTP, session aggregate source contract passed.");
