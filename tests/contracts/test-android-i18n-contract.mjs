import assert from "node:assert/strict";
import fs from "node:fs";

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function resourceNames(source) {
  return [...source.matchAll(/<string\s+name="([^"]+)"/gu)]
    .map((match) => match[1])
    .sort();
}

const ko = read("quickhack_android/app/src/main/res/values/strings.xml");
const en = read("quickhack_android/app/src/main/res/values-en/strings.xml");
assert.deepEqual(resourceNames(en), resourceNames(ko));

const activity = read(
  "quickhack_android/app/src/main/java/com/quickhack/mobile/MainActivity.java"
);
assert.doesNotMatch(activity, /["`][^"`]*[가-힣][^"`]*["`]/u);
assert.doesNotMatch(
  activity,
  /(?:showSetup|setSetupStatus|setText|setTitle|setMessage)\(\s*"[^"]+/u
);
assert.match(activity, /response\.json\.optString\("locale", "ko"\)/u);
assert.match(activity, /AppCompatDelegate\.setApplicationLocales\(requested\)/u);
assert.match(activity, /AppCompatDelegate\.getApplicationLocales\(\)\.isEmpty\(\)/u);

const manifest = read("quickhack_android/app/src/main/AndroidManifest.xml");
assert.match(manifest, /AppLocalesMetadataHolderService/u);
assert.match(manifest, /android:value="true"/u);
assert.match(manifest, /android:configChanges="locale\|layoutDirection"/u);

console.log("Android ko/en resource parity and account-locale ownership contract passed.");
