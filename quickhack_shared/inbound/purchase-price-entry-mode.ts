// QuickHack object: 매입 확정가가 기준 매입가와 어떤 관계로 입력됐는지 보존하는 코드입니다.
export const PURCHASE_PRICE_ENTRY_MODE = {
  rate: "RATE",
  override: "OVERRIDE",
  manual: "MANUAL",
} as const;

export type PurchasePriceEntryMode =
  (typeof PURCHASE_PRICE_ENTRY_MODE)[keyof typeof PURCHASE_PRICE_ENTRY_MODE];
