import { createHash } from "node:crypto";
import type { CoupangApiMode } from "@/quickhack_server/sales-channel/coupang/config";
import {
  openCoupangRequestAuthSession,
  type ChannelSignMetadata,
  type CoupangRequestAuthSession,
} from "@/quickhack_server/security/channel-auth";
import {
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";
import { safeCoupangExternalResponseCode } from "@/quickhack_server/sales-channel/coupang/external-response-metadata";
import { parseCoupangJson } from "@/quickhack_server/sales-channel/coupang/safe-json";
import { nowKstSqlDateTime, todayKstDate } from "@/quickhack_shared/core/time";

type QueryValue = string | number | boolean | null | undefined;

export type CoupangApiResponse<T> = {
  mode: CoupangApiMode;
  source: string;
  requestPath: string;
  httpStatusCode: number;
  responseHash: string;
  rawPayloadText: string;
  auth: ChannelSignMetadata;
  payload: T;
};

export class CoupangApiResponseError extends Error {
  readonly httpStatusCode: number;
  readonly externalResponseCode: string | null;
  readonly transient: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(input: {
    httpStatusCode: number;
    externalResponseCode?: string | null;
    transient: boolean;
    retryAfterSeconds?: number | null;
  }) {
    super(`Coupang API response error (${input.httpStatusCode}).`);
    this.name = input.transient
      ? "TransientCoupangApiError"
      : "CoupangApiError";
    this.httpStatusCode = input.httpStatusCode;
    this.externalResponseCode = input.externalResponseCode ?? null;
    this.transient = input.transient;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }
}

export class CoupangInventoryPayloadError extends Error {
  readonly code: string;
  responseMetadata: {
    requestPath: string;
    httpStatusCode: number;
    responseHash: string;
    externalResponseCode: string | null;
  } | null = null;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CoupangInventoryPayloadError";
    this.code = code;
  }
}

export type CoupangVendorItemInventory = {
  vendorItemId: string;
  amountInStock: number;
  salePrice: number | null;
  onSale: boolean | null;
  checkedAt: string;
};

export type CoupangInventoryQuantityUpdateResult = {
  code: string;
  message: string;
};

export type CoupangOrdersheetsInput = {
  status?: QueryValue;
  nextToken?: QueryValue;
  maxPerPage?: QueryValue;
  createdAtFrom?: QueryValue;
  createdAtTo?: QueryValue;
  searchType?: QueryValue;
};

export type CoupangReturnRequestsInput = {
  status?: QueryValue;
  cancelType?: QueryValue;
  orderId?: QueryValue;
  nextToken?: QueryValue;
  maxPerPage?: QueryValue;
  createdAtFrom?: QueryValue;
  createdAtTo?: QueryValue;
  searchType?: QueryValue;
};

export type CoupangExchangeRequestsInput = {
  status?: QueryValue;
  orderId?: QueryValue;
  nextToken?: QueryValue;
  maxPerPage?: QueryValue;
  createdAtFrom?: QueryValue;
  createdAtTo?: QueryValue;
};

export type CoupangReturnWithdrawalsInput = {
  dateFrom: QueryValue;
  dateTo: QueryValue;
  pageIndex?: QueryValue;
  sizePerPage?: QueryValue;
};

export type CoupangSellerProductsInput = {
  sellerProductId?: QueryValue;
  sellerProductName?: QueryValue;
  status?: QueryValue;
  nextToken?: QueryValue;
  maxPerPage?: QueryValue;
};

export type CoupangOrdersheetAcknowledgementInput = {
  shipmentBoxIds: Array<string | number>;
};

export type CoupangInvoiceUploadItem = {
  shipmentBoxId: string | number;
  orderId: string | number;
  vendorItemId: string | number;
  deliveryCompanyCode: string;
  invoiceNumber: string;
  splitShipping: boolean;
  preSplitShipped: boolean;
  estimatedShippingDate: string;
};

export type CoupangInvoiceUploadInput = {
  items: CoupangInvoiceUploadItem[];
};

export type CoupangReturnReceiveConfirmationInput = {
  receiptId: string | number;
};

