import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) => readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
const signing = read("packaging/windows/msix/sign-msix.ps1");
const finalizer = read("packaging/windows/msix/finalize-production-msix.ps1");
const iconVerifier = read("packaging/windows/msix/verify-pe-icon.ps1");
const nativeRunner = read("tests/integration/windows/msix/run-release-candidate-matrix.ps1");
const postgresql = JSON.parse(read("packaging/windows/postgresql-runtime.json"));

assert.match(signing, /ValidateSet\("AzureArtifactSigning", "CertificateStore"\)/u);
assert.match(signing, /MSIX_PRODUCTION_PUBLISHER_REQUIRED/u);
assert.match(signing, /\/tr.*TimestampUrl.*\/td.*SHA256/su);
assert.match(signing, /certificate\.Subject -eq \$certificate\.Issuer/u);
assert.doesNotMatch(`${signing}\n${finalizer}`, /Pfx|password/iu);
assert.match(finalizer, /Get-AuthenticodeSignature/u);
assert.match(finalizer, /TimeStamperCertificate/u);
assert.match(finalizer, /SignTool verify \/pa \/all \/v/u);
assert.match(finalizer, /schemaVersion = 2/u);
assert.match(finalizer, /signingMode = "PRODUCTION"/u);
assert.match(finalizer, /packageContentInventorySha256/u);
assert.match(finalizer, /canonicalIconSha256/u);
assert.match(iconVerifier, /ExtractAssociatedIcon/u);
assert.match(iconVerifier, /PE_ICON_RESOURCE_MISMATCH/u);
assert.match(iconVerifier, /Format32bppArgb/u);

for (const check of [
  "cleanInstall",
  "provisioning",
  "interruptionRecovery",
  "update",
  "reboot",
  "migration",
  "repair",
  "serverConflict",
  "dualClients",
  "uninstallPreserved",
  "purge",
  "shellIcon",
]) {
  assert.match(nativeRunner, new RegExp(`"${check}"`, "u"));
}
assert.match(nativeRunner, /ProductType -ne 1/u);
assert.match(nativeRunner, /UNSUPPORTED_WINDOWS_VERSION/u);
assert.match(nativeRunner, /EXTERNAL_OPERATION_ENVIRONMENT_UNAVAILABLE/u);
assert.equal(postgresql.schemaVersion, 1);
assert.equal(postgresql.version, "18.4");
assert.match(postgresql.archiveSha256, /^[a-f0-9]{64}$/u);
assert.match(postgresql.downloadUrl, /^https:\/\//u);

console.log("QuickHack production MSIX signing, provenance, icon, and workstation evidence contracts verified.");
