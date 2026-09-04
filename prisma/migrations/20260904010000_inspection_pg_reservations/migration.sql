CREATE TABLE "inspection_pg_reservations" (
    "inspection_pg_reservation_id" UUID NOT NULL,
    "client_record_id" TEXT NOT NULL,
    "pg_no" TEXT NOT NULL,
    "inspection_kind" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "issued_by_user_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "abandoned_at" TIMESTAMPTZ(3),
    "result_payload" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inspection_pg_reservations_pkey" PRIMARY KEY ("inspection_pg_reservation_id"),
    CONSTRAINT "ck_inspection_pg_reservations_kind" CHECK ("inspection_kind" IN ('appearance', 'function')),
    CONSTRAINT "ck_inspection_pg_reservations_status" CHECK ("status" IN ('RESERVED', 'CONSUMED', 'ABANDONED')),
    CONSTRAINT "ck_inspection_pg_reservations_lifecycle" CHECK (
      ("status" = 'RESERVED' AND "consumed_at" IS NULL AND "abandoned_at" IS NULL AND "result_payload" IS NULL)
      OR ("status" = 'CONSUMED' AND "consumed_at" IS NOT NULL AND "abandoned_at" IS NULL AND "result_payload" IS NOT NULL)
      OR ("status" = 'ABANDONED' AND "consumed_at" IS NULL AND "abandoned_at" IS NOT NULL AND "result_payload" IS NULL)
    )
);

CREATE UNIQUE INDEX "uq_inspection_pg_reservations_client_record" ON "inspection_pg_reservations"("client_record_id");
CREATE UNIQUE INDEX "uq_inspection_pg_reservations_pg_no" ON "inspection_pg_reservations"("pg_no");
CREATE INDEX "idx_inspection_pg_reservations_status_expiry" ON "inspection_pg_reservations"("status", "expires_at");
CREATE INDEX "idx_inspection_pg_reservations_issued_by" ON "inspection_pg_reservations"("issued_by_user_id");
CREATE INDEX "idx_inspection_pg_reservations_created_at" ON "inspection_pg_reservations"("created_at");

ALTER TABLE "inspection_pg_reservations"
  ADD CONSTRAINT "inspection_pg_reservations_issued_by_user_id_fkey"
  FOREIGN KEY ("issued_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
