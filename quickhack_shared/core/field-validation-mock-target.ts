type Provider = "COUPANG" | "LOGEN";

export function resolveFieldValidationMockTarget(
  input: {
    sourceRoot: string;
    environment: "development" | "production";
    packageFlavor: "DEMONSTRATION" | "OPERATIONAL";
    provider: Provider;
    defaultUrl: string;
  },
  environment: NodeJS.ProcessEnv
) {
  if (!input.sourceRoot || input.environment !== "development" || input.packageFlavor !== "DEMONSTRATION" || environment.QUICKHACK_FIELD_VALIDATION_ENABLED !== "1") {
    return input.defaultUrl;
  }
  const variable = input.provider === "LOGEN"
    ? "QUICKHACK_FIELD_VALIDATION_LOGEN_MOCK_URL"
    : "QUICKHACK_FIELD_VALIDATION_COUPANG_MOCK_URL";
  const requested = String(environment[variable] ?? "").trim();
  if (!requested) return input.defaultUrl;
  const url = new URL(requested);
  const port = input.provider === "LOGEN" ? "3200" : "3100";
  const match = /^10\.253\.(\d{1,3})\.2$/.exec(url.hostname);
  if (url.protocol !== "http:" || !match || Number(match[1]) < 1 || Number(match[1]) > 201 || url.port !== port || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new TypeError("Invalid field validation lab mock URL.");
  }
  return url.origin;
}
