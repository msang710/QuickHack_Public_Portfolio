CREATE TABLE "manual_order_match_intent_leases" (
  "lease_id" UUID NOT NULL,
  "external_order_id" TEXT NOT NULL,
  "external_shipment_id" TEXT NOT NULL,
  "pg_nos" TEXT[] NOT NULL,
  "command_key" TEXT NOT NULL,
  "owner_user_id" INTEGER NOT NULL,
  "lease_status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "acquired_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "released_at" TIMESTAMPTZ(3),

  CONSTRAINT "manual_order_match_intent_leases_pkey" PRIMARY KEY ("lease_id"),
  CONSTRAINT "ck_manual_match_intent_status" CHECK ("lease_status" IN ('ACTIVE', 'RELEASED', 'EXPIRED')),
  CONSTRAINT "ck_manual_match_intent_expiry" CHECK ("expires_at" > "acquired_at"),
  CONSTRAINT "manual_order_match_intent_leases_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_manual_match_intent_shipment_active"
  ON "manual_order_match_intent_leases" ("external_order_id", "external_shipment_id", "lease_status", "expires_at");
CREATE INDEX "idx_manual_match_intent_owner_active"
  ON "manual_order_match_intent_leases" ("owner_user_id", "lease_status", "expires_at");
CREATE INDEX "idx_manual_match_intent_expiry"
  ON "manual_order_match_intent_leases" ("expires_at");
CREATE INDEX "idx_manual_match_intent_pg_nos"
  ON "manual_order_match_intent_leases" USING GIN ("pg_nos");
