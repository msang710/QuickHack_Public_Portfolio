export const DESKTOP_IPC = Object.freeze({
  environment: "quickhack:desktop:environment",
  openOutputWindow: "quickhack:desktop:open-output-window",
  openAdbWindow: "quickhack:desktop:open-adb-window",
  closeWindow: "quickhack:desktop:close-window",
  closeRequested: "quickhack:desktop:close-requested",
  confirmClose: "quickhack:desktop:confirm-close",
  showNotification: "quickhack:desktop:show-notification",
  updateState: "quickhack:desktop:update-state",
  updateCheck: "quickhack:desktop:update-check",
  updateApply: "quickhack:desktop:update-apply",
  updateChanged: "quickhack:desktop:update-changed",
});

export type DesktopEnvironment = Readonly<{
  platform: NodeJS.Platform;
  theme: "dark" | "light";
  reducedMotion: boolean;
}>;

export type QuickHackDesktopApi = Readonly<{
  environment(): Promise<DesktopEnvironment>;
  openOutputWindow(): Promise<void>;
  openAdbWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  onCloseRequested(callback: () => void): () => void;
  confirmClose(): Promise<void>;
  showNotification(input: { title: string; body: string }): Promise<boolean>;
  updateState(): Promise<import("./update-contract").DesktopUpdateSnapshot>;
  checkForUpdates(): Promise<import("./update-contract").DesktopUpdateSnapshot>;
  applyUpdate(): Promise<import("./update-contract").DesktopUpdateSnapshot>;
  onUpdateChanged(callback: (snapshot: import("./update-contract").DesktopUpdateSnapshot) => void): () => void;
}>;

declare global {
  interface Window {
    quickhackDesktop?: QuickHackDesktopApi;
  }
}
