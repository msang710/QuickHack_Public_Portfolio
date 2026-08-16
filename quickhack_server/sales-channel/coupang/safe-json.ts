import {
  parseLosslessIntegrationJson,
  quoteUnsafeJsonIntegers,
} from "@/quickhack_server/integration/schema-validation";

export { quoteUnsafeJsonIntegers };

export function parseCoupangJson<T>(rawText: string): T {
  return parseLosslessIntegrationJson<T>({
    provider: "COUPANG",
    endpoint: "TRANSPORT",
    rawText,
  });
}
