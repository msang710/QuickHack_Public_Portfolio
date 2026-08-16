import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { QUICKHACK_RELEASE_MATRIX, packageReleaseVariant } from "../../packaging/package-release-matrix.mjs";

assert.equal(QUICKHACK_RELEASE_MATRIX.length, 8);
assert.equal(new Set(QUICKHACK_RELEASE_MATRIX.map((item) => `${item.platform}:${item.target}`)).size, 8);
assert.equal(new Set(QUICKHACK_RELEASE_MATRIX.map((item) => item.artifactKind)).size, 4);
assert.equal(QUICKHACK_RELEASE_MATRIX.every((item) => item.official), true);
assert.equal(QUICKHACK_RELEASE_MATRIX.some((item) => /portable|\.zip$/iu.test(item.artifactFileName)), false);
for (const item of QUICKHACK_RELEASE_MATRIX) {
  assert.ok(item.manifestFileName.endsWith("-manifest-VERSION.json"));
  assert.ok(item.checksumFileName.endsWith("-SHA256SUMS.txt"));
}
assert.match(packageReleaseVariant("windows", "operational-client", "2.0.0").artifactFileName, /QuickHack-Operational-Client-Setup-2\.0\.0\.exe/);
assert.match(packageReleaseVariant("linux", "demo-server", "2.0.0").artifactFileName, /quickhack-demonstration-server-2\.0\.0-1-x86_64\.pkg\.tar\.zst/);

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
for (const platform of ["windows", "linux"]) {
  for (const target of ["demo-server", "demo-client", "operational-server", "operational-client"]) {
    assert.ok(packageJson.scripts[`stage:${platform}:${target}`]);
    assert.ok(packageJson.scripts[`release:${platform}:${target}`]);
  }
}
assert.equal(packageJson.scripts["stage:demo-server"], "npm run stage:windows:demo-server");
assert.equal(packageJson.scripts["stage:demo-client"], "npm run stage:windows:demo-client");

const integrationWorkflowSource = readFileSync(new URL("../../.github/workflows/pull-request-checks.yml", import.meta.url), "utf8");
const windowsWorkflowSource = readFileSync(new URL("../../.github/workflows/windows-release.yml", import.meta.url), "utf8");
const linuxWorkflowSource = readFileSync(new URL("../../.github/workflows/linux-release.yml", import.meta.url), "utf8");
for (const source of [integrationWorkflowSource, windowsWorkflowSource, linuxWorkflowSource]) {
  assert.doesNotThrow(() => parseYaml(source));
  for (const target of ["demo-server", "demo-client", "operational-server", "operational-client"]) {
    assert.ok(source.includes(target));
  }
}
assert.doesNotMatch(integrationWorkflowSource, /^\s*pull_request:/mu);
assert.match(integrationWorkflowSource, /^\s*workflow_dispatch:/mu);
assert.match(integrationWorkflowSource, /PR labels are work\/review units, not execution blockers/);
assert.match(integrationWorkflowSource, /version:/);
assert.match(integrationWorkflowSource, /source-and-postgresql:/);
assert.match(integrationWorkflowSource, /windows-package-matrix:/);
assert.match(integrationWorkflowSource, /linux-package-matrix:/);
assert.match(integrationWorkflowSource, /android-build:/);
assert.match(integrationWorkflowSource, /final-integration-complete:/);
assert.match(integrationWorkflowSource, /if: always\(\)/);
assert.equal(
  [...integrationWorkflowSource.matchAll(/verify-package-release-artifact\.mjs/g)].length,
  2
);
assert.doesNotMatch(
  integrationWorkflowSource,
  /WINDOWS_PHYSICAL|LINUX_PHYSICAL|HARDWARE_MANUAL|closure-(?:evidence|attestation)|review-closure|114 findings|closure-ledger/
);
for (const source of [windowsWorkflowSource, linuxWorkflowSource]) {
  assert.match(source, /actions: read/);
  assert.match(source, /Resolve successful same-revision Final Integration run/);
  assert.match(source, /Verify package manifest, version, target, and hashes/);
  assert.match(source, /verify-package-release-artifact\.mjs/);
  assert.doesNotMatch(source, /closure-(?:evidence|attestation)|review-closure|closure-ledger/);
  assert.doesNotMatch(source, /npm run (?:build|stage:|release:|verify)/);
}
assert.doesNotMatch(`${windowsWorkflowSource}\n${linuxWorkflowSource}`, /Portable-|\.zip/u);

console.log("Four logical artifacts and eight official platform release variants verified.");
