import { createHash, generateKeyPairSync, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { openDedicatedPool, withTransaction } from "./db.mjs";
import { validateLoadProfile } from "./profile.mjs";

const scrypt = promisify(scryptCallback);

function mobileHash(purpose, value) {
  return `sha256:v2:${createHash("sha256").update("quickhack-mobile-credential-v2").update("\0").update(purpose).update("\0").update(value).digest("hex")}`;
}

async function passwordHash(password) {
  const salt = randomBytes(16).toString("base64url");
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(key).toString("base64url")}`;
}

export async function provisionLoadAccounts(profileInput, connectionString, secretsPath) {
  const profile = validateLoadProfile(profileInput);
  if (!secretsPath || typeof secretsPath !== "string") throw new TypeError("A private secrets file path is required.");
  const { pool, identity } = await openDedicatedPool(connectionString, "server-accounts");
  const prefix = `lv_${profile.runId.toLowerCase().replaceAll("-", "_")}_`;
  const credentials = [];
  try {
    await withTransaction(pool, async (tx) => {
      const prior = await tx.query("SELECT count(*)::int AS count FROM users WHERE username LIKE $1", [`${prefix}%`]);
      if (prior.rows[0].count !== 0) throw new Error("Load test accounts already exist in this dedicated database.");
      const state = await tx.query("SELECT instance_epoch FROM server_instance_state WHERE singleton_key='QUICKHACK'");
      if (state.rowCount !== 1) throw new Error("Initialize the dedicated QuickHack server security state first.");
      for (let worker = 0; worker < profile.workerCount; worker += 1) {
        const username = `${prefix}${String(worker + 1).padStart(3, "0")}`;
        const discardedPassword = randomBytes(32).toString("base64url");
        const created = await tx.query(`INSERT INTO users
          (username, password_hash, role, is_active, mobile_packing_enabled, must_change_password)
          VALUES ($1,$2,'STAFF',1,1,0) RETURNING user_id, credential_revision`, [username, await passwordHash(discardedPassword)]);
        const user = created.rows[0];
        await tx.query("INSERT INTO employee_profiles (user_id, display_name) VALUES ($1,$2)", [user.user_id, username]);
        const sessionToken = randomBytes(32).toString("base64url");
        const appInstanceId = randomBytes(16).toString("hex");
        const deviceToken = randomBytes(32).toString("base64url");
        const provisioningToken = randomBytes(32).toString("base64url");
        const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        const spki = publicKey.export({ format: "der", type: "spki" });
        const fingerprint = `sha256:${createHash("sha256").update(spki).digest("base64url")}`;
        await tx.query(`INSERT INTO user_sessions
          (user_id, session_token_hash, expires_at, credential_revision, instance_epoch)
          VALUES ($1,$2,now()+interval '12 hours',$3,$4)`, [user.user_id, createHash("sha256").update(sessionToken).digest("base64url"), user.credential_revision, state.rows[0].instance_epoch]);
        await tx.query(`INSERT INTO mobile_registered_devices
          (user_id, label, adb_serial_hmac, adb_serial_preview, registration_revision, registration_state,
           provisioning_token_hash, provisioning_expires_at, app_instance_id_hash,
           device_public_key_spki, device_public_key_fingerprint, device_token_hash,
           user_credential_revision, instance_epoch, activated_at)
          VALUES ($1,$2,$3,$4,1,'ACTIVE',$5,now()+interval '12 hours',$6,$7,$8,$9,$10,$11,now())`, [
          user.user_id, `Load test virtual device ${worker + 1}`,
          mobileHash("load-adb-serial", username), `LV-${worker + 1}`,
          mobileHash("provisioning-token", provisioningToken), mobileHash("app-instance", appInstanceId),
          spki.toString("base64"), fingerprint, mobileHash("device-token", deviceToken),
          user.credential_revision, state.rows[0].instance_epoch,
        ]);
        credentials.push({ worker, username, sessionToken, appInstanceId, deviceToken });
      }
    });
    await writeFile(secretsPath, `${JSON.stringify({ schema: "quickhack-load-secrets/v1", runId: profile.runId, credentials })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { database: identity, accountCount: credentials.length, secretsPath };
  } finally { await pool.end(); }
}
