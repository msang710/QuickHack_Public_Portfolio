import { createHash } from "node:crypto";

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${name} is required.`);
  return text;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function scenarioFixture({ seed, scenarioId }) {
  const key = digest(`${requiredText(seed, "seed")}\0${requiredText(scenarioId, "scenarioId")}`);
  const letters = String.fromCharCode(65 + parseInt(key.slice(0, 2), 16) % 26)
    + String.fromCharCode(65 + parseInt(key.slice(2, 4), 16) % 26);
  const digits = BigInt(`0x${key.slice(4, 20)}`) % 10_000_000_000n;
  return Object.freeze({
    pgNo: `${letters}${digits.toString().padStart(10, "0")}`,
    orderId: `FV-${key.slice(20, 36).toUpperCase()}`,
    fixtureHash: key,
  });
}

export function createRunManifest(input) {
  const runId = requiredText(input.runId, "runId");
  const seed = requiredText(input.seed, "seed");
  const scenarioId = requiredText(input.scenarioId, "scenarioId");
  const fixture = scenarioFixture({ seed, scenarioId });
  return Object.freeze({
    schema: "quickhack-field-validation/v1",
    runId,
    seed,
    scenarioId,
    sourceRevision: requiredText(input.sourceRevision, "sourceRevision"),
    environment: requiredText(input.environment, "environment"),
    networkProfile: requiredText(input.networkProfile, "networkProfile"),
    fixtureHash: fixture.fixtureHash,
    evidenceClass: input.evidenceClass ?? "MOCK",
  });
}
