// QuickHack note: 판매 채널별 주문 재고 매칭을 하나의 worker 진입점에서 실행합니다.
import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { nowKstSqlDateTime } from "@/quickhack_shared/core/time";
import {
  assertWorkerLeaseActive,
  requireOwnedWorkerLease,
  throwIfWorkerLeaseAborted,
} from "@/quickhack_server/workers/lease-guard";
import type {
  OwnedWorkerLeaseGuard,
  WorkerLeaseGuard,
} from "@/quickhack_server/workers/types";

type OrderInventoryMatchingInput = Record<string, unknown>;

type ChannelMatchingResult = {
  summary?: Record<string, unknown>;
  items?: unknown[];
};

type ChannelMatcher = {
  channel: string;
  run: (
    input: OrderInventoryMatchingInput,
    user: AuthUser | null,
    workerLease: OwnedWorkerLeaseGuard
  ) => Promise<ChannelMatchingResult>;
};

function nullableText(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function summaryNumber(summary: Record<string, unknown> | undefined, key: string) {
  const value = summary?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function runCoupangOrderMatcher(
  input: OrderInventoryMatchingInput,
  user: AuthUser | null,
  workerLease: OwnedWorkerLeaseGuard
) {
  const { matchCoupangOrders } = await import(
    "@/quickhack_server/sales-channel/coupang/order-matching-service"
  );

  return matchCoupangOrders(input, user, workerLease);
}

const channelMatchers: ChannelMatcher[] = [
  {
    channel: "COUPANG",
    run: runCoupangOrderMatcher,
  },
];

// QuickHack object: 등록된 판매 채널 matcher를 순서대로 실행해 주문 재고 매칭 결과를 합산합니다.
export async function matchOrderInventory(
  input: OrderInventoryMatchingInput = {},
  user: AuthUser | null = null,
  workerLease?: WorkerLeaseGuard
) {
  const ownedWorkerLease = requireOwnedWorkerLease(workerLease);
  const startedAt = nowKstSqlDateTime();
  const requestedChannel = nullableText(input.channel)?.toUpperCase() ?? null;
  const selectedMatchers = requestedChannel
    ? channelMatchers.filter((matcher) => matcher.channel === requestedChannel)
    : channelMatchers;

  if (selectedMatchers.length === 0) {
    throw new Error(`지원하지 않는 주문 매칭 채널입니다: ${requestedChannel}`);
  }

  const channelResults = [];

  for (const matcher of selectedMatchers) {
    await assertWorkerLeaseActive(ownedWorkerLease);
    const result = await matcher.run(input, user, ownedWorkerLease);
    throwIfWorkerLeaseAborted(ownedWorkerLease);

    channelResults.push({
      channel: matcher.channel,
      summary: result.summary ?? {},
      itemCount: Array.isArray(result.items) ? result.items.length : 0,
    });
  }

  const finishedAt = nowKstSqlDateTime();
  const summary = {
    startedAt,
    finishedAt,
    channelCount: channelResults.length,
    channels: channelResults.map((result) => result.channel),
    processedItemCount: channelResults.reduce(
      (sum, result) => sum + summaryNumber(result.summary, "processedItemCount"),
      0
    ),
    matchedDeviceCount: channelResults.reduce(
      (sum, result) => sum + summaryNumber(result.summary, "matchedDeviceCount"),
      0
    ),
    fullyMatchedItemCount: channelResults.reduce(
      (sum, result) => sum + summaryNumber(result.summary, "fullyMatchedItemCount"),
      0
    ),
    partialItemCount: channelResults.reduce(
      (sum, result) => sum + summaryNumber(result.summary, "partialItemCount"),
      0
    ),
    failedItemCount: channelResults.reduce(
      (sum, result) => sum + summaryNumber(result.summary, "failedItemCount"),
      0
    ),
    skippedItemCount: channelResults.reduce(
      (sum, result) => sum + summaryNumber(result.summary, "skippedItemCount"),
      0
    ),
    conflictCount: channelResults.reduce(
      (sum, result) => sum + summaryNumber(result.summary, "conflictCount"),
      0
    ),
  };

  return {
    summary,
    channels: channelResults,
  };
}
