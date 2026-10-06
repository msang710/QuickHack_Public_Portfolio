import { createDeliveryApiClient } from "@/quickhack_server/integration/deliveryapi/client";
import { deliveryApiCredentialsFromServerEnvironment } from "@/quickhack_server/integration/deliveryapi/config";

export async function probeDeliveryTracking(input: {
  courierCode: string;
  trackingNumber: string;
  clientId?: string;
}, options: { signal?: AbortSignal } = {}) {
  const client = createDeliveryApiClient({ credentials: deliveryApiCredentialsFromServerEnvironment });
  return client.trace([input], options);
}
