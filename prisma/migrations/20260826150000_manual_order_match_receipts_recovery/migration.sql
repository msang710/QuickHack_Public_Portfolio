ALTER TABLE "order_matching_work_queue"
  ADD COLUMN "manual_recovery_status" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN "manual_recovery_started_at" TIMESTAMPTZ(3),
  ADD COLUMN "manual_recovery_started_by_user_id" INTEGER;

ALTER TABLE "order_matching_work_queue"
  ADD CONSTRAINT "ck_order_matching_work_queue_manual_recovery"
  CHECK (
    ("manual_recovery_status" = 'NONE'
      AND "manual_recovery_started_at" IS NULL
      AND "manual_recovery_started_by_user_id" IS NULL)
    OR
    ("manual_recovery_status" = 'REASSIGNMENT_REQUIRED'
      AND "manual_recovery_started_at" IS NOT NULL
      AND "manual_recovery_started_by_user_id" IS NOT NULL)
  );

ALTER TABLE "order_matching_work_queue"
  ADD CONSTRAINT "order_matching_work_queue_manual_recovery_user_fkey"
  FOREIGN KEY ("manual_recovery_started_by_user_id") REFERENCES "users"("user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "idx_order_matching_work_queue_manual_recovery"
  ON "order_matching_work_queue"("manual_recovery_status");
CREATE INDEX "idx_order_matching_work_queue_manual_recovery_user"
  ON "order_matching_work_queue"("manual_recovery_started_by_user_id");

CREATE TABLE "manual_order_match_selection_receipts" (
  "receipt_id" UUID NOT NULL,
  "work_item_id" INTEGER NOT NULL,
  "operation" TEXT NOT NULL,
  "pg_no" TEXT NOT NULL,
  "candidate_fingerprint_hash" TEXT NOT NULL,
  "issued_to_user_id" INTEGER NOT NULL,
  "work_revision" INTEGER NOT NULL,
  "inventory_revision" INTEGER,
  "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3),
  CONSTRAINT "manual_order_match_selection_receipts_pkey" PRIMARY KEY ("receipt_id"),
  CONSTRAINT "ck_manual_order_match_receipt_operation"
    CHECK ("operation" IN ('ASSIGN', 'REPLACE')),
  CONSTRAINT "ck_manual_order_match_receipt_expiry"
    CHECK ("expires_at" > "issued_at"),
  CONSTRAINT "manual_order_match_receipt_work_item_fkey"
    FOREIGN KEY ("work_item_id") REFERENCES "order_matching_work_queue"("work_item_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "manual_order_match_receipt_user_fkey"
    FOREIGN KEY ("issued_to_user_id") REFERENCES "users"("user_id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_manual_order_match_receipts_scope"
  ON "manual_order_match_selection_receipts"("work_item_id", "operation", "pg_no");
CREATE INDEX "idx_manual_order_match_receipts_user_expiry"
  ON "manual_order_match_selection_receipts"("issued_to_user_id", "expires_at");
CREATE INDEX "idx_manual_order_match_receipts_expiry"
  ON "manual_order_match_selection_receipts"("expires_at");
