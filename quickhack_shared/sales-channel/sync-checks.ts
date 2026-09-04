import type {
  SalesChannelWriteRequestStatus,
  SalesChannelWriteRequestType,
} from "@/quickhack_shared/sales-channel/write-requests";

export const SALES_CHANNEL_SYNC_CHECK_KIND = {
  all: "ALL",
  writeRequest: "WRITE_REQUEST",
  inventoryVerification: "INVENTORY_VERIFICATION",
  claimIntegrity: "CLAIM_INTEGRITY",
} as const;

export type SalesChannelSyncCheckQueryKind =
  (typeof SALES_CHANNEL_SYNC_CHECK_KIND)[keyof typeof SALES_CHANNEL_SYNC_CHECK_KIND];

export type SalesChannelSyncCheckItemKind = Exclude<
  SalesChannelSyncCheckQueryKind,
  "ALL"
>;

export const SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS = {
  pending: "PENDING",
  checking: "CHECKING",
  matched: "MATCHED",
  mismatch: "MISMATCH",
  checkFailed: "CHECK_FAILED",
  skipped: "SKIPPED",
} as const;

export type SalesChannelInventoryVerificationStatus =
  (typeof SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS)[keyof typeof SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS];

export const SALES_CHANNEL_INVENTORY_RECHECKABLE_STATUSES = [
  SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS.mismatch,
  SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS.checkFailed,
] as const;

export const SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME = {
  matched: "MATCHED",
  mismatch: "MISMATCH",
  checkFailed: "CHECK_FAILED",
  skipped: "SKIPPED",
  alreadyClaimed: "ALREADY_CLAIMED",
  claimLost: "CLAIM_LOST",
} as const;

export type SalesChannelInventoryVerificationRefreshOutcome =
  (typeof SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME)[keyof typeof SALES_CHANNEL_INVENTORY_VERIFICATION_REFRESH_OUTCOME];

export type SalesChannelWriteReviewTargetDto = {
  id: number;
  resolutionGroupKey: string;
  resolutionGroupRepresentativeTargetId: number;
  resolutionGroupTargetCount: number;
  targetPosition: number;
  targetType: string;
  targetExternalId: string;
  allocationId: number | null;
  pgNo: string;
  externalOrderId: string;
  externalShipmentId: string;
  externalVendorItemId: string;
  quantity: number | null;
  inventoryVerificationStateId: number | null;
  inventoryDesiredVersionSnapshot: number | null;
  inventoryMismatchSinceSnapshot: string;
  inventoryProjectionBasisHashSnapshot: string;
  inventoryLedgerQuantitySnapshot: number | null;
  inventoryPendingOrderQuantitySnapshot: number | null;
  inventoryExpectedChannelQuantitySnapshot: number | null;
  inventoryObservedChannelQuantitySnapshot: number | null;
  inspectionResult: string;
  externalResultStatus: string;
  externalResultCode: string;
  externalResultMessage: string;
  retryRequired: boolean | null;
  resultReceivedAt: string;
  localFinalizationStatus: string;
  localFinalizedAt: string;
};

export type SalesChannelWriteReviewAttemptDto = {
  id: number;
  attemptNo: number;
  attemptType: string;
  attemptStatus: string;
  triggerType: string;
  httpStatusCode: number | null;
  externalResponseCode: string;
  errorCode: string;
  errorMessage: string;
  externalAppliedUnknown: boolean;
  startedAt: string;
  completedAt: string;
};

export type SalesChannelWriteReviewItemDto = {
  id: number;
  channel: string;
  requestType: SalesChannelWriteRequestType;
  requestStatus: SalesChannelWriteRequestStatus;
  reviewOperationInProgress: boolean;
  activeReviewOperation: string;
  activeReviewStartedAt: string;
  failureStage: string;
  externalOrderId: string;
  targetType: string;
  targetExternalId: string;
  sourceMenuKey: string;
  sourceEntityType: string;
  sourceEntityId: string;
  expectedBeforeStatus: string;
  requestedAfterStatus: string;
  errorCode: string;
  errorMessage: string;
  requestedAt: string;
  completedAt: string;
  reviewRequiredAt: string;
  manualVerificationStatus: string;
  manualVerificationNote: string;
  requestedBy: string;
  manualVerifiedBy: string;
  targets: SalesChannelWriteReviewTargetDto[];
  attempts: SalesChannelWriteReviewAttemptDto[];
};

