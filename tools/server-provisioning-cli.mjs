import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServerProvisioningCore } from "./server-provisioning-core.mjs";
import { assertServerProvisioningArtifact } from "./server-provisioning-contract.mjs";
import { createWindowsServerProvisioningJournal } from "./platform/windows/server-provisioning-journal.mjs";
import { createWindowsServerProvisioningAdapter } from "./platform/windows/server-provisioning-adapter.mjs";
import { createWindowsLegacyMsixMigration } from "./windows-legacy-msix-migration.mjs";
import { createWindowsLegacyMigrationJournal } from "./platform/windows/legacy-msix-migration-journal.mjs";
import { createWindowsLegacyMsixMigrationAdapter } from "./platform/windows/legacy-msix-migration-adapter.mjs";
import { createServerRepairCore } from "./server-repair-core.mjs";
import { createWindowsServerRepairAdapter } from "./platform/windows/server-repair-adapter.mjs";

export const SERVER_SETUP_HANDOFF_PROTOCOL = "QUICKHACK_SERVER_SETUP_HANDOFF_V1";

function parseArguments(argv) {
  const result = {
    action: "",
    artifactKind: "",
    packageRoot: "",
    programData: "",
    transactionId: "",
    generation: 0,
    handoffStdio: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--provision" || argument === "--acknowledge" || argument === "--migrate" || argument === "--repair") {
      if (result.action) throw new TypeError("Server Setup accepts one action.");
      result.action = argument.slice(2).toUpperCase();
    } else if (argument === "--handoff-stdio") result.handoffStdio = true;
    else if (argument === "--artifact-kind") result.artifactKind = argv[++index] || "";
    else if (argument === "--package-root") result.packageRoot = argv[++index] || "";
    else if (argument === "--program-data") result.programData = argv[++index] || "";
    else if (argument === "--transaction-id") result.transactionId = argv[++index] || "";
    else if (argument === "--generation") result.generation = Number(argv[++index] || 0);
    else throw new TypeError(`Unsupported Server Setup argument: ${argument}`);
  }
  if (!result.action || !result.packageRoot || !result.programData) {
    throw new TypeError("Server Setup action, package root, and ProgramData are required.");
  }
  if (["PROVISION", "MIGRATE", "REPAIR"].includes(result.action) && !result.handoffStdio) {
    throw new TypeError("Server Setup provisioning requires the protected stdio handoff.");
  }
  if (result.action === "ACKNOWLEDGE" && (!result.transactionId || result.generation < 1)) {
    throw new TypeError("Server Setup acknowledgement identity is required.");
  }
  return Object.freeze({
    ...result,
    artifactKind: assertServerProvisioningArtifact(result.artifactKind),
    packageRoot: path.resolve(result.packageRoot),
    programData: path.resolve(result.programData),
  });
}

function writeHandoff(result) {
  const lines = [
    SERVER_SETUP_HANDOFF_PROTOCOL,
    `status=${result.state}`,
    `transactionId=${result.transactionId}`,
  ];
  if (result.state === "INITIAL_LEADER_PENDING_ACK") {
    lines.push(
      `userId=${result.handoff.userId}`,
      `generation=${result.handoff.generation}`,
      `username=${result.handoff.username}`,
      `temporaryPassword=${result.handoff.temporaryPassword}`
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

export async function runServerProvisioningCommand(argv = process.argv.slice(2)) {
  if (process.platform !== "win32") {
    const error = new Error("QuickHack MSIX Server Setup is Windows-only.");
    error.code = "PROVISIONING_PLATFORM_UNSUPPORTED";
    throw error;
  }
  const input = parseArguments(argv);
  const journal = createWindowsServerProvisioningJournal({
    artifactKind: input.artifactKind,
    programData: input.programData,
  });
  if (input.action === "ACKNOWLEDGE") {
    await journal.acknowledgeInitialLeader({
      transactionId: input.transactionId,
      generation: input.generation,
    });
  }
  const runtimeConfigPath = path.join(
    input.programData,
    "QuickHack",
    input.artifactKind === "DEMONSTRATION_SERVER" ? "demonstration-server" : "operational-server",
    "config",
    "server-runtime.json"
  );
  const runtimeArgumentIndex = process.argv.indexOf("--runtime-config");
  if (runtimeArgumentIndex < 0) process.argv.push("--runtime-config", runtimeConfigPath);
  const runProvisioning = (options = {}) => {
    const adapter = createWindowsServerProvisioningAdapter({
      artifactKind: input.artifactKind,
      packageRoot: input.packageRoot,
      programData: input.programData,
      journal,
      allowExistingLeaderAdoption: options.allowExistingLeaderAdoption === true,
    });
    return createServerProvisioningCore({
      artifactKind: input.artifactKind,
      adapter,
      journal,
    }).run(input.transactionId ? { transactionId: input.transactionId } : {});
  };
  let result;
  if (input.action === "MIGRATE") {
    const migrationJournal = createWindowsLegacyMigrationJournal({
      artifactKind: input.artifactKind,
      programData: input.programData,
    });
    const migrationAdapter = createWindowsLegacyMsixMigrationAdapter({
      artifactKind: input.artifactKind,
      packageRoot: input.packageRoot,
      programData: input.programData,
      provision: () => runProvisioning({ allowExistingLeaderAdoption: true }),
    });
    result = await createWindowsLegacyMsixMigration({
      artifactKind: input.artifactKind,
      adapter: migrationAdapter,
      journal: migrationJournal,
    }).run();
  } else if (input.action === "REPAIR") {
    const repairAdapter = createWindowsServerRepairAdapter({
      artifactKind: input.artifactKind,
      packageRoot: input.packageRoot,
      programData: input.programData,
      provision: () => runProvisioning(),
    });
    const repair = await createServerRepairCore(repairAdapter).run();
    if (repair.disposition !== "READY") {
      const error = new Error(`Server repair stopped with ${repair.code}. Check ${repair.logDirectory}.`);
      error.code = repair.code;
      throw error;
    }
    const readyJournal = await journal.read();
    result = { state: "READY", transactionId: readyJournal?.transactionId };
  } else {
    result = await runProvisioning();
  }
  writeHandoff(result);
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runServerProvisioningCommand().catch((error) => {
    const code = /^[A-Z][A-Z0-9_]{2,95}$/u.test(String(error?.code ?? ""))
      ? error.code
      : "PROVISIONING_STEP_FAILED";
    process.stderr.write(`errorCode=${code}\n`);
    process.exitCode = 1;
  });
}
