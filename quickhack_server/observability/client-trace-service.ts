import { prisma } from "@/quickhack_server/core/prisma";
import {
  databaseDateTime,
  databaseNow,
} from "@/quickhack_server/core/database/time-boundary";
import type { ClientHttpTraceObservationInput } from "@/quickhack_shared/observability/http-trace";

export const CLIENT_TRACE_BATCH_LIMIT = 20;
const MAX_CLIENT_DURATION_MS = 600_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundedInteger(
  value: unknown,
  name: string,
  options: { nullable?: boolean; min?: number; max?: number } = {}
) {
  if ((value === null || value === undefined) && options.nullable) return null;
  const numberValue = Number(value);
  const min = options.min ?? 0;
  const max = options.max ?? MAX_CLIENT_DURATION_MS;

  if (!Number.isFinite(numberValue)) {
    throw new Error(`${name} must be a finite number.`);
  }

  const integer = Math.round(numberValue);

  if (integer < min || integer > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }

  return integer;
}

export function normalizeClientTraceBatch(
  payload: unknown
): ClientHttpTraceObservationInput[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Request body must be an object.");
  }

  const items = (payload as { items?: unknown }).items;

  if (!Array.isArray(items) || items.length < 1) {
    throw new Error("items must contain at least one observation.");
  }

  if (items.length > CLIENT_TRACE_BATCH_LIMIT) {
    throw new Error(`items cannot exceed ${CLIENT_TRACE_BATCH_LIMIT}.`);
  }

  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`items[${index}] must be an object.`);
    }

    const value = item as Record<string, unknown>;
    const traceId = String(value.traceId ?? "").trim();

    if (!UUID_PATTERN.test(traceId)) {
      throw new Error(`items[${index}].traceId is invalid.`);
    }

    const observedAt = String(value.observedAt ?? "").trim();

    if (
      !observedAt ||
      observedAt.length > 40 ||
      !Number.isFinite(Date.parse(observedAt))
    ) {
      throw new Error(`items[${index}].observedAt is invalid.`);
    }

    const normalizedObservedAt = new Date(observedAt).toISOString();

    return {
      traceId: traceId.toLowerCase(),
      responseStatus: boundedInteger(value.responseStatus, "responseStatus", {
        min: 100,
        max: 599,
      }) as number,
      headerReceivedMs: boundedInteger(
        value.headerReceivedMs,
        "headerReceivedMs"
      ) as number,
      responseCompleteMs: boundedInteger(
        value.responseCompleteMs,
        "responseCompleteMs",
        { nullable: true }
      ),
      bodyProcessingMs: boundedInteger(
        value.bodyProcessingMs,
        "bodyProcessingMs",
        { nullable: true }
      ),
      gatewayMs: boundedInteger(value.gatewayMs, "gatewayMs", {
        nullable: true,
      }),
      observedAt: normalizedObservedAt,
    };
  });
}

export async function saveClientTraceObservations(input: {
  userId: number;
  items: ClientHttpTraceObservationInput[];
}) {
  const updatedAt = databaseNow();

  await prisma.$transaction(
    input.items.map((item) =>
      prisma.client_http_trace_observations.upsert({
        where: { trace_id: item.traceId },
        create: {
          trace_id: item.traceId,
          reported_by_user_id: input.userId,
          response_status: item.responseStatus,
          header_received_ms: item.headerReceivedMs,
          response_complete_ms: item.responseCompleteMs,
          body_processing_ms: item.bodyProcessingMs,
          gateway_ms: item.gatewayMs,
          observed_at: databaseDateTime(item.observedAt),
          updated_at: updatedAt,
        },
        update: {
          reported_by_user_id: input.userId,
          response_status: item.responseStatus,
          header_received_ms: item.headerReceivedMs,
          ...(item.responseCompleteMs === null
            ? {}
            : { response_complete_ms: item.responseCompleteMs }),
          ...(item.bodyProcessingMs === null
            ? {}
            : { body_processing_ms: item.bodyProcessingMs }),
          ...(item.gatewayMs === null ? {} : { gateway_ms: item.gatewayMs }),
          observed_at: databaseDateTime(item.observedAt),
          updated_at: updatedAt,
        },
      })
    )
  );
}
