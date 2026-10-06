import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createChildProcessEnvironment } from "../../quickhack_shared/core/child-process-environment.mjs";
import { createLinuxChildProcessPolicy } from "../../quickhack_shared/platform/linux/child-process-policy.mjs";

const execFileAsync = promisify(execFile);
const SEGMENTS = new Set(["client", "external"]);

function boundedNumber(value, name, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) {
    throw new TypeError(`${name} must be between 0 and ${max}.`);
  }
  return number;
}

function command(args) {
  return Object.freeze({ file: "ip", args: Object.freeze(args) });
}

export function createIsolatedNetworkPlan({ runId, segment, delayMs = 0, jitterMs = 0, lossPercent = 0 }) {
  if (!SEGMENTS.has(segment)) throw new TypeError("Invalid isolated network segment.");
  if (!String(runId ?? "").trim()) throw new TypeError("runId is required.");
  const delay = boundedNumber(delayMs, "delayMs", 60_000);
  const jitter = boundedNumber(jitterMs, "jitterMs", 60_000);
  const loss = boundedNumber(lossPercent, "lossPercent", 100);
  const token = createHash("sha256").update(String(runId)).digest("hex").slice(0, 7);
  const suffix = segment === "client" ? "c" : "e";
  const namespace = `qhfv-${suffix}-${token}`;
  const interfaceName = `fv${suffix}-${token}`;
  const prefix = ["netns", "exec", namespace, "tc", "qdisc"];
  const netem = ["replace", "dev", interfaceName, "root", "netem"];
  if (delay || jitter) netem.push("delay", `${delay}ms`, `${jitter}ms`);
  if (loss) netem.push("loss", `${loss}%`);
  if (!delay && !jitter && !loss) netem.push("delay", "0ms");
  return Object.freeze({
    namespace,
    interfaceName,
    segment,
    profile: Object.freeze({ delayMs: delay, jitterMs: jitter, lossPercent: loss }),
    apply: Object.freeze([command([...prefix, ...netem])]),
    inspect: Object.freeze([command(["netns", "exec", namespace, "tc", "-s", "qdisc", "show", "dev", interfaceName])]),
    cleanup: Object.freeze([command([...prefix, "del", "dev", interfaceName, "root"])]),
  });
}

async function systemExecute({ file, args }) {
  const env = createChildProcessEnvironment({ policy: createLinuxChildProcessPolicy(), source: process.env });
  const result = await execFileAsync(file, args, { timeout: 15_000, maxBuffer: 256 * 1024, env });
  return result.stdout;
}

export async function runIsolatedNetworkProfile(plan, { execute = systemExecute, measure, run }) {
  if (!plan?.namespace?.startsWith("qhfv-") || !plan?.interfaceName?.startsWith("fv") || typeof run !== "function") {
    throw new TypeError("A disposable network plan and run callback are required.");
  }
  let applied = false;
  try {
    for (const step of plan.apply) await execute(step);
    applied = true;
    const observations = [];
    for (const step of plan.inspect) observations.push(await execute(step));
    const rttSamplesMs = measure ? await measure() : null;
    if (rttSamplesMs !== null && (!Array.isArray(rttSamplesMs) || rttSamplesMs.some((value) => !Number.isFinite(value) || value < 0))) {
      throw new TypeError("Network RTT samples are invalid.");
    }
    return { result: await run(), observations, profile: plan.profile, rttSamplesMs };
  } finally {
    if (applied) {
      for (const step of plan.cleanup) await execute(step);
    }
  }
}

export function createDisposableTopology(runId) {
  if (!String(runId ?? "").trim()) throw new TypeError("runId is required.");
  const token = createHash("sha256").update(String(runId)).digest("hex").slice(0, 7);
  const lastOctet = 1 + (parseInt(token.slice(0, 2), 16) % 200);
  const segments = {};
  const setup = [];
  const cleanup = [];
  for (const [segment, suffix, subnet] of [["client", "c", lastOctet], ["external", "e", lastOctet + 1]]) {
    const namespace = `qhfv-${suffix}-${token}`;
    const hostInterface = `fvh${suffix}-${token}`;
    const interfaceName = `fv${suffix}-${token}`;
    const hostAddress = `10.253.${subnet}.1`;
    const isolatedAddress = `10.253.${subnet}.2`;
    segments[segment] = Object.freeze({ namespace, hostInterface, interfaceName, hostAddress, isolatedAddress });
    setup.push(
      command(["netns", "add", namespace]),
      command(["link", "add", hostInterface, "type", "veth", "peer", "name", interfaceName]),
      command(["link", "set", interfaceName, "netns", namespace]),
      command(["addr", "add", `${hostAddress}/30`, "dev", hostInterface]),
      command(["link", "set", hostInterface, "up"]),
      command(["netns", "exec", namespace, "ip", "addr", "add", `${isolatedAddress}/30`, "dev", interfaceName]),
      command(["netns", "exec", namespace, "ip", "link", "set", "lo", "up"]),
      command(["netns", "exec", namespace, "ip", "link", "set", interfaceName, "up"]),
    );
    cleanup.unshift(command(["netns", "del", namespace]));
    cleanup.unshift(command(["link", "del", hostInterface]));
  }
  return Object.freeze({ runId: String(runId), segments: Object.freeze(segments), setup: Object.freeze(setup), cleanup: Object.freeze(cleanup) });
}

export async function withDisposableTopology(topology, { execute = systemExecute, run }) {
  if (!topology?.segments?.client?.namespace?.startsWith("qhfv-c-") || !topology?.segments?.external?.namespace?.startsWith("qhfv-e-") || typeof run !== "function") {
    throw new TypeError("A disposable topology and run callback are required.");
  }
  let failed = false;
  try {
    for (const step of topology.setup) await execute(step);
    return await run(topology.segments);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const step of topology.cleanup) {
      try { await execute(step); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length && !failed) throw new AggregateError(cleanupErrors, "Disposable network cleanup failed.");
  }
}

export function parsePingRtt(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /icmp_seq=\d+.*\btime=([0-9]+(?:\.[0-9]+)?)\s*ms\b/.exec(line);
      return match ? [Number(match[1])] : [];
    });
}

export async function measureSegmentRtt(segment, { execute = systemExecute } = {}) {
  if (!segment?.namespace?.startsWith("qhfv-") || !/^10\.253\.\d{1,3}\.1$/.test(segment?.hostAddress ?? "")) {
    throw new TypeError("RTT measurement requires a disposable segment.");
  }
  const stdout = await execute(command(["netns", "exec", segment.namespace, "ping", "-n", "-c", "5", "-W", "1", segment.hostAddress]));
  const samplesMs = parsePingRtt(stdout);
  if (!samplesMs.length) throw new Error("Disposable segment produced no RTT samples.");
  return { namespace: segment.namespace, samplesMs };
}
