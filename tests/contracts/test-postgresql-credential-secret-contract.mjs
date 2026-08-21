import assert from "node:assert/strict";
import { protectedPostgresqlCredentialFile } from "../../quickhack_server/core/database/postgresql-credential.mjs";
import { createTestServerSecretProtector } from "../support/server-secret-protector-fixture.mjs";

const marker = Buffer.from("POSTGRESQL-TEST-PROTECTION:", "utf8");
let observedKind = null;
const secretProtector = createTestServerSecretProtector({
  transform(secret, kind) {
    observedKind = kind;
    return Buffer.concat([marker, secret]);
  },
});
const password = Buffer.from("not-a-real-password", "utf8");
const filePayload = await protectedPostgresqlCredentialFile(
  password,
  secretProtector
);
const machineProtector = createTestServerSecretProtector({
  protection: "WINDOWS_DPAPI_LOCAL_MACHINE",
  identityScope: "LOCAL_WINDOWS_MACHINE",
  transform(secret) {
    return Buffer.concat([marker, secret]);
  },
});
const machinePassword = Buffer.from("not-a-real-machine-password", "utf8");
const machineFilePayload = await protectedPostgresqlCredentialFile(
  machinePassword,
  machineProtector
);

try {
  assert.equal(observedKind, "POSTGRESQL_CREDENTIAL");
  assert.match(filePayload.toString("utf8"), /^QHPG1\nDPAPI_CURRENT_USER\n/u);
  assert.equal(filePayload.includes(password), false);
  assert.equal(filePayload.toString("utf8").endsWith("\n"), true);
  assert.match(
    machineFilePayload.toString("utf8"),
    /^QHPG1\nDPAPI_LOCAL_MACHINE\n/u
  );
  assert.equal(machineFilePayload.includes(machinePassword), false);
} finally {
  password.fill(0);
  filePayload.fill(0);
  machinePassword.fill(0);
  machineFilePayload.fill(0);
}

console.log("PostgreSQL credential protection kind and persisted prefix verified.");
