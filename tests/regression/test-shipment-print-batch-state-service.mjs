import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { transitionShipmentPrintBatchStatus } = await import(
  "@/quickhack_server/shipment/shipment-print-batch-state-service"
);

function stateClient(initialStatus) {
  let row = initialStatus
    ? { shipment_list_print_batch_id: 1, batch_status: initialStatus }
    : null;

  return {
    tx: {
      sales_channel_shipment_list_print_batches: {
        async updateMany({ where, data }) {
          const allowedStatuses = where.batch_status?.in ?? [];
          if (
            row &&
            row.shipment_list_print_batch_id ===
              where.shipment_list_print_batch_id &&
            allowedStatuses.includes(row.batch_status)
          ) {
            row = { ...row, batch_status: data.batch_status };
            return { count: 1 };
          }
          return { count: 0 };
        },
        async findUnique() {
          return row ? { batch_status: row.batch_status } : null;
        },
      },
    },
    status() {
      return row?.batch_status ?? null;
    },
  };
}

const confirmed = stateClient("PENDING");
assert.deepEqual(
  await transitionShipmentPrintBatchStatus(confirmed.tx, {
    batchId: 1,
    targetStatus: "PRINT_DIALOG_CLOSED",
    transitionedAt: "2026-08-08 10:01:00",
  }),
  { applied: true, status: "PRINT_DIALOG_CLOSED" }
);
assert.deepEqual(
  await transitionShipmentPrintBatchStatus(confirmed.tx, {
    batchId: 1,
    targetStatus: "CONFIRMED",
    transitionedAt: "2026-08-08 10:02:00",
  }),
  { applied: true, status: "CONFIRMED" }
);
assert.deepEqual(
  await transitionShipmentPrintBatchStatus(confirmed.tx, {
    batchId: 1,
    targetStatus: "CONFIRMED",
    transitionedAt: "2026-08-08 10:03:00",
  }),
  { applied: false, status: "CONFIRMED" }
);

await assert.rejects(
  () =>
    transitionShipmentPrintBatchStatus(confirmed.tx, {
      batchId: 1,
      targetStatus: "CANCELED",
      transitionedAt: "2026-08-08 10:04:00",
    }),
  (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "SHIPMENT_PRINT_BATCH_STATE_CONFLICT");
    assert.deepEqual(error.details, {
      batchId: 1,
      currentStatus: "CONFIRMED",
      requestedStatus: "CANCELED",
    });
    return true;
  }
);
assert.equal(confirmed.status(), "CONFIRMED");

const canceled = stateClient("PENDING");
assert.deepEqual(
  await transitionShipmentPrintBatchStatus(canceled.tx, {
    batchId: 1,
    targetStatus: "CANCELED",
    transitionedAt: "2026-08-08 10:01:00",
  }),
  { applied: true, status: "CANCELED" }
);
await assert.rejects(
  () =>
    transitionShipmentPrintBatchStatus(canceled.tx, {
      batchId: 1,
      targetStatus: "CONFIRMED",
      transitionedAt: "2026-08-08 10:02:00",
    }),
  (error) =>
    error.status === 409 &&
    error.code === "SHIPMENT_PRINT_BATCH_STATE_CONFLICT"
);
assert.equal(canceled.status(), "CANCELED");

const missing = stateClient(null);
await assert.rejects(
  () =>
    transitionShipmentPrintBatchStatus(missing.tx, {
      batchId: 1,
      targetStatus: "CANCELED",
      transitionedAt: "2026-08-08 10:01:00",
    }),
  (error) =>
    error.status === 404 && error.code === "SHIPMENT_PRINT_BATCH_NOT_FOUND"
);

console.log("Shipment print batch state service tests passed.");
