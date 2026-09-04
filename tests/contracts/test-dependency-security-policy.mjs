import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readProjectFile = (relativePath) =>
  readFile(path.join(projectRoot, relativePath), "utf8");

const approvedActions = new Map([
  ["actions/checkout", Object.freeze({ sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1" })],
  ["actions/setup-node", Object.freeze({ sha: "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e", version: "v6" })],
  ["actions/setup-java", Object.freeze({ sha: "b6effb05e454b25005698d916606bdc6ffcbf961", version: "v5.7.0" })],
  ["actions/upload-artifact", Object.freeze({ sha: "ea165f8d65b6e75b540449e92b4886f43607fa02", version: "v4.6.2" })],
  ["actions/download-artifact", Object.freeze({ sha: "d3f86a106a0bac45b974a628896c90dbdf5c8093", version: "v4.3.0" })],
  ["azure/login", Object.freeze({ sha: "f5d393ae46f8fde4be8b75f32e3fc50e654ad0ca", version: "v3" })],
  ["azure/artifact-signing-action", Object.freeze({ sha: "c7ab2a863ab5f9a846ddb8265964877ef296ee82", version: "v2.0.0" })],
]);

async function listWorkflowPaths(directory = path.join(projectRoot, ".github", "workflows")) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await listWorkflowPaths(absolute));
    } else if (/\.ya?ml$/i.test(entry.name)) {
      paths.push(path.relative(projectRoot, absolute).replaceAll(path.sep, "/"));
    }
  }
  return paths.sort();
}

