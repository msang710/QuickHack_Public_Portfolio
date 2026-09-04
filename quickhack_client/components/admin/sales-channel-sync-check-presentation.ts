import type { SalesChannelWriteRequestStatus } from "@/quickhack_shared/sales-channel/write-requests";
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
  labelKey: SalesChannelSyncCheckStatusLabelKey;
};

export type SalesChannelSyncCheckStatusLabelKey =
  | "unresolved" | "all" | "combinedPending"
  | "inventoryChecking" | "inventoryMatched" | "inventoryMismatch"
  | "inventoryCheckFailed" | "inventorySkipped"
  | "claimInvalid" | "claimInvalidLong"
  | `write.${"pending" | "sending" | "verifying" | "localPending" | "completed" | "partiallyCompleted" | "reviewRequired" | "notApplied" | "rejected"}`
  | `inventory.${"pending" | "checking" | "matched" | "mismatch" | "checkFailed" | "skipped"}`;

export const SALES_CHANNEL_SYNC_CHECK_KIND_OPTIONS: ReadonlyArray<{
  value: SalesChannelSyncCheckQueryKind;
  labelKey: "all" | "writeRequest" | "inventoryVerification" | "claimIntegrity";
}> = [
  { value: SALES_CHANNEL_SYNC_CHECK_KIND.all, labelKey: "all" },
  { value: SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest, labelKey: "writeRequest" },
  { value: SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification, labelKey: "inventoryVerification" },
  { value: SALES_CHANNEL_SYNC_CHECK_KIND.claimIntegrity, labelKey: "claimIntegrity" },
];

const WRITE_STATUS_KEY = {
  PENDING: "pending", SENDING: "sending", VERIFYING: "verifying",
  LOCAL_PENDING: "localPending", COMPLETED: "completed",
  PARTIALLY_COMPLETED: "partiallyCompleted", REVIEW_REQUIRED: "reviewRequired",
  NOT_APPLIED: "notApplied", REJECTED: "rejected",
} as const satisfies Record<SalesChannelWriteRequestStatus, string>;

const INVENTORY_STATUS_KEY = {
  PENDING: "pending", CHECKING: "checking", MATCHED: "matched",
  MISMATCH: "mismatch", CHECK_FAILED: "checkFailed", SKIPPED: "skipped",
} as const satisfies Record<SalesChannelInventoryVerificationStatus, string>;

const GROUPED_STATUS_OPTIONS: SalesChannelSyncCheckStatusOption[] = [
  { value: "UNRESOLVED", labelKey: "unresolved" },
  { value: "ALL", labelKey: "all" },
];

const WRITE_STATUS_OPTIONS: SalesChannelSyncCheckStatusOption[] = [
  "PENDING", "SENDING", "VERIFYING", "LOCAL_PENDING", "COMPLETED",
  "REVIEW_REQUIRED", "NOT_APPLIED", "REJECTED",
].map((value) => ({
  value,
  labelKey: `write.${WRITE_STATUS_KEY[value as SalesChannelWriteRequestStatus]}` as SalesChannelSyncCheckStatusLabelKey,
}));

const INVENTORY_STATUS_OPTIONS: SalesChannelSyncCheckStatusOption[] = (
  Object.values(SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS)
).map((value) => ({ value, labelKey: `inventory.${INVENTORY_STATUS_KEY[value]}` as SalesChannelSyncCheckStatusLabelKey }));

const CLAIM_INTEGRITY_STATUS_OPTIONS: SalesChannelSyncCheckStatusOption[] = [
  { value: "INVALID", labelKey: "claimInvalid" },
];

const ALL_STATUS_OPTIONS: SalesChannelSyncCheckStatusOption[] = [
  { value: "PENDING", labelKey: "combinedPending" },
  ...WRITE_STATUS_OPTIONS.filter(({ value }) => value !== "PENDING"),
  { value: "CHECKING", labelKey: "inventoryChecking" },
  { value: "MATCHED", labelKey: "inventoryMatched" },
  { value: "MISMATCH", labelKey: "inventoryMismatch" },
  { value: "CHECK_FAILED", labelKey: "inventoryCheckFailed" },
  { value: "SKIPPED", labelKey: "inventorySkipped" },
  { value: "INVALID", labelKey: "claimInvalidLong" },
];

