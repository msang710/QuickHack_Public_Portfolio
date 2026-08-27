export type DesktopUpdateState = "IDLE" | "CHECKING" | "AVAILABLE" | "DOWNLOADED" | "APPLYING" | "FAILED" | "UNAVAILABLE";
export type DesktopUpdateSnapshot = Readonly<{
  state: DesktopUpdateState;
  currentVersion: string;
  availableVersion: string | null;
  message: string;
}>;
export type PackageUpdateAdapter = Readonly<{
  check(): Promise<{ version: string } | null>;
  download(version: string): Promise<void>;
  apply(): Promise<void>;
}>;
export class PackageAdapterUnavailableError extends Error { readonly code = "PACKAGE_ADAPTER_UNAVAILABLE"; }
export const unavailablePackageUpdateAdapter: PackageUpdateAdapter = Object.freeze({
  async check() { throw new PackageAdapterUnavailableError("패키지 업데이트 어댑터가 설치되지 않았습니다."); },
  async download() { throw new PackageAdapterUnavailableError("패키지 업데이트 어댑터가 설치되지 않았습니다."); },
  async apply() { throw new PackageAdapterUnavailableError("패키지 업데이트 어댑터가 설치되지 않았습니다."); },
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
  let snapshot: DesktopUpdateSnapshot = Object.freeze({ state: "IDLE", currentVersion: input.currentVersion, availableVersion: null, message: "" });
  let operation: Promise<DesktopUpdateSnapshot> | null = null;
  const set = (next: DesktopUpdateSnapshot) => { snapshot = Object.freeze(next); input.publish(snapshot); return snapshot; };
  const fail = (error: unknown) => set({ ...snapshot, state: error instanceof PackageAdapterUnavailableError ? "UNAVAILABLE" : "FAILED", message: error instanceof Error ? error.message : String(error) });
  return Object.freeze({
    snapshot: () => snapshot,
    check: () => {
      if (operation) return operation;
      set({ ...snapshot, state: "CHECKING", message: "" });
      operation = input.adapter.check()
        .then(async (available) => {
          if (!available) return set({ ...snapshot, state: "IDLE", availableVersion: null, message: "최신 버전입니다." });
          set({ ...snapshot, state: "AVAILABLE", availableVersion: available.version, message: "업데이트를 다운로드하고 있습니다." });
          await input.adapter.download(available.version);
          return set({ ...snapshot, state: "DOWNLOADED", availableVersion: available.version, message: "업데이트를 적용할 준비가 됐습니다." });
        })
        .catch(fail)
        .finally(() => { operation = null; });
      return operation;
    },
    apply: async () => {
      if (snapshot.state !== "DOWNLOADED") throw new Error("UPDATE_NOT_READY");
      set({ ...snapshot, state: "APPLYING", message: "업데이트를 적용하고 있습니다." });
      try { await input.adapter.apply(); return snapshot; } catch (error) { return fail(error); }
    },
  });
}
