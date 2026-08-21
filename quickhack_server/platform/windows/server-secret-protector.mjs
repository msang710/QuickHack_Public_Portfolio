import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertServerSecretBuffer,
  assertServerSecretKind,
  createServerSecretProtectionMetadata,
} from "../server-secret-contract.mjs";
import {
  runPowerShellScript,
  runPowerShellScriptSync,
  runWindowsSystemCommand,
  WINDOWS_SECURITY_OPERATION_TIMEOUT_MS,
} from "./security-process.mjs";

const OUTPUT_LIMIT_BYTES = 64 * 1024;
const WINDOWS_COMMAND_OPTIONS = Object.freeze({
  timeoutMs: WINDOWS_SECURITY_OPERATION_TIMEOUT_MS,
  maxOutputBytes: 256 * 1024,
});
const WINDOWS_ACL_REMOVE_BATCH_SIZE = 32;
export const WINDOWS_SERVER_SECRET_SCOPE_ENV =
  "QUICKHACK_WINDOWS_SECRET_SCOPE";
export const WINDOWS_SERVER_SECRET_SCOPES = Object.freeze([
  "CURRENT_USER",
  "LOCAL_MACHINE",
]);

const WINDOWS_SERVER_SECRET_SCOPE_SET = new Set(WINDOWS_SERVER_SECRET_SCOPES);

export function resolveWindowsServerSecretScope(value) {
  const scope = String(value ?? "CURRENT_USER").trim().toUpperCase();
  if (!WINDOWS_SERVER_SECRET_SCOPE_SET.has(scope)) {
    throw new TypeError("Unsupported Windows server secret identity scope.");
  }
  return scope;
}

function scopeContract(value) {
  const scope = resolveWindowsServerSecretScope(value);
  return Object.freeze({
    scope,
    dpapiScope: scope === "LOCAL_MACHINE" ? "LocalMachine" : "CurrentUser",
    includeNetworkService: scope === "LOCAL_MACHINE",
    metadata: createServerSecretProtectionMetadata({
      protection: scope === "LOCAL_MACHINE"
        ? "WINDOWS_DPAPI_LOCAL_MACHINE"
        : "WINDOWS_DPAPI_CURRENT_USER",
      identityScope: scope === "LOCAL_MACHINE"
        ? "LOCAL_WINDOWS_MACHINE"
        : "CURRENT_WINDOWS_USER",
      portable: false,
      formatVersion: 1,
      lifecycle: "OPAQUE_PAYLOAD",
    }),
  });
}

function dpapiScript(operation, dpapiScope) {
  const method = operation === "PROTECT" ? "Protect" : "Unprotect";
  const result = operation === "PROTECT" ? "protected" : "plain";
  return (
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
    "$inputText=[Console]::In.ReadLine(); " +
    "$bytes=[Convert]::FromBase64String($inputText); " +
    `$${result}=[System.Security.Cryptography.ProtectedData]::${method}($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::${dpapiScope}); ` +
    `[Convert]::ToBase64String($${result})`
  );
}

export const windowsServerSecretProtectionMetadata =
  scopeContract("CURRENT_USER").metadata;
export const windowsMachineServerSecretProtectionMetadata =
  scopeContract("LOCAL_MACHINE").metadata;

function decodeStrictBase64(value, label) {
  const normalized = String(value ?? "").trim();
  if (
    !normalized ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      normalized
    )
  ) {
    throw new Error(`${label} returned an invalid base64 payload.`);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    decoded.fill(0);
    throw new Error(`${label} returned a non-canonical base64 payload.`);
  }
  return decoded;
}

function normalizedAclPrincipal(value, currentSid) {
  const principal = String(value).toUpperCase();
  const normalizedCurrentSid = String(currentSid ?? "").toUpperCase();
  if (
    normalizedCurrentSid.endsWith("-500") &&
    (principal === "LA" || principal === normalizedCurrentSid)
  ) {
    return "LA";
  }
  if (principal === "S-1-5-18") return "SY";
  if (principal === "S-1-5-20") return "NS";
  if (principal === "S-1-5-32-544") return "BA";
  return principal;
}

