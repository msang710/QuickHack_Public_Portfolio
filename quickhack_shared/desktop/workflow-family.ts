export type WorkflowFamily =
  | "INSPECTION"
  | "INVENTORY"
  | "SHIPMENT"
  | "RETURNS"
  | "MANUAL_MATCHING"
  | "ACCOUNT";

export function menuWorkflowFamily(menuId: string): WorkflowFamily | null {
  if (menuId.startsWith("inbound-")) return "INSPECTION";
  if (menuId.startsWith("inventory-")) return "INVENTORY";
  if (menuId.startsWith("shipment-") || menuId.startsWith("invoice-"))
    return "SHIPMENT";
  if (menuId.startsWith("return-")) return "RETURNS";
  if (menuId === "channel-manual-order-match") return "MANUAL_MATCHING";
  if (menuId === "personal-settings") return "ACCOUNT";
  return null;
}
