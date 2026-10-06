import { desktopKo } from "../../quickhack_client/i18n/catalogs/ko/desktop.ts";
import path from "node:path";

export type DesktopStartupStage = "NATIVE_BROKER" | "CLIENT_RUNTIME" | "MAIN_WINDOW";

function observedCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "";
  const reported = /\[QuickHack Client\]\s+([A-Z][A-Z0-9_]{2,79}):/u.exec(value)?.[1];
  if (reported) return reported;
  const direct = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return /^[A-Z][A-Z0-9_]{2,79}$/u.test(direct) ? direct : "";
}

function missingBundlePath(error: unknown): string {
  const value = error instanceof Error ? error.message : "";
  const match = /Trust bundle (directory|file) is missing:\s*([^\r\n]+)/u.exec(value);
  const candidate = match?.[2]?.trim() ?? "";
  // Only show a bounded absolute path from the known trust-bundle error.
  if (candidate.length > 256 || !/^(?:\/|[A-Za-z]:[\\/])/u.test(candidate) || /[\x00-\x1f]/u.test(candidate)) return "";
  return match?.[1] === "file"
    ? (/^[A-Za-z]:[\\/]/u.test(candidate) ? path.win32.dirname(candidate) : path.posix.dirname(candidate))
    : candidate;
}

export function describeDesktopStartupFailure(error: unknown, stage: DesktopStartupStage): string {
  const t = desktopKo.updateStatus;
  const code = observedCode(error);
  const lines = [
    `${t.nativeStartFailureStage}: ${stage === "NATIVE_BROKER" ? t.nativeStartFailureBroker : stage === "MAIN_WINDOW" ? t.nativeStartFailureWindow : t.nativeStartFailureClientRuntime}`,
  ];
  if (code) lines.push(`${t.nativeStartFailureCode}: ${code}`);

  if (code === "TRUST_BUNDLE_INCOMPLETE") {
    lines.push(`${t.nativeStartFailureReason}: ${t.nativeStartFailureTrustMissing}`);
    const location = missingBundlePath(error);
    if (location) lines.push(`${t.nativeStartFailureLocation}: ${location}`);
    lines.push(`${t.nativeStartFailureAction}: ${t.nativeStartFailureTrustAction}`);
  } else if (code === "TRUST_BUNDLE_INVALID" || code === "CENTRAL_SERVER_CA_INVALID") {
    lines.push(`${t.nativeStartFailureReason}: ${t.nativeStartFailureTrustInvalid}`);
    lines.push(`${t.nativeStartFailureAction}: ${t.nativeStartFailureTrustAction}`);
  } else if (["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "CENTRAL_SERVER_PROBE_TIMEOUT"].includes(code)) {
    lines.push(`${t.nativeStartFailureReason}: ${t.nativeStartFailureServerUnavailable}`);
    lines.push(`${t.nativeStartFailureAction}: ${t.nativeStartFailureServerAction}`);
  } else if (code.startsWith("CENTRAL_SERVER_PROBE_") || ["ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN"].includes(code)) {
    lines.push(`${t.nativeStartFailureReason}: ${t.nativeStartFailureServerMismatch}`);
    lines.push(`${t.nativeStartFailureAction}: ${t.nativeStartFailureServerAction}`);
  } else if (code === "CLIENT_RUNTIME_READINESS_TIMEOUT" || code === "CLIENT_RUNTIME_START_IN_PROGRESS") {
    lines.push(`${t.nativeStartFailureReason}: ${t.nativeStartFailureRuntimeTimeout}`);
    lines.push(`${t.nativeStartFailureAction}: ${t.nativeStartFailureLogAction}`);
  } else {
    lines.push(`${t.nativeStartFailureReason}: ${t.nativeStartFailureUnknown}`);
    lines.push(`${t.nativeStartFailureAction}: ${t.nativeStartFailureLogAction}`);
  }
  return lines.join("\n");
}
