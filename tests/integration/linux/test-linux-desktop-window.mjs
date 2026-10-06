import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { _electron as electron } from "playwright";

// Exercise the packaged main/preload and renderer with an isolated runtime stub.
// Real server pairing and device operations remain separate integration checks.
const desktop = path.resolve(process.argv[2] || "release/linux/demo-client/pkgroot/usr/lib/quickhack/demonstration-client/desktop");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "quickhack-desktop-window-"));
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<!doctype html><title>QuickHack package smoke</title><h1>QuickHack package smoke</h1>");
});
let application;
let virtualDisplay;
try {
  virtualDisplay = spawn(process.env.QUICKHACK_TEST_XVFB || "Xvfb", ["-displayfd", "3", "-screen", "0", "1440x900x24", "-nolisten", "tcp", "-ac"], { stdio: ["ignore", "ignore", "inherit", "pipe"] });
  const display = await new Promise((resolve, reject) => {
    virtualDisplay.once("error", reject);
    virtualDisplay.once("exit", (code) => reject(new Error(`Xvfb exited: ${code}`)));
    virtualDisplay.stdio[3].once("data", (data) => resolve(`:${String(data).trim()}`));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await fs.mkdir(path.join(temporary, "tools"));
  await fs.writeFile(path.join(temporary, "tools/client-runtime-launcher.mjs"), "process.exit(0);\n");
  const environment = { ...process.env, HOME: temporary, XDG_CONFIG_HOME: path.join(temporary, "config"), XDG_CACHE_HOME: path.join(temporary, "cache"), QUICKHACK_APP_ROOT: temporary, QUICKHACK_NODE_EXECUTABLE: process.execPath, QUICKHACK_ARTIFACT_KIND: "DEMONSTRATION_CLIENT", QUICKHACK_CLIENT_ORIGIN: `http://127.0.0.1:${server.address().port}` };
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.DISPLAY = display;
  delete environment.WAYLAND_DISPLAY;
  application = await electron.launch({
    executablePath: path.join(desktop, "electron"),
    args: [path.join(desktop, "resources/app"), "--ozone-platform=x11", "--disable-gpu", "--disable-setuid-sandbox"],
    env: environment,
    timeout: 30_000,
  });
  const window = await application.firstWindow();
  await window.waitForSelector("h1");
  assert.equal(await window.title(), "QuickHack package smoke");
  const state = await application.evaluate(({ app, BrowserWindow }) => ({
    name: app.getName(), version: app.getVersion(), userData: app.getPath("userData"),
    preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  }));
  assert.equal(state.name, "QuickHack Demo Client");
  assert.ok(state.userData.endsWith("quickhack-demonstration-client"));
  assert.equal(state.preferences.contextIsolation, true);
  assert.equal(state.preferences.sandbox, true);
  assert.equal(state.preferences.nodeIntegration, false);
  console.log(JSON.stringify({ status: "PASS", version: state.version, packagedWindow: true, rendererSandboxConfigured: true, harness: "Playwright Electron (adds --no-sandbox)" }));
} finally {
  if (application) {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await application.close().catch(() => {});
  }
  await new Promise((resolve) => server.close(resolve));
  virtualDisplay?.kill();
  await fs.rm(temporary, { recursive: true, force: true });
}
