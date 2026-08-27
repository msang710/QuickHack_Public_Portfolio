import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../support/project-root.mjs";

const main = readFileSync(path.join(projectRoot, "quickhack_desktop/main.ts"), "utf8");
const preload = readFileSync(path.join(projectRoot, "quickhack_desktop/preload.ts"), "utf8");
const windows = readFileSync(path.join(projectRoot, "quickhack_desktop/main/window-manager.ts"), "utf8");

assert.match(main, /requestSingleInstanceLock\(\)/u);
assert.match(main, /assertTrustedSender\(event\)/u);
assert.match(main, /setPermissionRequestHandler/u);
assert.match(main, /setPermissionCheckHandler/u);
assert.match(windows, /nodeIntegration:\s*false/u);
assert.match(windows, /contextIsolation:\s*true/u);
assert.match(windows, /sandbox:\s*true/u);
assert.match(windows, /setWindowOpenHandler/u);
assert.match(windows, /will-navigate/u);
assert.doesNotMatch(preload, /(?:on|send):\s*ipcRenderer\.(?:on|send)|exposeInMainWorld\([^,]+,\s*ipcRenderer/u);
assert.match(preload, /ipcRenderer\.on\(DESKTOP_IPC\.closeRequested, listener\)/u);
assert.match(preload, /const listener = \(\) => callback\(\)/u);
assert.equal((windows.match(/quickhackDesktopWindow=output/gu) || []).length, 1);
assert.equal((windows.match(/quickhackDesktopWindow=adb/gu) || []).length, 1);

console.log("Electron main, preload and BrowserWindow security contracts verified.");
