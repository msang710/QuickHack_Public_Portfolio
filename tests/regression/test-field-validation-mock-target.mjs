import assert from "node:assert/strict";
import test from "node:test";
import { resolveFieldValidationMockTarget } from "../../quickhack_shared/core/field-validation-mock-target.ts";

test("only source development demo can route a mock through the disposable lab", () => {
  const input = { sourceRoot: "/source", environment: "development", packageFlavor: "DEMONSTRATION", provider: "LOGEN", defaultUrl: "http://127.0.0.1:3200" };
  const env = { QUICKHACK_FIELD_VALIDATION_ENABLED: "1", QUICKHACK_FIELD_VALIDATION_LOGEN_MOCK_URL: "http://10.253.17.2:3200" };
  assert.equal(resolveFieldValidationMockTarget(input, env), "http://10.253.17.2:3200");
  assert.equal(resolveFieldValidationMockTarget({ ...input, packageFlavor: "OPERATIONAL" }, env), input.defaultUrl);
  assert.equal(resolveFieldValidationMockTarget({ ...input, sourceRoot: "" }, env), input.defaultUrl);
  assert.throws(() => resolveFieldValidationMockTarget(input, { ...env, QUICKHACK_FIELD_VALIDATION_LOGEN_MOCK_URL: "https://example.com" }), /lab mock URL/);
});
