import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXPECTED_VERIFY_ENVIRONMENT = {
  HOME: "${{ runner.temp }}\\home",
  LOCALAPPDATA: "${{ runner.temp }}\\local-app-data",
  QUICKHACK_RELEASE_VERSION: "${{ inputs.version }}",
  QUICKHACK_MSIX_PUBLISHER: "${{ inputs.windows_publisher }}",
  USERPROFILE: "${{ runner.temp }}\\user-profile",
};
const WORKFLOWS = [
  {
    path: ".github/workflows/pull-request-checks.yml",
    verifyStep: "Build and stage exact four Windows artifacts once",
    requiredCommands: [
      "npm run build",
      "./packaging/stage-windows-four-artifacts.ps1",
      "./packaging/build-msix-four-artifacts.ps1",
    ],
  },
];

function indentation(line) {
  return line.length - line.trimStart().length;
}

function extractStep(lines, stepName, workflowPath) {
  const marker = `- name: ${stepName}`;
  const start = lines.findIndex((line) => line.trim() === marker);

  assert.notEqual(start, -1, `${workflowPath} is missing step '${stepName}'.`);

  const stepIndent = indentation(lines[start]);
  let end = lines.length;

  for (let index = start + 1; index < lines.length; index += 1) {
    if (
      indentation(lines[index]) === stepIndent &&
      lines[index].trimStart().startsWith("- name:")
    ) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end);
}

function extractEnvironment(stepLines, workflowPath, stepName) {
  const envIndex = stepLines.findIndex((line) => line.trim() === "env:");

  assert.notEqual(
    envIndex,
    -1,
    `${workflowPath} step '${stepName}' must define a step-local env mapping.`
  );

  const envIndent = indentation(stepLines[envIndex]);
  const environment = {};

  for (let index = envIndex + 1; index < stepLines.length; index += 1) {
    const line = stepLines[index];

    if (!line.trim()) {
      continue;
    }
    if (indentation(line) <= envIndent) {
      break;
    }

    const match = /^\s*([A-Z][A-Z0-9_]*):\s*(.+?)\s*$/.exec(line);
    assert.ok(
      match,
      `${workflowPath} step '${stepName}' has an unsupported env entry: ${line.trim()}`
    );
    environment[match[1]] = match[2];
  }

  return environment;
}

function countEnvironmentKey(lines, key) {
  const pattern = new RegExp(`^\\s+${key}:`);
  return lines.filter((line) => pattern.test(line)).length;
}

for (const workflow of WORKFLOWS) {
  const workflowPath = path.join(ROOT, workflow.path);
  const source = fs.readFileSync(workflowPath, "utf8");
  const lines = source.split(/\r?\n/);
  const stepLines = extractStep(lines, workflow.verifyStep, workflow.path);
  const stepSource = stepLines.join("\n");
  const environment = extractEnvironment(
    stepLines,
    workflow.path,
    workflow.verifyStep
  );

  assert.match(
    source,
    /^\s*runs-on:\s*windows-2025\s*$/m,
    `${workflow.path} must run verification on windows-2025.`
  );
  for (const command of workflow.requiredCommands) {
    assert.ok(
      stepSource.includes(command),
      `${workflow.path} step '${workflow.verifyStep}' must run ${command}.`
    );
  }
  for (const [key, value] of Object.entries(EXPECTED_VERIFY_ENVIRONMENT)) {
    assert.equal(
      environment[key],
      value,
      `${workflow.path} step '${workflow.verifyStep}' has a different ${key} isolation contract.`
    );
  }
  assert.equal(
    countEnvironmentKey(lines, "HOME"),
    1,
    `${workflow.path} must declare HOME only on its verify step.`
  );
  assert.equal(
    countEnvironmentKey(lines, "LOCALAPPDATA"),
    1,
    `${workflow.path} must declare LOCALAPPDATA only on its verify step.`
  );
  assert.equal(
    countEnvironmentKey(lines, "USERPROFILE"),
    1,
    `${workflow.path} must declare USERPROFILE only on its verify step.`
  );
  assert.equal(
    countEnvironmentKey(lines, "QUICKHACK_DATA_DIR"),
    0,
    `${workflow.path} must not restore the removed QUICKHACK_DATA_DIR interface.`
  );
}

const releaseWorkflow = fs.readFileSync(
  path.join(ROOT, ".github/workflows/windows-release.yml"),
  "utf8"
);
assert.match(releaseWorkflow, /runs-on:\s*ubuntu-latest/);
assert.doesNotMatch(releaseWorkflow, /matrix:/);
assert.match(releaseWorkflow, /candidate_run_id:/);
assert.match(releaseWorkflow, /windows_10_evidence_run_id:/);
assert.match(releaseWorkflow, /windows_11_evidence_run_id:/);
assert.match(releaseWorkflow, /release-candidate\.mjs/);
assert.doesNotMatch(releaseWorkflow, /closure-(?:evidence|attestation)|review-closure|closure-ledger/);
assert.match(releaseWorkflow, /gh release create/);
assert.doesNotMatch(releaseWorkflow, /npm ci|npm run build|npm run verify|choco install/);
assert.doesNotMatch(releaseWorkflow, /^\s+QUICKHACK_DATA_DIR:/m);

console.log(
  "Windows build isolation and same-revision package verification contract verified."
);
