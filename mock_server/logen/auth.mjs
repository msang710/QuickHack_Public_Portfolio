import { timingSafeEqual } from "node:crypto";
import { sendJson } from "./response.mjs";

export function normalizeIp(value) {
  const ip = String(value ?? "").trim();
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

export function isLoopbackRequest(request) {
  const ip = normalizeIp(request.socket.remoteAddress);
  return ip === "127.0.0.1" || ip === "::1";
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function validateLogenAuth(request, response, db) {
  const ip = normalizeIp(request.socket.remoteAddress);
  const allowedIp = await db
    .prepare("SELECT ip_address FROM mock_ip_allowlist WHERE ip_address = ? AND enabled = 1")
    .get(ip);
  const suppliedKey = String(request.headers.secretkey ?? "").trim();
  const credentials = await db
    .prepare("SELECT secret_key FROM mock_credentials WHERE enabled = 1")
    .all();
  const validKey = credentials.some((row) => safeEqual(suppliedKey, row.secret_key));

  if (!allowedIp || !validKey) {
    sendJson(response, 401, {
      sttsCd: "FAIL",
      sttsMsg: "등록 IP 또는 secretKey 인증에 실패했습니다.",
    });
    return false;
  }
  return true;
}
