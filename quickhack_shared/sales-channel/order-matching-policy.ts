// QuickHack note: 주문 매칭 운영 정책과 판매 오퍼별 우선순위 설정 타입을 공유합니다.

export const ORDER_MATCHING_CANDIDATE_SORT_MODES = [
  "SALE_GRADE_THEN_STOCKED_OLD",
  "SALE_GRADE_THEN_STOCKED_RECENT",
  "STOCKED_OLD_THEN_SALE_GRADE",
  "STOCKED_RECENT_THEN_SALE_GRADE",
] as const;

export const ORDER_MATCHING_SALE_GRADE_VALUES = ["A", "A-", "B+", "B"] as const;

export type OrderMatchingCandidateSortMode =
  (typeof ORDER_MATCHING_CANDIDATE_SORT_MODES)[number];

export type OrderMatchingSaleGradeValue =
  (typeof ORDER_MATCHING_SALE_GRADE_VALUES)[number];

export type OrderMatchingPriorityTierDto = {
  tierId?: number;
  priorityOrder: number;
  saleGradeValues: string[];
  isEnabled: boolean;
};

export type OrderMatchingPolicyDto = {
  policyId: number | null;
  salesOfferId: number | null;
  policyName: string | null;
  autoMatchEnabled: boolean;
  candidateSortMode: OrderMatchingCandidateSortMode;
  gradeFallbackEnabled: boolean;
  isActive: boolean;
  version: number;
  source: "DEFAULT" | "SAVED";
  tiers: OrderMatchingPriorityTierDto[];
  updatedAt: string | null;
};

export type OrderMatchingPolicyExpectedState = {
  expectedPolicyId: number | null;
  expectedVersion: number;
};

export type SaveOrderMatchingPolicyRequest =
  OrderMatchingPolicyExpectedState & {
    action: "saveSalesOfferPolicy";
    salesOfferId: number;
    policyName: string | null;
    autoMatchEnabled: boolean;
    candidateSortMode: OrderMatchingCandidateSortMode;
    gradeFallbackEnabled: boolean;
    tiers: OrderMatchingPriorityTierDto[];
  };

export type ResetOrderMatchingPolicyRequest = {
  action: "resetSalesOfferPolicy";
  salesOfferId: number;
  expectedPolicyId: number;
  expectedVersion: number;
};

export type OrderMatchingPolicyMutationRequest =
  | SaveOrderMatchingPolicyRequest
  | ResetOrderMatchingPolicyRequest;

export type OrderMatchingSalesOfferPolicyRow = {
  salesOfferId: number;
  offerCode: string;
  model: string;
  requiredStorage: string | null;
  requiredColor: string | null;
  requiredWarrantyGroup: string | null;
  requiredWarrantyLabel: string | null;
  isActive: boolean;
  channelNames: string[];
  mappedVendorItemCount: number;
  orderItemCount: number;
  policy: OrderMatchingPolicyDto;
};

export type OrderMatchingPoliciesPayload = {
  rows: OrderMatchingSalesOfferPolicyRow[];
};

export const ORDER_MATCHING_DEFAULT_POLICY_VALUES = {
  autoMatchEnabled: true,
  candidateSortMode: "SALE_GRADE_THEN_STOCKED_OLD",
  gradeFallbackEnabled: true,
} as const;
