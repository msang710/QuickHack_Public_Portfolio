import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(
  path.join(projectRoot, ".github", "scripts", "run-gitleaks.ps1"),
  "utf8"
);

assert.match(source, /RuntimeInformation.*IsOSPlatform/s);
assert.match(source, /OSPlatform\]::Windows/);
assert.match(source, /OSPlatform\]::Linux/);
assert.match(source, /gitleaks_\$\{version\}_windows_x64\.zip/);
assert.match(source, /d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e/);
assert.match(source, /gitleaks_\$\{version\}_linux_x64\.tar\.gz/);
assert.match(source, /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/);
assert.match(source, /Expand-Archive/);
assert.match(source, /Get-Command "tar" -CommandType Application/);
assert.match(source, /Select-Object -First 1/);
assert.match(source, /-xzf \$archivePath -C \$installRoot/);
assert.match(source, /Join-Path \$installRoot \$executableName/);

console.log("Gitleaks Windows and Linux runtime selection contract verified.");
