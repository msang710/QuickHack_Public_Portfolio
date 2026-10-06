import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageRuntimeNodeDependencies } from "../../packaging/common/stage-runtime-node-dependencies.mjs";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "quickhack-cli-dependencies-"));
const source = path.join(fixture, "source");
const output = path.join(fixture, "output");
function pkg(name, dependencies = {}) {
  const directory = path.join(source, "node_modules", ...name.split("/"));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js", dependencies }));
  fs.writeFileSync(path.join(directory, "index.js"), "module.exports = true;\n");
}
try {
  pkg("pg", { "pg-pool": "1.0.0" });
  pkg("pg-pool");
  pkg("prisma", { "@prisma/engines": "1.0.0" });
  pkg("@prisma/engines");
  stageRuntimeNodeDependencies({ sourceRoot: source, destinationRoot: output, packages: ["pg", "prisma"] });
  for (const name of ["pg", "pg-pool", "prisma", "@prisma/engines"]) {
    assert.ok(fs.existsSync(path.join(output, "node_modules", ...name.split("/"), "package.json")), name);
  }
  fs.rmSync(path.join(source, "node_modules", "pg-pool"), { recursive: true });
  assert.throws(() => stageRuntimeNodeDependencies({ sourceRoot: source, destinationRoot: path.join(fixture, "broken"), packages: ["pg"] }), /pg-pool/);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
