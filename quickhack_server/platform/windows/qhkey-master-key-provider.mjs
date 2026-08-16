import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { normalizeQhkeyMasterKey } from "../../security/qhkey-format.mjs";
import { createWindowsSecurityProcess } from "./security-process.mjs";

const MASTER_FILE_NAME = "qhkey-master.key";
const DPAPI_PREFIX = "QHDPAPI1\n";
const MAX_MASTER_FILE_BYTES = 4096;

function descriptor(platform) {
  return Object.freeze({
    id: "qhkey-master-key-provider",
    role: "server",
    platform,
    state: "COMPATIBILITY",
    ownerStage: "PR-08",
  });
}

function masterFilePath(dataDir) {
  const root = String(dataDir ?? "").trim();
  if (!root || !path.isAbsolute(root)) {
    throw new TypeError("An absolute QuickHack data directory is required.");
  }
  return path.join(path.resolve(root), "security", MASTER_FILE_NAME);
}

function safeReadFileSync(filePath, fileSystem = fs) {
  const stat = fileSystem.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_MASTER_FILE_BYTES) {
    throw new Error("QHKEY master key file is invalid.");
  }
  return fileSystem.readFileSync(filePath);
}

async function safeReadFile(filePath, fileSystem = fsPromises) {
  const stat = await fileSystem.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_MASTER_FILE_BYTES) {
    throw new Error("QHKEY master key file is invalid.");
  }
  return fileSystem.readFile(filePath);
}

function protectionFromPayload(payload) {
  return payload.toString("utf8").trim().startsWith(DPAPI_PREFIX.trim())
    ? "DPAPI"
    : "RAW";
}

function protectedBytes(payload) {
  const text = payload.toString("utf8").trim();
  return Buffer.from(text.slice(DPAPI_PREFIX.trim().length).trim(), "base64");
}

const PROTECT_SCRIPT =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
  "$inputText=[Console]::In.ReadLine(); $bytes=[Convert]::FromBase64String($inputText); " +
  "$protected=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); " +
  "[Convert]::ToBase64String($protected)";
const UNPROTECT_SCRIPT =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
  "$inputText=[Console]::In.ReadLine(); $bytes=[Convert]::FromBase64String($inputText); " +
  "$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); " +
  "[Convert]::ToBase64String($plain)";

function decodeSync(payload, securityProcess) {
  if (protectionFromPayload(payload) === "RAW") {
    return normalizeQhkeyMasterKey(payload);
  }
  const encrypted = protectedBytes(payload);
  try {
    return normalizeQhkeyMasterKey(
      Buffer.from(
        securityProcess.runPowerShellScriptSync(UNPROTECT_SCRIPT, {
          inputLine: encrypted.toString("base64"),
          timeoutMs: 5000,
        }),
        "base64"
      )
    );
  } catch {
    throw new Error(
      "Windows DPAPI operation failed. QHKEY master key files can be read only by the same Windows user account that created them."
    );
  } finally {
    encrypted.fill(0);
  }
}

async function decode(payload, securityProcess) {
  if (protectionFromPayload(payload) === "RAW") {
    return normalizeQhkeyMasterKey(payload);
  }
  const encrypted = protectedBytes(payload);
  try {
    return normalizeQhkeyMasterKey(
      Buffer.from(
        await securityProcess.runPowerShellScript(UNPROTECT_SCRIPT, {
          inputLine: encrypted.toString("base64"),
          timeoutMs: 5000,
        }),
        "base64"
      )
    );
  } catch {
    throw new Error(
      "Windows DPAPI operation failed. QHKEY master key files can be read only by the same Windows user account that created them."
    );
  } finally {
    encrypted.fill(0);
  }
}

