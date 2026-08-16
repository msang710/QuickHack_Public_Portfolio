const DEFAULT_MOCK_SERVER_URL = "http://127.0.0.1:3100";
const MAX_CREDENTIAL_LENGTH = 4096;

function requiredText(value, label) {
  const text = String(value || "").trim();

  if (!text) {
    throw new Error(`Mock credential response is missing ${label}.`);
  }

  if (text.length > MAX_CREDENTIAL_LENGTH) {
    throw new Error(`Mock credential response ${label} is too long.`);
  }

  return text;
}

function localMockServerUrl(value) {
  const url = new URL(String(value || DEFAULT_MOCK_SERVER_URL));
  const localHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

  if (url.protocol !== "http:" || !localHosts.has(url.hostname)) {
    throw new Error("Mock credential issuance is restricted to a local HTTP server.");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function isoTimestamp(value, label) {
  const text = requiredText(value, label);

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) {
    throw new Error(`Mock credential response ${label} is not an ISO UTC timestamp.`);
  }

  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`Mock credential response ${label} is invalid.`);
  }

  return text;
}

export async function issueMockCoupangCredential(input = {}) {
  const baseUrl = localMockServerUrl(
    input.baseUrl || process.env.COUPANG_MOCK_SERVER_URL
  );
  const endpoint = new URL("/admin/openapi-credentials/issue", baseUrl);
  const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : 5000;
  const response = await fetch(endpoint, {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json;charset=UTF-8",
    },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Mock credential issuance returned invalid JSON (${response.status}).`);
  }

  if (!response.ok || !payload?.ok || !payload?.credential) {
    throw new Error(
      String(payload?.message || `Mock credential issuance failed (${response.status}).`)
    );
  }

  const credential = payload.credential;
  const vendorId = requiredText(credential.vendorId, "vendorId");

  if (!/^[AC]\d+$/.test(vendorId)) {
    throw new Error("Mock credential response vendorId has an invalid format.");
  }

  const issuedAt = isoTimestamp(credential.issuedAt, "issuedAt");
  const expiresAt = isoTimestamp(credential.expiresAt, "expiresAt");

  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new Error("Mock credential response expiration range is invalid.");
  }

  return {
    credentialId: requiredText(credential.credentialId, "credentialId"),
    vendorId,
    accessKey: requiredText(credential.accessKey, "accessKey"),
    secretKey: requiredText(credential.secretKey, "secretKey"),
    issuedAt,
    expiresAt,
  };
}
