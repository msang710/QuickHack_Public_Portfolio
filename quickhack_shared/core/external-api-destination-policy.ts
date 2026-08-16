// QuickHack note: live credential은 코드로 고정한 공식 HTTPS origin에만 전송합니다.
export const OFFICIAL_LIVE_API_HOSTS = {
  COUPANG: "https://api-gateway.coupang.com",
  LOGEN: "https://openapi.ilogen.com",
} as const;

export type ExternalApiProvider = keyof typeof OFFICIAL_LIVE_API_HOSTS;

export class ExternalApiDestinationConfigurationError extends Error {
  readonly code = "EXTERNAL_API_DESTINATION_REJECTED";
  readonly provider: ExternalApiProvider;

  constructor(provider: ExternalApiProvider) {
    super(`${provider} live API 목적지 설정이 허용되지 않았습니다.`);
    this.name = "ExternalApiDestinationConfigurationError";
    this.provider = provider;
  }
}

export function resolveOfficialLiveApiHost(
  provider: ExternalApiProvider
) {
  return OFFICIAL_LIVE_API_HOSTS[provider];
}
