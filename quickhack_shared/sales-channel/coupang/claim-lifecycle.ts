// QuickHack contract: shared terminal-state rules for Coupang claim lifecycles.

export const COUPANG_TERMINAL_RETURN_STATUSES = [
  "RETURNS_COMPLETED",
] as const;

export const COUPANG_TERMINAL_EXCHANGE_STATUSES = [
  "SUCCESS",
  "REJECT",
  "CANCEL",
] as const;

const TERMINAL_RETURN_STATUS_SET = new Set<string>(
  COUPANG_TERMINAL_RETURN_STATUSES
);
const TERMINAL_EXCHANGE_STATUS_SET = new Set<string>(
  COUPANG_TERMINAL_EXCHANGE_STATUSES
);

function normalizedStatus(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

export function isTerminalCoupangReturnStatus(
  value: string | null | undefined
) {
  return TERMINAL_RETURN_STATUS_SET.has(normalizedStatus(value));
}

export function isTerminalCoupangExchangeStatus(
  value: string | null | undefined
) {
  return TERMINAL_EXCHANGE_STATUS_SET.has(normalizedStatus(value));
}
