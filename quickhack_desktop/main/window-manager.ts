import { BrowserWindow, shell } from "electron";
import path from "node:path";

export type DesktopWindowKind = "main" | "output" | "adb";

export type WindowManagerOptions = Readonly<{
  origin: string;
  preloadPath: string;
}>;

const WINDOW_PATHS: Record<DesktopWindowKind, string> = {
  main: "/",
  output: "/?quickhackDesktopWindow=output",
  adb: "/?quickhackDesktopWindow=adb",
};

export function isAllowedDesktopUrl(origin: string, candidate: string): boolean {
  try { return new URL(candidate).origin === new URL(origin).origin; }
  catch { return false; }
}

export function createWindowManager(options: WindowManagerOptions) {
  const windows = new Map<DesktopWindowKind, BrowserWindow>();

  function create(kind: DesktopWindowKind) {
    const existing = windows.get(kind);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return existing;
    }
    const window = new BrowserWindow({
      width: kind === "main" ? 1440 : 1080,
      height: kind === "main" ? 900 : 760,
      minWidth: 720,
      minHeight: 540,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.resolve(options.preloadPath),
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    windows.set(kind, window);
    window.once("ready-to-show", () => window.show());
    window.once("closed", () => windows.delete(kind));
    window.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedDesktopUrl(options.origin, url)) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    void window.loadURL(new URL(WINDOW_PATHS[kind], options.origin).toString());
    return window;
  }

  return Object.freeze({
    create,
    get(kind: DesktopWindowKind) { return windows.get(kind) ?? null; },
    closeAll() {
      for (const window of windows.values()) if (!window.isDestroyed()) window.destroy();
      windows.clear();
    },
  });
}
