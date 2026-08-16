import {
  SALES_CHANNEL_WRITE_STATUS_LABELS,
  type SalesChannelWriteRequestStatus,
} from "@/quickhack_shared/sales-channel/write-requests";
import {
  SALES_CHANNEL_INVENTORY_RECHECKABLE_STATUSES,
  SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME,
  SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS,
  SALES_CHANNEL_SYNC_CHECK_KIND,
  type SalesChannelInventoryVerificationRefreshOutcome,
  type SalesChannelInventoryVerificationStatus,
  type SalesChannelSyncCheckItem,
  type SalesChannelSyncCheckQueryKind,
} from "@/quickhack_shared/sales-channel/sync-checks";

export type SalesChannelSyncCheckBadgeVariant =
  | "secondary"
  | "success"
  | "warning"
  | "danger"
  | "neutral"
  | "sky";

export type SalesChannelSyncCheckStatusOption = {
  value: string;
  label: string;
};

export const SALES_CHANNEL_SYNC_CHECK_KIND_OPTIONS: ReadonlyArray<{
  value: SalesChannelSyncCheckQueryKind;
  label: string;
}> = [
  { value: SALES_CHANNEL_SYNC_CHECK_KIND.all, label: "전체" },
  { value: SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest, label: "쓰기 결과" },
  {
    value: SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification,
    label: "재고 수량",
  },
  {
    value: SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity,
    label: "클레임 무결성",
  },
];

export const SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS_LABELS: Record<
  SalesChannelInventoryVerificationStatus,
  string
> = {
  PENDING: "점검 대기",
  CHECKING: "점검 중",
  MATCHED: "일치",
  MISMATCH: "수량 불일치",
  CHECK_FAILED: "점검 실패",
  SKIPPED: "점검 제외",
};

const GROUPED_STATUS_OPTIONS: SalesChannelSyncCheckStatusOption[] = [
  { value: "UNRESOLVED", label: "점검 필요" },
  { value: "ALL", label: "전체 상태" },
];

const WRITE_STATUS_OPTIONS: SalesChannelSyncCheckStatusOption[] = [
  { value: "PENDING", label: SALES_CHANNEL_WRITE_STATUS_LABELS.PENDING },
  { value: "SENDING", label: SALES_CHANNEL_WRITE_STATUS_LABELS.SENDING },
  { value: "VERIFYING", label: SALES_CHANNEL_WRITE_STATUS_LABELS.VERIFYING },
  {
    value: "LOCAL_PENDING",
    label: SALES_CHANNEL_WRITE_STATUS_LABELS.LOCAL_PENDING,
  },
  { value: "COMPLETED", label: SALES_CHANNEL_WRITE_STATUS_LABELS.COMPLETED },
  {
    value: "REVIEW_REQUIRED",
    label: SALES_CHANNEL_WRITE_STATUS_LABELS.REVIEW_REQUIRED,
  },
  {
    value: "NOT_APPLIED",
    label: SALES_CHANNEL_WRITE_STATUS_LABELS.NOT_APPLIED,
  },
  { value: "REJECTED", label: SALES_CHANNEL_WRITE_STATUS_LABELS.REJECTED },
];

const INVENTORY_STATUS_OPTIONS: SalesChannelSyncCheckStatusOption[] = [
  {
    value: SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS.pending,
    label: SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS_LABELS.PENDING,
  },
  {
    value: SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS.checking,
    label: SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS_LABELS.CHECKING,
  },
  {
    value: SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS.matched,
    label: SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS_LABELS.MATCHED,
  },
  {
    value: SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS.mismatch,
    label: SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS_LABELS.MISMATCH,
  },
  {
    value: SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS.checkFailed,
    label: SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS_LABELS.CHECK_FAILED,
  },
  {
    value: SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS.skipped,
    label: SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS_LABELS.SKIPPED,
  },
];

const CLAIM_INTEGRITY_STATUS_OPTIONS: SalesChannelSyncCheckStatusOption[] = [
  { value: "INVALID", label: "범위 확인 필요" },
];

const ALL_STATUS_OPTIONS: SalesChannelSyncCheckStatusOption[] = [
  { value: "PENDING", label: "대기 (쓰기·재고)" },
  ...WRITE_STATUS_OPTIONS.filter(({ value }) => value !== "PENDING"),
  { value: "CHECKING", label: "재고 점검 중" },
  { value: "MATCHED", label: "재고 일치" },
  { value: "MISMATCH", label: "재고 수량 불일치" },
  { value: "CHECK_FAILED", label: "재고 점검 실패" },
  { value: "SKIPPED", label: "재고 점검 제외" },
  { value: "INVALID", label: "클레임 범위 확인 필요" },
];