export type SalesChannelWriteControlDto = {
  id: number;
  revision: number;
  channel: string;
  endpointKey: string;
  requestType: string;
  isPaused: boolean;
  consecutiveFailureCount: number;
  pauseReason: string;
  lastFailureMessage: string;
  lastFailureAt: string;
  pausedAt: string;
};

export type SalesChannelWriteReviewResponseDto = {
  ok: true;
  unresolvedCount: number;
  controls: SalesChannelWriteControlDto[];
  items: SalesChannelWriteReviewItemDto[];
};

export type SalesChannelWriteSyncCheckItem =
  SalesChannelWriteReviewItemDto & {
    kind: "WRITE_REQUEST";
    status: SalesChannelWriteRequestStatus;
    updatedAt: string;
  };

export type SalesChannelInventoryVerificationSyncCheckItem = {
  kind: "INVENTORY_VERIFICATION";
  id: number;
  verificationStateId: number;
  mappingId: number;
  channel: string;
  status: SalesChannelInventoryVerificationStatus;
  verificationStatus: SalesChannelInventoryVerificationStatus;
  updatedAt: string;
  externalProductId: string;
  externalVendorItemId: string;
  externalOptionName: string;
  salesOfferId: number | null;
  offerCode: string;
  model: string;
  storageMatchMode: string;
  storage: string;
  colorMatchMode: string;
  color: string;
  warranty: string;
  desiredVersion: number;
  processingVersion: number | null;
  ledgerQuantity: number;
  pendingOrderQuantity: number;
  expectedChannelQuantity: number;
  channelQuantity: number | null;
  difference: number | null;
  retryCount: number;
  mismatchSince: string;
  lastCheckedAt: string;
  resolvedAt: string;
  lastErrorCode: string;
  lastErrorMessage: string;
  lastApiCallLogId: number | null;
  lastWorkerJobId: number | null;
};

export type SalesChannelClaimIntegritySyncCheckItem = {
  kind: "CLAIM_INTEGRITY";
  id: number;
  status: "INVALID";
  updatedAt: string;
  claimType: "RETURN" | "EXCHANGE";
  externalClaimId: string;
  externalOrderId: string;
  externalShipmentId: string;
  integrityStatus: string;
  messageCode: "RETURN_ITEM_QUANTITY_MISMATCH" | "EXCHANGE_ORIGINAL_SHIPMENT_UNKNOWN";
};

export type SalesChannelSyncCheckItem =
  | SalesChannelWriteSyncCheckItem
  | SalesChannelInventoryVerificationSyncCheckItem
  | SalesChannelClaimIntegritySyncCheckItem;

export type SalesChannelSyncCheckListResponseDto = {
  ok: true;
  count: number;
  totalCount: number;
  limit: number;
  unresolvedCount: number;
  unresolvedCounts: {
    writeRequest: number;
    inventoryVerification: number;
    claimIntegrity: number;
  };
  controls: SalesChannelWriteControlDto[];
  items: SalesChannelSyncCheckItem[];
  hasMore: boolean;
  nextCursor: string | null;
  coverage: "COMPLETE" | "PARTIAL";
};

export type SalesChannelInventoryRecheckResponseDto = {
  ok: true;
  outcome: SalesChannelInventoryVerificationRefreshOutcome;
  item: SalesChannelInventoryVerificationSyncCheckItem;
};

export const SALES_CHANNEL_INVENTORY_REPAIR_OUTCOME = {
  repaired: "REPAIRED",
} as const;

export type SalesChannelInventoryRepairOutcome =
  (typeof SALES_CHANNEL_INVENTORY_REPAIR_OUTCOME)[keyof typeof SALES_CHANNEL_INVENTORY_REPAIR_OUTCOME];

export type SalesChannelInventoryRepairResponseDto = {
  ok: true;
  outcome: SalesChannelInventoryRepairOutcome;
  writeRequestId: number;
  item: SalesChannelInventoryVerificationSyncCheckItem;
};

export type SalesChannelInventoryRepairFailureDetails = {
  writeRequestId?: number;
  latestItem?: SalesChannelInventoryVerificationSyncCheckItem;
};
