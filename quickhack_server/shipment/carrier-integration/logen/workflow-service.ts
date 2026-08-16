import {
  isLogenWriteOutcomeUncertain,
  logenCarrierClient,
} from "@/quickhack_server/shipment/carrier-integration/logen/api-client";
import type { LogenRequestCredentialSession } from "@/quickhack_server/shipment/carrier-integration/logen/credential-session";
import {
  appendCarrierTrackingEvents,
  openCarrierReconciliationWork,
  recordCarrierApiCall,
  recordCarrierApiFailure,
  upsertCarrierReturnRequest,
  upsertCarrierShipment,
} from "@/quickhack_server/shipment/carrier-integration/persistence-service";
import type {
  CarrierApiResult,
  CarrierOperationType,
  CarrierRequestItem,
} from "@/quickhack_server/shipment/carrier-integration/types";
import { classifyLogenTrackingStatus } from "@/quickhack_shared/shipment/carrier-tracking-status";

const LOGEN_BASE = "/lrm02b-edi/edi";

function text(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function responseItems(result: CarrierApiResult) {
  const data = result.payload.data;
  if (Array.isArray(data)) return data.map(object).filter(Boolean) as Record<string, unknown>[];
  const item = object(data);
  return item ? [item] : [];
}

function succeeded(item: Record<string, unknown> | undefined) {
  return item?.resultCd === "TRUE" || item?.resultCd === "SUCCESS";
}

type LoggedCallInput = {
  apiName: string;
  endpointPath: string;
  operationType: CarrierOperationType;
  externalOrderId?: string | null;
  trackingNumber?: string | null;
  takeNo?: string | null;
  carrierShipmentId?: number | null;
  workerJobId?: number | null;
  reconcileLookup?: { type: string; value: string } | null;
  run: () => Promise<CarrierApiResult>;
};

async function runLoggedCall(input: LoggedCallInput) {
  try {
    const result = await input.run();
    const log = await recordCarrierApiCall({
      result,
      carrierShipmentId: input.carrierShipmentId,
      externalOrderId: input.externalOrderId,
      trackingNumber: input.trackingNumber,
      takeNo: input.takeNo,
      workerJobId: input.workerJobId,
    });
    return { result, apiCallLogId: log.carrier_api_call_log_id };
  } catch (error) {
    const uncertain =
      input.operationType === "WRITE" && isLogenWriteOutcomeUncertain(error);
    const log = await recordCarrierApiFailure({
      carrierCode: "LOGEN",
      apiName: input.apiName,
      endpointPath: input.endpointPath,
      method: "POST",
      operationType: input.operationType,
      error,
      externalOrderId: input.externalOrderId,
      trackingNumber: input.trackingNumber,
      takeNo: input.takeNo,
      carrierShipmentId: input.carrierShipmentId,
      uncertain,
      workerJobId: input.workerJobId,
    });
    if (uncertain && input.reconcileLookup) {
      await openCarrierReconciliationWork({
        carrierCode: "LOGEN",
        operationType: input.apiName,
        lookupKeyType: input.reconcileLookup.type,
        lookupKeyValue: input.reconcileLookup.value,
        apiCallLogId: log.carrier_api_call_log_id,
        reason: "택배사 쓰기 API 결과가 불명확하여 조회 API 대조가 필요합니다.",
        lastErrorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    throw new CarrierApiCallFailureError(
      error instanceof Error ? error.message : String(error),
      log.carrier_api_call_log_id,
      uncertain,
      error
    );
  }
}

export class CarrierApiCallFailureError extends Error {
  readonly code = "CARRIER_API_CALL_FAILED";
  readonly apiCallLogId: number;
  readonly outcomeUncertain: boolean;
  readonly originalError: unknown;

  constructor(
    message: string,
    apiCallLogId: number,
    outcomeUncertain: boolean,
    originalError: unknown
  ) {
    super(message);
    this.name = "CarrierApiCallFailureError";
    this.apiCallLogId = apiCallLogId;
    this.outcomeUncertain = outcomeUncertain;
    this.originalError = originalError;
  }
}

export type LogenTrackingNumberAllocationItem = {
  trackingNumber: string | null;
  resultCode: string | null;
  resultMessage: string | null;
  succeeded: boolean;
};

export function parseLogenTrackingNumberAllocation(result: CarrierApiResult) {
  const data = object(result.payload.data);
  const rows = Array.isArray(data?.data1)
    ? (data.data1.map(object).filter(Boolean) as Record<string, unknown>[])
    : [];

  return {
    statusCode: text(result.payload.sttsCd),
    statusMessage: text(result.payload.sttsMsg),
    items: rows.map((item): LogenTrackingNumberAllocationItem => {
      const trackingNumber = text(item.slipNo);
      return {
        trackingNumber,
        resultCode: text(item.resultCd),
        resultMessage: text(item.resultMsg),
        succeeded: succeeded(item) && Boolean(trackingNumber),
      };
    }),
  };
}

export async function allocateLogenTrackingNumbers(quantity: number) {
  const call = await runLoggedCall({
    apiName: "getSlipNo",
    endpointPath: `${LOGEN_BASE}/getSlipNo`,
    operationType: "WRITE",
    run: () => logenCarrierClient.allocateTrackingNumbers(quantity),
  });
  return {
    ...call,
    allocation: parseLogenTrackingNumberAllocation(call.result),
  };
}

export async function registerLogenPrintedShipment(
  data: CarrierRequestItem,
  context: {
    channel?: string | null;
    externalOrderId?: string | null;
    externalShipmentId?: string | null;
    allocationId?: number | null;
    pgNo?: string | null;
    carrierShipmentId?: number | null;
    signal?: AbortSignal;
    credentialSession?: LogenRequestCredentialSession;
  } = {}
) {
  const trackingNumber = text(data.slipNo);
  if (!trackingNumber) throw new Error("slipNo가 필요합니다.");
  const externalOrderId = context.externalOrderId ?? text(data.fixTakeNo);
  const call = await runLoggedCall({
    apiName: "slipPrintM",
    endpointPath: `${LOGEN_BASE}/slipPrintM`,
    operationType: "WRITE",
    externalOrderId,
    trackingNumber,
    carrierShipmentId: context.carrierShipmentId,
    reconcileLookup: { type: "TRACKING_NUMBER", value: trackingNumber },
    run: () =>
      logenCarrierClient.registerPrintedShipment(data, {
        signal: context.signal,
        credentialSession: context.credentialSession,
      }),
  });
  const item = responseItems(call.result)[0];
  return { ...call, item, succeeded: succeeded(item) };
}

export async function getLogenContractInfoForRegistration(
  customerCode: string,
  carrierShipmentId?: number | null,
  signal?: AbortSignal,
  credentialSession?: LogenRequestCredentialSession
) {
  return runLoggedCall({
    apiName: "contractTotalInfo",
    endpointPath: `${LOGEN_BASE}/contractTotalInfo`,
    operationType: "READ",
    carrierShipmentId,
    run: () =>
      logenCarrierClient.getContractInfo([customerCode], {
        signal,
        credentialSession,
      }),
  });
}

export async function getLogenContractFaresForRegistration(
  customerCode: string,
  fareType: string,
  carrierShipmentId?: number | null,
  signal?: AbortSignal,
  credentialSession?: LogenRequestCredentialSession
) {
  return runLoggedCall({
    apiName: "contPickFares",
    endpointPath: `${LOGEN_BASE}/contPickFares`,
    operationType: "READ",
    carrierShipmentId,
    run: () =>
      logenCarrierClient.getContractFares(
        [{ custCd: customerCode, fareTy: fareType }],
        { signal, credentialSession }
      ),
  });
}

export async function getLogenPrintInfoForRegistration(
  customerCode: string,
  address: string,
  carrierShipmentId?: number | null,
  signal?: AbortSignal,
  credentialSession?: LogenRequestCredentialSession
) {
  return runLoggedCall({
    apiName: "integratedInquiry",
    endpointPath: `${LOGEN_BASE}/integratedInquiry`,
    operationType: "READ",
    carrierShipmentId,
    run: () =>
      logenCarrierClient.getPrintInfo(
        [{ custCd: customerCode, addr: address }],
        { signal, credentialSession }
      ),
  });
}

export async function getLogenExtraFareForRegistration(
  data: CarrierRequestItem,
  carrierShipmentId?: number | null,
  signal?: AbortSignal,
  credentialSession?: LogenRequestCredentialSession
) {
  return runLoggedCall({
    apiName: "custExtraFare",
    endpointPath: `${LOGEN_BASE}/custExtraFare`,
    operationType: "READ",
    carrierShipmentId,
    run: () =>
      logenCarrierClient.getExtraFare([data], {
        signal,
        credentialSession,
      }),
  });
}

export async function getLogenLatestTrackingForReconciliation(
  trackingNumber: string,
  carrierShipmentId?: number | null,
  signal?: AbortSignal
) {
  return runLoggedCall({
    apiName: "inquiryCargoTrackingMultiLast",
    endpointPath: `${LOGEN_BASE}/inquiryCargoTrackingMultiLast`,
    operationType: "READ",
    trackingNumber,
    carrierShipmentId,
    run: () =>
      logenCarrierClient.getLatestTracking([trackingNumber], { signal }),
  });
}

export function firstLogenResponseItem(result: CarrierApiResult) {
  return responseItems(result)[0] ?? null;
}

export function isLogenResponseItemSucceeded(
  item: Record<string, unknown> | null | undefined
) {
  return succeeded(item ?? undefined);
}

export function registerLogenCarrierPrintOrders(data: CarrierRequestItem[]) {
  const firstOrderId = text(data[0]?.fixTakeNo);
  return runLoggedCall({
    apiName: "registerOrderData",
    endpointPath: `${LOGEN_BASE}/registerOrderData`,
    operationType: "WRITE",
    externalOrderId: firstOrderId,
    reconcileLookup: firstOrderId
      ? { type: "EXTERNAL_ORDER_ID", value: firstOrderId }
      : null,
    run: () => logenCarrierClient.registerCarrierPrintOrders(data),
  });
}

export async function syncLogenPrintedTrackingNumbers(
  data: CarrierRequestItem[],
  context: { channel?: string | null; externalShipmentId?: string | null } = {}
) {
  const call = await runLoggedCall({
    apiName: "inquirySlipNoMulti",
    endpointPath: `${LOGEN_BASE}/inquirySlipNoMulti`,
    operationType: "READ",
    externalOrderId: text(data[0]?.fixTakeNo),
    run: () => logenCarrierClient.getPrintedTrackingNumbers(data),
  });
  const shipments = [];
  for (const item of responseItems(call.result)) {
    if (!succeeded(item)) continue;
    const nested = Array.isArray(item.data1) ? item.data1.map(object).filter(Boolean) : [];
    for (const invoice of nested) {
      const trackingNumber = text(invoice?.slipNo);
      if (!trackingNumber) continue;
      shipments.push(
        await upsertCarrierShipment({
          carrierCode: "LOGEN",
          sourceType: "CARRIER_POPUP",
          channel: context.channel ?? null,
          externalOrderId: text(item.fixTakeNo),
          externalShipmentId: context.externalShipmentId ?? null,
          trackingNumber,
          invoiceStatus: invoice?.delYn === "Y" ? "VOID_LOCAL" : "REGISTERED",
          shipmentStatus: "REGISTERED",
        })
      );
    }
  }
  return { ...call, shipments };
}

export type LogenTrackingResponseItem = {
  trackingNumber: string | null;
  succeeded: boolean;
  resultCode: string | null;
  resultMessage: string | null;
  events: Array<{
    scanDate: string | null;
    scanTime: string | null;
    statusName: string;
    branchCode: string | null;
    branchName: string | null;
    salesOfficeCode: string | null;
    salesOfficeName: string | null;
    recipientTypeName: string | null;
  }>;
};

function trackingEventSortKey(event: {
  scanDate?: string | null;
  scanTime?: string | null;
}) {
  return `${event.scanDate ?? ""}${event.scanTime ?? ""}`;
}

export function parseLogenTrackingResponse(result: CarrierApiResult) {
  return responseItems(result).map((item): LogenTrackingResponseItem => {
    const events = Array.isArray(item.data1)
      ? item.data1
          .map(object)
          .filter(Boolean)
          .map((event) => ({
            scanDate: text(event?.scanDt),
            scanTime: text(event?.scanTm),
            statusName: text(event?.statNm) || "UNKNOWN",
            branchCode: text(event?.branCd),
            branchName: text(event?.branNm),
            salesOfficeCode: text(event?.salesCd),
            salesOfficeName: text(event?.salesNm),
            recipientTypeName: text(event?.acptorTyNm),
          }))
          .sort((left, right) =>
            trackingEventSortKey(left).localeCompare(trackingEventSortKey(right))
          )
      : [];

    return {
      trackingNumber: text(item.slipNo),
      succeeded: succeeded(item),
      resultCode: text(item.resultCd),
      resultMessage: text(item.resultMsg),
      events,
    };
  });
}

export async function getLogenTrackingBatch(
  trackingNumbers: string[],
  context: { workerJobId?: number | null; signal?: AbortSignal } = {}
) {
  const call = await runLoggedCall({
    apiName: "inquiryCargoTrackingMulti",
    endpointPath: `${LOGEN_BASE}/inquiryCargoTrackingMulti`,
    operationType: "READ",
    trackingNumber: trackingNumbers[0] ?? null,
    workerJobId: context.workerJobId,
    run: () =>
      logenCarrierClient.getTracking(trackingNumbers, {
        signal: context.signal,
      }),
  });
  return {
    ...call,
    items: parseLogenTrackingResponse(call.result),
  };
}

export async function syncLogenTracking(trackingNumbers: string[]) {
  const call = await getLogenTrackingBatch(trackingNumbers);
  const shipments = [];
  for (const item of call.items) {
    if (!item.succeeded) continue;
    const trackingNumber = item.trackingNumber;
    if (!trackingNumber) continue;
    const latest = item.events.at(-1);
    const shipment = await upsertCarrierShipment({
      carrierCode: "LOGEN",
      sourceType: "MANUAL",
      trackingNumber,
      invoiceStatus: "REGISTERED",
      shipmentStatus:
        classifyLogenTrackingStatus(latest?.statusName) ?? "REGISTERED",
    });
    await appendCarrierTrackingEvents({
      carrierShipmentId: shipment.carrier_shipment_id,
      events: item.events,
      responseHash: call.result.responseHash,
      shipmentStatus:
        classifyLogenTrackingStatus(latest?.statusName) ?? "REGISTERED",
    });
    shipments.push(shipment);
  }
  return { ...call, shipments };
}

export async function registerLogenReturn(data: CarrierRequestItem[]) {
  const first = data[0];
  const call = await runLoggedCall({
    apiName: "registReturnRequest",
    endpointPath: `${LOGEN_BASE}/registReturnRequest`,
    operationType: "WRITE",
    externalOrderId: text(first?.fixTakeNo),
    trackingNumber: text(first?.orgnSlipNo),
    reconcileLookup: text(first?.fixTakeNo)
      ? { type: "EXTERNAL_ORDER_ID", value: text(first?.fixTakeNo) as string }
      : text(first?.orgnSlipNo)
        ? { type: "ORIGINAL_TRACKING_NUMBER", value: text(first?.orgnSlipNo) as string }
        : null,
    run: () => logenCarrierClient.registerReturn(data),
  });
  const returns = [];
  const response = responseItems(call.result);
  for (let index = 0; index < response.length; index += 1) {
    const item = response[index];
    if (!succeeded(item)) continue;
    const takeNo = text(item.takeNo);
    if (!takeNo) continue;
    const request = data[index] || {};
    returns.push(
      await upsertCarrierReturnRequest({
        carrierCode: "LOGEN",
        takeNo,
        externalOrderId: text(request.fixTakeNo),
        customerCode: text(request.custCd),
        originalTrackingNumber: text(request.orgnSlipNo),
        requestStatus: "CONFIRMED",
      })
    );
  }
  return { ...call, returns };
}
