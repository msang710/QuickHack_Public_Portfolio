import { createHash } from "node:crypto";
import type {
  CarrierApiResult,
  CarrierClient,
  CarrierHtmlResult,
  CarrierOperationType,
  CarrierPayload,
  CarrierRequestItem,
} from "@/quickhack_server/shipment/carrier-integration/types";
import {
  assertLogenSessionForOperation,
  openLogenRequestCredentialSession,
  type LogenRequestCredentialSession,
} from "@/quickhack_server/shipment/carrier-integration/logen/credential-session";

const API_BASE = "/lrm02b-edi/edi";
const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Logen API request was aborted.");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class LogenApiError extends Error {
  readonly code: "LOGEN_API_HTTP_ERROR" | "LOGEN_API_INVALID_RESPONSE";
  readonly apiName: string;
  readonly statusCode: number | null;
  readonly transient: boolean;
  readonly outcomeUncertain: boolean;

  constructor(input: {
    code: "LOGEN_API_HTTP_ERROR" | "LOGEN_API_INVALID_RESPONSE";
    apiName: string;
    statusCode: number | null;
    transient: boolean;
    outcomeUncertain: boolean;
  }) {
    super(
      input.code === "LOGEN_API_HTTP_ERROR"
        ? `로젠 API ${input.apiName} 응답 오류 (${input.statusCode ?? "NO_STATUS"}).`
        : `로젠 API ${input.apiName} 응답 형식 오류 (${input.statusCode ?? "NO_STATUS"}).`
    );
    this.name = "LogenApiError";
    this.code = input.code;
    this.apiName = input.apiName;
    this.statusCode = input.statusCode;
    this.transient = input.transient;
    this.outcomeUncertain = input.outcomeUncertain;
  }
}

type RequestInput = {
  apiName: string;
  path: string;
  operationType: CarrierOperationType;
  body:
    | CarrierPayload
    | ((session: LogenRequestCredentialSession) => CarrierPayload);
};

export type LogenApiRequestOptions = {
  signal?: AbortSignal;
  credentialSession?: LogenRequestCredentialSession;
};

async function requestLogenJson<T extends CarrierPayload = CarrierPayload>(
  input: RequestInput,
  options: LogenApiRequestOptions = {}
): Promise<CarrierApiResult<T>> {
  throwIfAborted(options.signal);
  const session = options.credentialSession
    ? assertLogenSessionForOperation(
        options.credentialSession,
        input.operationType
      )
    : await openLogenRequestCredentialSession({
        apiName: input.apiName,
        operationType: input.operationType,
      });
  const config = session.runtime;
  const method = "POST" as const;
  const body =
    typeof input.body === "function" ? input.body(session) : input.body;
  const requestText = JSON.stringify({ userId: session.userId, ...body });
  const attempts = input.operationType === "READ" ? config.readRetryCount + 1 : 1;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
      const requestSignal =
        input.operationType === "READ" && options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
      const response = await fetch(`${config.apiHost}${input.path}`, {
        method,
        cache: "no-store",
        headers: {
          secretKey: session.secretKey,
          "content-type": "application/json; charset=utf-8",
        },
        body: requestText,
        signal: requestSignal,
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new LogenApiError({
          code: "LOGEN_API_HTTP_ERROR",
          apiName: input.apiName,
          statusCode: response.status,
          transient: TRANSIENT_STATUS_CODES.has(response.status),
          outcomeUncertain: TRANSIENT_STATUS_CODES.has(response.status),
        });
      }
      let payload: T;
      try {
        payload = JSON.parse(responseText) as T;
      } catch {
        throw new LogenApiError({
          code: "LOGEN_API_INVALID_RESPONSE",
          apiName: input.apiName,
          statusCode: response.status,
          transient: false,
          outcomeUncertain: true,
        });
      }
      return {
        carrierCode: config.carrierCode,
        mode: config.mode,
        source: `${config.mode}:${input.path}`,
        apiName: input.apiName,
        requestPath: input.path,
        method,
        operationType: input.operationType,
        httpStatusCode: response.status,
        requestHash: sha256(requestText),
        responseHash: sha256(responseText),
        rawPayloadText: responseText,
        payload,
      };
    } catch (error) {
      lastError = error;
      const transient =
        error instanceof LogenApiError
          ? error.transient
          : error instanceof Error &&
            (error.name === "TimeoutError" || error.message.includes("fetch failed"));
      if (!transient || attempt + 1 >= attempts) throw error;
      await sleep(200 * (attempt + 1), options.signal);
    }
  }

  throw lastError;
}

export function isLogenWriteOutcomeUncertain(error: unknown) {
  if (error instanceof LogenApiError) return error.outcomeUncertain;
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.message.includes("fetch failed"))
  );
}

export class LogenCarrierClient implements CarrierClient {
  getContractInfo(customerCodes?: string[], options?: LogenApiRequestOptions) {
    return requestLogenJson({
      apiName: "contractTotalInfo",
      path: `${API_BASE}/contractTotalInfo`,
      operationType: "READ",
      body: (session) => {
        const values = customerCodes?.length
          ? customerCodes
          : [session.customerCode];
        return { data: values.map((custCd) => ({ custCd })) };
      },
    }, options);
  }

  getContractFares(data: CarrierRequestItem[], options?: LogenApiRequestOptions) {
    return requestLogenJson({ apiName: "contPickFares", path: `${API_BASE}/contPickFares`, operationType: "READ", body: { data } }, options);
  }

