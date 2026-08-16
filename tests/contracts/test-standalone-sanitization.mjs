import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findSensitiveStandaloneFiles,
  sanitizeStandaloneOutput,
  verifyStandaloneRuntime,
} from "../../packaging/sanitize-standalone.mjs";

const rootDir = mkdtempSync(path.join(os.tmpdir(), "quickhack-standalone-"));
const distDir = path.join(rootDir, ".next");
const standaloneDir = path.join(distDir, "standalone");
const packageJson = JSON.parse(
  readFileSync(path.resolve("package.json"), "utf8")
);
const nextConfigSource = readFileSync(path.resolve("next.config.ts"), "utf8");

assert.equal(
  packageJson.scripts.build,
  "next build --webpack",
  "Standalone builds must use the tracing path that honors sensitive-file excludes."
);
assert.match(
  nextConfigSource,
  /outputFileTracingExcludes:\s*\{\s*"\/\*":\s*\[/,
  "Sensitive runtime paths must be excluded from every traced Next route."
);
assert.match(
  nextConfigSource,
  /"\.\/database\/\*\*\/\*"/,
  "The ACL-protected runtime database tree must be excluded before tracing."
);

function write(relativePath, value = "fixture") {
  const targetPath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, value);
}

try {
  write(".next/standalone/server.js", "// server fixture");
  write(".next/static/chunks/app.js", "// static fixture");
  write("public/favicon.ico");
  write(".next/standalone/database/postgresql-runtime.key");
  write(".next/standalone/data/demo/postgresql-migrator.key");
  write(".next/standalone/config/quickhack-ca.pem");
  write(".next/standalone/runtime/server.qhkey");
  write(".next/standalone/.next/server/.env.production");
  write(".next/standalone/node_modules/example/fixture.key");
  write(
    ".next/standalone/node_modules/next/dist/server/lib/router-utils/filesystem.js",
    'require("../../../lib/metadata/get-metadata-route");'
  );

  assert.throws(
    () => verifyStandaloneRuntime(standaloneDir),
    /Next standalone runtime dependency probe failed/,
    "A traced Next runtime with a missing transitive dependency must fail verification."
  );

  write(
    ".next/standalone/node_modules/next/dist/lib/metadata/get-metadata-route.js",
    "module.exports = {};"
  );

  assert.deepEqual(findSensitiveStandaloneFiles(standaloneDir), [
    ".next/server/.env.production",
    "config/quickhack-ca.pem",
    "data/demo/postgresql-migrator.key",
    "database/postgresql-runtime.key",
    "runtime/server.qhkey",
  ]);

  const result = sanitizeStandaloneOutput({ rootDir, distDir });
  assert.deepEqual(result.sensitiveFiles, []);
  assert.equal(existsSync(path.join(standaloneDir, "database")), false);
  assert.equal(existsSync(path.join(standaloneDir, "data")), false);
  assert.equal(existsSync(path.join(standaloneDir, "config")), false);
  assert.equal(
    existsSync(path.join(standaloneDir, "runtime", "server.qhkey")),
    false
  );
  assert.equal(
    existsSync(path.join(standaloneDir, ".next", "server", ".env.production")),
    false
  );
  assert.equal(
    existsSync(path.join(standaloneDir, "node_modules", "example", "fixture.key")),
    true,
    "Dependency fixtures must not be mistaken for QuickHack runtime credentials."
  );
  assert.equal(
    existsSync(path.join(standaloneDir, ".next", "static", "chunks", "app.js")),
    true
  );
  assert.equal(existsSync(path.join(standaloneDir, "public", "favicon.ico")), true);

  console.log(
    "Standalone runtime dependency, data, and credential sanitization verified."
  );
} finally {
  rmSync(rootDir, { recursive: true, force: true });
}
