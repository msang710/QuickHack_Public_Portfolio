import assert from "node:assert/strict";
import {
  clientUpdateRequired,
  compareClientVersions,
  issueWorkflowAdmission,
  menuWorkflowFamily,
  protectedWorkflowFamily,
  readClientCompatibilityPolicy,
  verifyWorkflowAdmission,
} from "../../quickhack_shared/desktop/client-compatibility.ts";

assert.equal(compareClientVersions("1.2.0", "1.1.9"), 1);
assert.equal(compareClientVersions("1.2.0-beta.1", "1.2.0"), -1);
const policy = readClientCompatibilityPolicy({ QUICKHACK_CLIENT_MINIMUM_VERSION: "2.0.0", QUICKHACK_CLIENT_RECOMMENDED_VERSION: "2.1.0", QUICKHACK_CLIENT_VERSION_ENFORCEMENT_AT: "2026-08-27T00:00:00.000Z" });
assert.equal(clientUpdateRequired(policy, "1.9.9", Date.parse("2026-08-27T00:00:00.000Z")), true);
assert.equal(clientUpdateRequired(policy, "1.9.9", Date.parse("2026-08-26T23:59:59.000Z")), false);

const secret = "s".repeat(64);
const token = issueWorkflowAdmission({ userId: 7, sessionId: "session-1", clientFamily: "ELECTRON_OPERATIONAL", clientVersion: "2.1.0", workflowFamily: "SHIPMENT" }, secret, 1_000);
assert.equal(verifyWorkflowAdmission(token, { sessionId: "session-1", clientFamily: "ELECTRON_OPERATIONAL", clientVersion: "2.1.0", workflowFamily: "SHIPMENT" }, secret, 1_001).userId, 7);
assert.throws(() => verifyWorkflowAdmission(`${token}x`, { clientFamily: "ELECTRON_OPERATIONAL", clientVersion: "2.1.0", workflowFamily: "SHIPMENT" }, secret, 1_001), /INVALID/u);
assert.throws(() => verifyWorkflowAdmission(token, { clientFamily: "ELECTRON_OPERATIONAL", clientVersion: "2.1.0", workflowFamily: "RETURNS" }, secret, 1_001), /INVALID/u);
assert.throws(() => verifyWorkflowAdmission(token, { clientFamily: "ELECTRON_OPERATIONAL", clientVersion: "2.1.0", workflowFamily: "SHIPMENT" }, secret, 1_000 + 30 * 60_000), /ADMISSION_EXPIRED/u);

assert.equal(protectedWorkflowFamily("/api/coupang/manual-order-matches/preview"), "MANUAL_MATCHING");
assert.equal(menuWorkflowFamily("shipment-matched"), "SHIPMENT");
assert.equal(menuWorkflowFamily("dashboard"), null);
console.log("Electron client compatibility and workflow admission contracts verified.");
