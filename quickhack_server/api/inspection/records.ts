// QuickHack note: 업로드된 외관/기능 검수 기록을 DB에 저장하는 서버 API입니다.
﻿import { NextRequest, NextResponse } from "next/server";
import { canAccessRole } from "@/quickhack_shared/auth/auth-constants";
import { PublicError } from "@/quickhack_server/core/public-error";
import type { InspectionRecord } from "@/quickhack_shared/inspection/inspection-schema";
import { isClientRuntime } from "@/quickhack_shared/core/runtime";
import { proxyToServer } from "@/quickhack_shared/core/server-proxy";
import {
  markOperationTraceFailed,
  runOperationTrace,
  setOperationTraceTargetCount,
  setOperationTraceUserId,
  traceOperationSpan,
} from "@/quickhack_server/observability/operation-trace";

export const runtime = "nodejs";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  if (isClientRuntime()) {
    return proxyToServer(request, "/api/inspection-records", {
      method: "POST",
      body: bodyText,
    });
  }

  return runOperationTrace(
    {
      operationName: "inspection.record.save",
      source: "HTTP",
      route: "/api/inspection-records",
      method: "POST",
    },
    async () => {

  const { getAuthUserFromRequest } = await import("@/quickhack_server/auth/auth-service");
  const user = await getAuthUserFromRequest(request);

  if (!user) {
    return NextResponse.json(
      { ok: false, message: "로그인이 필요합니다." },
      { status: 401 }
    );
  }

  if (!canAccessRole(user.role, "STAFF")) {
    return NextResponse.json(
      { ok: false, message: "검수 내역 저장 권한이 없습니다." },
      { status: 403 }
    );
  }
  setOperationTraceUserId(user.userId);

  const body = bodyText
    ? (() => {
        try {
          return JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          return null;
        }
      })()
    : null;

  if (!isObject(body) || !Array.isArray(body.records)) {
    return NextResponse.json(
      { ok: false, message: "저장할 검수 내역이 없습니다." },
      { status: 400 }
    );
  }
  const records = body.records;
  setOperationTraceTargetCount(records.length);

  const [{ saveInspectionRecord }, { prisma }] = await Promise.all([
    import("@/quickhack_server/inspection/inspection-save-service"),
    import("@/quickhack_server/core/prisma"),
  ]);

  const results = await traceOperationSpan("SERVICE_WRITE", async () => {
    const savedResults = [];

    for (const record of records) {
      if (!isObject(record)) {
        savedResults.push({
          ok: false,
          label: "-",
          error: "검수 내역 형식이 올바르지 않습니다.",
        });
        continue;
      }

      const label = String(record.PG || record.IMEI || "-");

      try {
        const result = await saveInspectionRecord(
          prisma,
          record as Partial<InspectionRecord> & Record<string, unknown>,
          user.userId
        );
        savedResults.push({ ok: true, label, result });
      } catch (error) {
        markOperationTraceFailed(error, "INSPECTION_RECORD_SAVE_FAILED");
        savedResults.push({
          ok: false,
          label,
          error:
            error instanceof PublicError
              ? error.message
              : "검수 기록을 저장하지 못했습니다.",
        });
      }
    }

    return savedResults;
  });

  const failCount = results.filter((result) => !result.ok).length;

  return NextResponse.json({
    ok: failCount === 0,
    successCount: results.length - failCount,
    failCount,
    results,
  });
    }
  );
}
