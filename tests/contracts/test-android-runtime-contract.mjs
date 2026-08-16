import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NATIVE_RUNTIME_CONTRACT } from "../../quickhack_shared/platform/native-runtime-contract.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const build = read("quickhack_android/build.gradle");
const appBuild = read("quickhack_android/app/build.gradle");
const wrapper = read("quickhack_android/gradle/wrapper/gradle-wrapper.properties");
const wrapperJar = readFileSync(
  path.join(root, "quickhack_android", "gradle", "wrapper", "gradle-wrapper.jar")
);

assert.match(
  build,
  new RegExp(`com\\.android\\.application" version "${NATIVE_RUNTIME_CONTRACT.android.agpVersion.replaceAll(".", "\\.")}"`)
);
assert.match(appBuild, new RegExp(`compileSdk ${NATIVE_RUNTIME_CONTRACT.android.compileSdk}\\b`));
assert.match(appBuild, new RegExp(`targetSdk ${NATIVE_RUNTIME_CONTRACT.android.targetSdk}\\b`));
assert.match(
  wrapper,
  new RegExp(`gradle-${NATIVE_RUNTIME_CONTRACT.android.gradleVersion.replaceAll(".", "\\.")}-bin\\.zip`)
);
assert.match(
  wrapper,
  /distributionSha256Sum=31c55713e40233a8303827ceb42ca48a47267a0ad4bab9177123121e71524c26/
);
assert.equal(
  createHash("sha256").update(wrapperJar).digest("hex"),
  "2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046"
);
assert.match(read("quickhack_android/gradlew"), /^#!\/bin\/sh/);
assert.match(read("quickhack_android/gradlew.bat"), /org\.gradle\.wrapper\.GradleWrapperMain/);

console.log("Android repository Gradle wrapper and runtime contracts verified.");