export function salesChannelSyncCheckStatusOptions(
  kind: SalesChannelSyncCheckQueryKind
) {
  if (kind === SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest) {
    return [...GROUPED_STATUS_OPTIONS, ...WRITE_STATUS_OPTIONS];
  }

  if (kind === SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification) {
    return [...GROUPED_STATUS_OPTIONS, ...INVENTORY_STATUS_OPTIONS];
  }

  if (kind === SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity) {
    return [...GROUPED_STATUS_OPTIONS, ...CLAIM_INTEGRITY_STATUS_OPTIONS];
  }

  return [...GROUPED_STATUS_OPTIONS, ...ALL_STATUS_OPTIONS];
}

export function salesChannelSyncCheckItemKey(
  item: Pick<SalesChannelSyncCheckItem, "kind" | "id">
) {
  return `${item.kind}:${item.id}`;
}

export function formatSalesChannelSyncCheckDate(value: string) {
  if (!value) return "-";
  return value.replace("T", " ").slice(0, 19);
}

export function salesChannelWriteStatusVariant(
  status: SalesChannelWriteRequestStatus
): SalesChannelSyncCheckBadgeVariant {
  if (status === "COMPLETED") return "success";
  if (status === "PARTIALLY_COMPLETED") return "warning";
  if (status === "REVIEW_REQUIRED" || status === "LOCAL_PENDING") {
    return "danger";
  }
  if (status === "SENDING" || status === "VERIFYING") return "sky";
  if (status === "NOT_APPLIED" || status === "REJECTED") return "neutral";
  return "secondary";
}

export function inventoryVerificationStatusVariant(
  status: SalesChannelInventoryVerificationStatus
): SalesChannelSyncCheckBadgeVariant {
  if (status === "MATCHED") return "success";
  if (status === "MISMATCH") return "danger";
  if (status === "CHECK_FAILED") return "warning";
  if (status === "CHECKING") return "sky";
  if (status === "SKIPPED") return "neutral";
  return "secondary";
}

export function salesChannelSyncCheckStatusLabel(item: SalesChannelSyncCheckItem) {
  if (item.kind === SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest) {
    return SALES_CHANNEL_WRITE_STATUS_LABELS[item.requestStatus] ?? item.requestStatus;
  }
  if (item.kind === SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification) {
    return (
      SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS_LABELS[
        item.verificationStatus
      ] ?? item.verificationStatus
    );
  }
  return "범위 확인 필요";
}

export function salesChannelSyncCheckStatusVariant(
  item: SalesChannelSyncCheckItem
) {
  if (item.kind === SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest) {
    return salesChannelWriteStatusVariant(item.requestStatus);
  }
  if (item.kind === SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification) {
    return inventoryVerificationStatusVariant(item.verificationStatus);
  }
  return "danger";
}

export function formatSalesChannelInventoryOption(
  matchMode: string,
  value: string
) {
  if (matchMode === "ANY") return "전체";
  if (matchMode === "RANDOM") return "무작위";
  return value || "-";
}

export function formatSalesChannelQuantity(value: number | null) {
  return value === null ? "미확인" : value.toLocaleString("ko-KR");
}

export function formatSalesChannelDifference(value: number | null) {
  if (value === null) return "미확인";
  if (value > 0) return `+${value.toLocaleString("ko-KR")}`;
  return value.toLocaleString("ko-KR");
}

export function formatSalesChannelSyncCheckResultCount(
  count: number,
  limit: number
) {
  return count >= limit
    ? `조회 결과 최대 ${limit.toLocaleString("ko-KR")}건`
    : `조회 결과 ${count.toLocaleString("ko-KR")}건`;
}

export function isInventoryVerificationRecheckable(
  status: SalesChannelInventoryVerificationStatus
) {
  return (SALES_CHANNEL_INVENTORY_RECHECKABLE_STATUSES as readonly string[])
    .includes(status);
}

export function salesChannelInventoryRecheckOutcomeMessage(
  outcome: SalesChannelInventoryVerificationRefreshOutcome
) {
  switch (outcome) {
    case SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME.matched:
      return "최신 기준으로 재고 수량이 일치해 점검 필요 상태가 해소되었습니다.";
    case SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME.mismatch:
      return "최신 기준으로 다시 점검했지만 재고 수량 차이가 남아 있습니다.";
    case SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME.checkFailed:
      return "판매 채널 재고수량을 다시 조회하지 못했습니다. 상세 오류를 확인하세요.";
    case SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME.skipped:
      return "현재 연결 조건이 점검 대상이 아니어서 재고 점검을 제외했습니다.";
    case SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME.alreadyClaimed:
      return "다른 점검이 진행 중입니다. 최신 상태를 다시 불러왔습니다.";
    case SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME.claimLost:
      return "점검 소유권이 변경되어 이전 결과를 적용하지 않았습니다.";
    default:
      return "재고 점검 결과를 갱신했습니다.";
  }
}
