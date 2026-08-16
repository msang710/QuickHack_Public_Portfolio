// QuickHack note: 쿠팡 쓰기 API 차단 여부와 safe mode 상태 메시지를 제공합니다.
import { getCoupangRuntimeConfig } from "@/quickhack_server/sales-channel/coupang/config";
import {
  getMockOrdersheets,
  getMockReturnRequests,
} from "@/quickhack_server/sales-channel/coupang/mock-client";

const WATCHED_ID_KEYS = new Set([
  "orderId",
  "shipmentBoxId",
  "vendorItemId",
  "receiptId",
]);

function collectWatchedIdTypes(
  value: unknown,
  path = "$",
  results: Array<{ path: string; type: string; valuePreview: string }> = []
) {
  if (!value || typeof value !== "object") {
    return results;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectWatchedIdTypes(item, `${path}[${index}]`, results);
    });
    return results;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;

    if (WATCHED_ID_KEYS.has(key)) {
      results.push({
        path: childPath,
        type: typeof child,
        valuePreview: String(child).slice(0, 24),
      });
    }

    collectWatchedIdTypes(child, childPath, results);
  }

  return results;
}

export async function getCoupangSafeModeStatus() {
  const config = getCoupangRuntimeConfig();
  const mockServerChecks = [];

  try {
    const ordersheets = await getMockOrdersheets({ status: "INSTRUCT" });
    mockServerChecks.push({
      name: "ordersheets",
      ok: true,
      source: ordersheets.source,
      idTypes: collectWatchedIdTypes(ordersheets.payload),
    });
  } catch (error) {
    mockServerChecks.push({
      name: "ordersheets",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const returnRequests = await getMockReturnRequests({ status: "RU" });
    mockServerChecks.push({
      name: "returnRequests",
      ok: true,
      source: returnRequests.source,
      idTypes: collectWatchedIdTypes(returnRequests.payload),
    });
  } catch (error) {
    mockServerChecks.push({
      name: "returnRequests",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    config,
    mockServerChecks,
    nextRecommendedStep:
      config.mode === "mock"
        ? "별도 mock 서버로 주문/반품 동기화 파서를 먼저 검증합니다."
        : "운영 GET 호출은 짧은 시간 범위와 읽기 전용으로만 실행합니다.",
  };
}
