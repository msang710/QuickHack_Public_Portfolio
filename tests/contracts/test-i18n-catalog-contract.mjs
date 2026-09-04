import assert from "node:assert/strict";
import fs from "node:fs";
import { enMessages } from "../../quickhack_client/i18n/catalogs/en/index.ts";
import { koMessages } from "../../quickhack_client/i18n/catalogs/ko/index.ts";
import { DEFAULT_LOCALE, normalizeQuickHackLocale, SUPPORTED_LOCALES } from "../../quickhack_shared/i18n/locales.ts";

function leafContract(value, prefix = "") {
  const result = new Map();
  for (const [key, child] of Object.entries(value)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") {
      const args = [...child.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]).sort();
      result.set(keyPath, args.join(","));
    } else {
      assert.equal(child && typeof child === "object" && !Array.isArray(child), true, `invalid catalog node: ${keyPath}`);
      for (const [nestedPath, args] of leafContract(child, keyPath)) result.set(nestedPath, args);
    }
  }
  return result;
}

assert.deepEqual(SUPPORTED_LOCALES, ["ko", "en"]);
assert.equal(DEFAULT_LOCALE, "ko");
assert.equal(normalizeQuickHackLocale("ko"), "ko");
assert.equal(normalizeQuickHackLocale("en"), "en");
assert.equal(normalizeQuickHackLocale("ja"), "ko");
const ko = leafContract(koMessages);
const en = leafContract(enMessages);
assert.deepEqual([...en.keys()], [...ko.keys()]);
for (const [key, args] of ko) assert.equal(en.get(key), args, `ICU argument mismatch: ${key}`);
const menuSource = fs.readFileSync(
  "quickhack_client/components/app-shell/device-workspace-menu.ts",
  "utf8"
);
for (const match of menuSource.matchAll(/(?:label|description): "((?:groups|items)\.[^"]+)"/gu)) {
  assert.equal(ko.has(`navigation.${match[1]}`), true, `missing navigation key: ${match[1]}`);
}
console.log(`i18n catalog contract passed (${ko.size} keys).`);
