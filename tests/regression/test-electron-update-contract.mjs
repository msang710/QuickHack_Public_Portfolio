import assert from "node:assert/strict";
import { transitionDesktopUpdate, unavailablePackageUpdateAdapter } from "../../quickhack_desktop/shared/update-contract.ts";
assert.equal(transitionDesktopUpdate("IDLE", "CHECK"), "CHECKING");
assert.equal(transitionDesktopUpdate("CHECKING", "FOUND"), "AVAILABLE");
assert.equal(transitionDesktopUpdate("AVAILABLE", "DOWNLOADED"), "DOWNLOADED");
assert.equal(transitionDesktopUpdate("DOWNLOADED", "APPLY"), "APPLYING");
assert.throws(() => transitionDesktopUpdate("IDLE", "APPLY"), /INVALID/);
await assert.rejects(() => unavailablePackageUpdateAdapter.check(), (error) => error.code === "PACKAGE_ADAPTER_UNAVAILABLE");
console.log("Electron update state and unavailable adapter verified.");