function assertNoDirectExpressionsInRun(relativePath, source) {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!match) continue;

    const indentation = match[1].length;
    const scalar = match[2];
    if (!/^[|>][-+]?\s*$/.test(scalar)) {
      assert.doesNotMatch(
        scalar,
        /\$\{\{/,
        `${relativePath}:${index + 1} must pass workflow context through env instead of run`,
      );
      continue;
    }

    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const bodyLine = lines[bodyIndex];
      if (bodyLine.trim() && bodyLine.match(/^\s*/)[0].length <= indentation) break;
      assert.doesNotMatch(
        bodyLine,
        /\$\{\{/,
        `${relativePath}:${bodyIndex + 1} must pass workflow context through env instead of run`,
      );
    }
  }
}

function assertApprovedRemoteActions(relativePath, source) {
  const seen = [];
  const pattern = /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/gm;
  for (const match of source.matchAll(pattern)) {
    const actionReference = match[1];
    if (actionReference.startsWith("./")) continue;
    assert.doesNotMatch(
      actionReference,
      /^docker:\/\//,
      `${relativePath} must use a reviewed digest-pinned container action`,
    );

    const separator = actionReference.lastIndexOf("@");
    assert.ok(separator > 0, `${relativePath} action is missing a ref: ${actionReference}`);
    const actionPath = actionReference.slice(0, separator);
    const repository = actionPath.split("/").slice(0, 2).join("/");
    const ref = actionReference.slice(separator + 1);
    assert.match(ref, /^[0-9a-f]{40}$/, `${relativePath} action must use a full commit SHA: ${actionReference}`);

    const approved = approvedActions.get(repository);
    assert.ok(approved, `${relativePath} action repository is not reviewed: ${repository}`);
    assert.equal(ref, approved.sha, `${relativePath} action SHA is not approved: ${repository}`);
    assert.equal(match[2], approved.version, `${relativePath} action version comment is stale: ${repository}`);
    seen.push(repository);
  }
  return seen;
}

const packageJson = JSON.parse(await readProjectFile("package.json"));
assert.equal(packageJson.dependencies.next, "^16.3.1");
assert.equal(packageJson.devDependencies["eslint-config-next"], "^16.3.1");
assert.equal(packageJson.dependencies.prisma, "^7.9.1");
assert.equal(packageJson.dependencies["@prisma/client"], "^7.9.1");
assert.equal(packageJson.dependencies["@prisma/adapter-pg"], "^7.9.1");
assert.equal(packageJson.devDependencies.postcss, "^8.5.23");
assert.deepEqual(packageJson.overrides, {
  "@prisma/config": {
    "deepmerge-ts": "8.0.0",
  },
  browserslist: "4.28.8",
  "fast-uri": "4.1.4",
  mysql2: "3.24.3",
}, "검토된 dependency 보안 보정 외 override를 허용하지 않습니다.");
const packageLock = JSON.parse(await readProjectFile("package-lock.json"));
assert.equal(packageLock.packages["node_modules/deepmerge-ts"]?.version, "8.0.0");
assert.equal(packageLock.packages["node_modules/browserslist"]?.version, "4.28.8");
assert.equal(packageLock.packages["node_modules/fast-uri"]?.version, "4.1.4");
assert.equal(packageLock.packages["node_modules/mysql2"]?.version, "3.24.3");
assert.equal(packageJson.scripts["audit:dependencies"], "npm audit --package-lock-only --audit-level=low");
assert.equal(
  packageJson.scripts["test:dependency-security-policy"],
  "node tests/contracts/test-dependency-security-policy.mjs",
);

const workflowPaths = await listWorkflowPaths();
assert.ok(workflowPaths.length > 0, "At least one GitHub Actions workflow is required.");
const workflowEntries = await Promise.all(
  workflowPaths.map(async (relativePath) => ({ relativePath, source: await readProjectFile(relativePath) })),
);
const seenActions = [];
for (const { relativePath, source } of workflowEntries) {
  assertNoDirectExpressionsInRun(relativePath, source);
  seenActions.push(...assertApprovedRemoteActions(relativePath, source));
}
for (const repository of approvedActions.keys()) {
  assert.ok(seenActions.includes(repository), `Approved action is no longer used: ${repository}`);
}

assert.throws(
  () => assertNoDirectExpressionsInRun("fixture.yml", "steps:\n  - run: echo '${{ inputs.version }}'"),
  /through env/,
);
assert.throws(
  () => assertNoDirectExpressionsInRun(
    "fixture.yml",
    "steps:\n  - run: |\n      echo '${{ inputs.version }}'",
  ),
  /through env/,
);
assert.throws(
  () => assertApprovedRemoteActions("fixture.yml", "steps:\n  - uses: actions/upload-artifact@v4"),
  /full commit SHA/,
);
assert.throws(
  () => assertApprovedRemoteActions("fixture.yml", "steps:\n  - uses: unknown/action@0123456789012345678901234567890123456789 # v1"),
  /not reviewed/,
);

const finalIntegrationWorkflow = await readProjectFile(".github/workflows/pull-request-checks.yml");
const releaseWorkflows = await Promise.all([
  readProjectFile(".github/workflows/windows-release.yml"),
  readProjectFile(".github/workflows/linux-release.yml"),
]);
assert.equal(
  [...finalIntegrationWorkflow.matchAll(/- run: npm run audit:dependencies/g)].length,
  1,
  "최종 통합 워크플로에서 의존성 감사를 정확히 한 번 실행해야 합니다.",
);
assert.equal(
  releaseWorkflows.reduce((count, source) => count + [...source.matchAll(/npm run audit:dependencies/g)].length, 0),
  0,
  "플랫폼별 릴리스 워크플로가 동일 감사를 중복 실행하면 안 됩니다.",
);
assert.match(finalIntegrationWorkflow, /^on:\r?\n  workflow_dispatch:/m);
assert.doesNotMatch(finalIntegrationWorkflow, /^\s*pull_request:/m);

const installIndex = finalIntegrationWorkflow.indexOf("- run: npm ci");
const auditIndex = finalIntegrationWorkflow.indexOf("- run: npm run audit:dependencies");
const lintIndex = finalIntegrationWorkflow.indexOf("- run: npm run lint");
assert.ok(installIndex >= 0 && installIndex < auditIndex && auditIndex < lintIndex);

console.log(`Dependency security policy contract passed for ${workflowPaths.length} workflows.`);
