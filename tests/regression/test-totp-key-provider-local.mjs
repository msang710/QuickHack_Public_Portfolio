import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestServerSecretProtector } from "../support/server-secret-protector-fixture.mjs";

const { TotpKeyProvider } = await import(
  "@/quickhack_server/security/totp-key-provider"
);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "qh-totp-local-"));
const marker = Buffer.from("LOCAL-PROTECT:", "utf8");
const secretProtector = createTestServerSecretProtector({
  transform(secret) {
    return Buffer.concat([marker, secret]);
  },
  restore(payload) {
    if (!payload.subarray(0, marker.length).equals(marker)) {
      throw new Error("Unexpected local protection marker.");
    }
    return Buffer.from(payload.subarray(marker.length));
  },
  ensureDirectory(directory) {
    return fs.mkdir(directory, { recursive: true });
  },
});

try {
  const first = new TotpKeyProvider({
    dataDir: root,
    credentialCount: async () => 0,
    randomBytes: () => Buffer.alloc(32, 0x5a),
    secretProtector,
  });
  assert.deepEqual(await first.getStatus(), {
    state: "READY",
    configured: true,
    protection: "WINDOWS_DPAPI_CURRENT_USER",
  });
  const firstKey = await first.withKey((key) => Buffer.from(key));
  assert.equal(firstKey.equals(Buffer.alloc(32, 0x5a)), true);
  const source = await fs.readFile(first.keyFilePath(), "utf8");
  assert.match(source, /^QHTOTPKEY1\nDPAPI_CURRENT_USER\n/u);
  assert.equal(source.includes(firstKey.toString("base64")), false);

  const reloaded = new TotpKeyProvider({
    dataDir: root,
    credentialCount: async () => {
      throw new Error("Existing keys must be read before credential counting.");
    },
    secretProtector,
  });
  assert.equal(
    await reloaded.withKey((key) => key.equals(firstKey)),
    true
  );
  firstKey.fill(0);

  const unavailable = new TotpKeyProvider({
    dataDir: path.join(root, "unavailable"),
    credentialCount: async () => 0,
    secretProtector: createTestServerSecretProtector({ state: "UNAVAILABLE" }),
  });
  assert.equal((await unavailable.getStatus()).state, "UNSUPPORTED_PLATFORM");

  console.log(
    "TOTP secret-protector creation, persisted format, reload, and unavailable-adapter behavior verified."
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
