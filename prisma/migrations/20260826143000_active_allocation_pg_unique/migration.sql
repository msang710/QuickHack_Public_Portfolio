DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM match_worker_allocation
    WHERE allocation_status IN ('ALLOCATED', 'API_ACKED', 'SHIPMENT_LIST_PRINTED')
    GROUP BY pg_no
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Active allocation duplicates must be repaired before applying uq_match_worker_allocation_active_pg';
  END IF;
END $$;

CREATE UNIQUE INDEX "uq_match_worker_allocation_active_pg"
  ON "match_worker_allocation" ("pg_no")
  WHERE "allocation_status" IN ('ALLOCATED', 'API_ACKED', 'SHIPMENT_LIST_PRINTED');
