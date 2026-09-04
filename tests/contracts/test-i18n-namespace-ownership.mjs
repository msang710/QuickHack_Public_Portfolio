import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  I18N_EXCLUDED_CONTENT,
  I18N_NAMESPACE_OWNERS,
  I18N_RAW_CONTENT_BOUNDARIES,
} from "../../quickhack_client/i18n/catalog-manifest.ts";

const claimed = new Map();
for (const [namespace, roots] of Object.entries(I18N_NAMESPACE_OWNERS)) {
  assert.equal(roots.length > 0, true, `${namespace} must own at least one source boundary`);
  for (const root of roots) {
    assert.equal(path.isAbsolute(root), false, `absolute ownership path: ${root}`);
    assert.equal(root.split("/").includes(".."), false, `escaping ownership path: ${root}`);
    assert.equal(fs.existsSync(root), true, `missing ownership boundary: ${root}`);
    const previous = claimed.get(root);
    assert.equal(previous, undefined, `${root} is owned by both ${previous} and ${namespace}`);
    claimed.set(root, namespace);
  }
}
assert.deepEqual(I18N_EXCLUDED_CONTENT, [
  "operator-authored-free-text",
  "invoice-label-csv-output",
  "external-provider-payload",
  "business-identifiers-and-records",
]);
assert.deepEqual(Object.keys(I18N_RAW_CONTENT_BOUNDARIES), I18N_EXCLUDED_CONTENT);
for (const [boundary, contract] of Object.entries(I18N_RAW_CONTENT_BOUNDARIES)) {
  assert.equal(contract.examples.length > 0, true, `${boundary} must document examples`);
  assert.equal(
    ["verbatim-record", "protocol-owned", "diagnostic-snapshot"].includes(
      contract.presentation
    ),
    true,
    `${boundary} has an invalid presentation contract`
  );
}
const detectorSource = fs.readFileSync("tools/check-i18n-ui-strings.mjs", "utf8");
assert.match(detectorSource, /const SOURCE_ROOTS = \["app", "quickhack_client", "quickhack_desktop", "quickhack_server", "quickhack_shared", "tools"\]/);
assert.doesNotMatch(detectorSource, /const SOURCE_ROOTS = \[[^\]]*"mock_server"/);
console.log("i18n namespace ownership contract passed.");