export type CoupangReturnStoppedShipmentInput = {
  receiptId: string | number;
  cancelCount: number;
};

export type CoupangReturnApprovalInput = {
  receiptId: string | number;
  cancelCount: number;
};

type CoupangRequestContext = {
  mode: CoupangApiMode;
  apiHost: string;
  vendorId: string;
  timeoutMs: number;
};

// QuickHack object: keeps decrypted Coupang credentials only for one logical
// operation. Every HTTP request still creates a fresh HMAC signature.
export type CoupangApiCredentialContext = CoupangRequestAuthSession;

export type CoupangApiRequestOptions = {
  signal?: AbortSignal;
  retryCount?: number;
};

const TRANSIENT_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY_COUNT = 5;

function kstDateText() {
  return todayKstDate();
}

function queryString(params: Record<string, QueryValue>) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) {
      continue;
    }

    const text = String(value).trim();

    if (text) {
      query.set(key, text);
    }
  }

  return query.toString();
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Coupang API request was aborted.");
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

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function openCoupangApiCredentialContext(
  freshness: "CACHED_READ" | "FORCE_FRESH_WRITE" = "CACHED_READ"
): Promise<CoupangApiCredentialContext> {
  return traceOperationSpan("QHKEY_CONTEXT", () =>
    openCoupangRequestAuthSession(freshness)
  );
}

async function credentialContextOrOpen(
  credentialContext: CoupangApiCredentialContext | undefined,
  operationType: "READ" | "WRITE"
) {
  if (
    credentialContext &&
    (operationType === "READ" ||
      credentialContext.freshness === "FORCE_FRESH_WRITE")
  ) {
    return credentialContext;
  }

  return (
    await openCoupangApiCredentialContext(
      operationType === "WRITE" ? "FORCE_FRESH_WRITE" : "CACHED_READ"
    )
  );
}

function isTransientError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    (error instanceof CoupangApiResponseError && error.transient) ||
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    error.message.includes("Coupang API JSON parse error") ||
    error.message.includes("fetch failed") ||
    error.message.includes("network")
  );
}

function responseErrorValue(payload: unknown, key: string) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const direct = record[key];

  if (direct !== undefined && direct !== null) {
    return String(direct).trim() || null;
  }

  const data = record.data;

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const nested = (data as Record<string, unknown>)[key];
  return nested === undefined || nested === null
    ? null
    : String(nested).trim() || null;
}

function parseCoupangErrorCode(text: string) {
  try {
    const payload = JSON.parse(text) as unknown;
    return safeCoupangExternalResponseCode(
      responseErrorValue(payload, "code") ??
        responseErrorValue(payload, "responseCode") ??
        responseErrorValue(payload, "resultCode")
    );
  } catch {
    return null;
  }
}

function retryAfterSeconds(value: string | null) {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }

  const retryAt = Date.parse(value);

  return Number.isFinite(retryAt)
    ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
    : null;
}

