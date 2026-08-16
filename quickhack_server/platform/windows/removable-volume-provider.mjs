import fs from "node:fs";
import path from "node:path";
import {
  QHKEY_PROVIDER_RELATIVE_PATHS,
  QhkeyPlatformError,
  createQhkeyVolumeIdentity,
  sameQhkeyVolumeIdentity,
} from "../qhkey-contract.mjs";
import { createWindowsSecurityProcess } from "./security-process.mjs";

function descriptor(platform, role) {
  return Object.freeze({
    id: "removable-volume-provider",
    role,
    platform,
    state: "COMPATIBILITY",
    ownerStage: "PR-08",
  });
}

function normalizeDriveRoot(value) {
  const text = String(value || "").trim();
  return /^[a-zA-Z]:[\\/]?$/u.test(text)
    ? `${text.slice(0, 2).toUpperCase()}\\`
    : "";
}

function providerPresence(root, fileSystem) {
  const providers = [];
  for (const [provider, relativePath] of Object.entries(QHKEY_PROVIDER_RELATIVE_PATHS)) {
    const filePath = path.join(root, relativePath);
    try {
      const parentPath = path.dirname(filePath);
      const parentStat = fileSystem.lstatSync(parentPath);
      const stat = fileSystem.lstatSync(filePath);
      const realPath = fileSystem.realpathSync(filePath);
      if (
        parentStat.isDirectory() &&
        !parentStat.isSymbolicLink() &&
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        path.resolve(realPath) === path.resolve(filePath)
      ) {
        providers.push(provider);
      }
    } catch {}
  }
  return providers;
}

function volumeError(code, message) {
  return new QhkeyPlatformError(code, message);
}

export function createWindowsRemovableVolumeProvider(options = {}) {
  const platform = options.platform ?? "win32";
  const role = options.role ?? "server";
  const fileSystem = options.fileSystem ?? fs;
  const securityProcess = options.securityProcess ?? createWindowsSecurityProcess({ platform });
  const defaultProduction = options.production ?? false;

  async function nativeSnapshot(production) {
    if (typeof options.discoverSnapshot === "function") {
      return options.discoverSnapshot({ production });
    }
    const output = await securityProcess.runPowerShellScript(
      [
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new()",
        "[System.IO.DriveInfo]::GetDrives() | ForEach-Object {",
        "  if ($_.IsReady -and $_.DriveType -eq [System.IO.DriveType]::Removable) {",
        "    $root=$_.Name",
        "    $label=$_.VolumeLabel",
        "    $definition='using System; using System.Runtime.InteropServices; using System.Text; namespace QuickHack { public static class VolumeInfo { [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetVolumeInformationW(string rootPathName, StringBuilder volumeNameBuffer, int volumeNameSize, out uint volumeSerialNumber, out uint maximumComponentLength, out uint fileSystemFlags, StringBuilder fileSystemNameBuffer, int nFileSystemNameSize); } }'",
        "    Add-Type -TypeDefinition $definition -ErrorAction SilentlyContinue",
        "    $volumeName=New-Object System.Text.StringBuilder 261; $filesystem=New-Object System.Text.StringBuilder 261",
        "    [uint32]$serial=0; [uint32]$maxComponent=0; [uint32]$flags=0",
        "    $ok=[QuickHack.VolumeInfo]::GetVolumeInformationW($root,$volumeName,$volumeName.Capacity,[ref]$serial,[ref]$maxComponent,[ref]$flags,$filesystem,$filesystem.Capacity)",
        "    if ($ok) {",
        production
          ? "      try { $bitlocker=[string](Get-BitLockerVolume -MountPoint $root.Substring(0,2) -ErrorAction Stop).ProtectionStatus } catch { $bitlocker='Unknown' }"
          : "      $bitlocker='NOT_REQUIRED'",
        "      [pscustomobject]@{root=$root;label=$label;serial=('{0:X8}' -f $serial);filesystem=$filesystem.ToString();bitlocker=$bitlocker;readOnly=$_.DriveFormat -eq $null}",
        "    }",
        "  }",
        "} | ConvertTo-Json -Compress",
      ].join("\n"),
      { timeoutMs: 5000, maxOutputBytes: 256 * 1024 }
    );
    if (!output.trim()) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  async function list(input = {}) {
    const production = input.production ?? defaultProduction;
    let snapshot;
    try {
      snapshot = await nativeSnapshot(production);
    } catch {
      return Object.freeze([]);
    }
    const identities = [];
    for (const candidate of snapshot) {
      const root = normalizeDriveRoot(candidate.root);
      const serial = String(candidate.serial ?? "").trim().toUpperCase();
      if (!root || !/^[A-F0-9]{8}$/u.test(serial)) continue;
      if (production && String(candidate.bitlocker ?? "") !== "On") continue;
      identities.push(
        createQhkeyVolumeIdentity({
          platform: "win32",
          volumeId: `WIN-${serial}`,
          rootPath: root,
          deviceId: root.slice(0, 2),
          fileSystemUuid: serial,
          label: candidate.label,
          readOnly: Boolean(candidate.readOnly),
          providers: providerPresence(root, fileSystem),
        })
      );
    }
    return Object.freeze(identities);
  }

  async function locate(input = {}) {
    const volumes = await list(input);
    let candidates = volumes;
    const requestedVolumeId = String(input.volumeId ?? "").trim();
    const requestedRoot = normalizeDriveRoot(input.rootPath);
    if (requestedVolumeId) {
      candidates = candidates.filter((item) => item.volumeId === requestedVolumeId);
    }
    if (requestedRoot) {
      candidates = candidates.filter((item) => item.rootPath === requestedRoot);
    }
    if (input.requireProvider) {
      candidates = candidates.filter((item) => item.providers.includes(input.requireProvider));
    }
    if (input.requireWritable) {
      candidates = candidates.filter((item) => !item.readOnly);
    }
    if (candidates.length === 0) {
      throw volumeError("QHKEY_VOLUME_MISSING", "A matching removable QHKEY volume was not found.");
    }
    if (candidates.length > 1) {
      throw volumeError("QHKEY_VOLUME_AMBIGUOUS", "Multiple removable QHKEY volumes match the request.");
    }
    return candidates[0];
  }

  async function validate(identity, input = {}) {
    const current = await locate({ volumeId: identity.volumeId, production: input.production });
    if (!sameQhkeyVolumeIdentity(identity, current)) {
      throw volumeError("QHKEY_VOLUME_IDENTITY_CHANGED", "The QHKEY volume identity changed.");
    }
    return current;
  }

  return Object.freeze({
    descriptor: descriptor(platform, role),
    list,
    locate,
    validate,
  });
}

export function qhkeyProviderFilePath(root, provider) {
  const relativePath = QHKEY_PROVIDER_RELATIVE_PATHS[provider];
  if (!relativePath) throw new TypeError("Unsupported QHKEY provider.");
  return path.join(root, relativePath);
}
