import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runPowerShellScript } from "@/quickhack_server/security/async-powershell.mjs";
import {
  ensureCurrentWindowsUserSecretDirectory,
  protectForCurrentWindowsUser,
  secureWindowsDirectoryAcl,
  unprotectForCurrentWindowsUser,
} from "@/quickhack_server/security/windows-user-protected-secret";
import {
  createChildProcessEnvironment,
} from "@/quickhack_shared/core/child-process-environment.mjs";
import {
  createWindowsChildProcessPolicy,
  resolveWindowsSystemExecutable,
} from "@/quickhack_shared/platform/windows/child-process-policy.mjs";
import {
  getClientPrintSpoolPaths,
  initializeClientPrintSpool,
} from "../../../tools/client-print-spool-core.mjs";
import { windowsPrinterBackend } from "../../../quickhack_client/platform/windows/printer-backend.ts";
import { createWindowsQhkeyMasterKeyProvider } from "../../../quickhack_server/platform/windows/qhkey-master-key-provider.mjs";

const EXPECTED_SYSTEM_SID = "S-1-5-18";
const EXPECTED_NETWORK_SERVICE_SID = "S-1-5-20";
const EXPECTED_ADMINISTRATORS_SID = "S-1-5-32-544";
const execFileAsync = promisify(execFile);

async function seedUnexpectedDirectoryAcl(directoryPath) {
  await mkdir(directoryPath, { recursive: true });
  await execFileAsync(
    resolveWindowsSystemExecutable("icacls", process.env),
    [directoryPath, "/grant", "*S-1-1-0:(OI)(CI)R", "/c"],
    {
      env: createChildProcessEnvironment({
        policy: createWindowsChildProcessPolicy(process.env),
        source: process.env,
      }),
      timeout: 10_000,
      windowsHide: true,
    }
  );
}

function stageError(code, error) {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`${code}: ${message}`, { cause: error });

  wrapped.code = code;
  return wrapped;
}

async function runStage(code, operation) {
  try {
    return await operation();
  } catch (error) {
    throw stageError(code, error);
  }
}

async function inspectWindowsDirectoryAcls(directoryPaths) {
  const encodedPaths = Buffer.from(
    JSON.stringify(directoryPaths),
    "utf8"
  ).toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$inputText = [Console]::In.ReadLine()",
    "$pathsJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($inputText))",
    "$parsedPaths = ConvertFrom-Json -InputObject $pathsJson",
    "$paths = @()",
    "foreach ($parsedPath in $parsedPaths) { $paths += [string]$parsedPath }",
    "$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$results = @()",
    "foreach ($path in $paths) {",
    "  $acl = Get-Acl -LiteralPath ([string]$path) -ErrorAction Stop",
    "  $entries = @()",
    "  foreach ($entry in @($acl.Access)) {",
    "    try {",
    "      $sid = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "    } catch {",
    "      $sid = $entry.IdentityReference.Value",
    "    }",
    "    $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl",
    "    $containerInherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit",
    "    $objectInherit = [System.Security.AccessControl.InheritanceFlags]::ObjectInherit",
    "    $entries += [pscustomobject]@{",
    "      sid = $sid",
    "      accessControlType = [string]$entry.AccessControlType",
    "      hasFullControl = (($entry.FileSystemRights -band $fullControl) -eq $fullControl)",
    "      containerInherit = (($entry.InheritanceFlags -band $containerInherit) -eq $containerInherit)",
    "      objectInherit = (($entry.InheritanceFlags -band $objectInherit) -eq $objectInherit)",
    "      isInherited = [bool]$entry.IsInherited",
    "    }",
    "  }",
    "  $results += [pscustomobject]@{",
    "    path = [string]$path",
    "    accessRulesProtected = [bool]$acl.AreAccessRulesProtected",
    "    entries = @($entries)",
    "  }",
    "}",
    "$fileSystem = 'UNKNOWN'",
    "try {",
    "  $root = [IO.Path]::GetPathRoot([string]$paths[0])",
    "  if ($root) {",
    "    $drive = [System.IO.DriveInfo]::new($root)",
    "    $fileSystem = [string]$drive.DriveFormat",
    "  }",
    "} catch {}",
    "$output = [pscustomobject]@{",
    "  currentSid = $currentSid",
    "  powershellVersion = $PSVersionTable.PSVersion.ToString()",
    "  windowsVersion = [Environment]::OSVersion.VersionString",
    "  fileSystem = $fileSystem",
    "  directories = @($results)",
    "}",
    "$output | ConvertTo-Json -Depth 8 -Compress",
  ].join("\n");
  const output = await runPowerShellScript(script, {
    inputLine: encodedPaths,
    timeoutMs: 10_000,
    maxOutputBytes: 256 * 1024,
  });

  return JSON.parse(output);
}

function assertPrivateDirectoryAcl(directory, expectedSids) {
  assert.equal(
    directory.accessRulesProtected,
    true,
    `${directory.path} still inherits access rules.`
  );
  assert.equal(
    directory.entries.length,
    expectedSids.size,
    `${directory.path} has an unexpected number of ACL entries.`
  );

  const observedSids = new Set();

  for (const entry of directory.entries) {
    assert.equal(
      entry.accessControlType,
      "Allow",
      `${directory.path} contains a non-Allow ACL entry.`
    );
    assert.equal(
      expectedSids.has(entry.sid),
      true,
      `${directory.path} grants access to unexpected SID ${entry.sid}.`
    );
    assert.equal(
      entry.hasFullControl,
      true,
      `${directory.path} does not grant FullControl to ${entry.sid}.`
    );
    assert.equal(
      entry.containerInherit,
      true,
      `${directory.path} does not propagate to child directories for ${entry.sid}.`
    );
    assert.equal(
      entry.objectInherit,
      true,
      `${directory.path} does not propagate to child files for ${entry.sid}.`
    );
    assert.equal(
      entry.isInherited,
      false,
      `${directory.path} contains an inherited entry for ${entry.sid}.`
    );
    observedSids.add(entry.sid);
  }

  assert.deepEqual(observedSids, expectedSids);
}

