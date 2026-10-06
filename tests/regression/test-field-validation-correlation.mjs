import assert from "node:assert/strict";
import test from "node:test";
import { readFieldValidationCorrelation } from "../../quickhack_shared/observability/field-validation-correlation.ts";

test("correlation parser accepts bounded identifiers and rejects injected headers", () => {
  const valid = new Headers({ "x-quickhack-validation-run-id": "run-17", "x-quickhack-validation-scenario-id": "duplicate-pack" });
  assert.deepEqual(readFieldValidationCorrelation(valid), { runId: "run-17", scenarioId: "duplicate-pack" });
  const invalid = new Headers({ "x-quickhack-validation-run-id": "../../escape", "x-quickhack-validation-scenario-id": "duplicate-pack" });
  assert.equal(readFieldValidationCorrelation(invalid), null);
});
