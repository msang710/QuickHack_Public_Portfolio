import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readProjectFile = (relativePath) =>
  readFile(path.join(projectRoot, relativePath), "utf8");
const countOccurrences = (source, value) => source.split(value).length - 1;

const packageJson = JSON.parse(await readProjectFile("package.json"));

assert.equal(packageJson.dependencies.next, "^16.3.1");
assert.equal(packageJson.devDependencies["eslint-config-next"], "^16.3.1");
assert.equal(packageJson.dependencies.prisma, "^7.9.1");
assert.equal(packageJson.dependencies["@prisma/client"], "^7.9.1");
assert.equal(packageJson.dependencies["@prisma/adapter-pg"], "^7.9.1");
assert.equal(packageJson.devDependencies.postcss, "^8.5.23");
assert.equal(packageJson.overrides, undefined, "취약 버전을 고정하던 overrides가 없어야 합니다.");
assert.equal(
  packageJson.scripts["audit:dependencies"],
  "npm audit --package-lock-only --audit-level=low",
);
assert.equal(
  packageJson.scripts["test:dependency-security-policy"],
  "node tests/contracts/test-dependency-security-policy.mjs",
);

const workflowPaths = [
  ".github/workflows/pull-request-checks.yml",
  ".github/workflows/windows-release.yml",
  ".github/workflows/linux-release.yml",
];
const workflowSources = await Promise.all(workflowPaths.map(readProjectFile));
const finalIntegrationWorkflow = workflowSources[0];
const releaseWorkflows = workflowSources.slice(1);
const approvedCheckoutPin =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const supersededCheckoutPin =
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0";

assert.equal(
  workflowSources.reduce(
    (count, source) => count + countOccurrences(source, approvedCheckoutPin),
    0,
  ),
  8,
  "세 워크플로의 checkout 사용 8곳이 모두 승인된 v7.0.1 SHA여야 합니다.",
);
assert.equal(
  workflowSources.reduce(
    (count, source) => count + countOccurrences(source, supersededCheckoutPin),
    0,
  ),
  0,
  "교체 전 checkout v7.0.0 SHA가 남아 있으면 안 됩니다.",
);
assert.equal(
  countOccurrences(finalIntegrationWorkflow, "- run: npm run audit:dependencies"),
  1,
  "최종 통합 워크플로에서 의존성 감사를 정확히 한 번 실행해야 합니다.",
);
assert.equal(
  releaseWorkflows.reduce(
    (count, source) => count + countOccurrences(source, "npm run audit:dependencies"),
    0,
  ),
  0,
  "플랫폼별 릴리스 워크플로가 동일 감사를 중복 실행하면 안 됩니다.",
);

assert.match(finalIntegrationWorkflow, /^on:\r?\n  workflow_dispatch:/m);
assert.doesNotMatch(finalIntegrationWorkflow, /^\s*pull_request:/m);

const installIndex = finalIntegrationWorkflow.indexOf("- run: npm ci");
const auditIndex = finalIntegrationWorkflow.indexOf("- run: npm run audit:dependencies");
const lintIndex = finalIntegrationWorkflow.indexOf("- run: npm run lint");
assert.ok(installIndex >= 0 && installIndex < auditIndex && auditIndex < lintIndex);

console.log("Dependency security policy contract passed.");