function hasProtectedDaclControl(source) {
  if (!source.startsWith("D:")) return false;
  let remaining = source.slice(2);
  const observed = new Set();
  while (remaining) {
    const flag = ["AR", "AI", "P"].find((candidate) =>
      remaining.startsWith(candidate)
    );
    if (!flag || observed.has(flag)) return false;
    observed.add(flag);
    remaining = remaining.slice(flag.length);
  }
  return observed.has("P");
}

function exactPropagatingFullControlPrincipal(aceSource, currentSid) {
  const fields = aceSource.split(";");
  if (fields.length !== 6) return null;
  const [type, flagSource, rights, objectGuid, inheritedObjectGuid, principal] =
    fields;
  if (
    type !== "A" ||
    rights !== "FA" ||
    objectGuid ||
    inheritedObjectGuid ||
    !principal ||
    flagSource.length % 2 !== 0
  ) {
    return null;
  }
  const flags = [];
  for (let index = 0; index < flagSource.length; index += 2) {
    flags.push(flagSource.slice(index, index + 2));
  }
  if (flags.length !== 2 || !flags.includes("OI") || !flags.includes("CI")) {
    return null;
  }
  return normalizedAclPrincipal(principal, currentSid);
}

function assertExactDirectoryAcl(source, expectedPrincipals, currentSid) {
  const lines = String(source).replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const sddl = String(lines[1] ?? "").trim();
  const firstAceIndex = sddl.indexOf("(");
  const daclControl = firstAceIndex < 0 ? sddl : sddl.slice(0, firstAceIndex);
  const aceSection = firstAceIndex < 0 ? "" : sddl.slice(firstAceIndex);
  const principals = [];
  let consumedAceSection = "";
  let invalidAce = false;
  for (const match of aceSection.matchAll(/\(([^()]*)\)/gu)) {
    consumedAceSection += match[0];
    const principal = exactPropagatingFullControlPrincipal(match[1], currentSid);
    if (!principal) invalidAce = true;
    else principals.push(principal);
  }
  const expected = new Set(
    expectedPrincipals.map((principal) =>
      normalizedAclPrincipal(principal, currentSid)
    )
  );
  if (
    !hasProtectedDaclControl(daclControl) ||
    consumedAceSection !== aceSection ||
    invalidAce ||
    principals.length !== expected.size ||
    principals.some((principal) => !expected.has(principal))
  ) {
    throw new Error(
      "The Windows directory ACL contains an unexpected access rule or control flag " +
        `(control=${daclControl || "missing"}; principals=${principals.join(",") || "none"}).`
    );
  }
}

function aclPrincipalsFromIcaclsOutput(source, resolvedPath) {
  const principals = new Set();
  const normalizedPath = resolvedPath.toLowerCase();
  for (const line of String(source).split(/\r?\n/u)) {
    const permissionSeparator = line.indexOf(":(");
    if (permissionSeparator < 0) continue;
    let principal = line.slice(0, permissionSeparator).trim();
    if (principal.toLowerCase().startsWith(normalizedPath)) {
      principal = principal.slice(resolvedPath.length).trim();
    }
    if (principal) principals.add(principal);
  }
  return [...principals];
}

function isCurrentWindowsPrincipal(principal, identity) {
  const normalized = principal.replace(/^\*/u, "").toLowerCase();
  return (
    normalized === identity.accountName.toLowerCase() ||
    normalized === identity.sid.toLowerCase()
  );
}