export function salesChannelSyncCheckStatusOptions(kind: SalesChannelSyncCheckQueryKind) {
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

export function salesChannelSyncCheckItemKey(item: Pick<SalesChannelSyncCheckItem, "kind" | "id">) {
  return `${item.kind}:${item.id}`;
}

export function formatSalesChannelSyncCheckDate(value: string) {
  if (!value) return "-";
  return value.replace("T", " ").slice(0, 19);
}

export function salesChannelWriteStatusVariant(status: SalesChannelWriteRequestStatus): SalesChannelSyncCheckBadgeVariant {
  if (status === "COMPLETED") return "success";
  if (status === "PARTIALLY_COMPLETED") return "warning";
  if (status === "REVIEW_REQUIRED" || status === "LOCAL_PENDING") return "danger";
  if (status === "SENDING" || status === "VERIFYING") return "sky";
  if (status === "NOT_APPLIED" || status === "REJECTED") return "neutral";
  return "secondary";
}

export function inventoryVerificationStatusVariant(status: SalesChannelInventoryVerificationStatus): SalesChannelSyncCheckBadgeVariant {
  if (status === "MATCHED") return "success";
  if (status === "MISMATCH") return "danger";
  if (status === "CHECK_FAILED") return "warning";
  if (status === "CHECKING") return "sky";
  if (status === "SKIPPED") return "neutral";
  return "secondary";
}

export function salesChannelSyncCheckStatusKey(item: SalesChannelSyncCheckItem): SalesChannelSyncCheckStatusLabelKey {
  if (item.kind === SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest) {
    return `write.${WRITE_STATUS_KEY[item.requestStatus]}`;
  }
  if (item.kind === SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification) {
    return `inventory.${INVENTORY_STATUS_KEY[item.verificationStatus]}`;
  }
  return "claimInvalid";
}

export function salesChannelSyncCheckStatusVariant(item: SalesChannelSyncCheckItem) {
  if (item.kind === SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest) return salesChannelWriteStatusVariant(item.requestStatus);
  if (item.kind === SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification) return inventoryVerificationStatusVariant(item.verificationStatus);
  return "danger";
}

type SalesChannelFormattingOptions = {
  locale: string;
  unknownLabel: string;
  anyLabel?: string;
  randomLabel?: string;
};

export function formatSalesChannelInventoryOption(matchMode: string, value: string, options: SalesChannelFormattingOptions) {
  if (matchMode === "ANY") return options.anyLabel ?? "-";
  if (matchMode === "RANDOM") return options.randomLabel ?? "-";
  return value || "-";
}

export function formatSalesChannelQuantity(value: number | null, options: SalesChannelFormattingOptions) {
  return value === null ? options.unknownLabel : value.toLocaleString(options.locale);
}

export function formatSalesChannelDifference(value: number | null, options: SalesChannelFormattingOptions) {
  if (value === null) return options.unknownLabel;
  if (value > 0) return `+${value.toLocaleString(options.locale)}`;
  return value.toLocaleString(options.locale);
}

export function isInventoryVerificationRecheckable(status: SalesChannelInventoryVerificationStatus) {
  return (SALES_CHANNEL_INVENTORY_RECHECKABLE_STATUSES as readonly string[]).includes(status);
}

export function salesChannelInventoryRecheckOutcomeKey(outcome: SalesChannelInventoryVerificationRefreshOutcome) {
  switch (outcome) {
    case SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME.matched: return "matched";
    case SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME.mismatch: return "mismatch";
    case SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME.checkFailed: return "checkFailed";
    case SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME.skipped: return "skipped";
    case SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME.alreadyClaimed: return "alreadyClaimed";
    case SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME.claimLost: return "claimLost";
    default: return "updated";
  }
}
