import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export function stageLinuxDesktop({ root, outputRoot, applicationRoot, config, version }) {
  const write = (relative, content, mode = 0o644) => {
    const filename = path.join(outputRoot, relative);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, content, { mode });
  };
  const copy = (source, destination) => {
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: true });
  };
  const identity = config.installedIdentity;
  const title = `QuickHack ${config.flavorSlug === "demonstration" ? "Demo" : "Operational"} ${config.role === "client" ? "Client" : "Server Console"}`;
  const koreanTitle = `QuickHack ${config.flavorSlug === "demonstration" ? "데모" : "운영"} ${config.role === "client" ? "클라이언트" : "서버 콘솔"}`;
  copy(path.join(root, "assets/app.png"), path.join(outputRoot, "usr/share/icons/hicolor/256x256/apps", `${identity}.png`));

  if (config.role === "client") {
    const dist = path.join(root, "node_modules/electron/dist");
    if (!existsSync(path.join(dist, "electron"))) throw new Error("Electron runtime is missing. Run node node_modules/electron/install.js before packaging.");
    const expected = JSON.parse(readFileSync(path.join(root, "node_modules/electron/package.json"), "utf8")).version;
    if (readFileSync(path.join(dist, "version"), "utf8").trim() !== expected) throw new Error("Electron runtime version does not match the installed dependency.");
    const desktop = path.join(applicationRoot, "desktop");
    copy(dist, desktop);
    rmSync(path.join(desktop, "resources/default_app.asar"), { force: true });
    const appDirectory = path.join(desktop, "resources/app");
    for (const name of ["main.cjs", "preload.cjs"]) copy(path.join(root, ".quickhack-electron", name), path.join(appDirectory, name));
    copy(path.join(root, "assets/app.png"), path.join(appDirectory, "icon.png"));
    writeFileSync(path.join(appDirectory, "package.json"), `${JSON.stringify({ name: identity, productName: title, version, main: "main.cjs", desktopName: `${identity}.desktop` }, null, 2)}\n`);
    write(`usr/bin/${config.launcherName}`, `#!/bin/sh
export QUICKHACK_PACKAGE_MANIFEST="${config.applicationRoot}/quickhack-package.json"
export QUICKHACK_APP_ROOT="${config.applicationRoot}"
export QUICKHACK_NODE_EXECUTABLE=/usr/bin/node
export QUICKHACK_ARTIFACT_KIND=${config.artifactKind}
export QUICKHACK_CLIENT_ORIGIN=http://127.0.0.1:${config.localRuntimePort}
export QUICKHACK_UPDATE_CHANNEL=linux-package
if [ "$#" -gt 0 ]; then
  exec /usr/bin/node "${config.applicationRoot}/tools/client-runtime-launcher.mjs" "$@"
fi
unset ELECTRON_RUN_AS_NODE
exec "${config.applicationRoot}/desktop/electron"
`, 0o755);
  } else {
    write(`usr/bin/${config.launcherName}-desktop`, `#!/bin/sh
set -eu
if [ -f "/var/lib/quickhack/upgrade-state/${config.flavorSlug}-upgrade.pending" ]; then
  printf '\\nQuickHack upgrade needs review. Complete the package transaction, then run sudo ${config.launcherName}-repair --recover-upgrade.\\nPress Enter to close.\\n' >&2
  read -r answer || true
  exit 1
fi
if [ -f "${config.runtimeConfig}" ]; then
  action=repair
else
  action=setup
fi
if ! /usr/bin/node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync("${config.applicationRoot}/quickhack-package.json","utf8"));fetch("http://127.0.0.1:2999/api/readiness", {signal:AbortSignal.timeout(5000)}).then(r=>r.json()).then(s=>process.exit(s.applicationState==="ACTIVE"&&s.runtimeBuildId===m.contentInventorySha256&&s.database?.state==="ACTIVE"&&s.backendReadiness?.databaseReady===true&&s.tls?.ready===true?0:1)).catch(()=>process.exit(1))'; then
  if /usr/bin/${config.launcherName}-$action; then
    printf '\\nInitial login details can be shown with: sudo /usr/bin/${config.launcherName}-initial-login\\nPress Enter to continue.\\n'
    read -r answer || true
  else
    status=$?
    printf '\\nQuickHack server setup failed (exit %s). Press Enter to close.\\n' "$status" >&2
    read -r answer || true
    exit "$status"
  fi
fi
if ! /usr/bin/systemctl is-active --quiet "${config.services.console}"; then
  printf '\\nQuickHack server console service is inactive. Press Enter to close.\\n' >&2
  read -r answer || true
  exit 1
fi
if /usr/bin/xdg-open "http://127.0.0.1:2999"; then
  exit 0
else
  status=$?
  printf '\\nQuickHack server console could not open. Press Enter to close.\\n' >&2
  read -r answer || true
  exit "$status"
fi
`, 0o755);
  }
  write(`usr/share/applications/${identity}.desktop`, `[Desktop Entry]
Type=Application
Name=${title}
Name[ko]=${koreanTitle}
Exec=/usr/bin/${config.launcherName}${config.role === "server" ? "-desktop" : ""}
TryExec=/usr/bin/${config.launcherName}
Icon=${identity}
Terminal=${config.role === "server"}
Categories=Office;
Keywords=QuickHack;ERP;WMS;
${config.role === "client" ? `StartupWMClass=${identity}\n` : ""}`);
}
