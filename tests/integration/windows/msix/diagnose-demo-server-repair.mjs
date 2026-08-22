import path from "node:path";
import { pathToFileURL } from "node:url";

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing ${prefix}<value>.`);
  return path.win32.resolve(value);
}

const packageRoot = argument("package-root");
const programData = argument("program-data");
const adapterModule = await import(pathToFileURL(path.win32.join(
  packageRoot,
  "tools",
  "platform",
  "windows",
  "server-repair-adapter.mjs"
)).href);
const adapter = adapterModule.createWindowsServerRepairAdapter({
  artifactKind: "DEMONSTRATION_SERVER",
  packageRoot,
  programData,
  async provision() {
    throw new Error("Read-only repair diagnosis must not provision.");
  },
});
const diagnosis = await adapter.diagnose();
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  package: diagnosis.package,
  state: diagnosis.state,
  database: diagnosis.database,
})}\n`);
