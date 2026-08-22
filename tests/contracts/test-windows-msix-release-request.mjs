import assert from "node:assert/strict";
import { validateWindowsReleaseRequest } from "../../packaging/windows/msix/windows-release-request.mjs";

const request = {
  schemaVersion: 1,
  attempt: 1,
  version: "2.0.0",
  tag: "windows-v2.0.0",
  sourceCommit: "a".repeat(40),
  targets: ["demo-server", "demo-client", "operational-server", "operational-client"],
  publisher: "CN=QuickHack, O=QuickHack",
  signingProvider: "AZURE_ARTIFACT_SIGNING",
  prerelease: false,
};

assert.deepEqual(validateWindowsReleaseRequest(request), request);
assert.deepEqual(
  validateWindowsReleaseRequest(request, {
    currentPath: "release-requests/windows-msix/windows-v2.0.0.json",
    historicRequests: [{
      path: "release-requests/windows-msix/windows-v2.0.0.json",
      request,
    }],
  }),
  request
);
assert.throws(
  () => validateWindowsReleaseRequest({ ...request, publisher: "CN=QuickHack Development" }),
  (error) => error?.code === "MSIX_PRODUCTION_PUBLISHER_REQUIRED"
);
assert.throws(
  () => validateWindowsReleaseRequest({ ...request, targets: request.targets.slice(0, 2) }),
  (error) => error?.code === "WINDOWS_RELEASE_REQUEST_INVALID"
);
assert.throws(
  () => validateWindowsReleaseRequest(request, {
    currentPath: "release-requests/windows-msix/windows-v2.0.0.json",
    historicRequests: [
      { path: "release-requests/windows-msix/windows-v2.0.0.json", request },
      { path: "release-requests/windows-msix/deleted-v2.0.0.json", request },
    ],
  }),
  (error) => error?.code === "WINDOWS_RELEASE_IDENTITY_REUSED"
);
assert.throws(
  () => validateWindowsReleaseRequest({ ...request, extra: true }),
  (error) => error?.code === "WINDOWS_RELEASE_REQUEST_INVALID"
);

console.log("QuickHack Windows MSIX release request and immutable history contract verified.");
