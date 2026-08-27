import { app, BrowserWindow, ipcMain, nativeTheme, Notification, session, systemPreferences, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { DESKTOP_IPC } from "./shared/desktop-contract";
import { createClientRuntimeHost } from "./main/client-runtime-host";
import { createNativeBroker } from "./main/native-broker";
import { createWindowManager, isAllowedDesktopUrl } from "./main/window-manager";
import { createNativeAdapterHandlers } from "./main/native-adapters";
import { createDesktopUpdateCoordinator, unavailablePackageUpdateAdapter } from "./shared/update-contract";

const appRoot = path.resolve(process.env.QUICKHACK_APP_ROOT || app.getAppPath());
const origin = process.env.QUICKHACK_CLIENT_ORIGIN || "http://127.0.0.1:3001";
const preloadPath = path.join(__dirname, "preload.cjs");
const broker = createNativeBroker({
  platform: process.platform,
  runtimeDirectory: path.join(app.getPath("userData"), "runtime"),
  handlers: createNativeAdapterHandlers({
    platform: process.platform,
    appRoot,
    runtimeDirectory: path.join(app.getPath("userData"), "runtime"),
  }),
});
const runtime = createClientRuntimeHost({
  appRoot,
  origin,
  environment: process.env,
  childEnvironment: {
    QUICKHACK_DESKTOP_BROKER_ENDPOINT: broker.endpoint,
    QUICKHACK_DESKTOP_BROKER_SECRET: broker.secret,
    QUICKHACK_DESKTOP_BROKER_INSTANCE_ID: broker.instanceId,
    QUICKHACK_CLIENT_FAMILY: process.env.QUICKHACK_ARTIFACT_KIND === "OPERATIONAL_CLIENT" ? "ELECTRON_OPERATIONAL" : process.env.QUICKHACK_ARTIFACT_KIND === "DEMONSTRATION_CLIENT" ? "ELECTRON_DEMONSTRATION" : "ELECTRON_DEVELOPMENT",
    QUICKHACK_CLIENT_VERSION: app.getVersion(),
    QUICKHACK_UPDATE_CHANNEL: process.env.QUICKHACK_UPDATE_CHANNEL ?? "development",
  },
});
const windows = createWindowManager({ origin, preloadPath });
const updates = createDesktopUpdateCoordinator({
  currentVersion: app.getVersion(),
  adapter: unavailablePackageUpdateAdapter,
  publish: (snapshot) => windows.get("main")?.webContents.send(DESKTOP_IPC.updateChanged, snapshot),
});
let quitting = false;
let mainCloseApproved = false;
let mainClosePending = false;

function requestGuardedMainClose() {
  const mainWindow = windows.get("main");
  if (!mainWindow || mainWindow.isDestroyed() || mainClosePending) return;
  mainClosePending = true;
  mainWindow.webContents.send(DESKTOP_IPC.closeRequested);
}

function attachMainCloseGuard(window: BrowserWindow) {
  window.on("close", (event) => {
    if (mainCloseApproved) return;
    event.preventDefault();
    requestGuardedMainClose();
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const mainWindow = windows.get("main");
  const frameUrl = event.senderFrame?.url ?? "";
  if (!senderWindow || senderWindow !== mainWindow || !isAllowedDesktopUrl(origin, frameUrl)) {
    const error = new Error("Desktop IPC sender is not trusted.");
    Object.assign(error, { code: "DESKTOP_IPC_SENDER_REJECTED" });
    throw error;
  }
}

function registerIpc() {
  ipcMain.handle(DESKTOP_IPC.environment, (event) => {
    assertTrustedSender(event);
    return Object.freeze({
      platform: process.platform,
      theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      reducedMotion: systemPreferences.getAnimationSettings().prefersReducedMotion,
    });
  });
  ipcMain.handle(DESKTOP_IPC.openOutputWindow, (event) => {
    assertTrustedSender(event);
    windows.create("output");
  });
  ipcMain.handle(DESKTOP_IPC.openAdbWindow, (event) => {
    assertTrustedSender(event);
    windows.create("adb");
  });
  ipcMain.handle(DESKTOP_IPC.closeWindow, (event) => {
    assertTrustedSender(event);
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle(DESKTOP_IPC.confirmClose, (event) => {
    assertTrustedSender(event);
    mainCloseApproved = true;
    mainClosePending = false;
    windows.get("main")?.close();
  });
  ipcMain.handle(DESKTOP_IPC.showNotification, (event, value: unknown) => {
    assertTrustedSender(event);
    if (!Notification.isSupported() || !value || typeof value !== "object") return false;
    const input = value as { title?: unknown; body?: unknown };
    const title = String(input.title ?? "").trim().slice(0, 120);
    const body = String(input.body ?? "").trim().slice(0, 500);
    if (!title || !body) return false;
    new Notification({ title, body }).show();
    return true;
  });
  ipcMain.handle(DESKTOP_IPC.updateState, (event) => { assertTrustedSender(event); return updates.snapshot(); });
  ipcMain.handle(DESKTOP_IPC.updateCheck, (event) => { assertTrustedSender(event); return updates.check(); });
  ipcMain.handle(DESKTOP_IPC.updateApply, async (event) => {
    assertTrustedSender(event);
    const snapshot = await updates.apply();
    if (snapshot.state === "APPLYING") requestGuardedMainClose();
    return snapshot;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => windows.create("main"));
  app.on("before-quit", (event) => {
    if (!mainCloseApproved && windows.get("main")) {
      event.preventDefault();
      requestGuardedMainClose();
      return;
    }
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void runtime.stop().finally(() => broker.stop()).finally(() => {
      windows.closeAll();
      app.quit();
    });
  });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    registerIpc();
    try {
      await broker.start();
      await runtime.start();
      attachMainCloseGuard(windows.create("main"));
    } catch (error) {
      await import("electron").then(({ dialog }) => dialog.showErrorBox(
        "QuickHack 시작 실패",
        error instanceof Error ? error.message : String(error),
      ));
      app.quit();
    }
  });
  app.on("window-all-closed", () => app.quit());
}
