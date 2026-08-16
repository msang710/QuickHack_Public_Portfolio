import { createWindowsServiceProcess } from "../../../tools/platform/windows/windows-service-process.mjs";

function descriptor(platform) {
  return Object.freeze({
    id: "postgresql-service-controller",
    role: "server",
    platform,
    state: "COMPATIBILITY",
    ownerStage: "PR-09",
  });
}

export function createWindowsPostgresqlServiceController(options = {}) {
  const platform = options.platform ?? "win32";
  const serviceProcess = options.serviceProcess ?? createWindowsServiceProcess(options);
  async function installer(input) {
    const installerAdapter = await import("../../../tools/platform/windows/postgresql-service-install.mjs");
    return installerAdapter.installPostgresqlService(input);
  }
  return Object.freeze({
    descriptor: descriptor(platform),
    install: options.install ?? installer,
    repair: options.repair ?? options.install ?? installer,
    start() { return serviceProcess.operate("START", "POSTGRESQL"); },
    stop() { return serviceProcess.operate("STOP", "POSTGRESQL"); },
    restart() { return serviceProcess.operate("RESTART", "POSTGRESQL"); },
    status() { return serviceProcess.status("POSTGRESQL"); },
  });
}
