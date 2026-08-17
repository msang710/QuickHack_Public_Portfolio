import assert from "node:assert/strict";
import { runLinuxPackageSmoke } from "./linux-package-smoke-core.mjs";

function fixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    runtime: {
      platform: () => "linux",
      isArchLinux: () => true,
      uid: () => 0,
      verifyArtifact: async ({ target }) => calls.push(["verify", target]),
      install: async ({ target }) => calls.push(["install", target]),
      assertInstalled: async ({ target }) => calls.push(["installed", target]),
      assertConflict: async ({ target }, installed) => calls.push(["conflict", target, installed.target]),
      remove: async (identity) => calls.push(["remove", identity]),
      assertMutableStatePreserved: async ({ target }) => calls.push(["preserved", target]),
      ...overrides,
    },
  };
}

const disabled = fixture();
assert.deepEqual(
  await runLinuxPackageSmoke({ approved: false, version: "1.2.3", artifactRoot: "/tmp/artifacts", runtime: disabled.runtime }),
  { status: "NOT_RUN", reason: "EXPLICIT_OPT_IN_REQUIRED", steps: [] }
);
assert.deepEqual(disabled.calls, []);
await assert.rejects(
  () => runLinuxPackageSmoke({ approved: true, version: "1.2.3", artifactRoot: "relative", runtime: fixture().runtime }),
  /absolute artifact root/
);

const unprivileged = fixture({ uid: () => 1000 });
assert.equal(
  (await runLinuxPackageSmoke({ approved: true, version: "1.2.3", artifactRoot: "/tmp/artifacts", runtime: unprivileged.runtime })).reason,
  "ROOT_REQUIRED"
);
assert.deepEqual(unprivileged.calls, []);

const success = fixture();
const result = await runLinuxPackageSmoke({ approved: true, version: "1.2.3", artifactRoot: "/tmp/artifacts", runtime: success.runtime });
assert.equal(result.status, "PASS");
assert.deepEqual(success.calls.slice(0, 4), [
  ["verify", "demo-server"],
  ["verify", "demo-client"],
  ["verify", "operational-server"],
  ["verify", "operational-client"],
]);
assert.ok(success.calls.some((call) => call[0] === "conflict"));
assert.ok(success.calls.some((call) => call[0] === "preserved"));
assert.equal(success.calls.filter((call) => call[0] === "remove").length, 3);

const failure = fixture({
  install: async ({ target }) => {
    failure.calls.push(["install", target]);
    if (target === "demo-client") {
      const error = new Error("fixture failure");
      error.code = "FIXTURE_INSTALL_FAILED";
      throw error;
    }
  },
});
const failed = await runLinuxPackageSmoke({ approved: true, version: "1.2.3", artifactRoot: "/tmp/artifacts", runtime: failure.runtime });
assert.equal(failed.status, "FAIL");
assert.equal(failed.reason, "FIXTURE_INSTALL_FAILED");
assert.ok(failure.calls.some((call) => call[0] === "remove" && call[1] === "quickhack-demonstration-server"));

console.log("Linux physical package smoke opt-in, ordering, preservation, and cleanup contracts verified.");
