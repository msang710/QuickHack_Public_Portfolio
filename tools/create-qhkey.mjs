import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import {
  createEncryptedQhkey,
  writeQhkeyFile,
} from "../quickhack_server/security/qhkey-format.mjs";
import {
  getQhkeyMasterKeyFileProtection,
  readQhkeyMasterKeyFile,
  writeQhkeyMasterKeyFile,
} from "../quickhack_server/security/qhkey-master-key-provider.mjs";
import { issueMockCoupangCredential } from "./mock-coupang-credential-client.mjs";
import { serverRuntimeConfigService as runtimeConfigService } from "../quickhack_server/platform/server-runtime.ts";

const UTF8 = "utf8";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function hasArg(name) {
  return process.argv.includes(name);
}

function dataDir() {
  return runtimeConfigService.read().paths.dataDir;
}

function defaultQhkeyRoot() {
  return path.join(dataDir(), "qhkey");
}

function defaultMasterKeyFile() {
  return path.join(dataDir(), "security", "qhkey-master.key");
}

function absolutePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function required(value, label) {
  const text = String(value || "").trim();

  if (!text) {
    throw new Error(`${label} is required.`);
  }

  return text;
}

function loadOrCreateMasterKey(filePath, force, protection) {
  try {
    if (getQhkeyMasterKeyFileProtection(filePath) === "SYSTEMD_CREDENTIAL") {
      return readQhkeyMasterKeyFile(filePath);
    }
  } catch {
    // File-backed providers still need to create their first key below.
  }
  if (fs.existsSync(filePath)) {
    return readQhkeyMasterKeyFile(filePath);
  }

  writeQhkeyMasterKeyFile(filePath, force, { protection });
  return readQhkeyMasterKeyFile(filePath);
}

async function visiblePrompt(rl, label, defaultValue = "") {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const answer = String(await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function hiddenPrompt(label) {
  if (!process.stdin.isTTY) {
    throw new Error(`${label} must be entered from an interactive terminal.`);
  }

  return new Promise((resolve) => {
    let value = "";
    process.stdout.write(`${label}: `);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding(UTF8);

    const onData = (chunk) => {
      const char = String(chunk);

      if (char === "\r" || char === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off("data", onData);
        process.stdout.write("\n");
        resolve(value);
        return;
      }

      if (char === "\u0003") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off("data", onData);
        process.stdout.write("\n");
        process.exit(130);
      }

      if (char === "\b" || char === "\u007f") {
        value = value.slice(0, -1);
        return;
      }

      value += char;
    };

    process.stdin.on("data", onData);
  });
}

function coupangKeyDateRange(expiresOn, now = new Date()) {
  const value = required(expiresOn, "WING expiresOn");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    throw new Error("WING expiresOn must use YYYY-MM-DD format.");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));

  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    throw new Error("WING expiresOn is not a valid date.");
  }

  const expiresAt = new Date(calendarDate.getTime() - 9 * 3_600_000);
  const issuedAt = new Date(expiresAt.getTime() - 180 * 86_400_000);

  if (expiresAt.getTime() <= now.getTime()) {
    throw new Error("WING expiresOn is already past.");
  }

  if (issuedAt.getTime() > now.getTime() + 86_400_000) {
    throw new Error("WING expiresOn is more than 180 days in the future.");
  }

  return {
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

async function main() {
  const force = hasArg("--force");
  const runtimeConfig = runtimeConfigService.read();
  const qhkeyRoot = absolutePath(required(argValue("--root"), "--root"));
  const outputFile = absolutePath(
    argValue("--out") ||
      path.join(qhkeyRoot, "quickhack-keys", "coupang.qhkey")
  );
  const masterKeyFile = absolutePath(
    argValue("--master-key") ||
      defaultMasterKeyFile()
  );
  const masterKeyProtection =
    argValue("--master-key-protection") ||
    "AUTO";
  const now = new Date();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const environment = await visiblePrompt(
      rl,
      "environment",
      argValue("--environment") || runtimeConfig.endpoints.coupang.mode
    );
    const keyAlias = await visiblePrompt(
      rl,
      "key alias",
      argValue("--alias") || `coupang-${environment}`
    );
    let credential;

    if (environment.toLowerCase() === "mock") {
      credential = await issueMockCoupangCredential({
        baseUrl: argValue("--mock-server-url") || "http://127.0.0.1:3100",
      });
      console.log("Mock server issued a new Coupang credential.");
    } else {
      const vendorId = await visiblePrompt(
        rl,
        "Coupang vendorId",
        argValue("--vendor-id") || ""
      );
      const accessKey = await visiblePrompt(
        rl,
        "Coupang accessKey",
        argValue("--access-key") || ""
      );
      const expiresOn = await visiblePrompt(
        rl,
        "WING expiration date (YYYY-MM-DD)",
        argValue("--expires-on") || ""
      );
      const keyDateRange = coupangKeyDateRange(expiresOn, now);

      rl.pause();
      credential = {
        vendorId,
        accessKey,
        secretKey: required(await hiddenPrompt("Coupang secretKey"), "secretKey"),
        issuedAt: argValue("--issued-at") || keyDateRange.issuedAt,
        expiresAt: argValue("--expires-at") || keyDateRange.expiresAt,
      };
    }

    const masterKey = loadOrCreateMasterKey(masterKeyFile, force, masterKeyProtection);
    try {
      const qhkey = createEncryptedQhkey({
        masterKey,
        credentialKind: "COUPANG_OPEN_API",
        environment,
        keyAlias,
        credential: {
          vendorId: credential.vendorId,
          accessKey: credential.accessKey,
          secretKey: credential.secretKey,
        },
        issuedAt: credential.issuedAt,
        expiresAt: credential.expiresAt,
      });

      writeQhkeyFile(outputFile, qhkey.buffer, force);

      console.log("QHKEY created.");
      console.log(`file=${outputFile}`);
      console.log(`masterKeyFile=${masterKeyFile}`);
      console.log(`masterKeyProtection=${getQhkeyMasterKeyFileProtection(masterKeyFile)}`);
      console.log(`alias=${qhkey.metadata.keyAlias}`);
      console.log(`fingerprint=${qhkey.metadata.keyFingerprint}`);
      console.log(`expiresAt=${qhkey.metadata.expiresAt}`);
    } finally {
      masterKey.fill(0);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