async function fetchCoupangJson<T>(input: {
  url: URL;
  path: string;
  query: string;
  auth: CoupangRequestContext;
  authSession: CoupangRequestAuthSession;
  method: string;
  operationType: "READ" | "WRITE";
  body?: string;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const signed = await traceOperationSpan("QHKEY_SIGN", async () =>
    input.authSession.sign({
      method: input.method,
      path: input.path,
      query: input.query,
      operationType: input.operationType,
    })
  );
  throwIfAborted(input.signal);
  const timeoutSignal = AbortSignal.timeout(input.auth.timeoutMs);
  const requestSignal =
    input.operationType === "READ" && input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;
  const response = await traceOperationSpan("EXTERNAL_API_FETCH", () =>
    fetch(input.url, {
      method: input.method,
      cache: "no-store",
      headers: {
        authorization: signed.authorization,
        "content-type": "application/json;charset=UTF-8",
      },
      body: input.body,
      signal: requestSignal,
    })
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");

    throw new CoupangApiResponseError({
      httpStatusCode: response.status,
      externalResponseCode: parseCoupangErrorCode(text),
      transient: TRANSIENT_STATUS_CODES.has(response.status),
      retryAfterSeconds: retryAfterSeconds(response.headers.get("retry-after")),
    });
  }

  const text = await response.text();
  const responseHash = sha256Hex(text);

  try {
    return {
      httpStatusCode: response.status,
      responseHash,
      rawPayloadText: text,
      auth: {
        providerType: signed.providerType,
        keyAlias: signed.keyAlias,
        keyFingerprint: signed.keyFingerprint,
        authStatus: signed.authStatus,
        warningMessage: signed.warningMessage,
      },
      payload: parseCoupangJson<T>(text),
    };
  } catch {
    throw new Error(`Coupang API JSON parse error (${response.status}).`);
  }
}

async function readCoupangApi<T>(
  path: string,
  params: Record<string, QueryValue>,
  providedAuthSession?: CoupangRequestAuthSession,
  options: CoupangApiRequestOptions = {}
): Promise<CoupangApiResponse<T>> {
  const authSession = await credentialContextOrOpen(
    providedAuthSession,
    "READ"
  );
  const auth = authSession.context;
  const method = "GET";
  const query = queryString(params);
  const url = new URL(`${auth.apiHost}${path}`);
  const configuredRetryCount = options.retryCount;
  const retryCount =
    configuredRetryCount === undefined
      ? DEFAULT_RETRY_COUNT
      : Number.isFinite(configuredRetryCount) && configuredRetryCount >= 0
        ? Math.trunc(configuredRetryCount)
        : DEFAULT_RETRY_COUNT;

  if (query) {
    url.search = query;
  }

  let result: Awaited<ReturnType<typeof fetchCoupangJson<T>>>;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      result = await fetchCoupangJson<T>({
        url,
        path,
        query,
        auth,
        authSession,
        method,
        operationType: "READ",
        signal: options.signal,
      });

      return {
        mode: auth.mode,
        source: `${auth.mode}:${url.pathname}`,
        requestPath: `${url.pathname}${url.search}`,
        httpStatusCode: result.httpStatusCode,
        responseHash: result.responseHash,
        rawPayloadText: result.rawPayloadText,
        auth: result.auth,
        payload: result.payload,
      };
    } catch (error) {
      lastError = error;

      if (
        attempt >= retryCount ||
        (!isTransientError(error) && !(error instanceof Error && error.name === "TransientCoupangApiError"))
      ) {
        throw error;
      }

      await sleep(200 * (attempt + 1), options.signal);
    }
  }

  throw lastError;
}

async function writeCoupangApi<T>(input: {
  path: string;
  method: "PATCH" | "PUT" | "POST";
  body: Record<string, unknown> | string;
  authSession?: CoupangRequestAuthSession;
  signal?: AbortSignal;
}): Promise<CoupangApiResponse<T>> {
  throwIfAborted(input.signal);
  const authSession = await credentialContextOrOpen(
    input.authSession,
    "WRITE"
  );
  const auth = authSession.context;
  const query = "";
  const url = new URL(`${auth.apiHost}${input.path}`);
  const body =
    typeof input.body === "string" ? input.body : JSON.stringify(input.body);
  const result = await fetchCoupangJson<T>({
    url,
    path: input.path,
    query,
    auth,
    authSession,
    method: input.method,
    operationType: "WRITE",
    body,
    signal: input.signal,
  });

  return {
    mode: auth.mode,
    source: `${auth.mode}:${url.pathname}`,
    requestPath: url.pathname,
    httpStatusCode: result.httpStatusCode,
    responseHash: result.responseHash,
    rawPayloadText: result.rawPayloadText,
    auth: result.auth,
    payload: result.payload,
  };
}

export async function getCoupangOrdersheets(
  input: CoupangOrdersheetsInput = {},
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
) {
  const authSession = await credentialContextOrOpen(
    credentialContext,
    "READ"
  );
  const auth = authSession.context;
  const date = kstDateText();

  return readCoupangApi<Record<string, unknown>>(
    `/v2/providers/openapi/apis/api/v5/vendors/${encodeURIComponent(
      auth.vendorId
    )}/ordersheets`,
    {
      createdAtFrom: input.createdAtFrom ?? date,
      createdAtTo: input.createdAtTo ?? date,
      status: input.status ?? "INSTRUCT",
      nextToken: input.nextToken,
      maxPerPage: input.maxPerPage ?? 50,
      searchType: input.searchType,
    },
    authSession,
    options
  );
}

