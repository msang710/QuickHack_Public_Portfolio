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
assert.match(host, /environment\.Clear\(\)/u);
assert.match(host, /environment\["PATH"\] = executableDirectory/u);
assert.match(
  host,
  /environment\["QUICKHACK_WINDOWS_SECRET_SCOPE"\] = "LOCAL_MACHINE"/u
);
assert.match(host, /CreateJobObject/u);
assert.match(host, /AssignProcessToJobObject/u);
assert.match(host, /JobObjectLimitKillOnJobClose/u);
assert.match(host, /TerminateJobObject/u);
assert.doesNotMatch(host, /Environment\.GetEnvironmentVariable\("PATH"\)/u);
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
