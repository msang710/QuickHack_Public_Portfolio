import { readdirSync } from "node:fs";

for (const filename of readdirSync(import.meta.dirname).filter((name) => name.startsWith("test-field-validation-") && name.endsWith(".mjs") && name !== "test-field-validation-suite.mjs").sort()) {
  await import(`./${filename}`);
}
