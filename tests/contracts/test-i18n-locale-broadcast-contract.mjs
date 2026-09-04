import assert from "node:assert/strict";
import fs from "node:fs";

const provider = fs.readFileSync(
  "quickhack_client/i18n/quickhack-intl-provider.tsx",
  "utf8"
);
const adapter = fs.readFileSync("quickhack_client/i18n/locale-client.ts", "utf8");

assert.match(adapter, /quickhack\.locale\.v1/u);
assert.match(adapter, /Number\.isInteger\(input\.revision\)/u);
assert.match(adapter, /locale !== input\.locale/u);
assert.match(provider, /update\.revision <= latestRevisionRef\.current/u);
assert.match(provider, /React\.startTransition\(\(\) => router\.refresh\(\)\)/u);
assert.doesNotMatch(provider, /location\.reload/u);

console.log("i18n locale broadcast contract passed.");
