import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC, type QuickHackDesktopApi } from "./shared/desktop-contract";

const api: QuickHackDesktopApi = Object.freeze({
  environment: () => ipcRenderer.invoke(DESKTOP_IPC.environment),
  openOutputWindow: () => ipcRenderer.invoke(DESKTOP_IPC.openOutputWindow),
  openAdbWindow: () => ipcRenderer.invoke(DESKTOP_IPC.openAdbWindow),
  closeWindow: () => ipcRenderer.invoke(DESKTOP_IPC.closeWindow),
  onCloseRequested(callback) {
    const listener = () => callback();
    ipcRenderer.on(DESKTOP_IPC.closeRequested, listener);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.closeRequested, listener);
  },
  confirmClose: () => ipcRenderer.invoke(DESKTOP_IPC.confirmClose),
  showNotification: (input) => ipcRenderer.invoke(DESKTOP_IPC.showNotification, input),
  updateState: () => ipcRenderer.invoke(DESKTOP_IPC.updateState),
  checkForUpdates: () => ipcRenderer.invoke(DESKTOP_IPC.updateCheck),
  applyUpdate: () => ipcRenderer.invoke(DESKTOP_IPC.updateApply),
  onUpdateChanged(callback) {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof callback>[0]) => callback(snapshot);
    ipcRenderer.on(DESKTOP_IPC.updateChanged, listener);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.updateChanged, listener);
  },
});

contextBridge.exposeInMainWorld("quickhackDesktop", api);
