import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDeliveryApiClient } from "../../quickhack_server/integration/deliveryapi/client.ts";
import { deliveryApiCredentialsFromServerEnvironment } from "../../quickhack_server/integration/deliveryapi/config.ts";
import { createCafe24ReadClient } from "../../quickhack_server/integration/cafe24/client.ts";
import { cafe24Origin } from "../../quickhack_server/integration/cafe24/config.ts";

export async function runProviderProbe(provider, input, { env = process.env, fetchImpl = fetch } = {}) {
  const runId = String(input?.runId ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId)) throw new TypeError("A bounded runId is required.");
  if (provider === "deliveryapi") {
    const client = createDeliveryApiClient({
      credentials: () => deliveryApiCredentialsFromServerEnvironment(env),
      fetchImpl,
    });
    const result = await client.trace([{ courierCode: input.courierCode, trackingNumber: input.trackingNumber, clientId: input.clientId }]);
    return { runId, evidenceClass: "PROVIDER", ...result };
  }
  if (provider === "cafe24") {
    const mallId = String(env.QUICKHACK_CAFE24_MALL_ID ?? "");
    cafe24Origin(mallId);
    const token = String(env.QUICKHACK_CAFE24_ACCESS_TOKEN ?? "");
    const client = createCafe24ReadClient({ mallId, accessToken: () => token, fetchImpl });
    const [products, orders] = await Promise.all([client.listProductPreview(1), client.listOrderPreview(1)]);
    return { runId, evidenceClass: "PROVIDER", provider: "CAFE24", products, orders };
  }
  throw new TypeError("Provider must be deliveryapi or cafe24.");
}

async function main() {
  const [provider] = process.argv.slice(2);
  if (!["deliveryapi", "cafe24"].includes(provider)) {
    throw new Error("Usage: node --import ./tools/field-validation/register-ts-alias.mjs tools/field-validation/provider-probe.mjs <deliveryapi|cafe24> < input.json");
  }
  const raw = await readFile(0, "utf8");
  if (raw.length > 4096) throw new Error("Provider probe input is too large.");
  const input = raw.trim() ? JSON.parse(raw) : {};
  const result = await runProviderProbe(provider, input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Provider probe failed."}\n`);
    process.exitCode = 1;
  });
}
