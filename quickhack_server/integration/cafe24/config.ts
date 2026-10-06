export type Cafe24AppConfig = {
  mallId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export function cafe24Origin(mallId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(mallId)) {
    throw new TypeError("Invalid Cafe24 mallId.");
  }
  return `https://${mallId}.cafe24api.com`;
}

export function cafe24ConfigFromServerEnvironment(environment: NodeJS.ProcessEnv = process.env): Cafe24AppConfig {
  const config = {
    mallId: environment.QUICKHACK_CAFE24_MALL_ID ?? "",
    clientId: environment.QUICKHACK_CAFE24_CLIENT_ID ?? "",
    clientSecret: environment.QUICKHACK_CAFE24_CLIENT_SECRET ?? "",
    redirectUri: environment.QUICKHACK_CAFE24_REDIRECT_URI ?? "",
  };
  cafe24Origin(config.mallId);
  if (!config.clientId.trim() || !config.clientSecret.trim() || new URL(config.redirectUri).protocol !== "https:") {
    throw new Error("Cafe24 server app configuration is unavailable or invalid.");
  }
  return config;
}
