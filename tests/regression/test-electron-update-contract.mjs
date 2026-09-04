import assert from "node:assert/strict";
import {
  createDesktopUpdateCoordinator,
  transitionDesktopUpdate,
  unavailablePackageUpdateAdapter,
} from "../../quickhack_desktop/shared/update-contract.ts";
assert.equal(transitionDesktopUpdate("IDLE", "CHECK"), "CHECKING");
assert.equal(transitionDesktopUpdate("CHECKING", "FOUND"), "AVAILABLE");
assert.equal(transitionDesktopUpdate("AVAILABLE", "DOWNLOADED"), "DOWNLOADED");
assert.equal(transitionDesktopUpdate("DOWNLOADED", "APPLY"), "APPLYING");
assert.throws(() => transitionDesktopUpdate("IDLE", "APPLY"), /INVALID/);
await assert.rejects(() => unavailablePackageUpdateAdapter.check(), (error) => error.code === "PACKAGE_ADAPTER_UNAVAILABLE");
const published = [];
const coordinator = createDesktopUpdateCoordinator({
  currentVersion: "1.0.0",
  adapter: {
    async check() { return { version: "1.1.0" }; },
    async download() {},
    async apply() {},
  },
  publish(snapshot) { published.push(snapshot); },
});
assert.equal((await coordinator.check()).messageCode, "UPDATE_READY");
assert.equal((await coordinator.apply()).messageCode, "UPDATE_APPLYING");
assert.deepEqual(
  published.map((snapshot) => snapshot.messageCode),
  ["UPDATE_CHECKING", "UPDATE_DOWNLOADING", "UPDATE_READY", "UPDATE_APPLYING"]
);
assert.equal("message" in coordinator.snapshot(), false);
console.log("Electron update state and unavailable adapter verified.");
