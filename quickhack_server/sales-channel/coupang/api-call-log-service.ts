// QuickHack note: Coupang 읽기 API 호출의 공통 상태 전이와 민감정보 없는 오류 기록을 관리합니다.
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import {
  databaseNow,
  type DatabaseDateTime,
} from "@/quickhack_server/core/database/time-boundary";
import { prisma } from "@/quickhack_server/core/prisma";
import { CoupangApiResponseError } from "@/quickhack_server/sales-channel/coupang/api-client";
import { safeCoupangExternalResponseCode } from "@/quickhack_server/sales-channel/coupang/external-response-metadata";
import { isWorkerShutdownRequestedError } from "@/quickhack_server/workers/shutdown-runtime";
import { parseKstSqlDateTime } from "@/quickhack_shared/core/time";

const COUPANG_CHANNEL = "COUPANG";

function sha256TextOrNull(value: unknown) {
  const text = String(value ?? "").trim();

  return text ? createHash("sha256").update(text).digest("hex") : null;
}

export function coupangApiCallErrorCode(error: unknown) {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.trim()
  ) {
    return error.code.trim().slice(0, 100);
  }

  if (error instanceof Error && error.name && error.name !== "Error") {
    return error.name.slice(0, 100);
  }

  return "COUPANG_READ_SYNC_FAILED";
}

export function coupangApiCallErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

export async function beginCoupangApiCallLog(input: {
  apiName: string;
  endpointPath?: string | null;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  statusFilter?: string | null;
  externalOrderId?: string | null;
  externalVendorItemId?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  pageToken?: string | null;
  maxPerPage?: number | null;
  workerJobId?: number | null;
  projectionRevision?: number | null;
  requestStartedAt: DatabaseDateTime;
}) {
  const row = await prisma.coupang_api_call_log.create({
    data: {
      channel: COUPANG_CHANNEL,
      api_name: input.apiName,
      endpoint_path: input.endpointPath ?? null,
      method: input.method ?? "GET",
      status_filter: input.statusFilter ?? null,
      external_order_id: input.externalOrderId ?? null,
      external_vendor_item_id: input.externalVendorItemId ?? null,
      period_from: parseKstSqlDateTime(input.periodFrom),
      period_to: parseKstSqlDateTime(input.periodTo),
      page_token_hash: sha256TextOrNull(input.pageToken),
      next_page_token_hash: null,
      max_per_page: input.maxPerPage ?? null,
      projection_revision: input.projectionRevision ?? null,
      response_row_count: 0,
      processed_row_count: 0,
      skipped_row_count: 0,
      stale_snapshot_count: 0,
      processed_status: "PENDING",
      request_started_at: input.requestStartedAt,
      received_at: null,
      worker_job_id: input.workerJobId ?? null,
      created_at: input.requestStartedAt,
      updated_at: input.requestStartedAt,
    },
    select: {
      coupang_api_call_log_id: true,
    },
  });

  return row.coupang_api_call_log_id;
}

export async function markCoupangApiCallReceived(input: {
  apiCallLogId: number;
  endpointPath: string;
  httpStatusCode: number;
  externalResponseCode?: string | null;
  responseHash?: string | null;
  receivedAt: DatabaseDateTime;
}) {
  const updated = await prisma.coupang_api_call_log.updateMany({
    where: {
      coupang_api_call_log_id: input.apiCallLogId,
      processed_status: "PENDING",
    },
    data: {
      endpoint_path: input.endpointPath,
      http_status_code: input.httpStatusCode,
      external_response_code: safeCoupangExternalResponseCode(
        input.externalResponseCode
      ),
      external_response_message: null,
      response_hash: input.responseHash ?? null,
      processed_status: "RECEIVED",
      received_at: input.receivedAt,
      updated_at: input.receivedAt,
    },
  });

  if (updated.count !== 1) {
    throw new Error("Coupang API call log could not enter RECEIVED status.");
  }
}

export async function markCoupangApiCallProcessing(input: {
  apiCallLogId: number;
  nextPageToken?: string | null;
  responseRowCount: number;
  processingStartedAt: DatabaseDateTime;
}) {
  const updated = await prisma.coupang_api_call_log.updateMany({
    where: {
      coupang_api_call_log_id: input.apiCallLogId,
      processed_status: "RECEIVED",
    },
    data: {
      next_page_token_hash: sha256TextOrNull(input.nextPageToken),
      response_row_count: Math.max(0, input.responseRowCount),
      processed_status: "PROCESSING",
      processing_started_at: input.processingStartedAt,
      updated_at: input.processingStartedAt,
    },
  });

  if (updated.count !== 1) {
    throw new Error("Coupang API call log could not enter PROCESSING status.");
  }
}

export async function completeCoupangApiCallLog(
  tx: Prisma.TransactionClient,
  input: {
    apiCallLogId: number;
    processedRowCount: number;
    skippedRowCount?: number;
    staleSnapshotCount?: number;
    processedAt: DatabaseDateTime;
  }
) {
  const updated = await tx.coupang_api_call_log.updateMany({
    where: {
      coupang_api_call_log_id: input.apiCallLogId,
      processed_status: "PROCESSING",
    },
    data: {
      processed_row_count: Math.max(0, input.processedRowCount),
      skipped_row_count: Math.max(0, input.skippedRowCount ?? 0),
      stale_snapshot_count: Math.max(0, input.staleSnapshotCount ?? 0),
      processed_status: "SUCCESS",
      processed_at: input.processedAt,
      error_code: null,
      error_message: null,
      updated_at: input.processedAt,
    },
  });

  if (updated.count !== 1) {
    throw new Error("Coupang API call log could not enter SUCCESS status.");
  }
}

export async function failCoupangApiCallLog(
  apiCallLogId: number,
  error: unknown
) {
  const failedAt = databaseNow();
  const canceled = isWorkerShutdownRequestedError(error);
  const responseError =
    error instanceof CoupangApiResponseError ? error : null;
  const updated = await prisma.coupang_api_call_log.updateMany({
    where: {
      coupang_api_call_log_id: apiCallLogId,
      processed_status: { in: ["PENDING", "RECEIVED", "PROCESSING"] },
    },
    data: {
      processed_status: canceled ? "CANCELED" : "FAILED",
      http_status_code: responseError?.httpStatusCode,
      external_response_code: responseError?.externalResponseCode,
      external_response_message: null,
      error_code: coupangApiCallErrorCode(error),
      error_message: coupangApiCallErrorMessage(error),
      processed_at: failedAt,
      updated_at: failedAt,
    },
  });

  if (updated.count !== 1) {
    throw new Error(
      `Coupang API call log could not enter ${
        canceled ? "CANCELED" : "FAILED"
      } status.`
    );
  }
}
