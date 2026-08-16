import { createSystemdServiceProcess } from "../../../tools/platform/linux/systemd-service-process.mjs";

function descriptor(platform) {
  return Object.freeze({
    id: "postgresql-service-controller",
    role: "server",
    platform,
    state: "READY",
    ownerStage: "PR-09",
  });
}

export function createLinuxPostgresqlServiceController(options = {}) {
  const platform = options.platform ?? "linux";
  const serviceProcess = options.serviceProcess ?? createSystemdServiceProcess(options);
  let controller;
  async function installer(input) {
    const installerAdapter = await import("../../../tools/platform/linux/postgresql-service-install.mjs");
    return installerAdapter.installLinuxPostgresqlService(input, { controller });
  }
  controller = Object.freeze({
    descriptor: descriptor(platform),
    install: options.install ?? installer,
    repair: options.repair ?? options.install ?? installer,
    start() { return serviceProcess.operate("START", "POSTGRESQL"); },
    stop() { return serviceProcess.operate("STOP", "POSTGRESQL"); },
    restart() { return serviceProcess.operate("RESTART", "POSTGRESQL"); },
    status() { return serviceProcess.status("POSTGRESQL"); },
  });
  return controller;
}
