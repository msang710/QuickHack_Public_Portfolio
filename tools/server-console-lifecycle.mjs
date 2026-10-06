import { createServer } from "node:net";

export function createLifecycleQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}

function lifecycleError(code, id, message) {
  return Object.assign(new Error(message), { code, child: id });
}

export async function assertPortAvailable(id, port, host = "127.0.0.1") {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("A valid server port is required.");
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => reject(lifecycleError(
      error?.code === "EADDRINUSE" ? "SERVER_PORT_IN_USE" : "SERVER_PORT_CHECK_FAILED",
      id,
      `The ${id} port ${port} is unavailable.`
    )));
    probe.listen(port, host, () => probe.close(resolve));
  });
}

export async function waitForOwnedReady({ id, child, current, probe, timeoutMs = 60_000, pollMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0 || current() !== child ||
        child.exitCode !== null || child.signalCode !== null) {
      throw lifecycleError("CHILD_EXITED_BEFORE_READY", id, `The ${id} process exited before it became ready.`);
    }
    let ready = false;
    try { ready = await probe() === true; } catch { /* A failed probe is retried until the deadline. */ }
    if (ready) {
      if (current() === child && child.exitCode === null && child.signalCode === null) return child;
      throw lifecycleError("CHILD_EXITED_BEFORE_READY", id, `The ${id} process exited during readiness verification.`);
    }
    if (Date.now() >= deadline) throw lifecycleError("CHILD_START_TIMEOUT", id, `The ${id} process did not become ready in time.`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}