export async function getCoupangOrdersheetByOrderId(
  orderIdValue: string | number,
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
) {
  const authSession = await credentialContextOrOpen(
    credentialContext,
    "READ"
  );
  const auth = authSession.context;
  const orderId = requiredCoupangNumericId(orderIdValue, "orderId");

  return readCoupangApi<Record<string, unknown>>(
    `/v2/providers/openapi/apis/api/v5/vendors/${encodeURIComponent(
      auth.vendorId
    )}/${encodeURIComponent(orderId.pathValue)}/ordersheets`,
    {},
    authSession,
    options
  );
}

export async function acknowledgeCoupangOrdersheets(
  input: CoupangOrdersheetAcknowledgementInput,
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
) {
  const authSession = await credentialContextOrOpen(
    credentialContext,
    "WRITE"
  );
  const auth = authSession.context;
  const shipmentBoxIds = input.shipmentBoxIds
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  if (shipmentBoxIds.length === 0) {
    throw new Error("shipmentBoxIds is required.");
  }

  if (shipmentBoxIds.length > 50) {
    throw new Error("shipmentBoxIds must be 50 or fewer.");
  }

  return writeCoupangApi<Record<string, unknown>>({
    method: "PATCH",
    path: `/v2/providers/openapi/apis/api/v4/vendors/${encodeURIComponent(
      auth.vendorId
    )}/ordersheets/acknowledgement`,
    body: {
      vendorId: auth.vendorId,
      shipmentBoxIds,
    },
    authSession,
    signal: options.signal,
  });
}

export async function uploadCoupangInvoices(
  input: CoupangInvoiceUploadInput,
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
) {
  const authSession = await credentialContextOrOpen(
    credentialContext,
    "WRITE"
  );
  const auth = authSession.context;

  if (input.items.length === 0) {
    throw new Error("orderSheetInvoiceApplyDtos is required.");
  }
  if (input.items.length > 50) {
    throw new Error("orderSheetInvoiceApplyDtos must be 50 or fewer.");
  }

  const itemJson = input.items.map((item) => {
    const shipmentBoxId = requiredCoupangNumericId(
      item.shipmentBoxId,
      "shipmentBoxId"
    );
    const orderId = requiredCoupangNumericId(item.orderId, "orderId");
    const vendorItemId = requiredCoupangNumericId(
      item.vendorItemId,
      "vendorItemId"
    );
    const deliveryCompanyCode = String(item.deliveryCompanyCode ?? "").trim();
    const invoiceNumber = String(item.invoiceNumber ?? "").trim();

    if (!deliveryCompanyCode) {
      throw new Error("deliveryCompanyCode is required.");
    }
    if (!invoiceNumber) {
      throw new Error("invoiceNumber is required.");
    }

    return `{"shipmentBoxId":${shipmentBoxId.bodyNumberLiteral},"orderId":${orderId.bodyNumberLiteral},"vendorItemId":${vendorItemId.bodyNumberLiteral},"deliveryCompanyCode":${JSON.stringify(deliveryCompanyCode)},"invoiceNumber":${JSON.stringify(invoiceNumber)},"splitShipping":${item.splitShipping},"preSplitShipped":${item.preSplitShipped},"estimatedShippingDate":${JSON.stringify(item.estimatedShippingDate)}}`;
  });
  const body = `{"vendorId":${JSON.stringify(auth.vendorId)},"orderSheetInvoiceApplyDtos":[${itemJson.join(",")}]}`;

  return writeCoupangApi<Record<string, unknown>>({
    method: "POST",
    path: `/v2/providers/openapi/apis/api/v4/vendors/${encodeURIComponent(
      auth.vendorId
    )}/orders/invoices`,
    body,
    authSession,
    signal: options.signal,
  });
}

