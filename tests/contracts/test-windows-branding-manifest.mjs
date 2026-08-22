import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../../assets/branding/windows-icon.json", import.meta.url), "utf8")
);
const icon = readFileSync(new URL("../../assets/app.ico", import.meta.url));
const generator = readFileSync(
  new URL("../../packaging/windows/msix/generate-visual-assets.ps1", import.meta.url),
  "utf8"
);
const verifier = readFileSync(
  new URL("../../packaging/windows/msix/verify-visual-assets.ps1", import.meta.url),
  "utf8"
);

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.source.path, "assets/app.ico");
assert.equal(createHash("sha256").update(icon).digest("hex"), manifest.source.sha256);
assert.equal(manifest.source.sha256, "530deb06a676ac29892495d3f940aaced2595faa00d747bbfae3d52b51092807");
assert.equal(icon.readUInt16LE(0), 0);
assert.equal(icon.readUInt16LE(2), 1);
const frameCount = icon.readUInt16LE(4);
const frameSizes = [];
for (let index = 0; index < frameCount; index += 1) {
  const offset = 6 + index * 16;
  frameSizes.push(icon[offset] || 256);
}
assert.deepEqual([...new Set(frameSizes)].sort((left, right) => left - right), manifest.source.requiredFrames);

const outputPaths = manifest.outputs.map((output) => output.path);
assert.equal(new Set(outputPaths).size, outputPaths.length);
for (const requiredPath of ["Square44x44Logo.png", "Square150x150Logo.png", "StoreLogo.png"]) {
  assert.ok(outputPaths.includes(requiredPath), requiredPath);
}
assert.ok(manifest.outputs.some((output) => output.path === "Square44x44Logo.scale-400.png" && output.width === 176));
assert.ok(manifest.outputs.some((output) => output.path === "Square150x150Logo.scale-400.png" && output.width === 600));
assert.match(generator, /Get-FileHash -Algorithm SHA256/u);
assert.match(generator, /descendant of repository release/u);
assert.match(generator, /Format32bppArgb/u);
assert.match(generator, /HighQualityBicubic/u);
assert.match(verifier, /visual asset dimensions mismatch/iu);
assert.match(verifier, /visual asset hash mismatch/iu);

console.log("QuickHack canonical Windows icon and deterministic visual asset contract verified.");