export function createWindowsServerSecretProtector(options = {}) {
  const runCommand = options.runCommand ?? runWindowsSystemCommand;
  const runScript = options.runScript ?? runPowerShellScript;
  const runScriptSync = options.runScriptSync ?? runPowerShellScriptSync;
  const platform = options.platform ?? process.platform;
  const contract = scopeContract(options.scope);
  const protectScript = dpapiScript("PROTECT", contract.dpapiScope);
  const unprotectScript = dpapiScript("UNPROTECT", contract.dpapiScope);
  const secretDirectoryInitializations = new Map();
  let currentWindowsIdentityPromise;

  function requireWindows() {
    if (platform !== "win32") {
      throw new Error("Windows DPAPI server secret storage is unavailable.");
    }
  }

  async function currentWindowsIdentity() {
    currentWindowsIdentityPromise ??= runCommand(
      "whoami",
      ["/user", "/fo", "csv", "/nh"],
      WINDOWS_COMMAND_OPTIONS
    ).then((output) => {
      const match = String(output).match(
        /^"((?:[^"]|"")*)","(S-\d(?:-\d+)+)"\s*$/u
      );
      if (!match) throw new Error("whoami.exe returned an invalid Windows SID.");
      return { accountName: match[1].replaceAll('""', '"'), sid: match[2] };
    });
    currentWindowsIdentityPromise.catch(() => {
      currentWindowsIdentityPromise = undefined;
    });
    return currentWindowsIdentityPromise;
  }

  async function removeNonOwnerAclPrincipals(resolvedPath, identity) {
    const output = await runCommand(
      "icacls",
      [resolvedPath],
      WINDOWS_COMMAND_OPTIONS
    );
    const principals = aclPrincipalsFromIcaclsOutput(output, resolvedPath).filter(
      (principal) => !isCurrentWindowsPrincipal(principal, identity)
    );
    for (
      let index = 0;
      index < principals.length;
      index += WINDOWS_ACL_REMOVE_BATCH_SIZE
    ) {
      await runCommand(
        "icacls",
        [
          resolvedPath,
          "/remove",
          ...principals.slice(index, index + WINDOWS_ACL_REMOVE_BATCH_SIZE),
          "/c",
        ],
        WINDOWS_COMMAND_OPTIONS
      );
    }
  }

  async function secureDirectoryAcl(
    directoryPath,
    { includeNetworkService = false } = {}
  ) {
    requireWindows();
    const resolvedPath = path.resolve(directoryPath);
    await fs.mkdir(resolvedPath, { recursive: true, mode: 0o700 });
    const identity = await currentWindowsIdentity();
    const currentSid = identity.sid;
    const expectedPrincipals = [
      ...new Set([
        currentSid,
        "S-1-5-18",
        ...(includeNetworkService ? ["S-1-5-20"] : []),
        "S-1-5-32-544",
      ]),
    ];
    const grants = expectedPrincipals.map(
      (principal) => `*${principal}:(OI)(CI)F`
    );
    const verificationPath = path.join(
      os.tmpdir(),
      `.quickhack-acl-${process.pid}-${randomUUID()}.txt`
    );
    try {
      await runCommand(
        "icacls",
        [resolvedPath, "/inheritance:r", "/c"],
        WINDOWS_COMMAND_OPTIONS
      );
      await runCommand(
        "icacls",
        [resolvedPath, "/remove:d", `*${currentSid}`, "/c"],
        WINDOWS_COMMAND_OPTIONS
      );
      await runCommand(
        "icacls",
        [resolvedPath, "/grant:r", grants[0], "/c"],
        WINDOWS_COMMAND_OPTIONS
      );
      await removeNonOwnerAclPrincipals(resolvedPath, identity);
      await runCommand(
        "icacls",
        [resolvedPath, "/grant:r", ...grants, "/c"],
        WINDOWS_COMMAND_OPTIONS
      );
      await runCommand(
        "icacls",
        [resolvedPath, "/save", verificationPath, "/c"],
        WINDOWS_COMMAND_OPTIONS
      );
      assertExactDirectoryAcl(
        await fs.readFile(verificationPath, "utf16le"),
        expectedPrincipals,
        currentSid
      );
    } finally {
      await fs.rm(verificationPath, { force: true }).catch(() => undefined);
    }
  }

  async function protectBytes(secret) {
    requireWindows();
    assertServerSecretBuffer(secret, "server secret");
    try {
      return decodeStrictBase64(
        await runScript(protectScript, {
          inputLine: secret.toString("base64"),
          timeoutMs: WINDOWS_SECURITY_OPERATION_TIMEOUT_MS,
          timeoutAttempts: 2,
          maxOutputBytes: OUTPUT_LIMIT_BYTES,
        }),
        "Windows DPAPI protection"
      );
    } catch {
      throw new Error("Windows DPAPI could not protect the server-owned secret.");
    }
  }

  async function unprotectBytes(payload) {
    requireWindows();
    assertServerSecretBuffer(payload, "protected server secret");
    try {
      return decodeStrictBase64(
        await runScript(unprotectScript, {
          inputLine: payload.toString("base64"),
          timeoutMs: WINDOWS_SECURITY_OPERATION_TIMEOUT_MS,
          timeoutAttempts: 2,
          maxOutputBytes: OUTPUT_LIMIT_BYTES,
        }),
        "Windows DPAPI unprotection"
      );
    } catch {
      throw new Error(
        `Windows DPAPI could not open the server-owned secret in ${contract.scope} scope.`
      );
    }
  }

  function unprotectBytesSync(payload) {
    requireWindows();
    assertServerSecretBuffer(payload, "protected server secret");
    try {
      return decodeStrictBase64(
        runScriptSync(unprotectScript, {
          inputLine: payload.toString("base64"),
          timeoutMs: WINDOWS_SECURITY_OPERATION_TIMEOUT_MS,
          timeoutAttempts: 2,
          maxOutputBytes: OUTPUT_LIMIT_BYTES,
        }),
        "Windows DPAPI unprotection"
      );
    } catch {
      throw new Error(
        `Windows DPAPI could not open the server-owned secret in ${contract.scope} scope.`
      );
    }
  }

  function ensureDirectory(directoryPath) {
    requireWindows();
    const normalizedPath = path.resolve(directoryPath).toLowerCase();
    const existing = secretDirectoryInitializations.get(normalizedPath);
    if (existing) return existing;
    const initialization = secureDirectoryAcl(directoryPath, {
      includeNetworkService: contract.includeNetworkService,
    }).catch(() => {
      throw new Error(
        "The server could not secure the protected-secret directory ACL."
      );
    });
    secretDirectoryInitializations.set(normalizedPath, initialization);
    initialization.catch(() => {
      if (secretDirectoryInitializations.get(normalizedPath) === initialization) {
        secretDirectoryInitializations.delete(normalizedPath);
      }
    });
    return initialization;
  }

  const protector = Object.freeze({
    descriptor: Object.freeze({
      id: "server-secret-protector",
      role: "server",
      platform,
      state: "READY",
      ownerStage: "PR-05",
    }),
    metadata: contract.metadata,
    async protect(kind, secret) {
      assertServerSecretKind(kind);
      return protectBytes(secret);
    },
    async unprotect(kind, payload) {
      assertServerSecretKind(kind);
      return unprotectBytes(payload);
    },
    unprotectSync(kind, payload) {
      assertServerSecretKind(kind);
      return unprotectBytesSync(payload);
    },
    async readProvisioned(_identity) {
      throw new Error(
        "Provisioned activation credentials are not used by the Windows server secret provider."
      );
    },
    readProvisionedSync(_identity) {
      throw new Error(
        "Provisioned activation credentials are not used by the Windows server secret provider."
      );
    },
    ensureDirectory,
  });

  return Object.freeze({
    protector,
    protectBytes,
    unprotectBytes,
    unprotectBytesSync,
    secureDirectoryAcl,
    ensureDirectory,
  });
}

const windowsServerSecret = createWindowsServerSecretProtector({
  scope: "CURRENT_USER",
});

export const windowsServerSecretProtector = windowsServerSecret.protector;
export const protectForCurrentWindowsUser = windowsServerSecret.protectBytes;
export const unprotectForCurrentWindowsUser = windowsServerSecret.unprotectBytes;
export const unprotectForCurrentWindowsUserSync =
  windowsServerSecret.unprotectBytesSync;
export const secureWindowsDirectoryAcl = windowsServerSecret.secureDirectoryAcl;
export const ensureCurrentWindowsUserSecretDirectory =
  windowsServerSecret.ensureDirectory;