export async function updateCoupangInvoices(
  input: CoupangInvoiceUploadInput,
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
) {
  const authSession = await credentialContextOrOpen(
    credentialContext,
    "WRITE"
  );
  const auth = authSession.context;

  if (input.items.length === 0) {
    throw new Error("orderSheetInvoiceApplyDtos is required.");
  }
  if (input.items.length > 50) {
    throw new Error("orderSheetInvoiceApplyDtos must be 50 or fewer.");
  }

  const itemJson = input.items.map((item) => {
    const shipmentBoxId = requiredCoupangNumericId(
      item.shipmentBoxId,
      "shipmentBoxId"
    );
    const orderId = requiredCoupangNumericId(item.orderId, "orderId");
    const vendorItemId = requiredCoupangNumericId(
      item.vendorItemId,
      "vendorItemId"
    );
    const deliveryCompanyCode = String(item.deliveryCompanyCode ?? "").trim();
    const invoiceNumber = String(item.invoiceNumber ?? "").trim();

    if (!deliveryCompanyCode) {
      throw new Error("deliveryCompanyCode is required.");
    }
    if (!invoiceNumber) {
      throw new Error("invoiceNumber is required.");
    }

    return `{"shipmentBoxId":${shipmentBoxId.bodyNumberLiteral},"orderId":${orderId.bodyNumberLiteral},"vendorItemId":${vendorItemId.bodyNumberLiteral},"deliveryCompanyCode":${JSON.stringify(deliveryCompanyCode)},"invoiceNumber":${JSON.stringify(invoiceNumber)},"splitShipping":${item.splitShipping},"preSplitShipped":${item.preSplitShipped},"estimatedShippingDate":${JSON.stringify(item.estimatedShippingDate)}}`;
  });
  const body = `{"vendorId":${JSON.stringify(auth.vendorId)},"orderSheetInvoiceApplyDtos":[${itemJson.join(",")}]}`;

  return writeCoupangApi<Record<string, unknown>>({
    method: "POST",
    path: `/v2/providers/openapi/apis/api/v4/vendors/${encodeURIComponent(
      auth.vendorId
    )}/orders/updateInvoices`,
    body,
    authSession,
    signal: options.signal,
  });
}

function requiredCoupangNumericId(value: string | number, label: string) {
  const text = String(value ?? "").trim();

  if (!/^\d+$/.test(text)) {
    throw new Error(`${label} must be numeric.`);
  }

  if (text === "0") {
    throw new Error(`${label} must be positive.`);
  }

  return {
    pathValue: text,
    bodyNumberLiteral: text,
  };
}

export async function confirmCoupangReturnReceived(
  input: CoupangReturnReceiveConfirmationInput,
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
) {
  const authSession = await credentialContextOrOpen(
    credentialContext,
    "WRITE"
  );
  const auth = authSession.context;
  const receiptId = requiredCoupangNumericId(input.receiptId, "receiptId");

  return writeCoupangApi<Record<string, unknown>>({
    method: "PATCH",
    path: `/v2/providers/openapi/apis/api/v4/vendors/${encodeURIComponent(
      auth.vendorId
    )}/returnRequests/${encodeURIComponent(
      receiptId.pathValue
    )}/receiveConfirmation`,
    body: `{"vendorId":${JSON.stringify(auth.vendorId)},"receiptId":${receiptId.bodyNumberLiteral}}`,
    authSession,
    signal: options.signal,
  });
}

export async function stopCoupangReturnShipment(
  input: CoupangReturnStoppedShipmentInput,
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
) {
  const authSession = await credentialContextOrOpen(
    credentialContext,
    "WRITE"
  );
  const auth = authSession.context;
  const receiptId = requiredCoupangNumericId(input.receiptId, "receiptId");
  const cancelCount = Number(input.cancelCount);

  if (!Number.isSafeInteger(cancelCount) || cancelCount <= 0) {
    throw new Error("cancelCount must be a positive safe integer.");
  }

  return writeCoupangApi<Record<string, unknown>>({
    method: "PATCH",
    path: `/v2/providers/openapi/apis/api/v4/vendors/${encodeURIComponent(
      auth.vendorId
    )}/returnRequests/${encodeURIComponent(
      receiptId.pathValue
    )}/stoppedShipment`,
    body: `{"vendorId":${JSON.stringify(auth.vendorId)},"receiptId":${receiptId.bodyNumberLiteral},"cancelCount":${cancelCount}}`,
    authSession,
    signal: options.signal,
  });
}

