export const DESKTOP_NOTIFICATION_KIND = {
  inspectionComplete: "INSPECTION_COMPLETE",
  shipmentAddressChange: "SHIPMENT_ADDRESS_CHANGE",
  returnRequest: "RETURN_REQUEST",
} as const;

export type DesktopNotificationKind =
  (typeof DESKTOP_NOTIFICATION_KIND)[keyof typeof DESKTOP_NOTIFICATION_KIND];

export type DesktopNotificationPresentation = {
  presentationId: string;
  recipientIds: string[];
  count: number;
  eventKind: DesktopNotificationKind;
  menuId: string;
  title: string;
  body: string;
  occurredAt: string;
  readAt: string | null;
  resolvedAt: string | null;
};

export const DESKTOP_NOTIFICATION_PAGE_LIMIT = 50;
