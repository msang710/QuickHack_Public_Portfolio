import { cafe24Origin, type Cafe24AppConfig } from "@/quickhack_server/integration/cafe24/config";

const READ_SCOPES = "mall.read_product mall.read_order";

export type Cafe24Token = {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: string | null;
};

function validateConfig(config: Cafe24AppConfig) {
  const origin = cafe24Origin(config.mallId);
  if (!config.clientId.trim() || !config.clientSecret.trim()) throw new TypeError("Cafe24 app credentials are required.");
  if (new URL(config.redirectUri).protocol !== "https:") throw new TypeError("Cafe24 redirectUri must use HTTPS.");
  return origin;
}

function tokenPayload(value: unknown): Cafe24Token {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cafe24 token response is invalid.");
  const item = value as Record<string, unknown>;
  if (typeof item.access_token !== "string" || !item.access_token || typeof item.refresh_token !== "string" || !item.refresh_token) {
    throw new Error("Cafe24 token response is invalid.");
  }
  return {
    accessToken: item.access_token,
    refreshToken: item.refresh_token,
    scopes: Array.isArray(item.scopes) ? item.scopes.filter((scope): scope is string => typeof scope === "string") : [],
    expiresAt: typeof item.expires_at === "string" ? item.expires_at : null,
  };
}

async function postToken(config: Cafe24AppConfig, grant: Record<string, string>, fetchImpl: typeof fetch) {
  const origin = validateConfig(config);
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/api/v2/oauth/token`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...grant }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new Error("Cafe24 token transport failed."); }
  if (!response.ok) throw new Error(`Cafe24 token request failed (${response.status}).`);
  try { return tokenPayload(await response.json()); }
  catch { throw new Error("Cafe24 token response is invalid."); }
}

export function createCafe24AuthorizationUrl(config: Cafe24AppConfig, state: string): URL {
  const origin = validateConfig(config);
  if (!state || /\s/.test(state)) throw new TypeError("Cafe24 OAuth state is required.");
  const url = new URL("/api/v2/oauth/authorize", origin);
  url.search = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: READ_SCOPES, state }).toString();
  return url;
}

export async function exchangeCafe24Code(
  config: Cafe24AppConfig,
  input: { code: string; state: string; expectedState: string },
  fetchImpl: typeof fetch = fetch
) {
  if (!input.expectedState || input.state !== input.expectedState) throw new TypeError("Cafe24 OAuth state mismatch.");
  if (!input.code.trim()) throw new TypeError("Cafe24 OAuth code is required.");
  return postToken(config, { grant_type: "authorization_code", code: input.code, redirect_uri: config.redirectUri }, fetchImpl);
}

export function refreshCafe24Token(config: Cafe24AppConfig, refreshToken: string, fetchImpl: typeof fetch = fetch) {
  if (!refreshToken.trim()) throw new TypeError("Cafe24 refresh token is required.");
  return postToken(config, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}