export async function approveCoupangReturnRequest(
  input: CoupangReturnApprovalInput,
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
) {
  const authSession = await credentialContextOrOpen(
    credentialContext,
    "WRITE"
  );
  const auth = authSession.context;
  const receiptId = requiredCoupangNumericId(input.receiptId, "receiptId");
  const cancelCount = Number(input.cancelCount);

  if (!Number.isSafeInteger(cancelCount) || cancelCount <= 0) {
    throw new Error("cancelCount must be a positive safe integer.");
  }

  return writeCoupangApi<Record<string, unknown>>({
    method: "PATCH",
    path: `/v2/providers/openapi/apis/api/v4/vendors/${encodeURIComponent(
      auth.vendorId
    )}/returnRequests/${encodeURIComponent(receiptId.pathValue)}/approval`,
    body: `{"vendorId":${JSON.stringify(auth.vendorId)},"receiptId":${receiptId.bodyNumberLiteral},"cancelCount":${cancelCount}}`,
    authSession,
    signal: options.signal,
  });
}

export async function getCoupangReturnRequests(
  input: CoupangReturnRequestsInput = {},
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
) {
  const authSession = await credentialContextOrOpen(
    credentialContext,
    "READ"
  );
  const auth = authSession.context;
  const date = kstDateText();
  const orderIdSearch = String(input.orderId ?? "").trim().length > 0;

  return readCoupangApi<Record<string, unknown>>(
    `/v2/providers/openapi/apis/api/v6/vendors/${encodeURIComponent(
      auth.vendorId
    )}/returnRequests`,
    {
      searchType: input.searchType ?? (orderIdSearch ? "orderId" : "timeFrame"),
      createdAtFrom: input.createdAtFrom ?? (orderIdSearch ? undefined : date),
      createdAtTo: input.createdAtTo ?? (orderIdSearch ? undefined : date),
      status: input.status,
      cancelType: input.cancelType,
      orderId: input.orderId,
      nextToken: input.nextToken,
      maxPerPage: input.maxPerPage ?? 50,
    },
    authSession,
    options
  );
}

export async function getCoupangExchangeRequests(
  input: CoupangExchangeRequestsInput = {},
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
) {
  const authSession = await credentialContextOrOpen(
    credentialContext,
    "READ"
  );
  const auth = authSession.context;
  const date = kstDateText();

  return readCoupangApi<Record<string, unknown>>(
    `/v2/providers/openapi/apis/api/v4/vendors/${encodeURIComponent(
      auth.vendorId
    )}/exchangeRequests`,
    {
      createdAtFrom: input.createdAtFrom ?? `${date}T00:00:00`,
      createdAtTo: input.createdAtTo ?? `${date}T23:59:59`,
      status: input.status,
      orderId: input.orderId,
      nextToken: input.nextToken,
      maxPerPage: input.maxPerPage ?? 50,
    },
    authSession,
    options
  );
}

export async function getCoupangReturnWithdrawals(
  input: CoupangReturnWithdrawalsInput,
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
) {
  const authSession = await credentialContextOrOpen(
    credentialContext,
    "READ"
  );
  const auth = authSession.context;

  return readCoupangApi<Record<string, unknown>>(
    `/v2/providers/openapi/apis/api/v4/vendors/${encodeURIComponent(
      auth.vendorId
    )}/returnWithdrawRequests`,
    {
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      pageIndex: input.pageIndex ?? 1,
      sizePerPage: input.sizePerPage ?? 100,
    },
    authSession,
    options
  );
}

export async function getCoupangSellerProducts(
  input: CoupangSellerProductsInput = {},
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
) {
  const authSession = await credentialContextOrOpen(
    credentialContext,
    "READ"
  );
  const auth = authSession.context;

  return readCoupangApi<Record<string, unknown>>(
    "/v2/providers/seller_api/apis/api/v1/marketplace/seller-products",
    {
      vendorId: auth.vendorId,
      sellerProductId: input.sellerProductId,
      sellerProductName: input.sellerProductName,
      status: input.status,
      nextToken: input.nextToken,
      maxPerPage: input.maxPerPage ?? 100,
    },
    authSession,
    options
  );
}

