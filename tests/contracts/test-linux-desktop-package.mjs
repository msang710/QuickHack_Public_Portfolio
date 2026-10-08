import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stageLinuxDesktop } from "../../packaging/linux/stage-desktop.mjs";
import { LINUX_PACKAGE_TARGETS, linuxArtifactConfig } from "../../packaging/linux/linux-artifact-config.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "quickhack-desktop-package-"));
const write = (name, content) => {
  const filename = path.join(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
};
try {
  write("node_modules/electron/package.json", JSON.stringify({ version: "44.1.0" }));
  write("node_modules/electron/dist/version", "44.1.0");
  write("node_modules/electron/dist/electron", "fixture executable");
  write("node_modules/electron/dist/resources/default_app.asar", "development app");
  write(".quickhack-electron/main.cjs", "main fixture");
  write(".quickhack-electron/preload.cjs", "preload fixture");
  write("assets/app.png", "icon fixture");
  for (const target of LINUX_PACKAGE_TARGETS) {
    const config = linuxArtifactConfig(target);
    const outputRoot = path.join(root, target);
    const applicationRoot = path.join(outputRoot, config.applicationRoot);
    stageLinuxDesktop({ root, outputRoot, applicationRoot, config, version: "1.0.1" });
    const entry = path.join(outputRoot, "usr/share/applications", `${config.installedIdentity}.desktop`);
    const desktop = fs.readFileSync(entry, "utf8");
    assert.match(desktop, new RegExp(`Icon=${config.installedIdentity}`));
    assert.ok(fs.existsSync(path.join(outputRoot, "usr/share/icons/hicolor/256x256/apps", `${config.installedIdentity}.png`)));
    const validation = spawnSync("desktop-file-validate", [entry], { encoding: "utf8" });
    assert.equal(validation.status, 0, validation.stderr || validation.error?.message);
    if (config.role === "client") {
      assert.match(desktop, /Terminal=false/);
      assert.match(desktop, new RegExp(`Exec=/usr/bin/${config.launcherName}$`, "m"));
      const appDirectory = path.join(applicationRoot, "desktop/resources/app");
      const metadata = JSON.parse(fs.readFileSync(path.join(appDirectory, "package.json")));
      assert.equal(metadata.name, config.installedIdentity);
      assert.equal(metadata.version, "1.0.1");
      assert.equal(metadata.desktopName, `${config.installedIdentity}.desktop`);
      assert.ok(fs.existsSync(path.join(appDirectory, metadata.main)));
      assert.ok(fs.existsSync(path.join(appDirectory, "preload.cjs")));
      assert.ok(!fs.existsSync(path.join(applicationRoot, "desktop/resources/default_app.asar")));
      const launcher = fs.readFileSync(path.join(outputRoot, "usr/bin", config.launcherName), "utf8");
      assert.match(launcher, new RegExp(`QUICKHACK_ARTIFACT_KIND=${config.artifactKind}`));
      assert.match(launcher, new RegExp(`127.0.0.1:${config.localRuntimePort}`));
      assert.match(launcher, /QUICKHACK_NODE_EXECUTABLE=\/usr\/bin\/node/);
      assert.doesNotMatch(launcher, /--no-sandbox/);
    } else {
      assert.match(desktop, /Terminal=true/);
      assert.ok(!fs.existsSync(path.join(applicationRoot, "desktop")));
      const launcher = fs.readFileSync(path.join(outputRoot, "usr/bin", `${config.launcherName}-desktop`), "utf8");
      assert.match(launcher, /action=setup/);
      assert.match(launcher, /action=repair/);
      assert.match(launcher, /api\/readiness/);
      assert.doesNotMatch(launcher, /integration\?\.ready/);
      assert.match(launcher, /initial-login/);
      assert.match(launcher, /exit/);
      assert.doesNotMatch(launcher, /\[ ! -f .*server-runtime\.json/);
      assert.match(launcher, /server setup failed/i);
    }
  }
  fs.writeFileSync(path.join(root, "node_modules/electron/dist/version"), "43.0.0");
  assert.throws(() => stageLinuxDesktop({ root, outputRoot: path.join(root, "invalid"), applicationRoot: path.join(root, "invalid/app"), config: linuxArtifactConfig("demo-client"), version: "1.0.1" }), /version/i);
  console.log("Linux desktop entries, packaged Electron, flavor isolation and runtime version checks passed.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
