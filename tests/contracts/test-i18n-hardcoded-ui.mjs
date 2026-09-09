import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const script = path.join(root, "tools/check-i18n-ui-strings.mjs");
const baseline = path.join(root, "quickhack_client/i18n/hardcoded-ui-baseline.json");

assert.equal(fs.existsSync(script), true, "i18n UI detector must exist");
assert.equal(fs.existsSync(baseline), true, "reviewed UI string baseline must exist");

const document = JSON.parse(fs.readFileSync(baseline, "utf8"));
assert.equal(document.version, 1);
assert.equal(Array.isArray(document.entries), true);
assert.equal(
  document.entries.length,
  0,
  "the reviewed hardcoded UI baseline must remain empty"
);

const keys = new Set();
for (const entry of document.entries) {
  assert.match(entry.file, /^(?:app|quickhack_client)\//);
  assert.equal(path.isAbsolute(entry.file), false);
  assert.equal(entry.file.includes(".."), false);
  assert.equal(typeof entry.text, "string");
  assert.equal(/[가-힣]/u.test(entry.text), true);
  assert.equal(Number.isInteger(entry.occurrence), true);
  assert.equal(entry.occurrence > 0, true);
  const key = `${entry.file}:${entry.kind}:${entry.detail ?? ""}:${entry.text}:${entry.occurrence}`;
  assert.equal(keys.has(key), false, `duplicate baseline entry: ${key}`);
  keys.add(key);
}

const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

console.log("i18n hardcoded UI zero-baseline contract passed.");
