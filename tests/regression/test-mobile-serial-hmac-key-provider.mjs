import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestServerSecretProtector } from "../support/server-secret-protector-fixture.mjs";

const { MobileSerialHmacKeyProvider } = await import(
  "@/quickhack_server/security/mobile-serial-hmac-key-provider"
);

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "qh-mobile-hmac-"));
const protect = async (value) => Buffer.from(value.map((byte) => byte ^ 0xa5));
const unprotect = protect;
const ensureDirectory = (directory) => fs.mkdir(directory, { recursive: true });
const secretProtector = createTestServerSecretProtector({
  transform: protect,
  restore: unprotect,
  ensureDirectory,
});

try {
  const provider = new MobileSerialHmacKeyProvider({
    dataDir,
    production: true,
    liveRegistrationCount: async () => 0,
    randomBytes: () => Buffer.alloc(32, 0x51),
    secretProtector,
  });
  const first = await provider.withKey((key) => key.toString("hex"));
  assert.equal(first, Buffer.alloc(32, 0x51).toString("hex"));

  const reloaded = new MobileSerialHmacKeyProvider({
    dataDir,
    production: true,
    liveRegistrationCount: async () => 1,
    secretProtector,
  });
  assert.equal(await reloaded.withKey((key) => key.toString("hex")), first);

  const missingDir = path.join(dataDir, "missing-live-key");
  const missing = new MobileSerialHmacKeyProvider({
    dataDir: missingDir,
    production: true,
    liveRegistrationCount: async () => 1,
    secretProtector,
  });
  await assert.rejects(
    () => missing.withKey(() => undefined),
    (error) => error?.status === 503 && error?.code === "MOBILE_SERIAL_KEY_UNAVAILABLE"
  );
  assert.equal(
    await fs.stat(path.join(missingDir, "security", "mobile-device", "serial-hmac.key")).then(
      () => true,
      () => false
    ),
    false,
    "A live registration silently created a replacement serial key."
  );

  const corruptDir = path.join(dataDir, "corrupt-cleared-key");
  const corruptPath = path.join(
    corruptDir,
    "security",
    "mobile-device",
    "serial-hmac.key"
  );
  await fs.mkdir(path.dirname(corruptPath), { recursive: true });
  await fs.writeFile(corruptPath, "not-a-mobile-key", { mode: 0o600 });
  const recovered = new MobileSerialHmacKeyProvider({
    dataDir: corruptDir,
    production: true,
    liveRegistrationCount: async () => 0,
    randomBytes: () => Buffer.alloc(32, 0x52),
    secretProtector,
  });
  assert.equal(
    await recovered.withKey((key) => key.toString("hex")),
    Buffer.alloc(32, 0x52).toString("hex")
  );
  assert.equal(
    (await fs.readdir(path.dirname(corruptPath))).some((name) =>
      name.startsWith("serial-hmac.key.unusable.")
    ),
    true,
    "A corrupt key was overwritten instead of quarantined after every live registration was revoked."
  );

  const linuxProduction = new MobileSerialHmacKeyProvider({
    dataDir: path.join(dataDir, "linux-production"),
    production: true,
    liveRegistrationCount: async () => 0,
    secretProtector: createTestServerSecretProtector({
      state: "UNAVAILABLE",
    }),
  });
  await assert.rejects(
    () => linuxProduction.withKey(() => undefined),
    (error) => error?.status === 503 && error?.code === "MOBILE_SERIAL_KEY_UNAVAILABLE"
  );

  console.log(
    "Mobile serial HMAC v2 persistence, fail-closed live-row handling, and Linux production boundary verified."
  );
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}
