export const DELIVERYAPI_ORIGIN = "https://api.deliveryapi.co.kr" as const;

export type DeliveryApiCredentials = { apiKey: string; secretKey: string };

export function deliveryApiCredentialsFromServerEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): DeliveryApiCredentials {
  const apiKey = environment.QUICKHACK_DELIVERYAPI_API_KEY?.trim();
  const secretKey = environment.QUICKHACK_DELIVERYAPI_SECRET_KEY?.trim();
  if (!apiKey || !secretKey || /[:\s]/.test(apiKey) || /[\r\n]/.test(secretKey)) {
    throw new Error("DeliveryAPI server credentials are unavailable or invalid.");
  }
  return { apiKey, secretKey };
}
