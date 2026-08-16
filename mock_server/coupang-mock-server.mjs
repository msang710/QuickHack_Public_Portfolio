// QuickHack note: QuickHack 본 서버와 분리해서 실행하는 로컬 쿠팡 mock API 서버입니다.
import crypto from "node:crypto";
import http from "node:http";
import {
  createSyntheticProductCatalog,
  SYNTHETIC_CATALOG_VERSION,
  SYNTHETIC_PRODUCT_COUNT,
  SYNTHETIC_SELLER_PRODUCT_COUNT,
  SYNTHETIC_VENDOR_ITEM_COUNT,
} from "./coupang-synthetic-catalog.mjs";
import { openPostgresqlMockDatabase } from "./postgresql-mock-database.mjs";

const defaultHost = "127.0.0.1";
const defaultPort = 3100;
const maxPageSize = 100;
const defaultPageSize = 20;
const defaultOrderIntervalMs = 30000;
const defaultReturnExchangeIntervalMs = 180000;
const defaultResetOrderCount = 40;
const defaultResetReturnExchangeCount = 10;
const defaultFailurePolicy = {
  enabled: true,
  target: "all",
  randomFailureRate: 10,
  serverErrorRate: 0,
  rateLimitRate: 0,
  teapotRate: 0,
  httpFailureRate: 0,
  timeoutRate: 0,
  responseDelayRate: 0,
  malformedJsonRate: 0,
  missingRequiredFieldRate: 0,
  partialDataLossRate: 0,
  writeAppliedResponseFailureRate: 0,
  minDelayMs: 0,
  maxDelayMs: 0,
  serverErrorStatus: 500,
  httpStatus: 500,
  timeoutMs: 15000,
  retryAfterSeconds: 2,
};
const mockCredentialValidityMs = 180 * 24 * 60 * 60 * 1000;
const maxSignedDateSkewMs = 5 * 60 * 1000;
const trueValues = new Set(["1", "true", "yes", "y", "on"]);
const failureTargets = new Set([
  "all",
  "inventory",
  "inventory-write",
  "products",
  "ordersheets",
  "ordersheet-single",
  "ordersheet-acknowledgement",
  "return-requests",
  "return-stopped-shipment",
  "return-receive-confirmation",
  "return-approval",
  "return-withdrawals",
  "exchange-requests",
]);
const mockNames = [
  "예시고객01",
  "예시고객02",
  "예시고객03",
  "예시고객04",
  "예시고객05",
  "예시고객06",
  "예시고객07",
  "예시고객08",
  "예시고객09",
  "예시고객10",
];
const mockAddresses = [
  {
    postCode: "00000",
    addr1: "서울특별시 예시구 테스트로 1",
    addr2Prefix: "예시건물01",
  },
  {
    postCode: "00001",
    addr1: "서울특별시 예시구 테스트로 2",
    addr2Prefix: "예시건물02",
  },
  {
    postCode: "00002",
    addr1: "경기도 예시시 테스트로 3",
    addr2Prefix: "예시건물03",
  },
  {
    postCode: "00003",
    addr1: "부산광역시 예시구 테스트로 4",
    addr2Prefix: "예시건물04",
  },
  {
    postCode: "00004",
    addr1: "대전광역시 예시구 테스트로 5",
    addr2Prefix: "예시건물05",
  },
];
const deliveryMessages = [
  "문 앞에 놓아주세요.",
  "부재 시 경비실에 맡겨주세요.",
  "배송 전 연락 부탁드립니다.",
  "파손 주의 부탁드립니다.",
  "직접 수령 예정입니다.",
];

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);

  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }

  return fallback;
}

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function nonNegativeInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function booleanValue(value, fallback = false) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  return trueValues.has(String(value).trim().toLowerCase());
}

function percentageValue(value, fallback = 0) {
  const parsed = Number.parseFloat(String(value ?? ""));

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(100, Math.max(0, parsed));
}

function normalizeFailureTarget(value, fallback = "all") {
  const normalized = String(value ?? "").trim();

  return failureTargets.has(normalized) ? normalized : fallback;
}

function randomDelayMs(minDelayMs, maxDelayMs) {
  if (maxDelayMs <= 0) {
    return 0;
  }

  const min = Math.min(minDelayMs, maxDelayMs);
  const max = Math.max(minDelayMs, maxDelayMs);

  return Math.floor(min + Math.random() * (max - min + 1));
}

function shouldTrigger(percent) {
  return percent > 0 && Math.random() * 100 < percent;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function kstParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
}

