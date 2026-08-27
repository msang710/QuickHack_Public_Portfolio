"use client";

import * as React from "react";
import type { DesktopEnvironment, QuickHackDesktopApi } from "@/quickhack_desktop/shared/desktop-contract";

const STORAGE_KEY = "quickhack.desktop.appearance.v1";

export type DesktopAppearance = Readonly<{
  theme: "system" | "light" | "dark";
  fontFamily: "system" | "compact";
  fontSize: number;
  scale: number;
}>;

const DEFAULT_APPEARANCE: DesktopAppearance = Object.freeze({
  theme: "system",
  fontFamily: "system",
  fontSize: 16,
  scale: 1,
});

function bounded(value: unknown, fallback: number, minimum: number, maximum: number, step: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(maximum, Math.max(minimum, parsed)) / step) * step;
}

export function normalizeDesktopAppearance(value: unknown): DesktopAppearance {
  const input = value && typeof value === "object" ? value as Partial<DesktopAppearance> : {};
  return Object.freeze({
    theme: ["system", "light", "dark"].includes(String(input.theme)) ? input.theme as DesktopAppearance["theme"] : DEFAULT_APPEARANCE.theme,
    fontFamily: ["system", "compact"].includes(String(input.fontFamily)) ? input.fontFamily as DesktopAppearance["fontFamily"] : DEFAULT_APPEARANCE.fontFamily,
    fontSize: bounded(input.fontSize, DEFAULT_APPEARANCE.fontSize, 13, 20, 1),
    scale: bounded(input.scale, DEFAULT_APPEARANCE.scale, 0.85, 1.25, 0.05),
  });
}

type DesktopCapabilityContextValue = Readonly<{
  api: QuickHackDesktopApi | null;
  environment: DesktopEnvironment | null;
  appearance: DesktopAppearance;
  setAppearance: (next: DesktopAppearance) => void;
  resetAppearance: () => void;
}>;

const DesktopCapabilityContext = React.createContext<DesktopCapabilityContextValue | null>(null);

export function DesktopCapabilityProvider({ children }: { children: React.ReactNode }) {
  const [api] = React.useState<QuickHackDesktopApi | null>(() => window.quickhackDesktop ?? null);
  const [environment, setEnvironment] = React.useState<DesktopEnvironment | null>(null);
  const [appearance, setAppearanceState] = React.useState<DesktopAppearance>(() => {
    try { return normalizeDesktopAppearance(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")); }
    catch { return DEFAULT_APPEARANCE; }
  });

  React.useEffect(() => { if (api) void api.environment().then(setEnvironment).catch(() => setEnvironment(null)); }, [api]);
  React.useEffect(() => {
    const systemDark = environment?.theme === "dark" || (!environment && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const resolvedTheme = appearance.theme === "system" ? (systemDark ? "dark" : "light") : appearance.theme;
    const root = document.documentElement;
    root.dataset.quickhackTheme = resolvedTheme;
    root.dataset.quickhackFont = appearance.fontFamily;
    root.style.setProperty("--quickhack-ui-font-size", `${appearance.fontSize}px`);
    root.style.setProperty("--quickhack-ui-scale", String(appearance.scale));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  }, [appearance, environment]);

  const setAppearance = React.useCallback((next: DesktopAppearance) => setAppearanceState(normalizeDesktopAppearance(next)), []);
  const resetAppearance = React.useCallback(() => setAppearanceState(DEFAULT_APPEARANCE), []);
  const value = React.useMemo(() => ({ api, environment, appearance, setAppearance, resetAppearance }), [api, environment, appearance, setAppearance, resetAppearance]);
  return <DesktopCapabilityContext.Provider value={value}>{children}</DesktopCapabilityContext.Provider>;
}

export function useDesktopCapability() {
  const value = React.useContext(DesktopCapabilityContext);
  if (!value) throw new Error("DesktopCapabilityProvider is missing.");
  return value;
}
