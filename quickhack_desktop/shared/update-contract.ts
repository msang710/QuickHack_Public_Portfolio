export type DesktopUpdateState = "IDLE" | "CHECKING" | "AVAILABLE" | "DOWNLOADED" | "APPLYING" | "FAILED" | "UNAVAILABLE";
export type DesktopUpdateMessageCode =
  | "UPDATE_CHECKING"
  | "UPDATE_LATEST"
  | "UPDATE_DOWNLOADING"
  | "UPDATE_READY"
  | "UPDATE_APPLYING"
  | "UPDATE_FAILED"
  | "PACKAGE_ADAPTER_UNAVAILABLE";
export type DesktopUpdateSnapshot = Readonly<{
  state: DesktopUpdateState;
  currentVersion: string;
  availableVersion: string | null;
  messageCode: DesktopUpdateMessageCode | null;
}>;
export type PackageUpdateAdapter = Readonly<{
  check(): Promise<{ version: string } | null>;
  download(version: string): Promise<void>;
  apply(): Promise<void>;
}>;
export class PackageAdapterUnavailableError extends Error { readonly code = "PACKAGE_ADAPTER_UNAVAILABLE"; }
export const unavailablePackageUpdateAdapter: PackageUpdateAdapter = Object.freeze({
  async check() { throw new PackageAdapterUnavailableError("PACKAGE_ADAPTER_UNAVAILABLE"); },
  async download() { throw new PackageAdapterUnavailableError("PACKAGE_ADAPTER_UNAVAILABLE"); },
  async apply() { throw new PackageAdapterUnavailableError("PACKAGE_ADAPTER_UNAVAILABLE"); },
});

export function transitionDesktopUpdate(state: DesktopUpdateState, event: "CHECK" | "FOUND" | "NONE" | "DOWNLOADED" | "APPLY" | "FAIL" | "UNAVAILABLE"): DesktopUpdateState {
  const allowed: Record<DesktopUpdateState, Partial<Record<typeof event, DesktopUpdateState>>> = {
    IDLE: { CHECK: "CHECKING" }, CHECKING: { FOUND: "AVAILABLE", NONE: "IDLE", FAIL: "FAILED", UNAVAILABLE: "UNAVAILABLE" },
    AVAILABLE: { DOWNLOADED: "DOWNLOADED", FAIL: "FAILED", UNAVAILABLE: "UNAVAILABLE" }, DOWNLOADED: { APPLY: "APPLYING", FAIL: "FAILED", UNAVAILABLE: "UNAVAILABLE" },
    APPLYING: { FAIL: "FAILED" }, FAILED: { CHECK: "CHECKING" }, UNAVAILABLE: { CHECK: "CHECKING" },
  };
  const next = allowed[state][event];
  if (!next) throw new Error(`UPDATE_TRANSITION_INVALID:${state}:${event}`);
  return next;
}

export function createDesktopUpdateCoordinator(input: {
  currentVersion: string;
  adapter: PackageUpdateAdapter;
  publish(snapshot: DesktopUpdateSnapshot): void;
}) {
  let snapshot: DesktopUpdateSnapshot = Object.freeze({ state: "IDLE", currentVersion: input.currentVersion, availableVersion: null, messageCode: null });
  let operation: Promise<DesktopUpdateSnapshot> | null = null;
  const set = (next: DesktopUpdateSnapshot) => { snapshot = Object.freeze(next); input.publish(snapshot); return snapshot; };
  const fail = (error: unknown) => set({
    ...snapshot,
    state: error instanceof PackageAdapterUnavailableError ? "UNAVAILABLE" : "FAILED",
    messageCode: error instanceof PackageAdapterUnavailableError
      ? "PACKAGE_ADAPTER_UNAVAILABLE"
      : "UPDATE_FAILED",
  });
  return Object.freeze({
    snapshot: () => snapshot,
    check: () => {
      if (operation) return operation;
      set({ ...snapshot, state: "CHECKING", messageCode: "UPDATE_CHECKING" });
      operation = input.adapter.check()
        .then(async (available) => {
          if (!available) return set({ ...snapshot, state: "IDLE", availableVersion: null, messageCode: "UPDATE_LATEST" });
          set({ ...snapshot, state: "AVAILABLE", availableVersion: available.version, messageCode: "UPDATE_DOWNLOADING" });
          await input.adapter.download(available.version);
          return set({ ...snapshot, state: "DOWNLOADED", availableVersion: available.version, messageCode: "UPDATE_READY" });
        })
        .catch(fail)
        .finally(() => { operation = null; });
      return operation;
    },
    apply: async () => {
      if (snapshot.state !== "DOWNLOADED") throw new Error("UPDATE_NOT_READY");
      set({ ...snapshot, state: "APPLYING", messageCode: "UPDATE_APPLYING" });
      try { await input.adapter.apply(); return snapshot; } catch (error) { return fail(error); }
    },
  });
}
