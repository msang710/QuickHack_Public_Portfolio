import assert from "node:assert/strict";
import { legacyApiMessage } from "../../quickhack_client/api/legacy-api-message.ts";

assert.equal(legacyApiMessage(null, "fallback"), "fallback");
assert.equal(legacyApiMessage({ message: "  legacy snapshot  " }, "fallback"), "legacy snapshot");
assert.equal(legacyApiMessage({ message: "legacy", code: "STABLE_CODE" }, "fallback"), "fallback");
assert.equal(legacyApiMessage({ message: "\u0000unsafe\u0007" }, "fallback"), "unsafe");
assert.equal(legacyApiMessage({ message: "x".repeat(2_100) }, "fallback").length, 2_000);

console.log("Legacy API message dual-read contract passed.");
