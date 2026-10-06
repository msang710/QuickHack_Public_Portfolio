import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { createPostgresqlPackageManifest } from "../../../quickhack_shared/core/package-flavor-contract.mjs";
import { serverSecretIdentity } from "../../../quickhack_server/platform/server-secret-identity.mjs";
import { createSystemdCredentialProvisioner, systemdCredentialCiphertextPath } from "./systemd-credential-provisioner.mjs";
import { runSystemdCredentialProcess } from "./systemd-credential-process.mjs";

const { Pool } = pg;
const APPLICATION_KEY_KINDS = Object.freeze([
  "OTP_MASTER_KEY",
  "BACKUP_MASTER_KEY",
  "MOBILE_SERIAL_HMAC",
  "QHKEY_MASTER_KEY",
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function existingCredential(identity, read = runSystemdCredentialProcess) {
  const filename = systemdCredentialCiphertextPath(identity);
  let stat;
  try { stat = await fs.lstat(filename); } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("APPLICATION_CREDENTIAL_INVALID", "An application credential is not a regular file.");
  }
  const secret = await read(["decrypt", `--name=${identity.id}`, filename, "-"]);
  try {
    if (secret.length !== 32) fail("APPLICATION_CREDENTIAL_INVALID", "An application credential has an invalid length.");
  } finally {
    secret.fill(0);
  }
  return true;
}

async function assertEmptyApplicationState(runtimeConfig, read = runSystemdCredentialProcess) {
  const manifest = createPostgresqlPackageManifest(runtimeConfig);
  const migrator = manifest.roles.find((role) => role.kind === "migrator");
  const identity = serverSecretIdentity({ kind: "POSTGRESQL_CREDENTIAL", runtimeConfig, postgresqlRole: "migrator" });
  const password = await read(["decrypt", `--name=${identity.id}`, systemdCredentialCiphertextPath(identity), "-"]);
  let pool;
  try {
    pool = new Pool({
      host: "127.0.0.1",
      port: runtimeConfig.database.port,
      database: migrator.database,
      user: migrator.user,
      password: password.toString("utf8"),
      max: 1,
      connectionTimeoutMillis: 5_000,
    });
    const users = await pool.query("SELECT EXISTS(SELECT 1 FROM users) AS present");
    if (users.rows[0]?.present !== false) {
      fail("APPLICATION_CREDENTIAL_RECOVERY_REQUIRED", "Application keys are missing while user data exists.");
    }
  } finally {
    password.fill(0);
    await pool?.end();
  }
  const backupDirectory = path.join(runtimeConfig.dataDirectory, "backups");
  const backups = await fs.readdir(backupDirectory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  if (backups.some((entry) => entry.toLowerCase().endsWith(".qhb"))) {
    fail("APPLICATION_CREDENTIAL_RECOVERY_REQUIRED", "Application keys are missing while backup data exists.");
  }
}

export async function ensureLinuxApplicationCredentials(runtimeConfig, options = {}) {
  if ((options.getuid ?? process.getuid?.bind(process))?.() !== 0) {
    fail("APPLICATION_CREDENTIAL_ROOT_REQUIRED", "Application credential bootstrap requires administrator authentication.");
  }
  const provisioner = options.provisioner ?? createSystemdCredentialProvisioner();
  const read = options.read ?? runSystemdCredentialProcess;
  const exists = options.exists ?? existingCredential;
  const assertEmpty = options.assertEmpty ?? assertEmptyApplicationState;
  const identities = APPLICATION_KEY_KINDS.map((kind) => serverSecretIdentity({ kind }));
  const missing = [];
  for (const identity of identities) {
    if (!(await exists(identity, read))) missing.push(identity);
  }
  if (missing.length === 0) return Object.freeze({ state: "READY", created: 0 });
  await assertEmpty(runtimeConfig, read);
  const prepared = [];
  const committed = [];
  try {
    for (const identity of missing) {
      const secret = randomBytes(32);
      try { prepared.push(await provisioner.prepare({ identity, secret })); }
      finally { secret.fill(0); }
    }
    for (const token of prepared) committed.push(await provisioner.commit(token));
    for (const token of committed) await provisioner.activate(token);
    return Object.freeze({ state: "READY", created: committed.length });
  } catch (error) {
    for (const token of committed.reverse()) await provisioner.rollback(token).catch(() => undefined);
    const committedIds = new Set(committed.map((token) => token.identityId));
    for (const token of prepared) {
      if (!committedIds.has(token.identityId)) await provisioner.discard(token).catch(() => undefined);
    }
    throw error;
  }
}
