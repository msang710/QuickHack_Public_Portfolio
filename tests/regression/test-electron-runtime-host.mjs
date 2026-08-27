import assert from "node:assert/strict";
import { createClientRuntimeHost } from "../../quickhack_desktop/main/client-runtime-host.ts";

const commands = [];
const host = createClientRuntimeHost({
  appRoot: "/fixture",
  origin: "http://127.0.0.1:3001",
  async runCommand(command) { commands.push(command); },
});

await Promise.all([host.start(), host.start()]);
assert.deepEqual(commands, ["start"]);
await Promise.all([host.stop(), host.stop()]);
assert.deepEqual(commands, ["start", "stop"]);

let attempts = 0;
const retrying = createClientRuntimeHost({
  appRoot: "/fixture",
  origin: "http://127.0.0.1:3001",
  async runCommand(command) {
    attempts += 1;
    if (command === "start" && attempts === 1) throw new Error("fixture start failure");
  },
});
await assert.rejects(() => retrying.start(), /fixture start failure/u);
await retrying.start();
assert.equal(attempts, 2, "A failed start must remain retryable.");
await retrying.stop();
assert.equal(attempts, 3);

console.log("Electron-owned client runtime lifecycle verified.");
