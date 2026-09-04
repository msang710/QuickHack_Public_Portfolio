import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanI18nFiles } from "../../tools/check-i18n-ui-strings.mjs";

const directory = mkdtempSync(path.join(os.tmpdir(), "quickhack-i18n-detector-"));
const fixture = path.join(directory, "fixture.tsx");
const apiFixture = path.join(directory, "api-fixture.ts");
const serviceFixture = path.join(directory, "service-fixture.ts");
const htmlFixture = path.join(directory, "html-fixture.mjs");
try {
  writeFileSync(
    fixture,
    `export function Fixture() {
      const setError = (_value: string) => undefined;
      setError("저장하지 못했습니다.");
      showErrorBox("Native failure", "Review the logs.");
      return <input aria-label="주문 검색" placeholder={"PG를 입력하세요"}>표시 문구</input>;
    }
    export const descriptor = { title: "상세 정보", description: \`선택한 항목 ${"${count}"}건\` };
    `,
    "utf8"
  );
  const entries = scanI18nFiles([fixture], "ui");
  const kinds = new Set(entries.map((entry) => `${entry.kind}:${entry.detail ?? ""}`));
  assert.equal(kinds.has("ui-call:setError"), true);
  assert.equal(kinds.has("ui-call:showErrorBox"), true);
  assert.equal(kinds.has("jsx-prop:aria-label"), true);
  assert.equal(kinds.has("jsx-prop:placeholder"), true);
  assert.equal(kinds.has("jsx-text:"), true);
  assert.equal(kinds.has("object-prop:title"), true);
  assert.equal(kinds.has("object-template:description"), true);

  writeFileSync(
    apiFixture,
    `export const response = { ok: false, message: "English API error" };
     export const dynamicResponse = { ok: false, message: providerMessage };
     const message = providerMessage;
     export const shorthandResponse = { ok: false, message };
     export const codedResponse = { ok: false, code: "INVALID_BODY" };`,
    "utf8"
  );
  const apiEntries = scanI18nFiles([apiFixture], "api");
  assert.deepEqual(
    apiEntries.map((entry) => entry.kind),
    ["api-message", "api-message", "api-message"]
  );

  writeFileSync(
    serviceFixture,
    `const preserveKoreanSnapshot = <T extends string>(value: T) => value;
     export const localized = { message: "직접 생성한 서비스 문구" };
     export const internal = { message: "Internal diagnostic" };
     export const unavailable = { unavailableReason: "집계할 표본이 없습니다." };
     export const warnings = { warnings: ["후보를 찾지 못했습니다."] };
     export const persisted = { errorMessage: preserveKoreanSnapshot("보존할 운영 원문") };
     export const projected = { errorMessage: row.error_message };`,
    "utf8"
  );
  const serviceEntries = scanI18nFiles([serviceFixture], "server");
  assert.deepEqual(
    serviceEntries.map((entry) => entry.text),
    ["직접 생성한 서비스 문구", "집계할 표본이 없습니다.", "후보를 찾지 못했습니다."]
  );

  writeFileSync(
    htmlFixture,
    `const t = { title: "localized" };
     export const page = \`<main><h1>Raw console title</h1><input placeholder="Raw input label"><p>\${t.title}</p></main>\`;`,
    "utf8"
  );
  const htmlEntries = scanI18nFiles([htmlFixture], "server");
  assert.deepEqual(
    htmlEntries.map((entry) => entry.text),
    ["Raw console title", "Raw input label"]
  );
  console.log("i18n detector fixtures passed.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