async function runWindowsSecurityIntegration() {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "quickhack-windows-security-integration-")
  );
  const otpDirectory = path.join(temporaryRoot, "otp", "security");
  const serviceDirectory = path.join(temporaryRoot, "postgresql", "18");
  const clientDataDir = path.join(temporaryRoot, "client");
  const qhkeyDataDir = path.join(temporaryRoot, "qhkey");
  let plainSecret = null;
  let protectedSecret = null;
  let unprotectedSecret = null;

  try {
    await runStage("WINDOWS_SECURITY_CAPABILITY_FAILED", async () => {
      const output = await runPowerShellScript(
        "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        { timeoutMs: 5_000, maxOutputBytes: 16 * 1024 }
      );

      assert.match(output, /^S-\d(?:-\d+)+$/);
    });

    await runStage("WINDOWS_DPAPI_ROUNDTRIP_FAILED", async () => {
      plainSecret = crypto.randomBytes(32);
      protectedSecret = await protectForCurrentWindowsUser(plainSecret);
      assert.equal(
        protectedSecret.equals(plainSecret),
        false,
        "Windows DPAPI returned the plaintext secret."
      );
      unprotectedSecret = await unprotectForCurrentWindowsUser(protectedSecret);
      assert.equal(
        unprotectedSecret.equals(plainSecret),
        true,
        "Windows DPAPI did not recover the original secret."
      );
    });

    await runStage("WINDOWS_QHKEY_DPAPI_ROUNDTRIP_FAILED", async () => {
      const provider = createWindowsQhkeyMasterKeyProvider({ platform: "win32" });
      provider.write({ dataDir: qhkeyDataDir, protection: "DPAPI" });
      const masterFile = provider.masterFilePath(qhkeyDataDir);
      const protectedPayload = await readFile(masterFile, "utf8");
      assert.match(protectedPayload, /^QHDPAPI1\n[A-Za-z0-9+/]+=*\n$/u);
      const opened = await provider.read({ dataDir: qhkeyDataDir });
      try {
        assert.equal(opened.length, 32);
        assert.equal((await provider.status({ dataDir: qhkeyDataDir, production: true })).available, true);
      } finally {
        opened.fill(0);
      }
    });

    await runStage("OTP_DIRECTORY_ACL_FAILED", async () => {
      await seedUnexpectedDirectoryAcl(otpDirectory);
      await ensureCurrentWindowsUserSecretDirectory(otpDirectory);
    });
    await runStage("POSTGRESQL_DIRECTORY_ACL_FAILED", async () => {
      await seedUnexpectedDirectoryAcl(serviceDirectory);
      await secureWindowsDirectoryAcl(serviceDirectory, {
        includeNetworkService: true,
      });
    });

    const spoolPaths = getClientPrintSpoolPaths({ clientDataDir });
    await runStage("PRINT_SPOOL_ACL_FAILED", () =>
      initializeClientPrintSpool({
        clientDataDir,
        platform: "win32",
        applyWindowsAcl: (directory) =>
          windowsPrinterBackend.secureSpoolDirectory({
            appRoot: process.cwd(),
            runtimeDir: path.join(process.cwd(), "runtime"),
            environment: process.env,
            directory,
          }),
      })
    );
    const inspected = await runStage("ACL_POSTCONDITION_FAILED", () =>
      inspectWindowsDirectoryAcls([
        otpDirectory,
        spoolPaths.spoolDir,
        spoolPaths.recoveryDir,
        spoolPaths.recoveryIndexDir,
        serviceDirectory,
      ])
    );
    const expectedSids = new Set([
      inspected.currentSid,
      EXPECTED_SYSTEM_SID,
      EXPECTED_ADMINISTRATORS_SID,
    ]);

    await runStage("ACL_POSTCONDITION_FAILED", async () => {
      assert.equal(inspected.directories.length, 5);
      for (const directory of inspected.directories.slice(0, 4)) {
        assertPrivateDirectoryAcl(directory, expectedSids);
      }
      assertPrivateDirectoryAcl(
        inspected.directories[4],
        new Set([...expectedSids, EXPECTED_NETWORK_SERVICE_SID])
      );
    });

    console.log(
      [
        "Windows DPAPI and private-directory ACL integration verified.",
        `windows=${inspected.windowsVersion}`,
        `powershell=${inspected.powershellVersion}`,
        `filesystem=${inspected.fileSystem}`,
        `currentSid=${inspected.currentSid}`,
        `paths=${inspected.directories.map((item) => item.path).join(",")}`,
      ].join(" ")
    );
  } finally {
    plainSecret?.fill(0);
    protectedSecret?.fill(0);
    unprotectedSecret?.fill(0);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  console.log("NON_APPLICABLE: Windows security integration requires Windows.");
} else {
  await runWindowsSecurityIntegration();
}
