import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createNativeBroker, nativeBrokerEndpoint } from "../../quickhack_desktop/main/native-broker.ts";
import { nativeBrokerConfig, requestNativeBroker } from "../../quickhack_client/native/native-broker-client.ts";

const instanceId = "a".repeat(48);
const secret = "b".repeat(64);
assert.equal(nativeBrokerEndpoint("win32", "C:/ignored", instanceId), `\\\\.\\pipe\\quickhack-native-${instanceId}`);

const runtimeDirectory = mkdtempSync(path.join(os.tmpdir(), "quickhack-native-broker-"));
const broker = createNativeBroker({
  platform: "linux",
  runtimeDirectory,
  instanceId,
  secret,
  handlers: { "adb.list": async (payload) => ({ payload }) },
});

function request(input) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(broker.endpoint);
    let body = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(input)}\n`));
    socket.on("data", (chunk) => { body += chunk; });
    socket.on("error", reject);
    socket.on("end", () => resolve(JSON.parse(body)));
  });
}

await broker.start();
assert.equal(statSync(broker.endpoint).mode & 0o777, 0o600);
const valid = { version: 1, instanceId, secret, requestId: "request-0001", command: "adb.list", payload: { probe: true } };
assert.deepEqual(await request(valid), { requestId: "request-0001", ok: true, result: { payload: { probe: true } } });
assert.equal((await request(valid)).error.code, "BROKER_REPLAY_REJECTED");
assert.equal((await request({ ...valid, requestId: "request-0002", secret: "c".repeat(64) })).error.code, "BROKER_AUTH_FAILED");
assert.equal((await request({ ...valid, requestId: "request-0003", command: "shell.exec" })).error.code, "BROKER_COMMAND_REJECTED");
const environment = {
  NODE_ENV: "test",
  QUICKHACK_DESKTOP_BROKER_ENDPOINT: broker.endpoint,
  QUICKHACK_DESKTOP_BROKER_SECRET: broker.secret,
  QUICKHACK_DESKTOP_BROKER_INSTANCE_ID: broker.instanceId,
};
assert.equal(nativeBrokerConfig(environment).endpoint, broker.endpoint);
assert.deepEqual(await requestNativeBroker("adb.list", { via: "client" }, { environment }), { payload: { via: "client" } });
assert.throws(() => nativeBrokerConfig({ NODE_ENV: "test" }), (error) => error.code === "NATIVE_ADAPTER_UNAVAILABLE");
await broker.stop();
assert.throws(() => readFileSync(broker.endpoint), /ENOENT/u);

console.log("Electron native broker authentication, replay and command boundaries verified.");
