import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createDisposableTopology,
  createIsolatedNetworkPlan,
  measureSegmentRtt,
  runIsolatedNetworkProfile,
  withDisposableTopology,
} from "./network-control.mjs";

function percentile(sorted, fraction) {
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
}

export async function runNetworkLab({ runId, profiles = {} }, { execute } = {}) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)
      || Object.keys(profiles).some((key) => !["client", "external"].includes(key))) {
    throw new TypeError("Only client and external isolated segments are supported.");
  }
  const topology = createDisposableTopology(runId);
  const clientPlan = createIsolatedNetworkPlan({ runId, segment: "client", ...profiles.client });
  const externalPlan = createIsolatedNetworkPlan({ runId, segment: "external", ...profiles.external });
  const options = execute ? { execute } : {};
  return withDisposableTopology(topology, {
    ...options,
    run: async (segments) => {
      const client = await runIsolatedNetworkProfile(clientPlan, {
        ...options,
        run: async () => runIsolatedNetworkProfile(externalPlan, {
          ...options,
          run: async () => {
            const clientRtt = await measureSegmentRtt(segments.client, options);
            const externalRtt = await measureSegmentRtt(segments.external, options);
            return { clientRtt, externalRtt };
          },
        }),
      });
      const measurements = client.result.result;
      const network = {};
      for (const [segment, plan, rtt, observation] of [
        ["client", clientPlan, measurements.clientRtt, client.observations],
        ["external", externalPlan, measurements.externalRtt, client.result.observations],
      ]) {
        const samples = [...rtt.samplesMs].sort((a, b) => a - b);
        network[segment] = {
          configuredDelayMs: plan.profile.delayMs,
          configuredJitterMs: plan.profile.jitterMs,
          configuredLossPercent: plan.profile.lossPercent,
          measuredP50RttMs: percentile(samples, 0.5),
          measuredP95RttMs: percentile(samples, 0.95),
          sampleSize: samples.length,
          qdiscObserved: observation.some((output) => String(output).includes("netem")),
        };
      }
      return {
        schema: "quickhack-field-validation-network/v1",
        runId,
        evidenceClass: "NETWORK_ONLY",
        applicationTrafficVerified: false,
        network,
      };
    },
  });
}

async function main() {
  const [command, path] = process.argv.slice(2);
  if (command !== "run" || !path) throw new Error("Usage: node tools/field-validation/lab.mjs run <network.json>");
  const input = JSON.parse(await readFile(path, "utf8"));
  process.stdout.write(`${JSON.stringify(await runNetworkLab(input), null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Network lab failed."}\n`);
    process.exitCode = 1;
  });
}
