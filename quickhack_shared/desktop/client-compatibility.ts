import crypto from "node:crypto";

export const WORKFLOW_ADMISSION_COOKIE = "quickhack_workflow_admission";
export const WORKFLOW_ADMISSION_MAX_AGE_SECONDS = 30 * 60;
export type WorkflowFamily = "INSPECTION" | "INVENTORY" | "SHIPMENT" | "RETURNS" | "MANUAL_MATCHING" | "ACCOUNT";

export type ClientCompatibilityPolicy = {
  clientFamily: string;
  updateChannel: string;
  recommendedVersion: string;
  minimumVersion: string;
  enforcementAt: string | null;
};

function semver(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u.exec(value.trim());
  if (!match) throw new TypeError("CLIENT_VERSION_INVALID");
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] ?? null };
}

export function compareClientVersions(left: string, right: string) {
  const a = semver(left); const b = semver(right);
  for (let index = 0; index < 3; index += 1) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

export function readClientCompatibilityPolicy(environment: NodeJS.ProcessEnv = process.env): ClientCompatibilityPolicy {
  const minimumVersion = String(environment.QUICKHACK_CLIENT_MINIMUM_VERSION ?? "0.0.0").trim();
  const recommendedVersion = String(environment.QUICKHACK_CLIENT_RECOMMENDED_VERSION ?? minimumVersion).trim();
  semver(minimumVersion); semver(recommendedVersion);
  if (compareClientVersions(recommendedVersion, minimumVersion) < 0) throw new TypeError("CLIENT_VERSION_POLICY_INVALID");
  const enforcementText = String(environment.QUICKHACK_CLIENT_VERSION_ENFORCEMENT_AT ?? "").trim();
  if (enforcementText && !Number.isFinite(Date.parse(enforcementText))) throw new TypeError("CLIENT_ENFORCEMENT_TIME_INVALID");
  return {
    clientFamily: String(environment.QUICKHACK_CLIENT_FAMILY ?? "BROWSER_DEVELOPMENT").trim(),
    updateChannel: String(environment.QUICKHACK_UPDATE_CHANNEL ?? "development").trim(),
    recommendedVersion,
    minimumVersion,
    enforcementAt: enforcementText ? new Date(enforcementText).toISOString() : null,
  };
}

export function clientUpdateRequired(policy: ClientCompatibilityPolicy, version: string, now = Date.now()) {
  const enforced = !policy.enforcementAt || Date.parse(policy.enforcementAt) <= now;
  return enforced && compareClientVersions(version, policy.minimumVersion) < 0;
}

type AdmissionClaims = { userId: number; sessionId: string; clientFamily: string; clientVersion: string; workflowFamily: WorkflowFamily; issuedAt: number; expiresAt: number; nonce: string };
function signature(payload: string, secret: string) { return crypto.createHmac("sha256", secret).update(payload).digest("base64url"); }
export function issueWorkflowAdmission(input: Omit<AdmissionClaims, "issuedAt" | "expiresAt" | "nonce">, secret: string, now = Date.now()) {
  if (secret.length < 32) throw new TypeError("WORKFLOW_ADMISSION_SECRET_INVALID");
  const claims: AdmissionClaims = { ...input, issuedAt: now, expiresAt: now + WORKFLOW_ADMISSION_MAX_AGE_SECONDS * 1000, nonce: crypto.randomUUID() };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}
export function verifyWorkflowAdmission(token: string, expected: Pick<AdmissionClaims, "clientFamily" | "clientVersion" | "workflowFamily"> & { sessionId?: string }, secret: string, now = Date.now()) {
  const [payload, observed, extra] = token.split(".");
  if (!payload || !observed || extra) throw new Error("WORKFLOW_ADMISSION_INVALID");
  const left = Buffer.from(observed); const right = Buffer.from(signature(payload, secret));
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) throw new Error("WORKFLOW_ADMISSION_INVALID");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AdmissionClaims;
  if (claims.expiresAt <= now) throw new Error("WORKFLOW_ADMISSION_EXPIRED");
  if ((expected.sessionId && claims.sessionId !== expected.sessionId) || claims.clientFamily !== expected.clientFamily || claims.clientVersion !== expected.clientVersion || claims.workflowFamily !== expected.workflowFamily) throw new Error("WORKFLOW_ADMISSION_INVALID");
  return claims;
}

export function protectedWorkflowFamily(pathname: string): WorkflowFamily | null {
  if (/^\/api\/adb\/mobile-provision(?:\/|$)/u.test(pathname)) return "ACCOUNT";
  if (/^\/api\/adb(?:\/|$)/u.test(pathname)) return "INSPECTION";
  if (/^\/api\/inspection(?:\/|$)/u.test(pathname)) return "INSPECTION";
  if (/^\/api\/inventory(?:\/|$)/u.test(pathname)) return "INVENTORY";
  if (/^\/api\/(?:invoices|coupang\/shipment-list-print)(?:\/|$)/u.test(pathname)) return "SHIPMENT";
  if (/^\/api\/coupang\/returns(?:\/|$)/u.test(pathname)) return "RETURNS";
  if (/^\/api\/coupang\/manual-order-matches(?:\/|$)/u.test(pathname)) return "MANUAL_MATCHING";
  if (/^\/api\/auth\/(?:me|mobile-devices)(?:\/|$)/u.test(pathname)) return "ACCOUNT";
  return null;
}

export function menuWorkflowFamily(menuId: string): WorkflowFamily | null {
  if (menuId.startsWith("inbound-")) return "INSPECTION";
  if (menuId.startsWith("inventory-")) return "INVENTORY";
  if (menuId.startsWith("shipment-") || menuId.startsWith("invoice-")) return "SHIPMENT";
  if (menuId.startsWith("return-")) return "RETURNS";
  if (menuId === "channel-manual-order-match") return "MANUAL_MATCHING";
  if (menuId === "personal-settings") return "ACCOUNT";
  return null;
}
