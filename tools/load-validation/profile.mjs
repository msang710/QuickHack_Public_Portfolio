import { createHash } from "node:crypto";

export const DEFAULT_LOAD_PROFILE = Object.freeze({
  schema: "quickhack-load-profile/v1",
  runId: "load-v1",
  seed: "quickhack-load-v1",
  historyEnd: "2026-10-07T00:00:00.000Z",
  days: 30,
  ordersPerDay: 10_000,
  skuCount: 20_000,
  activePackingOrders: 20_000,
  workerCount: 10,
  serverCpuLimit: 4,
  serverMemoryMiB: 8_192,
  businessHours: 8,
  peakMultiplier: 5,
  stressMultiplier: 2,
  phases: [
    { id: "peak", durationSeconds: 1_800, orderMultiplier: 5, scored: true },
    { id: "stress", durationSeconds: 900, orderMultiplier: 10, scored: false },
    { id: "soak-2h", durationSeconds: 7_200, orderMultiplier: 1, scored: true },
    { id: "soak-8h", durationSeconds: 28_800, orderMultiplier: 1, scored: true },
  ],
  criteria: { readP95Ms: 2_000, writeP95Ms: 3_000, unexpectedFailureCount: 0, invariantViolationCount: 0 },
});

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function positiveInteger(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`${name} must be a positive integer <= ${max}.`);
  return value;
}

export function validateLoadProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== DEFAULT_LOAD_PROFILE.schema) {
    throw new TypeError("Unsupported QuickHack load profile.");
  }
  if (!SAFE_ID.test(value.runId) || !SAFE_ID.test(value.seed)) throw new TypeError("runId and seed must be safe identifiers.");
  if (typeof value.historyEnd !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.historyEnd) || !Number.isFinite(Date.parse(value.historyEnd))) {
    throw new TypeError("historyEnd must be an explicit UTC instant.");
  }
  for (const [name, max] of Object.entries({ days: 366, ordersPerDay: 1_000_000, skuCount: 20_000, activePackingOrders: 100_000, workerCount: 1_000, serverCpuLimit: 256, serverMemoryMiB: 1_048_576, businessHours: 24, peakMultiplier: 100, stressMultiplier: 100 })) {
    positiveInteger(value[name], name, max);
  }
  if (!Array.isArray(value.phases) || !value.phases.length || new Set(value.phases.map((phase) => phase.id)).size !== value.phases.length) {
    throw new TypeError("Phases must have unique ids.");
  }
  for (const phase of value.phases) {
    if (!SAFE_ID.test(phase.id) || typeof phase.scored !== "boolean") throw new TypeError("Invalid load phase.");
    positiveInteger(phase.durationSeconds, "phase.durationSeconds", 86_400);
    positiveInteger(phase.orderMultiplier, "phase.orderMultiplier", 100);
  }
  if (!value.criteria || typeof value.criteria !== "object") throw new TypeError("Load criteria are required.");
  for (const name of ["readP95Ms", "writeP95Ms"]) positiveInteger(value.criteria[name], name, 600_000);
  for (const name of ["unexpectedFailureCount", "invariantViolationCount"]) {
    if (!Number.isSafeInteger(value.criteria[name]) || value.criteria[name] < 0) throw new TypeError(`Invalid ${name}.`);
  }
  if (value.days * value.ordersPerDay > 2_000_000) throw new TypeError("History exceeds the bounded fixture generator limit.");
  return structuredClone(value);
}

export function profileDigest(profile) {
  const valid = validateLoadProfile(profile);
  return createHash("sha256").update(JSON.stringify(valid)).digest("hex");
}

export function ordersPerMinute(profile, multiplier = 1) {
  const valid = validateLoadProfile(profile);
  return valid.ordersPerDay / (valid.businessHours * 60) * multiplier;
}
