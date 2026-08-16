export const PURCHASE_CONFIRM_RESULT_MODES = [
  "CONFIRMED",
  "RECOVERED",
  "SKIPPED",
  "CONFLICT",
] as const;

export type PurchaseConfirmResultMode =
  (typeof PURCHASE_CONFIRM_RESULT_MODES)[number];

export type PurchaseConfirmResultDto = {
  mode: PurchaseConfirmResultMode;
  pgNo: string;
  reason?: string;
};

export type PurchaseConfirmResultReconciliation = {
  complete: boolean;
  results: PurchaseConfirmResultDto[];
  completedPgNos: Set<string>;
  conflicts: PurchaseConfirmResultDto[];
};

const PURCHASE_CONFIRM_RESULT_MODE_SET = new Set<string>(
  PURCHASE_CONFIRM_RESULT_MODES
);

export function reconcilePurchaseConfirmResults(
  requestedPgNos: readonly string[],
  value: unknown
): PurchaseConfirmResultReconciliation {
  const requested = new Set(requestedPgNos);
  if (
    requested.size !== requestedPgNos.length ||
    !Array.isArray(value) ||
    value.length !== requestedPgNos.length
  ) {
    return {
      complete: false,
      results: [],
      completedPgNos: new Set(),
      conflicts: [],
    };
  }

  const seen = new Set<string>();
  const results: PurchaseConfirmResultDto[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { complete: false, results: [], completedPgNos: new Set(), conflicts: [] };
    }
    const row = raw as Record<string, unknown>;
    const pgNo = typeof row.pgNo === "string" ? row.pgNo : "";
    const mode = typeof row.mode === "string" ? row.mode : "";
    if (
      !requested.has(pgNo) ||
      seen.has(pgNo) ||
      !PURCHASE_CONFIRM_RESULT_MODE_SET.has(mode)
    ) {
      return { complete: false, results: [], completedPgNos: new Set(), conflicts: [] };
    }
    seen.add(pgNo);
    results.push({
      pgNo,
      mode: mode as PurchaseConfirmResultMode,
      reason: typeof row.reason === "string" ? row.reason : undefined,
    });
  }

  const conflicts = results.filter((item) => item.mode === "CONFLICT");
  return {
    complete: true,
    results,
    completedPgNos: new Set(
      results.filter((item) => item.mode !== "CONFLICT").map((item) => item.pgNo)
    ),
    conflicts,
  };
}
