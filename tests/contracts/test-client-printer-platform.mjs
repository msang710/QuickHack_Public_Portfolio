import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createLinuxPrinterBackend } from "../../quickhack_client/platform/linux/printer-backend.ts";
import { createWindowsPrinterBackend } from "../../quickhack_client/platform/windows/printer-backend.ts";
import { projectRoot } from "../support/project-root.mjs";

const fixture = JSON.parse(
  readFileSync(
    path.join(
      projectRoot,
      "tests",
      "contracts",
      "fixtures",
      "client-hardware-adapter-cases.json"
    ),
    "utf8"
  )
);
const requestedBytes = 4096;

function missing() {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function fileState(size = 128) {
  return {
    size,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

function windowsFile(filename) {
  if (filename === fixture.windows.printerBridge) return fileState();
  if (filename === fixture.windows.spoolPath) return fileState(requestedBytes);
  throw missing();
}

const windowsCalls = [];
const windowsBackend = createWindowsPrinterBackend({
  lstatFile: async (filename) => windowsFile(filename),
  executeFile: async (executable, args, options) => {
    windowsCalls.push({ executable, args: [...args], options });
    if (args.includes("List")) {
      return {
        stdout: JSON.stringify([
          {
            name: "TSC DA200",
            isDefault: true,
            isOffline: false,
            status: "UNKNOWN",
          },
        ]),
      };
    }
    if (args.includes("Print")) {
      return {
        stdout: JSON.stringify({
          ok: true,
          requestedBytes,
          writtenBytes: requestedBytes,
        }),
      };
    }
    return { stdout: "" };
  },
});
const windowsContext = {
  appRoot: fixture.windows.appRoot,
  runtimeDir: fixture.windows.runtimeDir,
  environment: { Path: "C:\\hostile", SystemRoot: "C:\\Windows" },
};
assert.deepEqual(await windowsBackend.list(windowsContext), [
  {
    name: "TSC DA200",
    isDefault: true,
    isOffline: false,
    status: "UNKNOWN",
  },
]);
const windowsResult = await windowsBackend.submit({
  ...windowsContext,
  printerName: "TSC DA200",
  spoolPath: fixture.windows.spoolPath,
  requestedBytes,
});
assert.deepEqual(windowsResult, {
  status: "SPOOLED",
  requestedBytes,
  writtenBytes: requestedBytes,
  errorCode: null,
  errorMessage: null,
  nativeJobId: null,
});
const windowsPrintCalls = windowsCalls.filter((call) => call.args.includes("Print"));
assert.equal(windowsPrintCalls.length, 1);
assert.deepEqual(windowsPrintCalls[0].args.slice(-6), [
  "-Action",
  "Print",
  "-PrinterName",
  "TSC DA200",
  "-InputPath",
  fixture.windows.spoolPath,
]);
assert.doesNotMatch(windowsPrintCalls[0].options.env.Path, /hostile/i);

const aclCalls = [];
const windowsAclBackend = createWindowsPrinterBackend({
  lstatFile: async (filename) => windowsFile(filename),
  executeFile: async (executable, args, options) => {
    aclCalls.push({ executable, args: [...args], options });
    return { stdout: "" };
  },
});
await windowsAclBackend.secureSpoolDirectory({
  ...windowsContext,
  directory: "C:\\QuickHackData\\print-spool",
});
assert.equal(aclCalls.length, 1);
assert.deepEqual(aclCalls[0].args.slice(0, 3), [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
]);
assert.equal(
  aclCalls[0].options.env.QUICKHACK_PRINT_SPOOL_ACL_DIR,
  "C:\\QuickHackData\\print-spool"
);

function windowsFailureBackend(printOperation) {
  return createWindowsPrinterBackend({
    lstatFile: async (filename) => windowsFile(filename),
    executeFile: async (_executable, args) => {
      if (args.includes("List")) {
        return { stdout: JSON.stringify({ name: "TSC DA200" }) };
      }
      return printOperation(args);
    },
  });
}

const partial = await windowsFailureBackend(async () => ({
  stdout: JSON.stringify({
    ok: false,
    requestedBytes,
    writtenBytes: requestedBytes - 1,
  }),
})).submit({
  ...windowsContext,
  printerName: "TSC DA200",
  spoolPath: fixture.windows.spoolPath,
  requestedBytes,
});
assert.equal(partial.status, "FAILED");
assert.equal(partial.errorCode, "PARTIAL_SPOOL_WRITE");

let windowsTimeoutPrints = 0;
const windowsTimeout = await windowsFailureBackend(async () => {
  windowsTimeoutPrints += 1;
  throw Object.assign(new Error("timed out"), {
    code: null,
    killed: true,
    signal: "SIGTERM",
  });
}).submit({
  ...windowsContext,
  printerName: "TSC DA200",
  spoolPath: fixture.windows.spoolPath,
  requestedBytes,
});
assert.equal(windowsTimeout.status, "UNKNOWN");
assert.equal(windowsTimeout.errorCode, "PRINTER_SUBMIT_TIMEOUT");
assert.equal(windowsTimeoutPrints, 1);

const windowsUnknown = await windowsFailureBackend(async () => ({
  stdout: "not-json",
})).submit({
  ...windowsContext,
  printerName: "TSC DA200",
  spoolPath: fixture.windows.spoolPath,
  requestedBytes,
});
assert.equal(windowsUnknown.status, "UNKNOWN");
assert.equal(windowsUnknown.errorCode, "PRINTER_ACCEPTANCE_UNKNOWN");

function linuxFile(filename) {
  if (["/usr/bin/lpstat", "/usr/bin/lp"].includes(filename)) return fileState();
  if (filename === fixture.linux.spoolPath) return fileState(requestedBytes);
  throw missing();
}

const linuxCalls = [];
const linuxBackend = createLinuxPrinterBackend({
  lstatFile: async (filename) => linuxFile(filename),
  accessFile: async () => {},
  executeFile: async (executable, args, options) => {
    linuxCalls.push({ executable, args: [...args], options });
    if (executable === "/usr/bin/lpstat") {
      return {
        stdout:
          `printer ${fixture.linux.printerName} is idle. enabled since now\n` +
          `system default destination: ${fixture.linux.printerName}\n`,
      };
    }
    return {
      stdout: `request id is ${fixture.linux.printerName}-42 (1 file(s))`,
    };
  },
});
const linuxContext = {
  appRoot: fixture.linux.appRoot,
  runtimeDir: fixture.linux.runtimeDir,
  environment: { PATH: "/tmp/hostile", HOME: "/home/quickhack" },
};
assert.deepEqual(await linuxBackend.list(linuxContext), [
  {
    name: fixture.linux.printerName,
    isDefault: true,
    isOffline: false,
    status: "IDLE",
  },
]);
const linuxResult = await linuxBackend.submit({
  ...linuxContext,
  printerName: fixture.linux.printerName,
  spoolPath: fixture.linux.spoolPath,
  requestedBytes,
});
assert.deepEqual(linuxResult, {
  status: "SPOOLED",
  requestedBytes,
  writtenBytes: requestedBytes,
  errorCode: null,
  errorMessage: null,
  nativeJobId: `${fixture.linux.printerName}-42`,
});
const linuxSubmitCalls = linuxCalls.filter((call) => call.executable === "/usr/bin/lp");
assert.equal(linuxSubmitCalls.length, 1);
assert.deepEqual(linuxSubmitCalls[0].args, [
  "-d",
  fixture.linux.printerName,
  "-o",
  "raw",
  fixture.linux.spoolPath,
]);
assert.equal(linuxSubmitCalls[0].options.env.LC_ALL, "C");
assert.doesNotMatch(linuxSubmitCalls[0].options.env.PATH, /hostile/);

let injectionCalls = 0;
const injectionBackend = createLinuxPrinterBackend({
  lstatFile: async (filename) => linuxFile(filename),
  accessFile: async () => {},
  executeFile: async () => {
    injectionCalls += 1;
    return { stdout: "" };
  },
});
const injection = await injectionBackend.submit({
  ...linuxContext,
  printerName: "-o-sides=two-sided-long-edge",
  spoolPath: fixture.linux.spoolPath,
  requestedBytes,
});
assert.equal(injection.status, "FAILED");
assert.equal(injection.errorCode, "INVALID_PRINTER_NAME");
assert.equal(injectionCalls, 0);

function linuxFailureBackend(submitOperation) {
  let submits = 0;
  const backend = createLinuxPrinterBackend({
    lstatFile: async (filename) => linuxFile(filename),
    accessFile: async () => {},
    executeFile: async (executable) => {
      if (executable === "/usr/bin/lpstat") {
        return {
          stdout: `printer ${fixture.linux.printerName} is idle. enabled since now`,
        };
      }
      submits += 1;
      return submitOperation();
    },
  });
  return { backend, submitCount: () => submits };
}

const linuxTimeoutFixture = linuxFailureBackend(async () => {
  throw Object.assign(new Error("timed out"), {
    code: null,
    killed: true,
    signal: "SIGTERM",
  });
});
const linuxTimeout = await linuxTimeoutFixture.backend.submit({
  ...linuxContext,
  printerName: fixture.linux.printerName,
  spoolPath: fixture.linux.spoolPath,
  requestedBytes,
});
assert.equal(linuxTimeout.status, "UNKNOWN");
assert.equal(linuxTimeout.errorCode, "PRINTER_SUBMIT_TIMEOUT");
assert.equal(linuxTimeoutFixture.submitCount(), 1);

const linuxUnknownFixture = linuxFailureBackend(async () => ({
  stdout: "job accepted maybe",
}));
const linuxUnknown = await linuxUnknownFixture.backend.submit({
  ...linuxContext,
  printerName: fixture.linux.printerName,
  spoolPath: fixture.linux.spoolPath,
  requestedBytes,
});
assert.equal(linuxUnknown.status, "UNKNOWN");
assert.equal(linuxUnknownFixture.submitCount(), 1);

const printerServiceSource = readFileSync(
  path.join(projectRoot, "quickhack_client", "printing", "printer-service.ts"),
  "utf8"
);
assert.doesNotMatch(
  printerServiceSource,
  /node:child_process|process\.platform|PowerShell|powershell|\bCUPS\b/i
);
assert.match(printerServiceSource, /requestNativeBroker\("printer\.list"/);
assert.match(printerServiceSource, /requestNativeBroker\("printer\.print"/);
assert.doesNotMatch(printerServiceSource, /platform\.printerBackend\.submit/);

const shipmentOrderListSource = readFileSync(
  path.join(
    projectRoot,
    "quickhack_client",
    "components",
    "shipment",
    "shipment-order-list-view.tsx"
  ),
  "utf8"
);
assert.match(shipmentOrderListSource, /function localPrintErrorKey/);
assert.match(shipmentOrderListSource, /localPrintErrorMessage\(\s*job\?\.errorCode/);
assert.match(shipmentOrderListSource, /localPrintErrorMessage\(\s*payload\.job\.errorCode/);
assert.doesNotMatch(
  shipmentOrderListSource,
  /throw new Error\(\s*job\?\.errorMessage/
);
const spoolCoreSource = readFileSync(
  path.join(projectRoot, "tools", "client-print-spool-core.mjs"),
  "utf8"
);
assert.doesNotMatch(spoolCoreSource, /process\.platform|PowerShell|powershell/i);
assert.match(spoolCoreSource, /explicit supported client platform/);
const launcherSource = readFileSync(
  path.join(projectRoot, "tools", "client-runtime-launcher.mjs"),
  "utf8"
);
assert.match(launcherSource, /platform:\s*clientPlatform\.platform/);
assert.match(launcherSource, /printerBackend\.secureSpoolDirectory/);

console.log("Windows RAW and Linux CUPS printer adapter outcomes and no-replay boundaries verified.");