  allocateTrackingNumbers(quantity: number, options?: LogenApiRequestOptions) {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 9999) {
      throw new Error("송장 채번 수량은 1~9999 사이의 정수여야 합니다.");
    }
    return requestLogenJson({ apiName: "getSlipNo", path: `${API_BASE}/getSlipNo`, operationType: "WRITE", body: { data: [{ slipQty: quantity }] } }, options);
  }

  getPrintInfo(data: CarrierRequestItem[], options?: LogenApiRequestOptions) {
    return requestLogenJson({ apiName: "integratedInquiry", path: `${API_BASE}/integratedInquiry`, operationType: "READ", body: { data } }, options);
  }

  registerPrintedShipment(data: CarrierRequestItem, options?: LogenApiRequestOptions) {
    return requestLogenJson({ apiName: "slipPrintM", path: `${API_BASE}/slipPrintM`, operationType: "WRITE", body: { data } }, options);
  }

  registerCarrierPrintOrders(data: CarrierRequestItem[], options?: LogenApiRequestOptions) {
    return requestLogenJson({ apiName: "registerOrderData", path: `${API_BASE}/registerOrderData`, operationType: "WRITE", body: { data } }, options);
  }

  getPrintedTrackingNumbers(data: CarrierRequestItem[], options?: LogenApiRequestOptions) {
    return requestLogenJson({ apiName: "inquirySlipNoMulti", path: `${API_BASE}/inquirySlipNoMulti`, operationType: "READ", body: { data } }, options);
  }

  getReturnPickupInfo(data: CarrierRequestItem[]) {
    return requestLogenJson({ apiName: "reverseChkInfoMulti", path: `${API_BASE}/reverseChkInfoMulti`, operationType: "READ", body: { data } });
  }

  registerReturn(data: CarrierRequestItem[]) {
    return requestLogenJson({ apiName: "registReturnRequest", path: `${API_BASE}/registReturnRequest`, operationType: "WRITE", body: { data } });
  }

  getReturnStatusByReceipt(data: CarrierRequestItem[]) {
    return requestLogenJson({ apiName: "inquiryReserveStateMulti", path: `${API_BASE}/inquiryReserveStateMulti`, operationType: "READ", body: { data } });
  }

  getReturnStatusByOrder(data: CarrierRequestItem[]) {
    return requestLogenJson({ apiName: "inquiryReserveStateFixTakeNo", path: `${API_BASE}/inquiryReserveStateFixTakeNo`, operationType: "READ", body: { data } });
  }

  getReturnInfoByOriginalTracking(data: CarrierRequestItem[]) {
    return requestLogenJson({ apiName: "inquiryReturnStateMulti", path: `${API_BASE}/inquiryReturnStateMulti`, operationType: "READ", body: { data } });
  }

  getTracking(trackingNumbers: string[], options?: LogenApiRequestOptions) {
    return requestLogenJson({ apiName: "inquiryCargoTrackingMulti", path: `${API_BASE}/inquiryCargoTrackingMulti`, operationType: "READ", body: { data: trackingNumbers.map((slipNo) => ({ slipNo })) } }, options);
  }

  getLatestTracking(trackingNumbers: string[], options?: LogenApiRequestOptions) {
    return requestLogenJson({ apiName: "inquiryCargoTrackingMultiLast", path: `${API_BASE}/inquiryCargoTrackingMultiLast`, operationType: "READ", body: { data: trackingNumbers.map((slipNo) => ({ slipNo })) } }, options);
  }

  getExtraFare(data: CarrierRequestItem[], options?: LogenApiRequestOptions) {
    return requestLogenJson({ apiName: "custExtraFare", path: `${API_BASE}/custExtraFare`, operationType: "READ", body: { data } }, options);
  }

  async getPrintPopupHtml(input: {
    customerCode?: string;
    takeDate: string;
  }, options: LogenApiRequestOptions = {}): Promise<CarrierHtmlResult> {
    const session = options.credentialSession
      ? assertLogenSessionForOperation(options.credentialSession, "READ")
      : await openLogenRequestCredentialSession({
          apiName: "outSlipPrintPop",
          operationType: "READ",
        });
    const config = session.runtime;
    const url = new URL(`${config.apiHost}${API_BASE}/outSlipPrintPop`);
    url.searchParams.set("userId", session.userId);
    url.searchParams.set("custCd", input.customerCode || session.customerCode);
    url.searchParams.set("takeDt", input.takeDate);
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { secretKey: session.secretKey },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const html = await response.text();
    if (!response.ok) {
      throw new LogenApiError({
        code: "LOGEN_API_HTTP_ERROR",
        apiName: "outSlipPrintPop",
        statusCode: response.status,
        transient: TRANSIENT_STATUS_CODES.has(response.status),
        outcomeUncertain: false,
      });
    }
    return {
      carrierCode: config.carrierCode,
      mode: config.mode,
      source: `${config.mode}:${url.pathname}`,
      apiName: "outSlipPrintPop",
      requestPath: `${url.pathname}${url.search}`,
      method: "GET",
      operationType: "READ",
      httpStatusCode: response.status,
      requestHash: null,
      responseHash: sha256(html),
      html,
    };
  }
}

export const logenCarrierClient = new LogenCarrierClient();