function normalizeProtection(value) {
  const normalized = String(value || "DPAPI").trim().toUpperCase();
  if (normalized === "AUTO") return "DPAPI";
  if (normalized !== "DPAPI" && normalized !== "RAW") {
    throw new TypeError("QHKEY master key protection must be DPAPI or RAW.");
  }
  return normalized;
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

export function createWindowsQhkeyMasterKeyProvider(options = {}) {
  const platform = options.platform ?? "win32";
  const fileSystem = options.fileSystem ?? fs;
  const asyncFileSystem = options.asyncFileSystem ?? fsPromises;
  const securityProcess =
    options.securityProcess ?? createWindowsSecurityProcess({ platform });

  function readSync(input) {
    const filePath = input.filePath ?? masterFilePath(input.dataDir);
    const payload = safeReadFileSync(filePath, fileSystem);
    let opened;
    try {
      opened = decodeSync(payload, securityProcess);
      return opened;
    } finally {
      if (opened !== payload) payload.fill(0);
    }
  }

  async function read(input) {
    const filePath = input.filePath ?? masterFilePath(input.dataDir);
    const payload = await safeReadFile(filePath, asyncFileSystem);
    let opened;
    try {
      opened = await decode(payload, securityProcess);
      return opened;
    } finally {
      if (opened !== payload) payload.fill(0);
    }
  }

  function protectionSync(input) {
    const filePath = input.filePath ?? masterFilePath(input.dataDir);
    const payload = safeReadFileSync(filePath, fileSystem);
    try {
      return protectionFromPayload(payload);
    } finally {
      payload.fill(0);
    }
  }

  async function protection(input) {
    const filePath = input.filePath ?? masterFilePath(input.dataDir);
    const payload = await safeReadFile(filePath, asyncFileSystem);
    try {
      return protectionFromPayload(payload);
    } finally {
      payload.fill(0);
    }
  }

  function write(input) {
    const filePath = input.filePath ?? masterFilePath(input.dataDir);
    if (!input.force && fileSystem.existsSync(filePath)) {
      throw new Error(`QHKEY master key already exists: ${filePath}`);
    }
    const masterKey = crypto.randomBytes(32);
    const selectedProtection = normalizeProtection(input.protection);
    let protectedKey;
    let output = masterKey;
    try {
      if (selectedProtection === "DPAPI") {
        protectedKey = Buffer.from(
          securityProcess.runPowerShellScriptSync(PROTECT_SCRIPT, {
            inputLine: masterKey.toString("base64"),
            timeoutMs: 5000,
          }),
          "base64"
        );
        output = Buffer.from(`${DPAPI_PREFIX}${protectedKey.toString("base64")}\n`, "utf8");
      }
      fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
      fileSystem.writeFileSync(filePath, output, {
        mode: 0o600,
        flag: input.force ? "w" : "wx",
      });
    } finally {
      protectedKey?.fill(0);
      if (output !== masterKey) output.fill(0);
      masterKey.fill(0);
    }
  }

  async function status(input) {
    const filePath = input.filePath ?? masterFilePath(input.dataDir);
    try {
      const selectedProtection = await protection({ filePath });
      let warningMessage = null;
      if (input.production && selectedProtection !== "DPAPI") {
        return Object.freeze({
          available: false,
          protection: selectedProtection,
          warningMessage: "Production USB_QHKEY requires protected master key storage.",
          identityToken: `${selectedProtection}:${filePath}`,
          identityPaths: Object.freeze([filePath]),
        });
      }
      if (selectedProtection === "DPAPI") {
        try {
          const output = await securityProcess.runPowerShellScript(
            `$acl=Get-Acl -LiteralPath ${powershellLiteral(filePath)} -ErrorAction Stop; ` +
              '$acl.Access | ForEach-Object { try { $sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid=$_.IdentityReference.Value }; if ($_.AccessControlType -eq \'Allow\') { "${sid}:$($_.FileSystemRights)" } }',
            { timeoutMs: 3000, maxOutputBytes: 128 * 1024 }
          );
          if (/S-1-1-0:|S-1-5-11:|S-1-5-32-545:/u.test(output)) {
            warningMessage = "QHKEY master key file ACL is broader than the current Windows user.";
          }
        } catch {
          warningMessage = "QHKEY master key ACL could not be verified.";
        }
      }
      return Object.freeze({
        available: true,
        protection: selectedProtection,
        warningMessage,
        identityToken: `${selectedProtection}:${filePath}`,
        identityPaths: Object.freeze([filePath]),
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return Object.freeze({
        available: false,
        protection: "MISSING",
        warningMessage: null,
        identityToken: `MISSING:${filePath}`,
        identityPaths: Object.freeze([filePath]),
      });
    }
  }

  async function ensure(input) {
    const filePath = input.filePath ?? masterFilePath(input.dataDir);
    if (!fileSystem.existsSync(filePath)) write({ ...input, filePath });
    return status({ filePath, production: input.production });
  }

  function importProtectedFile(input) {
    const sourceFile = path.resolve(String(input.sourceFile ?? ""));
    const destinationFile = input.filePath ?? masterFilePath(input.dataDir);
    if (protectionSync({ filePath: sourceFile }) !== "DPAPI") {
      throw new Error("Only a DPAPI-protected QHKEY master key can be imported.");
    }
    fileSystem.mkdirSync(path.dirname(destinationFile), { recursive: true });
    fileSystem.copyFileSync(
      sourceFile,
      destinationFile,
      input.force ? 0 : fileSystem.constants.COPYFILE_EXCL
    );
    return destinationFile;
  }

  return Object.freeze({
    descriptor: descriptor(platform),
    masterFilePath,
    read,
    readSync,
    protection,
    protectionSync,
    write,
    status,
    ensure,
    importProtectedFile,
  });
}
