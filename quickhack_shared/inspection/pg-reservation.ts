export const INSPECTION_PG_RESERVATION_STATUS = {
  reserved: "RESERVED",
  consumed: "CONSUMED",
  abandoned: "ABANDONED",
} as const;

export type InspectionPgReservationStatus =
  (typeof INSPECTION_PG_RESERVATION_STATUS)[keyof typeof INSPECTION_PG_RESERVATION_STATUS];

export type InspectionPgReservationResult = {
  clientRecordId: string;
  pgNo: string;
  status: InspectionPgReservationStatus;
  expiresAt: string;
  replayed: boolean;
};
