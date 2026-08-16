import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { serverSecretIdentity } from "../../quickhack_server/platform/server-secret-identity.mjs";
import { runSystemdCredentialProcess } from "../../tools/platform/linux/systemd-credential-process.mjs";
import {
  createSystemdCredentialProvisioner,
  systemdCredentialCiphertextPath,
  SYSTEMD_PERSISTENT_HOST_KEY_PATH,
} from "../../tools/platform/linux/systemd-credential-provisioner.mjs";

function spawnFixture({ code = 0, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0) }) {
  return function spawnProcess(file, args, options) {
    assert.equal(file, "/usr/bin/systemd-creds");
    assert.equal(options.shell, false);
    assert.deepEqual(Object.keys(options.env).sort(), ["LANG", "LC_ALL", "PATH"]);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit("close", code, null);
    });
    return child;
  };
}

assert.equal(
  (
    await runSystemdCredentialProcess(["--version"], {
      spawnProcess: spawnFixture({ stdout: Buffer.from("systemd 255\n") }),
      environment: {},
    })
  ).toString("utf8"),
  "systemd 255\n"
);
await assert.rejects(
  () =>
    runSystemdCredentialProcess(["encrypt"], {
      spawnProcess: spawnFixture({ code: 1, stderr: Buffer.from("secret-value") }),
      environment: {},
    }),
  (error) =>
    error.code === "SYSTEMD_CREDS_EXIT" &&
    !error.message.includes("secret-value")
);

function memoryFileSystem() {
  const files = new Map([[SYSTEMD_PERSISTENT_HOST_KEY_PATH, Buffer.from("host")]]);
  return {
    files,
    async lstat(target) {
      if (target === "/var/lib/quickhack/security") {
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
          size: 0,
          uid: 0,
        };
      }
      if (!files.has(target)) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      const value = files.get(target);
      return {
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        size: value.length,
        uid: 0,
      };
    },
    async mkdir() {},
    async chmod() {},
    async open(target, flags) {
      if (flags === "wx" && files.has(target)) {
        const error = new Error("exists");
        error.code = "EEXIST";
        throw error;
      }
      let payload = Buffer.alloc(0);
      return {
        async writeFile(value) { payload = Buffer.from(value); },
        async sync() {},
        async close() { files.set(target, payload); },
      };
    },
    async link(source, target) {
      if (files.has(target)) {
        const error = new Error("exists");
        error.code = "EEXIST";
        throw error;
      }
      files.set(target, Buffer.from(files.get(source)));
    },
    async rename(source, target) {
      files.set(target, files.get(source));
      files.delete(source);
    },
    async rm(target) { files.delete(target); },
  };
}

const fileSystem = memoryFileSystem();
const observed = [];
let plaintext;
async function run(args, options = {}) {
  observed.push({ args: [...args], hasInput: Buffer.isBuffer(options.input) });
  if (args[0] === "--version") return Buffer.from("systemd 255 (255.7)\n");
  if (args.includes("--with-key=help")) return Buffer.from("auto host tpm2\n");
  if (args[0] === "has-tpm2") return Buffer.from("no\n");
  if (args[0] === "encrypt") {
    plaintext = Buffer.from(options.input);
    return Buffer.from(Buffer.from("encrypted-fixture").toString("base64"));
  }
  if (args[0] === "decrypt") return Buffer.from(plaintext);
  throw new Error("unexpected command");
}

const provisioner = createSystemdCredentialProvisioner({
  run,
  getuid: () => 0,
  platform: "linux",
  fileSystem,
});
assert.deepEqual(await provisioner.preflight(), {
  version: 255,
  keyMode: "HOST_KEY_ONLY",
});
const identity = serverSecretIdentity({ kind: "BACKUP_MASTER_KEY" });
const secret = Buffer.alloc(32, 9);
const prepared = await provisioner.prepare({ identity, secret });
assert.equal(prepared.state, "PREPARED");
assert.equal(JSON.stringify(prepared).includes(secret.toString("base64")), false);
assert.equal(
  observed.some((item) => item.args.some((arg) => arg.includes(secret.toString("base64")))),
  false
);
const committed = await provisioner.commit(prepared);
assert.equal(committed.state, "COMMITTED_RESTART_REQUIRED");
assert.equal(committed.previousExists, false);
assert.equal(fileSystem.files.has(systemdCredentialCiphertextPath(identity)), true);
assert.deepEqual(await provisioner.rollback(committed), {
  state: "ROLLED_BACK",
  generationId: committed.generationId,
  identityId: identity.id,
});
assert.equal(fileSystem.files.has(systemdCredentialCiphertextPath(identity)), false);

const targetPath = systemdCredentialCiphertextPath(identity);
fileSystem.files.set(targetPath, Buffer.from("previous-ciphertext"));
const preparedAgain = await provisioner.prepare({ identity, secret });
const committedAgain = await provisioner.commit(preparedAgain);
assert.equal(committedAgain.previousExists, true);
await provisioner.rollback(committedAgain);
assert.equal(
  fileSystem.files.get(targetPath).toString("utf8"),
  "previous-ciphertext"
);

const failingProvisioner = createSystemdCredentialProvisioner({
  run,
  getuid: () => 0,
  platform: "linux",
  fileSystem: {
    ...fileSystem,
    async open() {
      throw new Error("fixture write failure");
    },
  },
});
await assert.rejects(() => failingProvisioner.prepare({ identity, secret }));
assert.equal(
  fileSystem.files.get(targetPath).toString("utf8"),
  "previous-ciphertext"
);
assert.equal(
  [...fileSystem.files.keys()].some((value) => value.endsWith(".prepared")),
  false
);

const preparedActive = await provisioner.prepare({ identity, secret });
const committedActive = await provisioner.commit(preparedActive);
assert.deepEqual(await provisioner.activate(committedActive), {
  state: "ACTIVE",
  generationId: committedActive.generationId,
  identityId: identity.id,
});

const nonRoot = createSystemdCredentialProvisioner({
  run,
  getuid: () => 1000,
  platform: "linux",
  fileSystem,
});
await assert.rejects(
  () => nonRoot.preflight(),
  (error) => error.code === "SYSTEMD_CREDENTIAL_ROOT_REQUIRED"
);

secret.fill(0);
plaintext.fill(0);
console.log("Privileged systemd credential process, preflight, atomic rotation, and rollback verified.");
