export const CARRIER_INVOICE_STATUS = {
  allocated: "ALLOCATED",
  registered: "REGISTERED",
  replaced: "REPLACED",
  voidLocal: "VOID_LOCAL",
} as const;

export type CarrierInvoiceStatus =
  (typeof CARRIER_INVOICE_STATUS)[keyof typeof CARRIER_INVOICE_STATUS];
