import { createHmac, timingSafeEqual } from "node:crypto";
import { DELIVERYAPI_ORIGIN, type DeliveryApiCredentials } from "@/quickhack_server/integration/deliveryapi/config";
import type { DeliveryApiTraceInput } from "@/quickhack_server/integration/deliveryapi/tracking-schema";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function verifyDeliveryApiWebhook(rawBody: string, headers: Pick<Headers, "get">, secret: string, nowMs = Date.now()) {
  const timestamp = headers.get("x-webhook-timestamp") ?? "";
  const signature = headers.get("x-webhook-signature") ?? "";
  if (!/^\d{10}$/.test(timestamp) || Math.abs(nowMs / 1000 - Number(timestamp)) > 300) {
    throw new Error("DeliveryAPI webhook timestamp is invalid.");
  }
  if (rawBody.length > 1_000_000 || !secret || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
    throw new Error("DeliveryAPI webhook signature is invalid.");
  }
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error("DeliveryAPI webhook signature is invalid.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); } catch { throw new Error("DeliveryAPI webhook payload is invalid."); }
  const payload = record(parsed);
  const requestId = text(payload?.requestId);
  const event = text(payload?.event);
  if (!requestId || !event) throw new Error("DeliveryAPI webhook payload is invalid.");
  return {
    eventId: headers.get("x-webhook-id") ?? null,
    event,
    requestId,
    items: Array.isArray(payload?.items) ? payload.items.map((item) => {
      const row = record(item);
      return { clientId: text(row?.clientId), currentStatus: text(row?.currentStatus), hasChanged: row?.hasChanged === true };
    }) : [],
  };
}

export function createDeliveryApiWebhookClient({
  credentials,
  fetchImpl = fetch,
}: { credentials: () => DeliveryApiCredentials; fetchImpl?: typeof fetch }) {
  async function request(path: string, method: "GET" | "POST", body?: unknown) {
    const { apiKey, secretKey } = credentials();
    let response: Response;
    try {
      response = await fetchImpl(`${DELIVERYAPI_ORIGIN}${path}`, {
        method,
        redirect: "error",
        cache: "no-store",
        headers: { Authorization: `Bearer ${apiKey}:${secretKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new Error("DeliveryAPI webhook transport failed."); }
    if (!response.ok) throw new Error(`DeliveryAPI webhook request failed (${response.status}).`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("DeliveryAPI webhook response is invalid."); }
    const root = record(payload);
    const data = record(root?.data);
    if (root?.isSuccess !== true || !data) throw new Error("DeliveryAPI webhook response is invalid.");
    return data;
  }
  return {
    async registerOnce(item: DeliveryApiTraceInput) {
      if (!/^[a-z0-9.]{2,40}$/.test(item.courierCode) || !/^\d{8,30}$/.test(item.trackingNumber)) {
        throw new TypeError("DeliveryAPI tracking item is invalid.");
      }
      const data = await request("/v1/webhooks/register", "POST", { items: [item], recurring: false });
      if (!text(data.requestId)) throw new Error("DeliveryAPI webhook response is invalid.");
      return { requestId: data.requestId as string, itemCount: data.itemCount, recurring: false };
    },
    async getSubscription(requestId: string) {
      if (!/^req_[A-Za-z0-9_]{1,100}$/.test(requestId)) throw new TypeError("DeliveryAPI requestId is invalid.");
      const data = await request(`/v1/webhooks/subscriptions/${requestId}`, "GET");
      if (data.requestId !== requestId || !Array.isArray(data.items)) throw new Error("DeliveryAPI webhook response is invalid.");
      return {
        requestId,
        status: text(data.status),
        items: data.items.map((item) => {
          const row = record(item);
          return { clientId: text(row?.clientId), currentStatus: text(row?.currentStatus) };
        }),
      };
    },
  };
}
