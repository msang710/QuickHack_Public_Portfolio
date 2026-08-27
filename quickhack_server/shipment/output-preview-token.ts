import crypto from "node:crypto";

export type OutputPreviewClaims = {
  userId: number;
  sessionId: string;
  issueBatchId: number;
  shipmentListPrintBatchId: number;
  revision: number;
  payloadHash: string;
  expiresAt: number;
};
function encode(value: object) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function sign(payload: string, secret: string) { return crypto.createHmac("sha256", secret).update(payload).digest("base64url"); }

export function issueOutputPreviewToken(claims: OutputPreviewClaims, secret: string) {
  if (secret.length < 32 || claims.expiresAt <= Date.now()) throw new TypeError("Output preview token input is invalid.");
  const payload = encode(claims);
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyOutputPreviewToken(token: string, expected: Omit<OutputPreviewClaims, "expiresAt">, secret: string, now = Date.now()) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || secret.length < 32) throw new Error("OUTPUT_PREVIEW_TOKEN_INVALID");
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(sign(payload, secret));
  if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) throw new Error("OUTPUT_PREVIEW_TOKEN_INVALID");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OutputPreviewClaims;
  if (claims.expiresAt <= now) throw new Error("OUTPUT_PREVIEW_TOKEN_EXPIRED");
  if (
    claims.userId !== expected.userId ||
    claims.sessionId !== expected.sessionId ||
    claims.issueBatchId !== expected.issueBatchId ||
    claims.shipmentListPrintBatchId !== expected.shipmentListPrintBatchId ||
    claims.revision !== expected.revision ||
    claims.payloadHash !== expected.payloadHash
  ) throw new Error("OUTPUT_PREVIEW_TOKEN_STALE");
  return claims;
}
