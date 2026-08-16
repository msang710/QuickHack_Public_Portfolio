import {
  expectIntegrationArray,
  expectIntegrationObject,
  expectIntegrationString,
  schemaError,
} from "@/quickhack_server/integration/schema-validation";
import type { IntegrationJsonValue } from "@/quickhack_shared/integration/contracts";

const MAX_PROVIDER_CLOCK_SKEW_MS = 5 * 60 * 1_000;

type ValidationContext = {
  provider: string;
  endpoint: string;
};

export type NormalizedLogenTrackingEvent = {
  scanDate: string | null;
  scanTime: string | null;
  statusName: string;
  branchCode: string | null;
  branchName: string | null;
  salesOfficeCode: string | null;
  salesOfficeName: string | null;
  recipientTypeName: string | null;
};

export type NormalizedLogenTrackingItem = {
  trackingNumber: string;
  succeeded: boolean;
  resultCode: string;
  resultMessage: string | null;
  events: NormalizedLogenTrackingEvent[];
};

export type NormalizedLogenTrackingBatch = {
  statusCode: string;
  statusMessage: string | null;
  items: NormalizedLogenTrackingItem[];
};

function nullableString(
  value: unknown,
  context: ValidationContext,
  path: string
) {
  if (value == null) return null;
  return expectIntegrationString(value, context, path).trim() || null;
}

function requiredTrimmedString(
  value: unknown,
  context: ValidationContext,
  path: string
) {
  const result = expectIntegrationString(value, context, path).trim();
  if (!result) {
    return schemaError({ ...context, path, reason: "EXPECTED_NONEMPTY_STRING" });
  }
  return result;
}

function eventSortKey(event: NormalizedLogenTrackingEvent) {
  return `${event.scanDate ?? ""}${event.scanTime ?? ""}`;
}

export function validateLogenTrackingBatch(
  payload: unknown,
  context: ValidationContext
): NormalizedLogenTrackingBatch & IntegrationJsonValue {
  const root = expectIntegrationObject(payload, context);
  const statusCode = requiredTrimmedString(root.sttsCd, context, "$.sttsCd");
  if (!["SUCCESS", "PARTIAL SUCCESS", "FAIL"].includes(statusCode)) {
    return schemaError({
      ...context,
      path: "$.sttsCd",
      reason: "UNKNOWN_PROVIDER_BATCH_STATUS",
    });
  }
  const rows = expectIntegrationArray(root.data, context, "$.data");
  const items = rows.map((value, itemIndex): NormalizedLogenTrackingItem => {
    const itemPath = `$.data[${itemIndex}]`;
    const item = expectIntegrationObject(value, context, itemPath);
    const trackingNumber = requiredTrimmedString(
      item.slipNo,
      context,
      `${itemPath}.slipNo`
    );
    const resultCode = requiredTrimmedString(
      item.resultCd,
      context,
      `${itemPath}.resultCd`
    );
    const succeeded = resultCode === "TRUE" || resultCode === "SUCCESS";
    const eventValues = expectIntegrationArray(
      item.data1,
      context,
      `${itemPath}.data1`
    );
    const events = eventValues
      .map((eventValue, eventIndex): NormalizedLogenTrackingEvent => {
        const eventPath = `${itemPath}.data1[${eventIndex}]`;
        const event = expectIntegrationObject(eventValue, context, eventPath);
        return {
          scanDate: nullableString(event.scanDt, context, `${eventPath}.scanDt`),
          scanTime: nullableString(event.scanTm, context, `${eventPath}.scanTm`),
          statusName: requiredTrimmedString(
            event.statNm,
            context,
            `${eventPath}.statNm`
          ),
          branchCode: nullableString(event.branCd, context, `${eventPath}.branCd`),
          branchName: nullableString(event.branNm, context, `${eventPath}.branNm`),
          salesOfficeCode: nullableString(
            event.salesCd,
            context,
            `${eventPath}.salesCd`
          ),
          salesOfficeName: nullableString(
            event.salesNm,
            context,
            `${eventPath}.salesNm`
          ),
          recipientTypeName: nullableString(
            event.acptorTyNm,
            context,
            `${eventPath}.acptorTyNm`
          ),
        };
      })
      .sort((left, right) => eventSortKey(left).localeCompare(eventSortKey(right)));

    return {
      trackingNumber,
      succeeded,
      resultCode,
      resultMessage: nullableString(
        item.resultMsg,
        context,
        `${itemPath}.resultMsg`
      ),
      events,
    };
  });

  return {
    statusCode,
    statusMessage: nullableString(root.sttsMsg, context, "$.sttsMsg"),
    items,
  };
}

export type LogenTrackingOccurredAt = {
  occurredAt: Date;
  source: "PROVIDER_SCAN" | "RECEIVED_AT";
  invalidReason: "MISSING" | "FORMAT" | "FUTURE" | null;
};

export function resolveLogenTrackingOccurredAt(input: {
  scanDate?: string | null;
  scanTime?: string | null;
  receivedAt: Date;
}): LogenTrackingOccurredAt {
  const scanDate = input.scanDate?.trim() ?? "";
  const scanTime = input.scanTime?.trim() ?? "";
  if (!scanDate || !scanTime) {
    return {
      occurredAt: input.receivedAt,
      source: "RECEIVED_AT",
      invalidReason: "MISSING",
    };
  }
  if (!/^\d{8}$/.test(scanDate) || !/^\d{6}$/.test(scanTime)) {
    return {
      occurredAt: input.receivedAt,
      source: "RECEIVED_AT",
      invalidReason: "FORMAT",
    };
  }
  const year = Number(scanDate.slice(0, 4));
  const month = Number(scanDate.slice(4, 6));
  const day = Number(scanDate.slice(6, 8));
  const hour = Number(scanTime.slice(0, 2));
  const minute = Number(scanTime.slice(2, 4));
  const second = Number(scanTime.slice(4, 6));
  const occurredAt = new Date(
    `${scanDate.slice(0, 4)}-${scanDate.slice(4, 6)}-${scanDate.slice(6, 8)}` +
      `T${scanTime.slice(0, 2)}:${scanTime.slice(2, 4)}:${scanTime.slice(4, 6)}+09:00`
  );
  const roundTrip = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(occurredAt);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(roundTrip.find((value) => value.type === type)?.value ?? -1);
  if (
    Number.isNaN(occurredAt.getTime()) ||
    part("year") !== year ||
    part("month") !== month ||
    part("day") !== day ||
    part("hour") !== hour ||
    part("minute") !== minute ||
    part("second") !== second
  ) {
    return {
      occurredAt: input.receivedAt,
      source: "RECEIVED_AT",
      invalidReason: "FORMAT",
    };
  }
  if (occurredAt.getTime() > input.receivedAt.getTime() + MAX_PROVIDER_CLOCK_SKEW_MS) {
    return {
      occurredAt: input.receivedAt,
      source: "RECEIVED_AT",
      invalidReason: "FUTURE",
    };
  }
  return { occurredAt, source: "PROVIDER_SCAN", invalidReason: null };
}
