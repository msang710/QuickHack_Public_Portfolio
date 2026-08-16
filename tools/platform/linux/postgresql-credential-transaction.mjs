import { randomBytes } from "node:crypto";
import { createServerSecretIdentityManifest } from "../../../quickhack_server/platform/server-secret-identity.mjs";

function generatedPassword() {
  return Buffer.from(randomBytes(32).toString("base64url"), "utf8");
}

function secretToken(publicFields, passwords) {
  const token = { ...publicFields };
  Object.defineProperty(token, "passwords", {
    value: passwords,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(token);
}

export function createLinuxPostgresqlCredentialTransaction(options) {
  const provisioner = options?.provisioner;
  const readExisting = options?.readExisting;
  if (!provisioner || typeof readExisting !== "function") {
    throw new TypeError("Linux PostgreSQL credential transaction dependencies are required.");
  }

  async function prepare(runtimeConfig) {
    const manifest = createServerSecretIdentityManifest(runtimeConfig);
    const identities = manifest.identities.filter(
      (identity) => identity.kind === "POSTGRESQL_CREDENTIAL"
    );
    const passwords = new Map();
    const prepared = [];
    try {
      for (const identity of identities) {
        let password = await readExisting(identity);
        if (password !== null && !Buffer.isBuffer(password)) {
          throw new TypeError("Existing PostgreSQL credential readers must return Buffer or null.");
        }
        if (password === null) {
          password = generatedPassword();
          prepared.push(await provisioner.prepare({ identity, secret: password }));
        }
        if (!/^[A-Za-z0-9_-]{43}$/u.test(password.toString("utf8"))) {
          password.fill(0);
          throw new Error("A PostgreSQL credential has an invalid password payload.");
        }
        passwords.set(identity.postgresqlRole, password);
      }
      return secretToken(
        {
          state: "PREPARED",
          packageFlavor: manifest.packageFlavor,
          prepared: Object.freeze(prepared),
        },
        passwords
      );
    } catch (error) {
      await Promise.allSettled(prepared.map((token) => provisioner.discard(token)));
      for (const password of passwords.values()) password.fill(0);
      throw error;
    }
  }

  async function commit(token) {
    if (token?.state !== "PREPARED") throw new TypeError("A prepared credential transaction is required.");
    const committed = [];
    try {
      for (const prepared of token.prepared) {
        committed.push(await provisioner.commit(prepared));
      }
      return secretToken(
        {
          state: "COMMITTED_RESTART_REQUIRED",
          packageFlavor: token.packageFlavor,
          prepared: token.prepared,
          committed: Object.freeze(committed),
        },
        token.passwords
      );
    } catch (error) {
      await Promise.allSettled(committed.reverse().map((item) => provisioner.rollback(item)));
      const committedIds = new Set(committed.map((item) => item.identityId));
      await Promise.allSettled(
        token.prepared
          .filter((item) => !committedIds.has(item.identityId))
          .map((item) => provisioner.discard(item))
      );
      throw error;
    }
  }

  async function activate(token) {
    if (token?.state !== "COMMITTED_RESTART_REQUIRED") {
      throw new TypeError("A committed credential transaction is required.");
    }
    for (const committed of token.committed) await provisioner.activate(committed);
    return secretToken(
      { state: "ACTIVE", packageFlavor: token.packageFlavor },
      token.passwords
    );
  }

  async function rollback(token) {
    if (!token) return;
    if (token.state === "PREPARED") {
      await Promise.allSettled(token.prepared.map((item) => provisioner.discard(item)));
      return;
    }
    if (token.state === "COMMITTED_RESTART_REQUIRED") {
      for (const committed of [...token.committed].reverse()) {
        await provisioner.rollback(committed);
      }
    }
  }

  async function dispose(token) {
    if (!token?.passwords) return;
    for (const password of token.passwords.values()) password.fill(0);
  }

  return Object.freeze({ prepare, commit, activate, rollback, dispose });
}
