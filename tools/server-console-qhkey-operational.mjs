import {
  prepareProviderReplacement,
} from "./server-console-qhkey-common.mjs";

const MAX_CREDENTIAL_LENGTH = 4096;

function requiredCredential(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > MAX_CREDENTIAL_LENGTH) throw new Error(`${label} is too long.`);
  return text;
}

function calendarDate(value, label) {
  const text = requiredCredential(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (!match) throw new Error(`${label} must use YYYY-MM-DD.`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) {
    throw new Error(`${label} is not a valid calendar date.`);
  }
  return date;
}

function coupangKeyDateRange(expiresOn, now = new Date()) {
  const expiresAt = new Date(calendarDate(expiresOn, "WING expiry date").getTime() - 9 * 3_600_000);
  const issuedAt = new Date(expiresAt.getTime() - 180 * 86_400_000);
  if (expiresAt.getTime() <= now.getTime()) throw new Error("The WING key expiry date has already passed.");
  if (issuedAt.getTime() > now.getTime() + 86_400_000) throw new Error("The WING expiry exceeds its 180-day validity window.");
  return { issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() };
}

function logenKeyDateRange(expiresOn, now = new Date()) {
  const expiresAt = new Date(calendarDate(expiresOn, "Logen key expiry date").getTime() - 9 * 3_600_000);
  if (expiresAt.getTime() <= now.getTime()) throw new Error("The Logen key expiry date has already passed.");
  const maxExpiresAt = new Date(now);
  maxExpiresAt.setUTCFullYear(maxExpiresAt.getUTCFullYear() + 2);
  if (expiresAt.getTime() > maxExpiresAt.getTime()) throw new Error("The Logen key expiry cannot exceed two years.");
  return { issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString() };
}

export function rotateCoupangQhkey(input) {
  return prepareProviderReplacement(input, "coupang", {
    vendorId: requiredCredential(input.vendorId, "vendorId"),
    accessKey: requiredCredential(input.accessKey, "Access Key"),
    secretKey: requiredCredential(input.secretKey, "Secret Key"),
  }, coupangKeyDateRange(input.expiresOn));
}

export function rotateLogenQhkey(input) {
  return prepareProviderReplacement(input, "logen", {
    userId: requiredCredential(input.userId, "userId"),
    customerCode: requiredCredential(input.customerCode, "customerCode"),
    secretKey: requiredCredential(input.secretKey, "Secret Key"),
  }, logenKeyDateRange(input.expiresOn));
}
