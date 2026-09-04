export const I18N_NAMESPACE_OWNERS = {
  common: ["quickhack_client/components/ui", "quickhack_client/components/shared"],
  auth: ["quickhack_client/components/auth"],
  navigation: ["quickhack_client/components/app-shell/device-workspace-menu.ts"],
  settings: ["quickhack_client/components/user", "quickhack_client/components/desktop/desktop-appearance-settings.tsx"],
  inbound: ["quickhack_client/components/inbound"],
  inspection: ["quickhack_client/components/inspection"],
  inventory: ["quickhack_client/components/inventory"],
  shipment: ["quickhack_client/components/shipment"],
  returns: ["quickhack_client/components/returns"],
  invoice: ["quickhack_client/components/invoice"],
  catalog: ["quickhack_client/components/catalog"],
  salesChannel: ["quickhack_client/components/sales-channel"],
  supplies: ["quickhack_client/components/supplies"],
  statistics: ["quickhack_client/components/statistics"],
  administration: ["quickhack_client/components/admin", "quickhack_client/components/security"],
  developer: ["quickhack_client/components/developer"],
  desktop: ["quickhack_client/components/desktop"],
} as const;

export type I18nNamespace = keyof typeof I18N_NAMESPACE_OWNERS;

export const I18N_EXCLUDED_CONTENT = [
  "operator-authored-free-text",
  "invoice-label-csv-output",
  "external-provider-payload",
  "business-identifiers-and-records",
] as const;

/**
 * Raw text is allowed only at these ownership boundaries. The application must
 * not reuse a preserved snapshot as generic UI feedback; authored UI chrome
 * and public API failures still use catalog keys or semantic codes.
 */
export const I18N_RAW_CONTENT_BOUNDARIES = {
  "operator-authored-free-text": {
    presentation: "verbatim-record",
    examples: ["reason notes", "audit notes", "employee activity details"],
  },
  "invoice-label-csv-output": {
    presentation: "protocol-owned",
    examples: ["carrier labels", "invoice files", "CSV exports"],
  },
  "external-provider-payload": {
    presentation: "diagnostic-snapshot",
    examples: ["Coupang responses", "Logen responses", "mock provider surfaces"],
  },
  "business-identifiers-and-records": {
    presentation: "verbatim-record",
    examples: ["PG", "IMEI", "inventory locations", "historical status snapshots"],
  },
} as const;