export async function getCoupangSellerProduct(
  sellerProductId: QueryValue,
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
) {
  const authSession = await credentialContextOrOpen(
    credentialContext,
    "READ"
  );
  const id = String(sellerProductId ?? "").trim();

  if (!id) {
    throw new Error("sellerProductId is required.");
  }

  return readCoupangApi<Record<string, unknown>>(
    `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${encodeURIComponent(
      id
    )}`,
    {},
    authSession,
    options
  );
}

function inventoryPayloadRecord(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CoupangInventoryPayloadError(
      "COUPANG_INVENTORY_PAYLOAD_INVALID",
      "COUPANG_INVENTORY_PAYLOAD_INVALID"
    );
  }

  return payload as Record<string, unknown>;
}

function parseCoupangVendorItemInventoryPayload(
  vendorItemId: string,
  payload: unknown
): CoupangVendorItemInventory {
  const root = inventoryPayloadRecord(payload);
  const code = String(root.code ?? "").trim().toUpperCase();

  if (code !== "SUCCESS") {
    throw new CoupangInventoryPayloadError(
      "COUPANG_INVENTORY_RESPONSE_NOT_SUCCESS",
      "COUPANG_INVENTORY_RESPONSE_NOT_SUCCESS"
    );
  }

  const data = inventoryPayloadRecord(root.data);
  const amountInStock = data.amountInStock;

  if (
    typeof amountInStock !== "number" ||
    !Number.isSafeInteger(amountInStock) ||
    amountInStock < 0
  ) {
    throw new CoupangInventoryPayloadError(
      "COUPANG_INVENTORY_AMOUNT_INVALID",
      "COUPANG_INVENTORY_AMOUNT_INVALID"
    );
  }

  const salePrice =
    typeof data.salePrice === "number" &&
    Number.isSafeInteger(data.salePrice) &&
    data.salePrice >= 0
      ? data.salePrice
      : null;

  return {
    vendorItemId,
    amountInStock,
    salePrice,
    onSale: typeof data.onSale === "boolean" ? data.onSale : null,
    checkedAt: nowKstSqlDateTime(),
  };
}

export async function getCoupangVendorItemInventory(
  vendorItemId: QueryValue,
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
): Promise<CoupangApiResponse<CoupangVendorItemInventory>> {
  const id = String(vendorItemId ?? "").trim();

  if (!id) {
    throw new Error("vendorItemId is required.");
  }

  const response = await readCoupangApi<Record<string, unknown>>(
    `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${encodeURIComponent(
      id
    )}/inventories`,
    {},
    credentialContext,
    options
  );

  try {
    return {
      ...response,
      payload: parseCoupangVendorItemInventoryPayload(id, response.payload),
    };
  } catch (error) {
    if (error instanceof CoupangInventoryPayloadError) {
      const root = response.payload as Record<string, unknown>;
      error.responseMetadata = {
        requestPath: response.requestPath,
        httpStatusCode: response.httpStatusCode,
        responseHash: response.responseHash,
        externalResponseCode: safeCoupangExternalResponseCode(
          typeof root.code === "string" ? root.code.trim() : null
        ),
      };
    }

    throw error;
  }
}

export async function updateCoupangVendorItemQuantity(
  vendorItemId: QueryValue,
  quantityValue: number,
  credentialContext?: CoupangApiCredentialContext,
  options: CoupangApiRequestOptions = {}
): Promise<CoupangApiResponse<CoupangInventoryQuantityUpdateResult>> {
  const id = requiredCoupangNumericId(
    String(vendorItemId ?? "").trim(),
    "vendorItemId"
  );

  if (
    !Number.isSafeInteger(quantityValue) ||
    quantityValue < 0
  ) {
    throw new Error("quantity must be a non-negative safe integer.");
  }

  return writeCoupangApi<CoupangInventoryQuantityUpdateResult>({
    method: "PUT",
    path: `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${encodeURIComponent(
      id.pathValue
    )}/quantities/${quantityValue}`,
    body: "",
    authSession: credentialContext,
    signal: options.signal,
  });
}
