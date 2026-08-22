import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const host = readFileSync(
  new URL("../../packaging/windows/msix/service-host/QuickHackPackagedServiceHost.cs", import.meta.url),
  "utf8"
);
const build = readFileSync(
  new URL("../../packaging/build-msix-service-hosts.ps1", import.meta.url),
  "utf8"
);
const nativeTest = readFileSync(
  new URL("../integration/windows/msix/test-msix-packaged-services.ps1", import.meta.url),
  "utf8"
);

assert.match(host, /class QuickHackWindowsService : ServiceBase/u);
assert.match(host, /PROVISIONING_REQUIRED/u);
assert.match(host, /POSTGRES_CLUSTER_READY/u);
assert.match(host, /SERVICES_READY/u);
assert.match(host, /packaged-service-host\.log/u);
assert.match(host, /code=" \+ code/u);
assert.match(
  host,
  /EventLog\.WriteEntry\(message, entryType\);[\s\S]*if \(!definition\.IsProvisioned\) return;[\s\S]*Directory\.CreateDirectory\(logDirectory\)/u
);
assert.match(host, /quickhack-msix-service-preview\.txt/u);
assert.match(host, /runtime", "node", "node\.exe/u);
assert.match(host, /runtime", "postgresql", "bin", "postgres\.exe/u);
assert.match(host, /PostgresqlMajorVersion = "18"/u);
assert.match(host, /PostgresqlMajorVersion,[\s\S]*"data"/u);
assert.match(
  host,
  /#if QUICKHACK_POSTGRESQL[\s\S]*return true;[\s\S]*#else[\s\S]*return false;[\s\S]*#endif/u
);
assert.match(host, /RedirectStandardOutput = CaptureChildDiagnostics/u);
assert.match(host, /RedirectStandardError = CaptureChildDiagnostics/u);
assert.match(host, /started\.OutputDataReceived \+= diagnostics\.Observe/u);
assert.match(host, /started\.ErrorDataReceived \+= diagnostics\.Observe/u);
assert.match(host, /started\.BeginOutputReadLine\(\)/u);
assert.match(host, /started\.BeginErrorReadLine\(\)/u);
assert.match(host, /class QuickHackPostgresqlChildDiagnosticClassifier/u);
for (const code of [
  "POSTGRESQL_CHILD_ACCESS_DENIED",
  "POSTGRESQL_CHILD_ADDRESS_IN_USE",
  "POSTGRESQL_CHILD_CONFIGURATION_ERROR",
  "POSTGRESQL_CHILD_LOCK_FILE_ERROR",
  "POSTGRESQL_CHILD_DATA_VERSION_ERROR",
  "POSTGRESQL_CHILD_EXIT_NONZERO",
  "POSTGRESQL_CHILD_EXIT_ZERO"
]) {
  assert.match(host, new RegExp(`"${code}"`, "u"));
}
assert.match(
  host,
  /TryLogCode\(diagnostics\.CodeForExit\(childExitCode\)[\s\S]*TryLogCode\("CHILD_EXIT_UNEXPECTED"/u
);
assert.doesNotMatch(host, /StringBuilder/u);
assert.doesNotMatch(host, /TryLogCode\([^\n]*args\.Data/u);
assert.doesNotMatch(host, /AppendAllText\([^;]*args\.Data/u);
assert.match(host, /environment\.Clear\(\)/u);
assert.match(host, /environment\["PATH"\] = executableDirectory/u);
assert.match(
  host,
  /commandProcessor = Path\.Combine\(systemRoot, "System32", "cmd\.exe"\)/u
);
assert.match(host, /RequiredFile\(commandProcessor\)/u);
assert.match(host, /environment\["COMSPEC"\] = commandProcessor/u);
assert.match(
  host,
  /environment\["QUICKHACK_WINDOWS_SECRET_SCOPE"\] = "LOCAL_MACHINE"/u
);
assert.match(host, /CreateJobObject/u);
assert.match(host, /AssignProcessToJobObject/u);
assert.match(host, /JobObjectLimitKillOnJobClose/u);
assert.match(host, /TerminateJobObject/u);
assert.doesNotMatch(host, /Environment\.GetEnvironmentVariable\("PATH"\)/u);
assert.doesNotMatch(host, /Environment\.GetEnvironmentVariable\("COMSPEC"\)/u);
assert.match(build, /\/platform:x64/u);
assert.match(build, /QUICKHACK_POSTGRESQL/u);
assert.match(build, /QUICKHACK_CONSOLE/u);
assert.match(nativeTest, /QuickHackPreviewDemoPostgreSQL/u);
assert.match(nativeTest, /QuickHackPreviewDemoServerConsole/u);
assert.match(nativeTest, /Add-AppxPackage/u);
assert.match(nativeTest, /Remove-AppxPackage/u);
assert.match(nativeTest, /ParentProcessId/u);
assert.match(nativeTest, /orphan/iu);

console.log("QuickHack package-owned MSIX service host and native feasibility contract verified.");
