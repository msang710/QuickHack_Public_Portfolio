export const LOGEN_DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 3200,
  secretKey: "LOGEN-MOCK-TEST-SECRET",
  userId: "10358007",
  custCd: "20179999",
});

function argValue(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) {
    return fallback;
  }
  return String(argv[index + 1] ?? "").trim() || fallback;
}

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max
    ? parsed
    : fallback;
}

function nonNegativeInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max
    ? parsed
    : fallback;
}

function booleanValue(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return new Set(["1", "true", "yes", "y", "on"]).has(normalized);
}

function percentage(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : fallback;
}

export function getLogenMockConfig(argv = process.argv.slice(2)) {
  const port = positiveInteger(
    argValue(argv, "--port", LOGEN_DEFAULTS.port),
    LOGEN_DEFAULTS.port,
    65535
  );

  return {
    host: argValue(argv, "--host", LOGEN_DEFAULTS.host),
    port,
    initDb: argv.includes("--init-db"),
    seed: {
      secretKey:
        String(process.env.LOGEN_MOCK_SECRET_KEY || "").trim() ||
        LOGEN_DEFAULTS.secretKey,
      userId:
        String(process.env.LOGEN_MOCK_USER_ID || "").trim() ||
        LOGEN_DEFAULTS.userId,
      custCd:
        String(process.env.LOGEN_MOCK_CUSTOMER_CODE || "").trim() ||
        LOGEN_DEFAULTS.custCd,
    },
    failurePolicy: {
      enabled: booleanValue(process.env.LOGEN_MOCK_FAILURE_ENABLED, false),
      target:
        String(process.env.LOGEN_MOCK_FAILURE_TARGET || "all").trim() || "all",
      httpFailureRate: percentage(
        process.env.LOGEN_MOCK_HTTP_FAILURE_RATE,
        0
      ),
      timeoutRate: percentage(process.env.LOGEN_MOCK_TIMEOUT_RATE, 0),
      malformedJsonRate: percentage(
        process.env.LOGEN_MOCK_MALFORMED_JSON_RATE,
        0
      ),
      missingRequiredFieldRate: percentage(
        process.env.LOGEN_MOCK_MISSING_REQUIRED_FIELD_RATE,
        0
      ),
      partialDataLossRate: percentage(
        process.env.LOGEN_MOCK_PARTIAL_DATA_LOSS_RATE,
        0
      ),
      writeAppliedResponseFailureRate: percentage(
        process.env.LOGEN_MOCK_WRITE_APPLIED_RESPONSE_FAILURE_RATE,
        0
      ),
      minDelayMs: positiveInteger(process.env.LOGEN_MOCK_MIN_DELAY_MS, 0, 120000),
      maxDelayMs: positiveInteger(process.env.LOGEN_MOCK_MAX_DELAY_MS, 0, 120000),
      httpStatus: positiveInteger(process.env.LOGEN_MOCK_FAILURE_STATUS, 503, 599),
      timeoutMs: positiveInteger(process.env.LOGEN_MOCK_TIMEOUT_MS, 15000, 120000),
    },
    lifecycle: {
      trackingIntervalMs: nonNegativeInteger(
        process.env.LOGEN_MOCK_TRACKING_INTERVAL_MS,
        30000,
        3600000
      ),
      returnIntervalMs: nonNegativeInteger(
        process.env.LOGEN_MOCK_RETURN_INTERVAL_MS,
        60000,
        3600000
      ),
    },
  };
}