function sqlNow(date = new Date()) {
  const parts = kstParts(date);

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function coupangIso(minutesAgo = 0) {
  const date = new Date(new Date().getTime() - minutesAgo * 60 * 1000);

  return `${sqlNow(date).replace(" ", "T")}+09:00`;
}

function jsonText(value) {
  return JSON.stringify(value);
}

function safeJsonParseObject(text) {
  try {
    const parsed = JSON.parse(String(text || "{}"));

    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function randomToken(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
}

function encodeNextToken(input) {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

function normalizeFailurePolicy(input, fallback = defaultFailurePolicy) {
  const serverErrorRate = percentageValue(
    input.serverErrorRate ?? input.httpFailureRate,
    fallback.serverErrorRate ?? fallback.httpFailureRate
  );

  return {
    enabled: booleanValue(input.enabled, fallback.enabled),
    target: normalizeFailureTarget(input.target, fallback.target),
    randomFailureRate: percentageValue(
      input.randomFailureRate,
      fallback.randomFailureRate
    ),
    serverErrorRate,
    rateLimitRate: percentageValue(input.rateLimitRate, fallback.rateLimitRate),
    teapotRate: percentageValue(input.teapotRate, fallback.teapotRate),
    httpFailureRate: serverErrorRate,
    timeoutRate: percentageValue(input.timeoutRate, fallback.timeoutRate),
    responseDelayRate: percentageValue(
      input.responseDelayRate,
      fallback.responseDelayRate
    ),
    malformedJsonRate: percentageValue(
      input.malformedJsonRate,
      fallback.malformedJsonRate
    ),
    missingRequiredFieldRate: percentageValue(
      input.missingRequiredFieldRate,
      fallback.missingRequiredFieldRate
    ),
    partialDataLossRate: percentageValue(
      input.partialDataLossRate,
      fallback.partialDataLossRate
    ),
    writeAppliedResponseFailureRate: percentageValue(
      input.writeAppliedResponseFailureRate,
      fallback.writeAppliedResponseFailureRate
    ),
    minDelayMs: nonNegativeInteger(input.minDelayMs, fallback.minDelayMs, 60000),
    maxDelayMs: nonNegativeInteger(input.maxDelayMs, fallback.maxDelayMs, 60000),
    serverErrorStatus: boundedInteger(
      input.serverErrorStatus ?? input.httpStatus,
      fallback.serverErrorStatus ?? fallback.httpStatus,
      500,
      599
    ),
    httpStatus: boundedInteger(
      input.httpStatus ?? input.serverErrorStatus,
      fallback.httpStatus ?? fallback.serverErrorStatus,
      500,
      599
    ),
    timeoutMs: nonNegativeInteger(input.timeoutMs, fallback.timeoutMs, 120000),
    retryAfterSeconds: nonNegativeInteger(
      input.retryAfterSeconds,
      fallback.retryAfterSeconds,
      3600
    ),
  };
}

function failurePolicyFromEnv() {
  return normalizeFailurePolicy({
    enabled: process.env.COUPANG_MOCK_FAILURE_ENABLED,
    target: process.env.COUPANG_MOCK_FAILURE_TARGET,
    randomFailureRate: process.env.COUPANG_MOCK_RANDOM_FAILURE_RATE,
    serverErrorRate: process.env.COUPANG_MOCK_SERVER_ERROR_RATE,
    rateLimitRate: process.env.COUPANG_MOCK_RATE_LIMIT_RATE,
    teapotRate: process.env.COUPANG_MOCK_TEAPOT_RATE,
    httpFailureRate: process.env.COUPANG_MOCK_HTTP_FAILURE_RATE,
    timeoutRate: process.env.COUPANG_MOCK_TIMEOUT_RATE,
    responseDelayRate: process.env.COUPANG_MOCK_RESPONSE_DELAY_RATE,
    malformedJsonRate: process.env.COUPANG_MOCK_MALFORMED_JSON_RATE,
    missingRequiredFieldRate:
      process.env.COUPANG_MOCK_MISSING_REQUIRED_FIELD_RATE,
    partialDataLossRate: process.env.COUPANG_MOCK_PARTIAL_DATA_LOSS_RATE,
    writeAppliedResponseFailureRate:
      process.env.COUPANG_MOCK_WRITE_APPLIED_RESPONSE_FAILURE_RATE,
    minDelayMs: process.env.COUPANG_MOCK_MIN_DELAY_MS,
    maxDelayMs: process.env.COUPANG_MOCK_MAX_DELAY_MS,
    serverErrorStatus: process.env.COUPANG_MOCK_SERVER_ERROR_STATUS,
    httpStatus: process.env.COUPANG_MOCK_FAILURE_STATUS,
    timeoutMs: process.env.COUPANG_MOCK_TIMEOUT_MS,
    retryAfterSeconds: process.env.COUPANG_MOCK_RETRY_AFTER_SECONDS,
  });
}

function failurePolicySummary(policy) {
  if (!policy.enabled) {
    return "disabled";
  }

  const rules = [
    `target=${policy.target}`,
    `random=${policy.randomFailureRate}%`,
  ];
  const optionalRates = [
    ["server-error", policy.serverErrorRate],
    ["rate-limit", policy.rateLimitRate],
    ["teapot", policy.teapotRate],
    ["timeout", policy.timeoutRate],
    ["response-delay", policy.responseDelayRate],
    ["malformed-json", policy.malformedJsonRate],
    ["missing-field", policy.missingRequiredFieldRate],
    ["partial-data", policy.partialDataLossRate],
    ["write-response-loss", policy.writeAppliedResponseFailureRate],
  ];

  for (const [label, rate] of optionalRates) {
    if (rate > 0) {
      rules.push(`${label}=${rate}%`);
    }
  }

  return `enabled (${rules.join(", ")})`;
}

function parseJsonObject(text) {
  if (!text.trim()) {
    return {};
  }

  const parsed = JSON.parse(text);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON object body is required.");
  }

  return parsed;
}

function readRequestText(request, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let text = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      text += chunk;

      if (Buffer.byteLength(text, "utf8") > maxBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });
}

function parseCoupangAuthorization(value) {
  const text = String(value || "").trim();

  if (!text.startsWith("CEA ")) {
    return null;
  }

  const entries = {};
  const allowedKeys = new Set([
    "algorithm",
    "access-key",
    "signed-date",
    "signature",
  ]);

  for (const part of text.slice(4).split(",")) {
    const [key, ...rest] = part.trim().split("=");

    if (
      !key ||
      rest.length === 0 ||
      !allowedKeys.has(key) ||
      Object.hasOwn(entries, key)
    ) {
      return null;
    }

    entries[key] = rest.join("=");
  }

  return Object.keys(entries).length === allowedKeys.size ? entries : null;
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signedDateTimestamp(value) {
  const match = /^(\d{2})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
    String(value || "")
  );

  if (!match) {
    return null;
  }

  const parts = match.slice(1).map(Number);
  const timestamp = Date.UTC(
    2000 + parts[0],
    parts[1] - 1,
    parts[2],
    parts[3],
    parts[4],
    parts[5]
  );
  const date = new Date(timestamp);

  if (
    date.getUTCFullYear() !== 2000 + parts[0] ||
    date.getUTCMonth() !== parts[1] - 1 ||
    date.getUTCDate() !== parts[2] ||
    date.getUTCHours() !== parts[3] ||
    date.getUTCMinutes() !== parts[4] ||
    date.getUTCSeconds() !== parts[5]
  ) {
    return null;
  }

  return timestamp;
}

function mockCredentialFingerprint(accessKey) {
  return crypto.createHash("sha256").update(accessKey).digest("hex").slice(0, 16);
}

async function currentMockCredential(db) {
  return db
    .prepare(`
      SELECT
        credential_id AS credentialId,
        vendor_id AS vendorId,
        access_key AS accessKey,
        issued_at AS issuedAt,
        expires_at AS expiresAt
      FROM mock_openapi_credentials
      WHERE revoked_at IS NULL
      ORDER BY issued_at DESC
      LIMIT 1
    `)
    .get();
}

async function issueMockOpenApiCredential(db, now = new Date()) {
  const previous = await db
    .prepare(`
      SELECT vendor_id AS vendorId
      FROM mock_openapi_credentials
      ORDER BY issued_at DESC
      LIMIT 1
    `)
    .get();
  const vendorId =
    previous?.vendorId ||
    `A${crypto.randomInt(0, 100_000_000).toString().padStart(8, "0")}`;
  const credential = {
    credentialId: crypto.randomUUID(),
    vendorId,
    accessKey: crypto.randomBytes(20).toString("hex").toUpperCase(),
    secretKey: crypto.randomBytes(48).toString("base64url"),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + mockCredentialValidityMs).toISOString(),
  };

  await db.transaction(async () => {
    await db.prepare(`
      UPDATE mock_openapi_credentials
      SET revoked_at = ?
      WHERE revoked_at IS NULL
    `).run(credential.issuedAt);
    await db.prepare(`
      INSERT INTO mock_openapi_credentials (
        credential_id,
        vendor_id,
        access_key,
        secret_key,
        issued_at,
        expires_at,
        revoked_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      credential.credentialId,
      credential.vendorId,
      credential.accessKey,
      credential.secretKey,
      credential.issuedAt,
      credential.expiresAt,
      credential.issuedAt
    );
  })();

  return credential;
}

async function credentialForAccessKey(db, accessKey) {
  return db
    .prepare(`
      SELECT
        credential_id AS credentialId,
        vendor_id AS vendorId,
        access_key AS accessKey,
        secret_key AS secretKey,
        issued_at AS issuedAt,
        expires_at AS expiresAt,
        revoked_at AS revokedAt
      FROM mock_openapi_credentials
      WHERE access_key = ?
      LIMIT 1
    `)
    .get(accessKey);
}

function requestVendorId(url) {
  const pathMatch = url.pathname.match(/\/vendors\/([^/]+)/);

  if (pathMatch) {
    return decodeURIComponent(pathMatch[1]);
  }

  return url.searchParams.get("vendorId") || "";
}

function rejectAuthorization(response, message) {
  sendJson(response, 401, {
    code: "UNAUTHORIZED",
    message,
  });
  return false;
}

async function validateCoupangAuthorization(request, response, url, db) {
  const auth = parseCoupangAuthorization(request.headers.authorization);

  if (!auth) {
    return rejectAuthorization(response, "Missing or malformed Coupang HMAC authorization.");
  }

  if (
    auth.algorithm !== "HmacSHA256" ||
    !auth["signed-date"] ||
    !auth.signature
  ) {
    return rejectAuthorization(response, "Invalid Coupang HMAC authorization.");
  }

  const credential = await credentialForAccessKey(db, auth["access-key"]);
  const nowMs = Date.now();

  if (
    !credential ||
    credential.revokedAt ||
    Date.parse(credential.issuedAt) > nowMs ||
    Date.parse(credential.expiresAt) <= nowMs
  ) {
    return rejectAuthorization(response, "Coupang API credential is not active.");
  }

  const signedAtMs = signedDateTimestamp(auth["signed-date"]);

  if (signedAtMs === null || Math.abs(nowMs - signedAtMs) > maxSignedDateSkewMs) {
    return rejectAuthorization(response, "Coupang HMAC signed-date is invalid or stale.");
  }

  const vendorId = requestVendorId(url);

  if (vendorId && !timingSafeEqualText(vendorId, credential.vendorId)) {
    return rejectAuthorization(response, "Coupang vendorId does not match the credential.");
  }

  const query = url.search ? url.search.slice(1) : "";
  const message = `${auth["signed-date"]}${request.method}${url.pathname}${query}`;
  const expectedSignature = crypto
    .createHmac("sha256", credential.secretKey)
    .update(message)
    .digest("hex");

  if (!timingSafeEqualText(auth.signature, expectedSignature)) {
    return rejectAuthorization(response, "Invalid Coupang HMAC signature.");
  }

  return true;
}

function decodeNextToken(value) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

    if (parsed && typeof parsed === "object" && parsed.mode === "orders") {
      return parsed;
    }
  } catch {
    return null;
  }

  throw new Error("Invalid nextToken");
}

async function ensureColumn(db, tableName, columnName, columnDefinition) {
  await db.exec(
    `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${columnName} ${columnDefinition}`
  );
}

async function openMockDatabase() {
  const db = openPostgresqlMockDatabase("coupangMock", "quickhack-coupang-mock");
  await db.exec(`
    CREATE TABLE IF NOT EXISTS mock_counters (
      name TEXT PRIMARY KEY,
      value BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mock_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mock_openapi_credentials (
      credential_id TEXT PRIMARY KEY,
      vendor_id TEXT NOT NULL,
      access_key TEXT NOT NULL UNIQUE,
      secret_key TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS mock_openapi_one_active_credential
      ON mock_openapi_credentials ((1))
      WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS mock_batches (
      batch_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      page_size INTEGER NOT NULL,
      total_orders INTEGER NOT NULL,
      total_pages INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mock_products (
      vendor_item_id TEXT PRIMARY KEY,
      product_id TEXT,
      seller_product_id TEXT NOT NULL,
      seller_product_name TEXT NOT NULL,
      seller_product_item_name TEXT NOT NULL,
      vendor_item_name TEXT NOT NULL,
      vendor_sku_code TEXT NOT NULL,
      quickhack_model TEXT NOT NULL,
      quickhack_color TEXT NOT NULL,
      quickhack_capacity TEXT NOT NULL,
      quickhack_grade TEXT NOT NULL,
      current_quantity_snapshot INTEGER NOT NULL DEFAULT 0,
      average_price_snapshot INTEGER NOT NULL DEFAULT 0,
      quickhack_grade_group_code TEXT,
      quickhack_grade_group_label TEXT,
      source_row_index INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mock_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      page_no INTEGER NOT NULL,
      order_id TEXT NOT NULL UNIQUE,
      shipment_box_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      ordered_at TEXT NOT NULL,
      paid_at TEXT NOT NULL,
      orderer_name TEXT NOT NULL,
      orderer_phone TEXT NOT NULL DEFAULT '',
      receiver_name TEXT NOT NULL,
      receiver_phone TEXT NOT NULL DEFAULT '',
      receiver_mobile TEXT NOT NULL DEFAULT '',
      receiver_safe_number TEXT NOT NULL,
      receiver_addr1 TEXT NOT NULL,
      receiver_addr2 TEXT NOT NULL,
      receiver_post_code TEXT NOT NULL,
      delivery_message TEXT NOT NULL DEFAULT '',
      delivery_company_code TEXT,
      delivery_company_name TEXT,
      invoice_number TEXT,
      invoice_uploaded_at TEXT,
      split_shipping INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES mock_batches(batch_id)
    );

    CREATE TABLE IF NOT EXISTS mock_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      product_id TEXT,
      vendor_item_id TEXT NOT NULL,
      vendor_item_name TEXT NOT NULL,
      seller_product_id TEXT NOT NULL,
      seller_product_name TEXT NOT NULL,
      seller_product_item_name TEXT NOT NULL,
      vendor_sku_code TEXT NOT NULL,
      shipping_count INTEGER NOT NULL,
      hold_count_for_cancel INTEGER NOT NULL,
      cancel_count INTEGER NOT NULL,
      canceled INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES mock_orders(order_id)
    );

    CREATE TABLE IF NOT EXISTS mock_return_requests (
      receipt_id TEXT PRIMARY KEY,
      order_id TEXT,
      shipment_box_id TEXT,
      product_id TEXT,
      seller_product_id TEXT,
      vendor_item_id TEXT,
      seller_product_item_name TEXT,
      status TEXT NOT NULL,
      cancel_type TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      release_status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      fault_by_type TEXT,
      complete_confirm_date TEXT,
      complete_confirm_type TEXT,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mock_exchange_requests (
      exchange_id TEXT PRIMARY KEY,
      order_id TEXT,
      original_shipment_box_id TEXT,
      product_id TEXT,
      seller_product_id TEXT,
      vendor_item_id TEXT,
      seller_product_item_name TEXT,
      exchange_status TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      reason_code_text TEXT NOT NULL,
      reason_etc_detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mock_return_withdrawals (
      cancel_id TEXT PRIMARY KEY,
      order_id TEXT,
      refund_delivery_duty TEXT NOT NULL,
      created_at TEXT NOT NULL,
      vendor_item_ids_json TEXT NOT NULL
    );
  `);
  await ensureColumn(db, "mock_orders", "orderer_phone", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "mock_orders", "receiver_phone", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "mock_orders", "receiver_mobile", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "mock_orders", "delivery_message", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "mock_orders", "updated_at", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "mock_orders", "delivery_company_code", "TEXT");
  await ensureColumn(db, "mock_orders", "delivery_company_name", "TEXT");
  await ensureColumn(db, "mock_orders", "invoice_number", "TEXT");
  await ensureColumn(db, "mock_orders", "invoice_uploaded_at", "TEXT");
  await ensureColumn(db, "mock_orders", "split_shipping", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(db, "mock_order_items", "product_id", "TEXT");
  await ensureColumn(db, "mock_return_requests", "product_id", "TEXT");
  await ensureColumn(db, "mock_return_requests", "seller_product_id", "TEXT");
  await ensureColumn(db, "mock_return_requests", "vendor_item_id", "TEXT");
  await ensureColumn(db, "mock_return_requests", "seller_product_item_name", "TEXT");
  await ensureColumn(db, "mock_return_requests", "modified_at", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "mock_return_requests", "fault_by_type", "TEXT");
  await ensureColumn(db, "mock_return_requests", "complete_confirm_date", "TEXT");
  await ensureColumn(db, "mock_return_requests", "complete_confirm_type", "TEXT");
  await ensureColumn(db, "mock_exchange_requests", "product_id", "TEXT");
  await ensureColumn(db, "mock_exchange_requests", "seller_product_id", "TEXT");
  await ensureColumn(db, "mock_exchange_requests", "vendor_item_id", "TEXT");
  await ensureColumn(db, "mock_exchange_requests", "seller_product_item_name", "TEXT");
  await ensureColumn(
    db,
    "mock_exchange_requests",
    "reason_etc_detail",
    "TEXT NOT NULL DEFAULT ''"
  );

  return db;
}

async function nextCounter(db, name) {
  const row = await db.prepare(`
    INSERT INTO mock_counters (name, value)
    VALUES (?, 1)
    ON CONFLICT(name) DO UPDATE
      SET value = mock_counters.value + 1
    RETURNING value
  `).get(name);

  return BigInt(row.value);
}

function externalId(base, sequence) {
  return (BigInt(base) + sequence).toString();
}

async function seedSyntheticProducts(db) {
  const products = createSyntheticProductCatalog();
  const now = sqlNow();
  const insert = db.prepare(`
    INSERT INTO mock_products (
      vendor_item_id, product_id, seller_product_id, seller_product_name,
      seller_product_item_name, vendor_item_name, vendor_sku_code,
      quickhack_model, quickhack_color, quickhack_capacity, quickhack_grade,
      current_quantity_snapshot, average_price_snapshot,
      quickhack_grade_group_code, quickhack_grade_group_label,
      source_row_index, raw_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vendor_item_id) DO UPDATE SET
      product_id = excluded.product_id,
      seller_product_id = excluded.seller_product_id,
      seller_product_name = excluded.seller_product_name,
      seller_product_item_name = excluded.seller_product_item_name,
      vendor_item_name = excluded.vendor_item_name,
      vendor_sku_code = excluded.vendor_sku_code,
      quickhack_model = excluded.quickhack_model,
      quickhack_color = excluded.quickhack_color,
      quickhack_capacity = excluded.quickhack_capacity,
      quickhack_grade = excluded.quickhack_grade,
      current_quantity_snapshot = excluded.current_quantity_snapshot,
      average_price_snapshot = excluded.average_price_snapshot,
      quickhack_grade_group_code = excluded.quickhack_grade_group_code,
      quickhack_grade_group_label = excluded.quickhack_grade_group_label,
      source_row_index = excluded.source_row_index,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);

  await db.transaction(async () => {
    await db.prepare("DELETE FROM mock_products").run();

    for (const product of products) {
      await insert.run(
        product.vendorItemId,
        product.productId,
        product.sellerProductId,
        product.sellerProductName,
        product.sellerProductItemName,
        product.vendorItemName,
        product.vendorSkuCode,
        product.quickhackModel,
        product.quickhackColor,
        product.quickhackCapacity,
        product.quickhackGrade,
        product.currentQuantitySnapshot,
        product.averagePriceSnapshot,
        product.quickhackGradeGroupCode,
        product.quickhackGradeGroupLabel,
        product.sourceRowIndex,
        product.rawJson,
        now,
        now
      );
    }

    await db.prepare(`
      INSERT INTO mock_metadata (key, value, updated_at)
      VALUES ('product_catalog_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(SYNTHETIC_CATALOG_VERSION, now);
  })();

  return products.length;
}

async function syntheticCatalogState(db) {
  const counts = await db.prepare(`
    SELECT
      COUNT(*) AS item_count,
      COUNT(DISTINCT seller_product_id) AS seller_product_count,
      COUNT(DISTINCT product_id) AS product_count
    FROM mock_products
  `).get();
  const metadata = await db.prepare(`
    SELECT value
    FROM mock_metadata
    WHERE key = 'product_catalog_version'
  `).get();

  return {
    version: String(metadata?.value || ""),
    itemCount: Number(counts.item_count),
    sellerProductCount: Number(counts.seller_product_count),
    productCount: Number(counts.product_count),
  };
}

function assertSyntheticCatalogComplete(state) {
  if (
    state.itemCount !== SYNTHETIC_VENDOR_ITEM_COUNT ||
    state.sellerProductCount !== SYNTHETIC_SELLER_PRODUCT_COUNT ||
    state.productCount !== SYNTHETIC_PRODUCT_COUNT
  ) {
    throw new Error(
      "Synthetic Coupang catalog is incomplete. Run the explicit mock database reset."
    );
  }
}

async function ensureProductsSeeded(db) {
  const state = await syntheticCatalogState(db);

  if (state.version === SYNTHETIC_CATALOG_VERSION) {
    assertSyntheticCatalogComplete(state);
    return state.itemCount;
  }

  return seedSyntheticProducts(db);
}

async function productForOrderSequence(db, sequence) {
  const productCount = await ensureProductsSeeded(db);

  if (productCount <= 0) {
    throw new Error("No synthetic mock products were initialized.");
  }

  const offset = Number((sequence - 1n) % BigInt(productCount));

  return db
    .prepare(`
      SELECT *
      FROM mock_products
      ORDER BY source_row_index, vendor_item_id
      LIMIT 1 OFFSET ?
    `)
    .get(offset);
}

function phoneFor(sequence, prefix = "010") {
  const tail = String(sequence % 10000n).padStart(4, "0");
  const middle = String(3000n + (sequence % 6000n)).padStart(4, "0");

  return `${prefix}-${middle}-${tail}`;
}

function customerFor(sequence) {
  const index = Number(sequence % BigInt(mockNames.length));
  const address = mockAddresses[Number(sequence % BigInt(mockAddresses.length))];
  const ordererName = mockNames[index];
  const receiverName = mockNames[(index + 3) % mockNames.length];

  return {
    ordererName,
    ordererPhone: phoneFor(sequence),
    receiverName,
    receiverPhone: phoneFor(sequence + 17n),
    receiverMobile: phoneFor(sequence + 29n),
    receiverSafeNumber: `0504-${String(7000n + (sequence % 2000n)).padStart(4, "0")}-${String(sequence % 10000n).padStart(4, "0")}`,
    receiverAddr1: address.addr1,
    receiverAddr2: `${address.addr2Prefix} ${Number(sequence % 20n) + 1}층 ${Number(sequence % 70n) + 101}호`,
    receiverPostCode: address.postCode,
    deliveryMessage: deliveryMessages[Number(sequence % BigInt(deliveryMessages.length))],
  };
}

function moneyPayload(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const units = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;

  return {
    currencyCode: "KRW",
    units,
    nanos: 0,
  };
}

function orderItemPayload(item) {
  const salesPrice = item.sales_price ?? item.average_price_snapshot ?? 0;

  return {
    productId: item.product_id,
    vendorItemId: item.vendor_item_id,
    vendorItemName: item.vendor_item_name,
    sellerProductId: item.seller_product_id,
    sellerProductName: item.seller_product_name,
    sellerProductItemName: item.seller_product_item_name,
    vendorSkuCode: item.vendor_sku_code,
    quickhack: {
      model: item.quickhack_model ?? null,
      color: item.quickhack_color ?? null,
      capacity: item.quickhack_capacity ?? null,
      grade: item.quickhack_grade ?? null,
      gradeGroupCode: item.quickhack_grade_group_code ?? null,
      gradeGroupLabel: item.quickhack_grade_group_label ?? null,
    },
    salesPrice: moneyPayload(salesPrice),
    shippingCount: item.shipping_count,
    holdCountForCancel: item.hold_count_for_cancel,
    cancelCount: item.cancel_count,
    canceled: item.canceled === 1,
  };
}

function orderPayload(order, items) {
  return {
    orderId: order.order_id,
    shipmentBoxId: order.shipment_box_id,
    status: order.status,
    orderedAt: order.ordered_at,
    paidAt: order.paid_at,
    orderer: {
      name: order.orderer_name,
      phone: order.orderer_phone,
    },
    receiver: {
      name: order.receiver_name,
      phone: order.receiver_phone,
      mobile: order.receiver_mobile,
      safeNumber: order.receiver_safe_number,
      addr1: order.receiver_addr1,
      addr2: order.receiver_addr2,
      postCode: order.receiver_post_code,
    },
    parcelPrintMessage: order.delivery_message,
    deliveryMessage: order.delivery_message,
    deliveryCompanyName: order.delivery_company_name,
    invoiceNumber: order.invoice_number,
    splitShipping: order.split_shipping === 1,
    orderItems: items.map(orderItemPayload),
  };
}

function mockReturnReceiptStatusForFilter(status) {
  const text = String(status || "").trim().toUpperCase();

  if (text === "RU") {
    return "RELEASE_STOP_UNCHECKED";
  }

  if (text === "UC") {
    return "RETURNS_UNCHECKED";
  }

  return text || "RETURNS_UNCHECKED";
}

function mockReturnStatusFilterCandidates(status) {
  const text = String(status || "").trim().toUpperCase();

  if (text === "RU") {
    return ["RU", "RELEASE_STOP_UNCHECKED"];
  }

  if (text === "UC") {
    return ["UC", "RETURNS_UNCHECKED"];
  }

  return [mockReturnReceiptStatusForFilter(text)];
}

function officialReturnPayload(row) {
  return {
    receiptId: row.receipt_id,
    orderId: row.order_id,
    receiptType: row.cancel_type,
    receiptStatus: mockReturnReceiptStatusForFilter(row.status),
    releaseStopStatus: row.release_status,
    reasonCode: row.reason_code,
    createdAt: row.created_at,
    modifiedAt: row.modified_at || row.created_at,
    faultByType: row.fault_by_type,
    completeConfirmDate: row.complete_confirm_date || "",
    completeConfirmType: row.complete_confirm_type || "UNDEFINED",
    cancelCountSum: 1,
    returnItems: [
      {
        shipmentBoxId: row.shipment_box_id,
        productId: row.product_id,
        sellerProductId: row.seller_product_id,
        vendorItemId: row.vendor_item_id,
        sellerProductItemName: row.seller_product_item_name,
        cancelCount: 1,
        purchaseCount: 1,
        releaseStatus: row.release_status,
      },
    ],
  };
}

function officialExchangePayload(row) {
  const raw = safeJsonParseObject(row.raw_json);

  return {
    exchangeId: row.exchange_id,
    orderId: row.order_id,
    orderDeliveryStatusCode: "INSTRUCT",
    exchangeStatus: row.exchange_status,
    referType: "WEB_PC",
    faultType: raw.faultType || "CUSTOMER",
    exchangeAmount: "0",
    reason: null,
    reasonCode: row.reason_code,
    reasonCodeText: row.reason_code_text,
    reasonEtcDetail: row.reason_etc_detail,
    cancelReason: "",
    createdByType: "CUSTOMER",
    createdAt: row.created_at,
    modifiedByType: "CUSTOMER",
    modifiedAt: row.modified_at,
    exchangeItemDtoV1s: [
      {
        exchangeItemId: row.exchange_id,
        orderItemId: row.vendor_item_id,
        orderItemName: row.seller_product_item_name,
        orderPackageId: row.product_id,
        orderPackageName: row.seller_product_item_name,
        targetItemId: row.vendor_item_id,
        targetItemName: row.seller_product_item_name,
        targetPackageId: row.product_id,
        targetPackageName: row.seller_product_item_name,
        quantity: 1,
        orderItemDeliveryComplete: false,
        orderItemReturnComplete: false,
        targetItemDeliveryComplete: false,
        createdAt: row.created_at,
        modifiedAt: row.modified_at,
        originalShipmentBoxId: row.original_shipment_box_id,
      },
    ],
  };
}

function decodeProductNextToken(value) {
  if (!value) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

    if (parsed && parsed.mode === "products") {
      return nonNegativeInteger(parsed.offset, 0);
    }
  } catch {
    const numericOffset = Number.parseInt(String(value), 10);

    if (Number.isFinite(numericOffset) && numericOffset >= 0) {
      return numericOffset;
    }
  }

  throw new Error("Invalid nextToken");
}

function officialProductListItem(row, vendorId) {
  return {
    sellerProductId: row.seller_product_id,
    sellerProductName: row.seller_product_name,
    productId: row.product_id,
    statusName: "APPROVED",
    vendorId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function officialSellerProductsPayload(db, input) {
  const vendorId = (await currentMockCredential(db))?.vendorId || "";
  const limit = positiveInteger(input.maxPerPage, 100, maxPageSize);
  const offset = decodeProductNextToken(input.nextToken);
  const search = String(input.sellerProductName || input.search || "").trim();
  const sellerProductId = String(input.sellerProductId || "").trim();
  const rows = await db
    .prepare(
      `
      SELECT *
      FROM mock_products
      WHERE (? = '' OR seller_product_id = ?)
        AND (
          ? = ''
          OR seller_product_name LIKE ?
          OR seller_product_item_name LIKE ?
          OR vendor_item_id LIKE ?
          OR vendor_sku_code LIKE ?
        )
      ORDER BY source_row_index, vendor_item_id
    `
    )
    .all(
      sellerProductId,
      sellerProductId,
      search,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`
    );
  const uniqueRows = [];
  const seen = new Set();

  for (const row of rows) {
    if (!seen.has(row.seller_product_id)) {
      uniqueRows.push(row);
      seen.add(row.seller_product_id);
    }
  }

  const pageRows = uniqueRows.slice(offset, offset + limit);
  const nextOffset = offset + pageRows.length;
  const nextToken =
    nextOffset < uniqueRows.length
      ? encodeNextToken({ mode: "products", offset: nextOffset })
      : null;

  return {
    code: "SUCCESS",
    message: "OK",
    nextToken,
    data: pageRows.map((row) => officialProductListItem(row, vendorId)),
  };
}

async function officialSellerProductDetailPayload(db, sellerProductId) {
  const rows = await db
    .prepare(
      `
      SELECT *
      FROM mock_products
      WHERE seller_product_id = ?
      ORDER BY source_row_index, vendor_item_id
    `
    )
    .all(String(sellerProductId || ""));
  const first = rows[0];

  if (!first) {
    return null;
  }

  return {
    code: "SUCCESS",
    message: "OK",
    data: {
      sellerProductId: first.seller_product_id,
      sellerProductName: first.seller_product_name,
      productId: first.product_id,
      statusName: "APPROVED",
      vendorId: (await currentMockCredential(db))?.vendorId || "",
      createdAt: first.created_at,
      updatedAt: rows
        .map((row) => row.updated_at)
        .filter(Boolean)
        .sort()
        .at(-1),
      items: rows.map((row) => ({
        sellerProductItemId: row.vendor_item_id,
        vendorItemId: row.vendor_item_id,
        itemName: row.seller_product_item_name,
        externalVendorSku: row.vendor_sku_code,
        originalPrice: row.average_price_snapshot,
        salePrice: row.average_price_snapshot,
        maximumBuyCount: row.current_quantity_snapshot,
        statusName: "APPROVED",
      })),
    },
  };
}

async function officialVendorItemInventoryPayload(db, vendorItemId) {
  const row = await db
    .prepare(
      `
      SELECT vendor_item_id, current_quantity_snapshot, average_price_snapshot
      FROM mock_products
      WHERE vendor_item_id = ?
    `
    )
    .get(String(vendorItemId || ""));

  if (!row) return null;
  const numericSellerItemId = Number(row.vendor_item_id);

  return {
    code: "SUCCESS",
    message: "",
    data: {
      sellerItemId: Number.isSafeInteger(numericSellerItemId)
        ? numericSellerItemId
        : row.vendor_item_id,
      amountInStock: row.current_quantity_snapshot,
      salePrice: row.average_price_snapshot,
      onSale: true,
    },
  };
}

async function insertGeneratedOrder(db, input) {
  const orderSequence = await nextCounter(db, "order");
  const orderId = externalId("935770000000000000", orderSequence);
  const shipmentBoxId = externalId("884440000000000000", orderSequence);
  const product = await productForOrderSequence(db, orderSequence);
  const customer = customerFor(orderSequence);
  const minuteOffset = Number(orderSequence % 120n);
  const order = {
    orderId,
    shipmentBoxId,
    status: input.status,
    orderedAt: coupangIso(minuteOffset + 2),
    paidAt: coupangIso(minuteOffset + 1),
    ...customer,
  };
  const shippingCount = Number(orderSequence % 9n) === 0 ? 2 : 1;
  const holdCountForCancel = Number(orderSequence % 13n) === 0 ? 1 : 0;
  const cancelCount = 0;
  const canceled = Number(orderSequence % 29n) === 0 ? 1 : 0;
  const itemPayload = {
    productId: product.product_id,
    vendorItemId: product.vendor_item_id,
    vendorItemName: product.vendor_item_name,
    sellerProductId: product.seller_product_id,
    sellerProductName: product.seller_product_name,
    sellerProductItemName: product.seller_product_item_name,
    vendorSkuCode: product.vendor_sku_code,
    salesPrice: moneyPayload(product.average_price_snapshot),
    quickhack: {
      model: product.quickhack_model,
      color: product.quickhack_color,
      capacity: product.quickhack_capacity,
      grade: product.quickhack_grade,
      gradeGroupCode: product.quickhack_grade_group_code,
      gradeGroupLabel: product.quickhack_grade_group_label,
    },
    shippingCount,
    holdCountForCancel,
    cancelCount,
    canceled: canceled === 1,
  };
  const payload = {
    orderId: order.orderId,
    shipmentBoxId: order.shipmentBoxId,
    status: order.status,
    orderedAt: order.orderedAt,
    paidAt: order.paidAt,
    orderer: {
      name: order.ordererName,
      phone: order.ordererPhone,
    },
    receiver: {
      name: order.receiverName,
      phone: order.receiverPhone,
      mobile: order.receiverMobile,
      safeNumber: order.receiverSafeNumber,
      addr1: order.receiverAddr1,
      addr2: order.receiverAddr2,
      postCode: order.receiverPostCode,
    },
    parcelPrintMessage: order.deliveryMessage,
    deliveryMessage: order.deliveryMessage,
    orderItems: [itemPayload],
  };
  const now = sqlNow();

  await db.prepare(`
    INSERT INTO mock_orders (
      batch_id, page_no, order_id, shipment_box_id, status, ordered_at, paid_at,
      orderer_name, orderer_phone, receiver_name, receiver_phone, receiver_mobile,
      receiver_safe_number, receiver_addr1, receiver_addr2, receiver_post_code,
      delivery_message, raw_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.batchId,
    input.pageNo,
    order.orderId,
    order.shipmentBoxId,
    order.status,
    order.orderedAt,
    order.paidAt,
    order.ordererName,
    order.ordererPhone,
    order.receiverName,
    order.receiverPhone,
    order.receiverMobile,
    order.receiverSafeNumber,
    order.receiverAddr1,
    order.receiverAddr2,
    order.receiverPostCode,
    order.deliveryMessage,
    jsonText(payload),
    now,
    now
  );

  await db.prepare(`
    INSERT INTO mock_order_items (
      order_id, product_id, vendor_item_id, vendor_item_name, seller_product_id,
      seller_product_name, seller_product_item_name, vendor_sku_code,
      shipping_count, hold_count_for_cancel, cancel_count, canceled,
      raw_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.orderId,
    product.product_id,
    product.vendor_item_id,
    product.vendor_item_name,
    product.seller_product_id,
    product.seller_product_name,
    product.seller_product_item_name,
    product.vendor_sku_code,
    shippingCount,
    holdCountForCancel,
    cancelCount,
    canceled,
    jsonText(itemPayload),
    now
  );
}

async function generateOrderRecord(db, status = "ACCEPT") {
  const batchId = randomToken("auto_order");
  const now = sqlNow();

  await db.transaction(async () => {
    await db.prepare(`
      INSERT INTO mock_batches (
        batch_id, status, page_size, total_orders, total_pages, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(batchId, status, 1, 1, 1, now);

    await insertGeneratedOrder(db, {
      batchId,
      status,
      pageNo: 1,
    });
  })();

  return db
    .prepare("SELECT * FROM mock_orders WHERE batch_id = ? ORDER BY id DESC LIMIT 1")
    .get(batchId);
}

async function ordersheetPage(db, input) {
  const pageRequest = decodeNextToken(input.nextToken);
  const status = pageRequest?.status || input.status || "INSTRUCT";
  const limit = positiveInteger(pageRequest?.limit ?? input.limit, defaultPageSize, maxPageSize);
  const offset = nonNegativeInteger(pageRequest?.offset, 0);
  const maxId =
    pageRequest?.maxId ??
    Number((await db
      .prepare("SELECT COALESCE(MAX(id), 0) AS value FROM mock_orders WHERE status = ?")
      .get(status)).value);

  if (
    pageRequest &&
    (!Number.isInteger(pageRequest.maxId) ||
      !Number.isInteger(pageRequest.offset) ||
      !Number.isInteger(pageRequest.limit) ||
      typeof pageRequest.status !== "string")
  ) {
    throw new Error("Invalid nextToken");
  }

  const orders = await db
    .prepare(`
      SELECT * FROM mock_orders
      WHERE status = ? AND id <= ?
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `)
    .all(status, maxId, limit, offset);
  const itemQuery = db.prepare(`
    SELECT
      items.*,
      products.quickhack_model,
      products.quickhack_color,
      products.quickhack_capacity,
      products.quickhack_grade,
      products.quickhack_grade_group_code,
      products.quickhack_grade_group_label,
      products.average_price_snapshot
    FROM mock_order_items AS items
    LEFT JOIN mock_products AS products
      ON products.vendor_item_id = items.vendor_item_id
    WHERE items.order_id = ?
    ORDER BY items.id ASC
  `);
  const total = Number((await db
    .prepare("SELECT COUNT(*) AS value FROM mock_orders WHERE status = ? AND id <= ?")
    .get(status, maxId)).value);
  const nextOffset = offset + orders.length;
  const nextToken =
    nextOffset < total
      ? encodeNextToken({
          mode: "orders",
          status,
          maxId,
          offset: nextOffset,
          limit,
        })
      : null;

  return {
    code: "SUCCESS",
    message: "OK",
    nextToken,
    data: await Promise.all(
      orders.map(async (order) =>
        orderPayload(order, await itemQuery.all(order.order_id))
      )
    ),
  };
}

async function ordersheetByOrderId(db, orderId) {
  const orders = await db
    .prepare("SELECT * FROM mock_orders WHERE order_id = ? ORDER BY id ASC")
    .all(String(orderId ?? "").trim());
  const itemQuery = db.prepare(`
    SELECT
      items.*,
      products.quickhack_model,
      products.quickhack_color,
      products.quickhack_capacity,
      products.quickhack_grade,
      products.quickhack_grade_group_code,
      products.quickhack_grade_group_label,
      products.average_price_snapshot
    FROM mock_order_items AS items
    LEFT JOIN mock_products AS products
      ON products.vendor_item_id = items.vendor_item_id
    WHERE items.order_id = ?
    ORDER BY items.id ASC
  `);

  return {
    code: "SUCCESS",
    message: "OK",
    data: await Promise.all(
      orders.map(async (order) =>
        orderPayload(order, await itemQuery.all(order.order_id))
      )
    ),
  };
}

async function acknowledgeOrdersheetsPayload(db, input) {
  const shipmentBoxIds = Array.isArray(input.shipmentBoxIds)
    ? input.shipmentBoxIds.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  const now = coupangIso(0);
  const findOrder = db.prepare("SELECT * FROM mock_orders WHERE shipment_box_id = ?");
  const updateOrder = db.prepare(
    "UPDATE mock_orders SET status = ?, updated_at = ? WHERE shipment_box_id = ?"
  );
  const responseList = await Promise.all(shipmentBoxIds.map(async (shipmentBoxId) => {
    const order = await findOrder.get(shipmentBoxId);

    if (!order) {
      return {
        shipmentBoxId,
        succeed: false,
        resultCode: "NOT_FOUND_SHIPMENT_BOX",
        retryRequired: true,
        resultMessage: `shipmentBoxId (${shipmentBoxId}) is not found.`,
      };
    }

    if (order.status !== "ACCEPT") {
      return {
        shipmentBoxId,
        succeed: false,
        resultCode: "INVALID_ORDER_STATUS",
        retryRequired: false,
        resultMessage: `shipmentBoxId (${shipmentBoxId}) is ${order.status}.`,
      };
    }

    await updateOrder.run("INSTRUCT", now, shipmentBoxId);

    return {
      shipmentBoxId,
      succeed: true,
      resultCode: "OK",
      retryRequired: false,
      resultMessage: "request succeeded.",
    };
  }));
  const succeededCount = responseList.filter((item) => item.succeed).length;
  const responseCode =
    responseList.length === 0 || succeededCount === 0
      ? 99
      : succeededCount === responseList.length
        ? 0
        : 1;

  return {
    code: "200",
    message: "OK",
    data: {
      responseKey: Date.now(),
      responseCode,
      responseMessage:
        responseCode === 0
          ? "apply instructStatus result - All succeeded."
          : responseCode === 1
            ? "apply instructStatus result - Partial errors."
            : "apply instructStatus result - All Failed.",
      responseList,
    },
  };
}

async function uploadInvoicesPayload(db, input) {
  const rows = Array.isArray(input?.orderSheetInvoiceApplyDtos)
    ? input.orderSheetInvoiceApplyDtos
    : [];
  const now = coupangIso(0);
  const findOrder = db.prepare(
    "SELECT * FROM mock_orders WHERE shipment_box_id = ?"
  );
  const findItem = db.prepare(
    "SELECT 1 FROM mock_order_items WHERE order_id = ? AND vendor_item_id = ?"
  );
  const findInvoiceOwners = db.prepare(
    "SELECT receiver_name, receiver_post_code, receiver_addr1, receiver_addr2 FROM mock_orders WHERE invoice_number = ?"
  );
  const updateOrder = db.prepare(`
    UPDATE mock_orders
    SET status = 'DEPARTURE',
        delivery_company_code = ?,
        delivery_company_name = ?,
        invoice_number = ?,
        invoice_uploaded_at = ?,
        split_shipping = ?,
        updated_at = ?
    WHERE shipment_box_id = ?
  `);

  const responseList = await Promise.all(rows.map(async (row) => {
    const shipmentBoxId = String(row?.shipmentBoxId ?? "").trim();
    const orderId = String(row?.orderId ?? "").trim();
    const vendorItemId = String(row?.vendorItemId ?? "").trim();
    const deliveryCompanyCode = String(
      row?.deliveryCompanyCode ?? ""
    ).trim().toUpperCase();
    const invoiceNumber = String(row?.invoiceNumber ?? "").trim();
    const order = await findOrder.get(shipmentBoxId);

    function failed(resultCode, resultMessage, retryRequired = false) {
      return {
        shipmentBoxId,
        succeed: false,
        resultCode,
        retryRequired,
        resultMessage,
      };
    }

    if (!order || order.order_id !== orderId) {
      return failed(
        "NOT_FOUND_SHIPMENT_BOX",
        `shipmentBoxId (${shipmentBoxId}) is not found.`
      );
    }
    if (order.status !== "INSTRUCT") {
      return failed(
        "INVALID_STATUS",
        `shipmentBoxId (${shipmentBoxId}) is ${order.status}.`
      );
    }
    if (!(await findItem.get(orderId, vendorItemId))) {
      return failed(
        "NOT_FOUND_VENDOR_ITEM",
        `vendorItemId (${vendorItemId}) is not part of the shipment.`
      );
    }
    if (deliveryCompanyCode !== "KGB") {
      return failed(
        "INVALID_DELIVERY_COMPANY_CODE",
        `deliveryCompanyCode (${deliveryCompanyCode}) is not Logen.`
      );
    }
    if (!/^\d{10,11}$/.test(invoiceNumber)) {
      return failed(
        "INVALID_INVOICE_NUMBER",
        `invoiceNumber (${invoiceNumber}) is invalid.`,
        true
      );
    }
    if (row?.splitShipping === true || row?.preSplitShipped === true) {
      return failed(
        "SPLIT_SHIPPING_NOT_SUPPORTED",
        "The QuickHack mock only accepts full-shipment invoice uploads."
      );
    }

    const duplicateWithDifferentReceiver = (await findInvoiceOwners
      .all(invoiceNumber))
      .some(
        (owner) =>
          owner.receiver_name !== order.receiver_name ||
          owner.receiver_post_code !== order.receiver_post_code ||
          owner.receiver_addr1 !== order.receiver_addr1 ||
          owner.receiver_addr2 !== order.receiver_addr2
      );
    if (duplicateWithDifferentReceiver) {
      return failed(
        "DUPLICATE_INVOICE_NUMBER",
        "The invoice number is already assigned to another receiver.",
        true
      );
    }

    await updateOrder.run(
      deliveryCompanyCode,
      "로젠택배",
      invoiceNumber,
      now,
      0,
      now,
      shipmentBoxId
    );
    return {
      shipmentBoxId,
      succeed: true,
      resultCode: "OK",
      retryRequired: false,
      resultMessage: null,
    };
  }));
  const succeededCount = responseList.filter((row) => row.succeed).length;
  const responseCode =
    rows.length === 0 || succeededCount === 0
      ? 99
      : succeededCount === rows.length
        ? 0
        : 1;

  return {
    code: "200",
    message: "OK",
    data: {
      responseCode,
      responseMessage:
        responseCode === 0
          ? "SUCCESS"
          : responseCode === 1
            ? "PARTIAL_ERROR"
            : "FAILED",
      responseList,
    },
  };
}

async function updateInvoicesPayload(db, input) {
  const rows = Array.isArray(input?.orderSheetInvoiceApplyDtos)
    ? input.orderSheetInvoiceApplyDtos
    : [];
  const now = coupangIso(0);
  const findOrder = db.prepare(
    "SELECT * FROM mock_orders WHERE shipment_box_id = ?"
  );
  const findItem = db.prepare(
    "SELECT 1 FROM mock_order_items WHERE order_id = ? AND vendor_item_id = ?"
  );
  const findInvoiceOwners = db.prepare(
    "SELECT shipment_box_id, receiver_name, receiver_post_code, receiver_addr1, receiver_addr2 FROM mock_orders WHERE invoice_number = ?"
  );
  const updateOrder = db.prepare(`
    UPDATE mock_orders
    SET delivery_company_code = ?,
        delivery_company_name = ?,
        invoice_number = ?,
        invoice_uploaded_at = ?,
        updated_at = ?
    WHERE shipment_box_id = ?
  `);

  const responseList = await Promise.all(rows.map(async (row) => {
    const shipmentBoxId = String(row?.shipmentBoxId ?? "").trim();
    const orderId = String(row?.orderId ?? "").trim();
    const vendorItemId = String(row?.vendorItemId ?? "").trim();
    const deliveryCompanyCode = String(
      row?.deliveryCompanyCode ?? ""
    ).trim().toUpperCase();
    const invoiceNumber = String(row?.invoiceNumber ?? "").trim();
    const order = await findOrder.get(shipmentBoxId);

    function failed(resultCode, resultMessage, retryRequired = false) {
      return {
        shipmentBoxId,
        succeed: false,
        resultCode,
        retryRequired,
        resultMessage,
      };
    }

    if (!order || order.order_id !== orderId) {
      return failed(
        "NOT_FOUND_SHIPMENT_BOX",
        `shipmentBoxId (${shipmentBoxId}) is not found.`
      );
    }
    if (order.status !== "DEPARTURE") {
      return failed(
        "INVALID_STATUS",
        `shipmentBoxId (${shipmentBoxId}) is ${order.status}.`
      );
    }
    if (!order.invoice_number) {
      return failed(
        "INVOICE_NOT_REGISTERED",
        `shipmentBoxId (${shipmentBoxId}) has no registered invoice.`
      );
    }
    if (!(await findItem.get(orderId, vendorItemId))) {
      return failed(
        "NOT_FOUND_VENDOR_ITEM",
        `vendorItemId (${vendorItemId}) is not part of the shipment.`
      );
    }
    if (deliveryCompanyCode !== "KGB") {
      return failed(
        "INVALID_DELIVERY_COMPANY_CODE",
        `deliveryCompanyCode (${deliveryCompanyCode}) is not Logen.`
      );
    }
    if (!/^\d{10,11}$/.test(invoiceNumber)) {
      return failed(
        "INVALID_INVOICE_NUMBER",
        `invoiceNumber (${invoiceNumber}) is invalid.`,
        true
      );
    }
    if (row?.splitShipping === true || row?.preSplitShipped === true) {
      return failed(
        "SPLIT_SHIPPING_NOT_SUPPORTED",
        "The QuickHack mock only accepts full-shipment invoice updates."
      );
    }

    const duplicateWithDifferentReceiver = (await findInvoiceOwners
      .all(invoiceNumber))
      .some(
        (owner) =>
          owner.shipment_box_id !== shipmentBoxId &&
          (owner.receiver_name !== order.receiver_name ||
            owner.receiver_post_code !== order.receiver_post_code ||
            owner.receiver_addr1 !== order.receiver_addr1 ||
            owner.receiver_addr2 !== order.receiver_addr2)
      );
    if (duplicateWithDifferentReceiver) {
      return failed(
        "DUPLICATE_INVOICE_NUMBER",
        "The invoice number is already assigned to another receiver.",
        true
      );
    }

    await updateOrder.run(
      deliveryCompanyCode,
      "로젠택배",
      invoiceNumber,
      now,
      now,
      shipmentBoxId
    );
    return {
      shipmentBoxId,
      succeed: true,
      resultCode: "OK",
      retryRequired: false,
      resultMessage: null,
    };
  }));
  const succeededCount = responseList.filter((row) => row.succeed).length;
  const responseCode =
    rows.length === 0 || succeededCount === 0
      ? 99
      : succeededCount === rows.length
        ? 0
        : 1;

  return {
    code: "200",
    message: "OK",
    data: {
      responseCode,
      responseMessage:
        responseCode === 0
          ? "update invoice result - All Success."
          : responseCode === 1
            ? "update invoice result - Partial errors."
            : "update invoice result - All Failed.",
      responseList,
    },
  };
}

function requireNumericPathId(value, label) {
  const text = String(value ?? "").trim();

  if (!/^\d+$/.test(text) || text === "0") {
    throw new Error(`${label} must be a positive numeric value.`);
  }

  return text;
}

function requireBodyReceiptId(body) {
  const value = body?.receiptId;
  const text = String(value ?? "").trim();

  if (!text) {
    throw new Error("receiptId is required.");
  }

  return text;
}

function requirePositiveSafeInteger(value, label) {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }

  return parsed;
}

async function returnActionPayload(db, input) {
  const receiptId = requireNumericPathId(input.receiptId, "receiptId");
  const bodyReceiptId = requireBodyReceiptId(input.body);

  if (typeof input.body.receiptId === "string" && bodyReceiptId !== receiptId) {
    throw new Error("receiptId path and body do not match.");
  }

  if (input.requireCancelCount) {
    requirePositiveSafeInteger(input.body.cancelCount, "cancelCount");
  }

  const row = await db
    .prepare("SELECT * FROM mock_return_requests WHERE receipt_id = ?")
    .get(receiptId);

  if (!row) {
    throw new Error(`receiptId (${receiptId}) is not found.`);
  }

  if (row.cancel_type !== "RETURN") {
    throw new Error(`receiptId (${receiptId}) is not a return request.`);
  }

  if (!input.allowedStatuses.includes(row.status)) {
    throw new Error(`receiptId (${receiptId}) is ${row.status}.`);
  }

  if (
    Array.isArray(input.allowedReleaseStatuses) &&
    !input.allowedReleaseStatuses.includes(row.release_status)
  ) {
    throw new Error(`receiptId (${receiptId}) releaseStatus is ${row.release_status}.`);
  }

  const now = coupangIso(0);
  const completeConfirmDate =
    input.nextStatus === "RETURNS_COMPLETED"
      ? now
      : row.complete_confirm_date;
  const completeConfirmType =
    input.nextStatus === "RETURNS_COMPLETED"
      ? "VENDOR_CONFIRM"
      : row.complete_confirm_type;
  const payload = {
    ...safeJsonParseObject(row.raw_json),
    receiptId,
    status: input.nextStatus,
    receiptStatus: input.nextStatus,
    modifiedAt: now,
    completeConfirmDate: completeConfirmDate || "",
    completeConfirmType: completeConfirmType || "UNDEFINED",
  };

  await db.prepare(`
    UPDATE mock_return_requests
    SET status = ?,
        release_status = ?,
        modified_at = ?,
        complete_confirm_date = ?,
        complete_confirm_type = ?,
        raw_json = ?
    WHERE receipt_id = ?
  `).run(
    input.nextStatus,
    input.nextReleaseStatus,
    now,
    completeConfirmDate,
    completeConfirmType,
    jsonText(payload),
    receiptId
  );

  return {
    code: "200",
    message: "OK",
  };
}

async function generateReturnRecord(db, status = "RU", requestedCancelType = "RETURN") {
  const targetOrder = await db
    .prepare(`
      SELECT
        orders.order_id,
        orders.shipment_box_id,
        items.product_id,
        items.seller_product_id,
        items.vendor_item_id,
        items.seller_product_item_name
      FROM mock_orders AS orders
      JOIN mock_order_items AS items
        ON items.order_id = orders.order_id
      LEFT JOIN mock_return_requests AS requests
        ON requests.order_id = orders.order_id
      LEFT JOIN mock_exchange_requests AS exchanges
        ON exchanges.order_id = orders.order_id
      WHERE requests.receipt_id IS NULL
        AND exchanges.exchange_id IS NULL
      ORDER BY orders.id DESC
      LIMIT 1
    `)
    .get();

  if (!targetOrder) {
    return null;
  }

  const sequence = await nextCounter(db, "return");
  const receiptId = externalId("991230000000000000", sequence);
  const cancelType =
    String(requestedCancelType || "RETURN").trim().toUpperCase() === "CANCEL"
      ? "CANCEL"
      : "RETURN";
  const reasonCode = "CHANGE_MIND";
  const receiptStatus = mockReturnReceiptStatusForFilter(status);
  const createdAt = coupangIso(0);
  const faultByType = sequence % 2n === 0n ? "VENDOR" : "CUSTOMER";
  const payload = {
    receiptId,
    orderId: targetOrder.order_id,
    shipmentBoxId: targetOrder.shipment_box_id,
    productId: targetOrder.product_id,
    sellerProductId: targetOrder.seller_product_id,
    vendorItemId: targetOrder.vendor_item_id,
    sellerProductItemName: targetOrder.seller_product_item_name,
    status: receiptStatus,
    cancelType,
    reasonCode,
    releaseStatus: "N",
    createdAt,
    modifiedAt: createdAt,
    faultByType,
    completeConfirmDate: "",
    completeConfirmType: "UNDEFINED",
  };

  await db.prepare(`
    INSERT INTO mock_return_requests (
      receipt_id, order_id, shipment_box_id, product_id, seller_product_id,
      vendor_item_id, seller_product_item_name, status, cancel_type,
      reason_code, release_status, created_at, modified_at, fault_by_type,
      complete_confirm_date, complete_confirm_type, raw_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    receiptId,
    targetOrder.order_id,
    targetOrder.shipment_box_id,
    targetOrder.product_id,
    targetOrder.seller_product_id,
    targetOrder.vendor_item_id,
    targetOrder.seller_product_item_name,
    receiptStatus,
    cancelType,
    reasonCode,
    "N",
    createdAt,
    createdAt,
    faultByType,
    null,
    "UNDEFINED",
    jsonText(payload)
  );

  return db
    .prepare("SELECT * FROM mock_return_requests WHERE receipt_id = ?")
    .get(receiptId);
}

async function generateExchangeRecord(db, status = "RECEIPT") {
  const targetOrder = await db
    .prepare(`
      SELECT
        orders.order_id,
        orders.shipment_box_id,
        items.product_id,
        items.seller_product_id,
        items.vendor_item_id,
        items.seller_product_item_name
      FROM mock_orders AS orders
      JOIN mock_order_items AS items
        ON items.order_id = orders.order_id
      LEFT JOIN mock_return_requests AS requests
        ON requests.order_id = orders.order_id
      LEFT JOIN mock_exchange_requests AS exchanges
        ON exchanges.order_id = orders.order_id
      WHERE requests.receipt_id IS NULL
        AND exchanges.exchange_id IS NULL
      ORDER BY orders.id DESC
      LIMIT 1
    `)
    .get();

  if (!targetOrder) {
    return null;
  }

  const sequence = await nextCounter(db, "exchange");
  const exchangeId = externalId("881230000000000000", sequence);
  const createdAt = coupangIso(0);
  const payload = {
    exchangeId,
    orderId: targetOrder.order_id,
    originalShipmentBoxId: targetOrder.shipment_box_id,
    productId: targetOrder.product_id,
    sellerProductId: targetOrder.seller_product_id,
    vendorItemId: targetOrder.vendor_item_id,
    sellerProductItemName: targetOrder.seller_product_item_name,
    exchangeStatus: status,
    faultType: "CUSTOMER",
    reasonCode: "EXCHANGE_REQUEST",
    reasonCodeText: "교환 요청",
    reasonEtcDetail: "",
    createdAt,
    modifiedAt: createdAt,
  };

  await db.prepare(`
    INSERT INTO mock_exchange_requests (
      exchange_id, order_id, original_shipment_box_id, product_id,
      seller_product_id, vendor_item_id, seller_product_item_name,
      exchange_status, reason_code, reason_code_text, reason_etc_detail,
      created_at, modified_at, raw_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    exchangeId,
    targetOrder.order_id,
    targetOrder.shipment_box_id,
    targetOrder.product_id,
    targetOrder.seller_product_id,
    targetOrder.vendor_item_id,
    targetOrder.seller_product_item_name,
    status,
    payload.reasonCode,
    payload.reasonCodeText,
    payload.reasonEtcDetail,
    createdAt,
    createdAt,
    jsonText(payload)
  );

  return db
    .prepare("SELECT * FROM mock_exchange_requests WHERE exchange_id = ?")
    .get(exchangeId);
}

async function generateReturnOrExchangeRecord(db, status = "RU") {
  const sequence = await nextCounter(db, "returnExchangeKind");

  if (sequence % 3n === 0n) {
    return generateExchangeRecord(db, "RECEIPT");
  }

  return generateReturnRecord(
    db,
    status,
    sequence % 3n === 2n ? "CANCEL" : "RETURN"
  );
}

async function returnRequestsPayload(db, input) {
  const orderId = String(input.orderId || "").trim();
  const status = String(input.status || (orderId ? "" : "RU")).trim();
  const cancelType = String(input.cancelType || "").trim().toUpperCase();
  const conditions = [];
  const params = [];

  if (cancelType) {
    conditions.push("cancel_type = ?");
    params.push(cancelType);
  }

  if (status) {
    const statusCandidates = mockReturnStatusFilterCandidates(status);
    const statusPlaceholders = statusCandidates.map(() => "?").join(", ");
    conditions.push(`status IN (${statusPlaceholders})`);
    params.push(...statusCandidates);
  }

  if (orderId) {
    conditions.push("order_id = ?");
    params.push(orderId);
  }

  const rows = await db
    .prepare(`
      SELECT * FROM mock_return_requests
      ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(
      ...params,
      positiveInteger(input.limit, 20, 100)
    );

  return {
    code: "SUCCESS",
    message: "OK",
    nextToken: null,
    data: rows.map(officialReturnPayload),
  };
}

async function exchangeRequestsPayload(db, input) {
  const status = String(input.status || "").trim();
  const limit = positiveInteger(input.limit, 20, 100);
  const rows = status
    ? await db
        .prepare(`
          SELECT * FROM mock_exchange_requests
          WHERE exchange_status = ?
          ORDER BY created_at DESC
          LIMIT ?
        `)
        .all(status, limit)
    : await db
        .prepare(`
          SELECT * FROM mock_exchange_requests
          ORDER BY created_at DESC
          LIMIT ?
        `)
        .all(limit);

  return {
    code: "SUCCESS",
    message: "OK",
    nextToken: null,
    data: rows.map(officialExchangePayload),
  };
}

function dateKeyMilliseconds(value, label) {
  const text = String(value || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${label} must use yyyy-MM-dd.`);
  }

  const milliseconds = Date.parse(`${text}T00:00:00.000Z`);

  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== text
  ) {
    throw new Error(`${label} is invalid.`);
  }

  return { text, milliseconds };
}

function parseVendorItemIdsJson(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function officialReturnWithdrawalPayload(row) {
  return {
    cancelId: row.cancel_id,
    orderId: row.order_id,
    vendorId: null,
    refundDeliveryDuty: row.refund_delivery_duty,
    createdAt: row.created_at,
    vendorItemIds: parseVendorItemIdsJson(row.vendor_item_ids_json),
  };
}

async function returnWithdrawalsPayload(db, input) {
  const from = dateKeyMilliseconds(input.dateFrom, "dateFrom");
  const to = dateKeyMilliseconds(input.dateTo, "dateTo");
  const dayMilliseconds = 24 * 60 * 60 * 1000;

  if (from.milliseconds > to.milliseconds) {
    throw new Error("dateTo must not be before dateFrom.");
  }

  if (
    Math.floor((to.milliseconds - from.milliseconds) / dayMilliseconds) + 1 >
    7
  ) {
    throw new Error("The maximum view duration is 7 days.");
  }

  const rawPageIndex = String(input.pageIndex ?? "").trim();
  const rawSizePerPage = String(input.sizePerPage ?? "").trim();
  const pageIndex = rawPageIndex ? Number(rawPageIndex) : 1;
  const sizePerPage = rawSizePerPage ? Number(rawSizePerPage) : 10;

  if (!Number.isSafeInteger(pageIndex) || pageIndex <= 0) {
    throw new Error("pageIndex must be a positive integer.");
  }

  if (
    !Number.isSafeInteger(sizePerPage) ||
    sizePerPage <= 0 ||
    sizePerPage > 100
  ) {
    throw new Error("sizePerPage must be an integer from 1 to 100.");
  }

  const offset = (pageIndex - 1) * sizePerPage;
  const rows = await db
    .prepare(`
      SELECT *
      FROM mock_return_withdrawals
      WHERE substr(created_at, 1, 10) BETWEEN ? AND ?
      ORDER BY created_at DESC, cancel_id DESC
      LIMIT ? OFFSET ?
    `)
    .all(from.text, to.text, sizePerPage + 1, offset);
  const hasNextPage = rows.length > sizePerPage;

  return {
    code: 200,
    message: "OK",
    data: rows.slice(0, sizePerPage).map((row) => ({
      ...officialReturnWithdrawalPayload(row),
      vendorId: input.vendorId || null,
    })),
    nextPageIndex: hasNextPage ? String(pageIndex + 1) : "",
  };
}

async function generateReturnWithdrawal(db, requestedReceiptId) {
  const receiptId = String(requestedReceiptId || "").trim();
  const row = receiptId
    ? await db
        .prepare("SELECT * FROM mock_return_requests WHERE receipt_id = ?")
        .get(receiptId)
    : await db
        .prepare(`
          SELECT requests.*
          FROM mock_return_requests AS requests
          LEFT JOIN mock_return_withdrawals AS withdrawals
            ON withdrawals.cancel_id = requests.receipt_id
          WHERE withdrawals.cancel_id IS NULL
          ORDER BY requests.created_at DESC, requests.receipt_id DESC
          LIMIT 1
        `)
        .get();

  if (!row) {
    return null;
  }

  const createdAt = coupangIso(0);
  const vendorItemIds = row.vendor_item_id ? [String(row.vendor_item_id)] : [];

  await db.prepare(`
    INSERT INTO mock_return_withdrawals (
      cancel_id,
      order_id,
      refund_delivery_duty,
      created_at,
      vendor_item_ids_json
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cancel_id) DO UPDATE SET
      order_id = excluded.order_id,
      refund_delivery_duty = excluded.refund_delivery_duty,
      created_at = excluded.created_at,
      vendor_item_ids_json = excluded.vendor_item_ids_json
  `).run(
    row.receipt_id,
    row.order_id,
    row.fault_by_type === "VENDOR" ? "COM" : "CUS",
    createdAt,
    jsonText(vendorItemIds)
  );

  return db
    .prepare("SELECT * FROM mock_return_withdrawals WHERE cancel_id = ?")
    .get(row.receipt_id);
}

async function applyClaimScenario(db, input) {
  const action = String(input.action || "").trim().toUpperCase();
  const now = coupangIso(0);

  if (action === "RETURN_WITHDRAWN") {
    const withdrawal = await generateReturnWithdrawal(db, input.receiptId);

    if (!withdrawal) {
      throw new Error("No return request is available for withdrawal.");
    }

    return {
      action,
      withdrawal: officialReturnWithdrawalPayload(withdrawal),
    };
  }

  if (action === "RETURN_CHANGED") {
    const receiptId = String(input.receiptId || "").trim();
    const row = receiptId
      ? await db
          .prepare("SELECT * FROM mock_return_requests WHERE receipt_id = ?")
          .get(receiptId)
      : await db
          .prepare(
            "SELECT * FROM mock_return_requests ORDER BY created_at DESC LIMIT 1"
          )
          .get();

    if (!row) {
      throw new Error("No return request is available to change.");
    }

    const status = String(input.status || "VENDOR_WAREHOUSE_CONFIRM").trim();
    const faultByType = String(input.faultByType || "VENDOR").trim();
    const payload = {
      ...safeJsonParseObject(row.raw_json),
      receiptStatus: status,
      status,
      modifiedAt: now,
      faultByType,
    };

    await db.prepare(`
      UPDATE mock_return_requests
      SET status = ?, modified_at = ?, fault_by_type = ?, raw_json = ?
      WHERE receipt_id = ?
    `).run(status, now, faultByType, jsonText(payload), row.receipt_id);

    return {
      action,
      claim: officialReturnPayload(
        await db
          .prepare("SELECT * FROM mock_return_requests WHERE receipt_id = ?")
          .get(row.receipt_id)
      ),
    };
  }

  if (action === "EXCHANGE_CHANGED") {
    const exchangeId = String(input.exchangeId || "").trim();
    const row = exchangeId
      ? await db
          .prepare("SELECT * FROM mock_exchange_requests WHERE exchange_id = ?")
          .get(exchangeId)
      : await db
          .prepare(
            "SELECT * FROM mock_exchange_requests ORDER BY created_at DESC LIMIT 1"
          )
          .get();

    if (!row) {
      throw new Error("No exchange request is available to change.");
    }

    const status = String(input.status || "SUCCESS").trim();
    const reasonEtcDetail = String(
      input.reasonEtcDetail || "Mock exchange status changed"
    ).trim();
    const payload = {
      ...safeJsonParseObject(row.raw_json),
      exchangeStatus: status,
      modifiedAt: now,
      faultType: String(input.faultType || "VENDOR").trim(),
      reasonEtcDetail,
    };

    await db.prepare(`
      UPDATE mock_exchange_requests
      SET exchange_status = ?,
          reason_etc_detail = ?,
          modified_at = ?,
          raw_json = ?
      WHERE exchange_id = ?
    `).run(
      status,
      reasonEtcDetail,
      now,
      jsonText(payload),
      row.exchange_id
    );

    return {
      action,
      claim: officialExchangePayload(
        await db
          .prepare("SELECT * FROM mock_exchange_requests WHERE exchange_id = ?")
          .get(row.exchange_id)
      ),
    };
  }

  throw new Error(`Unsupported claim scenario action: ${action || "(empty)"}`);
}

async function resetDatabase(db) {
  await db.transaction(async () => {
    await db.exec(`
      TRUNCATE TABLE
        mock_return_withdrawals,
        mock_exchange_requests,
        mock_return_requests,
        mock_order_items,
        mock_orders,
        mock_batches,
        mock_products,
        mock_metadata,
        mock_counters
      RESTART IDENTITY CASCADE
    `);
  })();
}

async function seedGeneratedRecords(db, input) {
  const orderCount = nonNegativeInteger(input.orderCount, 0, 10000);
  const returnExchangeCount = nonNegativeInteger(input.returnExchangeCount, 0, 10000);

  for (let index = 0; index < orderCount; index += 1) {
    await generateOrderRecord(db, "ACCEPT");
  }

  for (let index = 0; index < returnExchangeCount; index += 1) {
    await generateReturnOrExchangeRecord(db, "RU");
  }

  if (returnExchangeCount > 0) {
    await generateReturnWithdrawal(db);
  }
}

async function counts(db) {
  const count = async (tableName) =>
    Number((await db.prepare(`SELECT COUNT(*) AS value FROM ${tableName}`).get()).value);
  const returnRows = await db
    .prepare(`
      SELECT cancel_type AS cancelType, COUNT(*) AS value
      FROM mock_return_requests
      GROUP BY cancel_type
    `)
    .all();
  const returnCounts = Object.fromEntries(
    returnRows.map((row) => [String(row.cancelType), Number(row.value)])
  );

  return {
    products: await count("mock_products"),
    batches: await count("mock_batches"),
    orders: await count("mock_orders"),
    items: await count("mock_order_items"),
    returns: await count("mock_return_requests"),
    exchanges: await count("mock_exchange_requests"),
    withdrawals: await count("mock_return_withdrawals"),
    returnRequests: returnCounts.RETURN ?? 0,
    cancelRequests: returnCounts.CANCEL ?? 0,
    exchangeRequests: await count("mock_exchange_requests"),
  };
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    ...extraHeaders,
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function isLoopbackRequest(request) {
  const address = String(request.socket.remoteAddress || "").toLowerCase();

  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

async function publicCredentialStatus(db) {
  const credential = await currentMockCredential(db);

  if (!credential) {
    return null;
  }

  return {
    credentialId: credential.credentialId,
    vendorId: credential.vendorId,
    keyFingerprint: mockCredentialFingerprint(credential.accessKey),
    issuedAt: credential.issuedAt,
    expiresAt: credential.expiresAt,
  };
}

function sendMalformedJson(response) {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  response.end('{"code":"SUCCESS","message":"BROKEN","data":');
}

function isWriteApiTarget(target) {
  return [
    "ordersheet-acknowledgement",
    "return-receive-confirmation",
    "return-approval",
    "inventory-write",
  ].includes(target);
}

function failureKindsForTarget(target) {
  const kinds = [
    "serverError",
    "rateLimit",
    "timeout",
    "responseDelay",
    "malformedJson",
    "missingRequiredField",
    "partialDataLoss",
  ];

  if (isWriteApiTarget(target)) {
    kinds.push("writeAppliedResponseFailure");
  }

  return kinds;
}

function randomFailureKind(target) {
  const kinds = failureKindsForTarget(target);

  return kinds[Math.floor(Math.random() * kinds.length)] ?? "http";
}

function sendServerErrorFailure(response, failurePolicy) {
  sendJson(response, failurePolicy.serverErrorStatus, {
    code: "MOCK_SERVER_ERROR",
    message: "Mock server intentionally returned a server error.",
  });
}

function sendRateLimitFailure(response, failurePolicy) {
  sendJson(response, 429, {
    code: "MOCK_RATE_LIMIT",
    message: "Mock server intentionally rate-limited this request.",
    retryAfterSeconds: failurePolicy.retryAfterSeconds,
  }, {
    "retry-after": String(failurePolicy.retryAfterSeconds),
  });
}

function sendTeapotFailure(response) {
  sendJson(response, 418, {
    code: 418,
    message: "I'm a teapot",
  });
}

function sendTimeoutFailure(response, failurePolicy) {
  setTimeout(() => {
    if (!response.writableEnded) {
      sendJson(response, 504, {
        code: "MOCK_TIMEOUT",
        message: "Mock server delayed this response to simulate an API timeout.",
      });
    }
  }, failurePolicy.timeoutMs);
}

function sendFailureKind(response, failurePolicy, kind) {
  if (kind === "serverError" || kind === "http") {
    sendServerErrorFailure(response, failurePolicy);
    return true;
  }

  if (kind === "rateLimit") {
    sendRateLimitFailure(response, failurePolicy);
    return true;
  }

  if (kind === "teapot") {
    sendTeapotFailure(response);
    return true;
  }

  if (kind === "timeout") {
    sendTimeoutFailure(response, failurePolicy);
    return true;
  }

  if (kind === "malformedJson") {
    sendMalformedJson(response);
    return true;
  }

  sendServerErrorFailure(response, failurePolicy);
  return true;
}

function selectedFailureKind(failurePolicy, target) {
  if (shouldTrigger(failurePolicy.randomFailureRate)) {
    return randomFailureKind(target);
  }

  const rates = [
    ["serverError", failurePolicy.serverErrorRate],
    ["rateLimit", failurePolicy.rateLimitRate],
    ["teapot", failurePolicy.teapotRate],
    ["timeout", failurePolicy.timeoutRate],
    ["responseDelay", failurePolicy.responseDelayRate],
    ["malformedJson", failurePolicy.malformedJsonRate],
    ["missingRequiredField", failurePolicy.missingRequiredFieldRate],
    ["partialDataLoss", failurePolicy.partialDataLossRate],
  ];

  if (isWriteApiTarget(target)) {
    rates.push([
      "writeAppliedResponseFailure",
      failurePolicy.writeAppliedResponseFailureRate,
    ]);
  }

  for (const [kind, rate] of rates) {
    if (shouldTrigger(rate)) {
      return kind;
    }
  }

  return null;
}

async function maybeSimulateApiFailure(response, failurePolicy, target) {
  if (!failurePolicy.enabled) {
    return false;
  }

  if (failurePolicy.target !== "all" && failurePolicy.target !== target) {
    return false;
  }

  const kind = selectedFailureKind(failurePolicy, target);

  if (!kind) {
    return false;
  }

  if (kind === "responseDelay") {
    const delayMs = randomDelayMs(
      failurePolicy.minDelayMs,
      failurePolicy.maxDelayMs
    );

    if (delayMs > 0) {
      await sleep(delayMs);
    }

    return false;
  }

  if (
    kind === "missingRequiredField" ||
    kind === "partialDataLoss" ||
    kind === "writeAppliedResponseFailure"
  ) {
    response.quickhackMockFailureKind = kind;
    response.quickhackMockFailureTarget = target;
    return false;
  }

  return sendFailureKind(response, failurePolicy, kind);
}

function cloneJsonPayload(payload) {
  return JSON.parse(JSON.stringify(payload));
}

function firstArrayPayload(payload) {
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload?.data?.responseList)) {
    return payload.data.responseList;
  }

  if (Array.isArray(payload?.data?.ordersheets)) {
    return payload.data.ordersheets;
  }

  if (Array.isArray(payload?.data?.returnRequests)) {
    return payload.data.returnRequests;
  }

  if (Array.isArray(payload?.data?.exchangeRequests)) {
    return payload.data.exchangeRequests;
  }

  return null;
}

function deleteRequiredFieldForTarget(payload, target) {
  const next = cloneJsonPayload(payload);

  if (target === "inventory") {
    if (next.data && typeof next.data === "object") {
      delete next.data.amountInStock;
    }

    return next;
  }

  const rows = firstArrayPayload(next);
  const firstRow = rows?.[0];

  if (isWriteApiTarget(target)) {
    if (next.data && typeof next.data === "object") {
      delete next.data.responseList;
    } else {
      delete next.code;
    }

    return next;
  }

  if (!firstRow || typeof firstRow !== "object") {
    if (next.data && typeof next.data === "object") {
      delete next.data;
    }

    return next;
  }

  if (target === "products") {
    delete firstRow.sellerProductId;
    delete firstRow.vendorItemId;
    return next;
  }

  if (target === "ordersheets") {
    delete firstRow.orderId;
    delete firstRow.shipmentBoxId;
    return next;
  }

  if (target === "return-requests") {
    delete firstRow.receiptId;
    delete firstRow.orderId;
    return next;
  }

  if (target === "return-withdrawals") {
    delete firstRow.cancelId;
    delete firstRow.orderId;
    return next;
  }

  if (target === "exchange-requests") {
    delete firstRow.exchangeId;
    delete firstRow.orderId;
    return next;
  }

  delete firstRow.id;
  return next;
}

function dropOneDataItem(payload) {
  const next = cloneJsonPayload(payload);

  if (Array.isArray(next?.data)) {
    next.data = next.data.slice(1);
    return next;
  }

  if (Array.isArray(next?.data?.responseList)) {
    next.data.responseList = next.data.responseList.slice(1);
    return next;
  }

  if (Array.isArray(next?.data?.ordersheets)) {
    next.data.ordersheets = next.data.ordersheets.slice(1);
    return next;
  }

  if (Array.isArray(next?.data?.returnRequests)) {
    next.data.returnRequests = next.data.returnRequests.slice(1);
    return next;
  }

  if (Array.isArray(next?.data?.exchangeRequests)) {
    next.data.exchangeRequests = next.data.exchangeRequests.slice(1);
    return next;
  }

  if (next && typeof next === "object") {
    next.mockWarning = "MOCK_PARTIAL_DATA_LOSS_NO_ARRAY_TO_DROP";
  }

  return next;
}

function payloadForMockFailure(response, payload, target) {
  const kind = response.quickhackMockFailureKind;

  if (kind === "missingRequiredField") {
    return deleteRequiredFieldForTarget(payload, target);
  }

  if (kind === "partialDataLoss") {
    return dropOneDataItem(payload);
  }

  return payload;
}

function sendMockJson(response, statusCode, payload, failurePolicy, target) {
  if (
    response.quickhackMockFailureKind === "writeAppliedResponseFailure" &&
    isWriteApiTarget(target)
  ) {
    sendServerErrorFailure(response, failurePolicy);
    return;
  }

  sendJson(
    response,
    statusCode,
    payloadForMockFailure(response, payload, target)
  );
}

function startAutoGenerators(db, input) {
  const timers = [];

  async function safeGenerate(label, generate) {
    try {
      const row = await generate();

      if (row) {
        console.log(`[coupang-mock] generated ${label}`);
      } else {
        console.log(`[coupang-mock] skipped ${label}: no eligible source row`);
      }
    } catch (error) {
      console.error(
        `[coupang-mock] failed to generate ${label}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  if (input.orderIntervalMs > 0) {
    timers.push(
      setInterval(
        () =>
          void safeGenerate("order", () =>
            generateOrderRecord(db, "ACCEPT")
          ),
        input.orderIntervalMs
      )
    );
  }

  if (input.returnExchangeIntervalMs > 0) {
    timers.push(
      setInterval(
        () =>
          void safeGenerate("return/exchange", () =>
            generateReturnOrExchangeRecord(db, "RU")
          ),
        input.returnExchangeIntervalMs
      )
    );
  }

  return timers;
}

async function handleRequest(request, response, db, generatorConfig, failurePolicy) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (url.pathname.startsWith("/admin/") && !isLoopbackRequest(request)) {
    sendJson(response, 403, { ok: false, message: "Local access only." });
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      name: "QuickHack Coupang mock server",
      database: "postgresql",
      openApiCredential: await publicCredentialStatus(db),
      generators: generatorConfig,
      failurePolicy,
      counts: await counts(db),
    });
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/admin/openapi-credentials"
  ) {
    sendJson(
      response,
      200,
      { ok: true, credential: await publicCredentialStatus(db) },
      { "cache-control": "no-store" }
    );
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/admin/openapi-credentials/issue"
  ) {
    const credential = await issueMockOpenApiCredential(db);
    sendJson(
      response,
      201,
      { ok: true, credential },
      { "cache-control": "no-store" }
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/admin/failure-policy") {
    sendJson(response, 200, { ok: true, failurePolicy });
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/failure-policy") {
    const body = parseJsonObject(await readRequestText(request));
    const nextPolicy = normalizeFailurePolicy(
      { ...failurePolicy, ...body },
      failurePolicy
    );

    Object.assign(failurePolicy, nextPolicy);
    sendJson(response, 200, { ok: true, failurePolicy });
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/claim-scenario") {
    try {
      const body = parseJsonObject(await readRequestText(request));
      sendJson(response, 200, {
        ok: true,
        ...(await applyClaimScenario(db, body)),
        counts: await counts(db),
      });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname ===
      "/v2/providers/seller_api/apis/api/v1/marketplace/seller-products"
  ) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (await maybeSimulateApiFailure(response, failurePolicy, "products")) {
      return;
    }

    sendMockJson(response, 200, await officialSellerProductsPayload(db, {
      vendorId: url.searchParams.get("vendorId"),
      sellerProductId: url.searchParams.get("sellerProductId"),
      sellerProductName: url.searchParams.get("sellerProductName"),
      status: url.searchParams.get("status"),
      nextToken: url.searchParams.get("nextToken"),
      maxPerPage: url.searchParams.get("maxPerPage"),
    }), failurePolicy, "products");
    return;
  }

  const sellerProductDetailMatch = url.pathname.match(
    /^\/v2\/providers\/seller_api\/apis\/api\/v1\/marketplace\/seller-products\/([^/]+)$/
  );

  if (request.method === "GET" && sellerProductDetailMatch) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (await maybeSimulateApiFailure(response, failurePolicy, "products")) {
      return;
    }

    const payload = await officialSellerProductDetailPayload(
      db,
      decodeURIComponent(sellerProductDetailMatch[1] || "")
    );

    if (!payload) {
      sendJson(response, 404, {
        code: "ERROR",
        message: "sellerProductId was not found.",
      });
      return;
    }

    sendMockJson(response, 200, payload, failurePolicy, "products");
    return;
  }

  const vendorItemInventoryMatch = url.pathname.match(
    /^\/v2\/providers\/seller_api\/apis\/api\/v1\/marketplace\/vendor-items\/([^/]+)\/inventories$/
  );

  if (request.method === "GET" && vendorItemInventoryMatch) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (await maybeSimulateApiFailure(response, failurePolicy, "inventory")) {
      return;
    }

    const payload = await officialVendorItemInventoryPayload(
      db,
      decodeURIComponent(vendorItemInventoryMatch[1] || "")
    );

    if (!payload) {
      sendJson(response, 400, {
        code: "ERROR",
        message: "해당 vendorItemId에 대한 유효한 옵션이 없습니다.",
      });
      return;
    }

    sendMockJson(response, 200, payload, failurePolicy, "inventory");
    return;
  }

  const vendorItemQuantityUpdateMatch = url.pathname.match(
    /^\/v2\/providers\/seller_api\/apis\/api\/v1\/marketplace\/vendor-items\/([^/]+)\/quantities\/([^/]+)$/
  );

  if (request.method === "PUT" && vendorItemQuantityUpdateMatch) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (
      await maybeSimulateApiFailure(
        response,
        failurePolicy,
        "inventory-write"
      )
    ) {
      return;
    }

    const vendorItemId = decodeURIComponent(
      vendorItemQuantityUpdateMatch[1] || ""
    );
    const quantityText = decodeURIComponent(
      vendorItemQuantityUpdateMatch[2] || ""
    );
    const quantity = Number(quantityText);

    if (
      !/^\d+$/.test(quantityText) ||
      !Number.isSafeInteger(quantity) ||
      quantity < 0
    ) {
      sendJson(response, 400, {
        code: "ERROR",
        message: "유효하지 않은 재고수량입니다.",
      });
      return;
    }

    const updated = await db
      .prepare(
        `
        UPDATE mock_products
        SET current_quantity_snapshot = ?, updated_at = ?
        WHERE vendor_item_id = ?
      `
      )
      .run(quantity, sqlNow(), vendorItemId);

    if (updated.changes !== 1) {
      sendJson(response, 400, {
        code: "ERROR",
        message: `재고변경에 실패했습니다. [vendoritemid ${vendorItemId} not found]`,
      });
      return;
    }

    sendMockJson(
      response,
      200,
      { code: "SUCCESS", message: "재고 변경을 완료했습니다." },
      failurePolicy,
      "inventory-write"
    );
    return;
  }

  const ordersheetsMatch = url.pathname.match(
    /^\/v2\/providers\/openapi\/apis\/api\/v5\/vendors\/([^/]+)\/ordersheets$/
  );

  if (request.method === "GET" && ordersheetsMatch) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (await maybeSimulateApiFailure(response, failurePolicy, "ordersheets")) {
      return;
    }

    sendMockJson(response, 200, await ordersheetPage(db, {
      status: url.searchParams.get("status") || "INSTRUCT",
      nextToken: url.searchParams.get("nextToken"),
      limit:
        url.searchParams.get("maxPerPage") ||
        url.searchParams.get("limit"),
    }), failurePolicy, "ordersheets");
    return;
  }

  const ordersheetByOrderIdMatch = url.pathname.match(
    /^\/v2\/providers\/openapi\/apis\/api\/v5\/vendors\/([^/]+)\/([^/]+)\/ordersheets$/
  );

  if (request.method === "GET" && ordersheetByOrderIdMatch) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (
      await maybeSimulateApiFailure(
        response,
        failurePolicy,
        "ordersheet-single"
      )
    ) {
      return;
    }

    sendMockJson(
      response,
      200,
      await ordersheetByOrderId(
        db,
        decodeURIComponent(ordersheetByOrderIdMatch[2] || "")
      ),
      failurePolicy,
      "ordersheet-single"
    );
    return;
  }

  const ordersheetAcknowledgementMatch = url.pathname.match(
    /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/ordersheets\/acknowledgement$/
  );

  if (
    (request.method === "PATCH" || request.method === "PUT") &&
    ordersheetAcknowledgementMatch
  ) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (
      await maybeSimulateApiFailure(
        response,
        failurePolicy,
        "ordersheet-acknowledgement"
      )
    ) {
      return;
    }

    const body = parseJsonObject(await readRequestText(request));

    sendMockJson(
      response,
      200,
      await acknowledgeOrdersheetsPayload(db, body),
      failurePolicy,
      "ordersheet-acknowledgement"
    );
    return;
  }

  const invoiceUploadMatch = url.pathname.match(
    /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/orders\/invoices$/
  );

  if (request.method === "POST" && invoiceUploadMatch) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (
      await maybeSimulateApiFailure(
        response,
        failurePolicy,
        "invoice-upload"
      )
    ) {
      return;
    }

    const body = parseJsonObject(await readRequestText(request));

    sendMockJson(
      response,
      200,
      await uploadInvoicesPayload(db, body),
      failurePolicy,
      "invoice-upload"
    );
    return;
  }

  const invoiceUpdateMatch = url.pathname.match(
    /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/orders\/updateInvoices$/
  );

  if (request.method === "POST" && invoiceUpdateMatch) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (
      await maybeSimulateApiFailure(
        response,
        failurePolicy,
        "invoice-update"
      )
    ) {
      return;
    }

    const body = parseJsonObject(await readRequestText(request));

    sendMockJson(
      response,
      200,
      await updateInvoicesPayload(db, body),
      failurePolicy,
      "invoice-update"
    );
    return;
  }

  const returnRequestsMatch = url.pathname.match(
    /^\/v2\/providers\/openapi\/apis\/api\/v6\/vendors\/([^/]+)\/returnRequests$/
  );

  if (request.method === "GET" && returnRequestsMatch) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (await maybeSimulateApiFailure(response, failurePolicy, "return-requests")) {
      return;
    }

    sendMockJson(response, 200, await returnRequestsPayload(db, {
      status: url.searchParams.get("status"),
      cancelType: url.searchParams.get("cancelType"),
      orderId: url.searchParams.get("orderId"),
      limit:
        url.searchParams.get("maxPerPage") ||
        url.searchParams.get("limit"),
    }), failurePolicy, "return-requests");
    return;
  }

  const returnWithdrawalsMatch = url.pathname.match(
    /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/returnWithdrawRequests$/
  );

  if (request.method === "GET" && returnWithdrawalsMatch) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (
      await maybeSimulateApiFailure(
        response,
        failurePolicy,
        "return-withdrawals"
      )
    ) {
      return;
    }

    try {
      sendMockJson(
        response,
        200,
        await returnWithdrawalsPayload(db, {
          vendorId: decodeURIComponent(returnWithdrawalsMatch[1] || ""),
          dateFrom: url.searchParams.get("dateFrom"),
          dateTo: url.searchParams.get("dateTo"),
          pageIndex: url.searchParams.get("pageIndex"),
          sizePerPage: url.searchParams.get("sizePerPage"),
        }),
        failurePolicy,
        "return-withdrawals"
      );
    } catch (error) {
      sendJson(response, 400, {
        code: "INVALID_REQUEST_PARAMETER",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const returnStoppedShipmentMatch = url.pathname.match(
    /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/returnRequests\/([^/]+)\/stoppedShipment$/
  );

  if (
    (request.method === "PATCH" || request.method === "PUT") &&
    returnStoppedShipmentMatch
  ) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (
      await maybeSimulateApiFailure(
        response,
        failurePolicy,
        "return-stopped-shipment"
      )
    ) {
      return;
    }

    let body;

    try {
      body = parseJsonObject(await readRequestText(request));
    } catch (error) {
      sendJson(response, 400, {
        code: "INVALID_REQUEST_BODY",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      sendMockJson(
        response,
        200,
        await returnActionPayload(db, {
          receiptId: decodeURIComponent(returnStoppedShipmentMatch[2] || ""),
          body,
          allowedStatuses: [
            "RU",
            "UC",
            "RELEASE_STOP_UNCHECKED",
            "RETURNS_UNCHECKED",
          ],
          allowedReleaseStatuses: ["N"],
          nextStatus: "RETURNS_COMPLETED",
          nextReleaseStatus: "S",
          requireCancelCount: true,
        }),
        failurePolicy,
        "return-stopped-shipment"
      );
    } catch (error) {
      sendJson(response, 400, {
        code: "INVALID_RETURN_ACTION",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const returnReceiveConfirmationMatch = url.pathname.match(
    /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/returnRequests\/([^/]+)\/receiveConfirmation$/
  );

  if (
    (request.method === "PATCH" || request.method === "PUT") &&
    returnReceiveConfirmationMatch
  ) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (
      await maybeSimulateApiFailure(
        response,
        failurePolicy,
        "return-receive-confirmation"
      )
    ) {
      return;
    }

    let body;

    try {
      body = parseJsonObject(await readRequestText(request));
    } catch (error) {
      sendJson(response, 400, {
        code: "INVALID_REQUEST_BODY",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      sendMockJson(
        response,
        200,
        await returnActionPayload(db, {
          receiptId: decodeURIComponent(returnReceiveConfirmationMatch[2] || ""),
          body,
          allowedStatuses: [
            "RU",
            "UC",
            "RELEASE_STOP_UNCHECKED",
            "RETURNS_UNCHECKED",
          ],
          nextStatus: "VENDOR_WAREHOUSE_CONFIRM",
          nextReleaseStatus: "WAREHOUSE_CONFIRMED",
          requireCancelCount: false,
        }),
        failurePolicy,
        "return-receive-confirmation"
      );
    } catch (error) {
      sendJson(response, 400, {
        code: "INVALID_RETURN_ACTION",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const returnApprovalMatch = url.pathname.match(
    /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/returnRequests\/([^/]+)\/approval$/
  );

  if ((request.method === "PATCH" || request.method === "PUT") && returnApprovalMatch) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (
      await maybeSimulateApiFailure(response, failurePolicy, "return-approval")
    ) {
      return;
    }

    let body;

    try {
      body = parseJsonObject(await readRequestText(request));
    } catch (error) {
      sendJson(response, 400, {
        code: "INVALID_REQUEST_BODY",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      sendMockJson(
        response,
        200,
        await returnActionPayload(db, {
          receiptId: decodeURIComponent(returnApprovalMatch[2] || ""),
          body,
          allowedStatuses: ["VENDOR_WAREHOUSE_CONFIRM"],
          nextStatus: "RETURNS_COMPLETED",
          nextReleaseStatus: "COMPLETED",
          requireCancelCount: true,
        }),
        failurePolicy,
        "return-approval"
      );
    } catch (error) {
      sendJson(response, 400, {
        code: "INVALID_RETURN_ACTION",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const exchangeRequestsMatch = url.pathname.match(
    /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/([^/]+)\/exchangeRequests$/
  );

  if (request.method === "GET" && exchangeRequestsMatch) {
    if (!(await validateCoupangAuthorization(request, response, url, db))) {
      return;
    }

    if (await maybeSimulateApiFailure(response, failurePolicy, "exchange-requests")) {
      return;
    }

    sendMockJson(response, 200, await exchangeRequestsPayload(db, {
      status: url.searchParams.get("status"),
      limit:
        url.searchParams.get("maxPerPage") ||
        url.searchParams.get("limit"),
    }), failurePolicy, "exchange-requests");
    return;
  }

  if (request.method === "POST" && url.pathname === "/admin/reset") {
    await resetDatabase(db);
    const productCount = await seedSyntheticProducts(db);
    await seedGeneratedRecords(db, {
      orderCount: url.searchParams.get("orderCount") || 0,
      returnExchangeCount: url.searchParams.get("returnExchangeCount") || 0,
    });
    sendJson(response, 200, {
      ok: true,
      catalogVersion: SYNTHETIC_CATALOG_VERSION,
      productCount,
      counts: await counts(db),
    });
    return;
  }

  sendJson(response, 404, {
    ok: false,
    message: `Unknown mock endpoint: ${request.method} ${url.pathname}`,
  });
}

function createServer(db, generatorConfig, failurePolicy) {
  return http.createServer((request, response) => {
    handleRequest(request, response, db, generatorConfig, failurePolicy).catch(
      (error) => {
        if (response.writableEnded) {
          return;
        }

      sendJson(response, 500, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
      }
    );
  });
}

const host = argValue("--host", defaultHost);
const port = positiveInteger(
  argValue("--port", defaultPort),
  defaultPort,
  65535
);
const generatorConfig = {
  orderIntervalMs: nonNegativeInteger(
    argValue(
      "--order-interval-ms",
      process.env.COUPANG_MOCK_ORDER_INTERVAL_MS || defaultOrderIntervalMs
    ),
    defaultOrderIntervalMs
  ),
  returnExchangeIntervalMs: nonNegativeInteger(
    argValue(
      "--return-exchange-interval-ms",
      process.env.COUPANG_MOCK_RETURN_EXCHANGE_INTERVAL_MS ||
        defaultReturnExchangeIntervalMs
    ),
    defaultReturnExchangeIntervalMs
  ),
};
const resetSeedConfig = {
  orderCount: nonNegativeInteger(
    argValue(
      "--reset-order-count",
      process.env.COUPANG_MOCK_RESET_ORDER_COUNT || defaultResetOrderCount
    ),
    defaultResetOrderCount,
    10000
  ),
  returnExchangeCount: nonNegativeInteger(
    argValue(
      "--reset-return-exchange-count",
      process.env.COUPANG_MOCK_RESET_RETURN_EXCHANGE_COUNT ||
        defaultResetReturnExchangeCount
    ),
    defaultResetReturnExchangeCount,
    10000
  ),
};
const db = await openMockDatabase();
const failurePolicy = failurePolicyFromEnv();

if (process.argv.includes("--init-db")) {
  const productCount = await ensureProductsSeeded(db);
  console.log("[coupang-mock] initialized PostgreSQL database");
  console.log(`[coupang-mock] synthetic products: ${productCount}`);
  await db.close();
  process.exit(0);
}

if (process.argv.includes("--reset-db")) {
  await resetDatabase(db);
  const productCount = await seedSyntheticProducts(db);
  await seedGeneratedRecords(db, {
    orderCount: resetSeedConfig.orderCount,
    returnExchangeCount: resetSeedConfig.returnExchangeCount,
  });
  console.log("[coupang-mock] reset PostgreSQL database");
  console.log(`[coupang-mock] synthetic products: ${productCount}`);
  console.log(
    `[coupang-mock] seed records: orders=${resetSeedConfig.orderCount}, return/exchange=${resetSeedConfig.returnExchangeCount}`
  );
  console.log(`[coupang-mock] counts: ${JSON.stringify(await counts(db))}`);
  await db.close();
  process.exit(0);
}

const productCount = await ensureProductsSeeded(db);
const server = createServer(db, generatorConfig, failurePolicy);
const generatorTimers = startAutoGenerators(db, generatorConfig);

server.listen(port, host, () => {
  console.log(`[coupang-mock] listening on http://${host}:${port}`);
  console.log("[coupang-mock] database: PostgreSQL quickhack_mock_coupang");
  console.log(`[coupang-mock] synthetic products: ${productCount}`);
  console.log(
    `[coupang-mock] generators: order=${generatorConfig.orderIntervalMs}ms, return/exchange=${generatorConfig.returnExchangeIntervalMs}ms`
  );
  console.log(
    `[coupang-mock] failure simulation: ${failurePolicySummary(failurePolicy)}`
  );
});

function shutdown() {
  for (const timer of generatorTimers) {
    clearInterval(timer);
  }

  server.close(() => {
    void db.close().finally(() => process.exit(0));
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
