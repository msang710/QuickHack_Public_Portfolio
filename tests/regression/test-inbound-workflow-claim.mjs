import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { claimInboundWorkflowState } = await import(
  "@/quickhack_server/inbound/inbound-workflow-claim-service"
);

function claimClient(initialRow) {
  let row = initialRow ? { ...initialRow } : null;
  const writes = [];

  return {
    tx: {
      inbounds: {
        async updateMany({ where, data }) {
          writes.push({ where, data });
          if (
            row &&
            row.inbound_id === where.inbound_id &&
            row.pg_no === where.pg_no &&
            row.inbound_status === where.inbound_status &&
            row.revision === where.revision
          ) {
            row = { ...row, ...data };
            return { count: 1 };
          }
          return { count: 0 };
        },
        async findFirst({ where }) {
          if (
            row &&
            row.inbound_id === where.inbound_id &&
            row.pg_no === where.pg_no
          ) {
            return {
              inbound_status: row.inbound_status,
              revision: row.revision,
            };
          }
          return null;
        },
      },
    },
    writes,
  };
}

const inspected = claimClient({
  inbound_id: 11,
  pg_no: "CL0000000001",
  inbound_status: "INSPECTED",
  revision: 3,
});
assert.deepEqual(
  await claimInboundWorkflowState(inspected.tx, {
    inboundId: 11,
    pgNo: "CL0000000001",
    expectedStatus: "INSPECTED",
    expectedRevision: 3,
  }),
  { claimed: true }
);
assert.deepEqual(inspected.writes[0].data, {
  inbound_status: "INSPECTED",
});

const purchased = claimClient({
  inbound_id: 12,
  pg_no: "CL0000000002",
  inbound_status: "PURCHASED",
  revision: 4,
});
assert.deepEqual(
  await claimInboundWorkflowState(purchased.tx, {
    inboundId: 12,
    pgNo: "CL0000000002",
    expectedStatus: "INSPECTED",
    expectedRevision: 3,
  }),
  { claimed: false, currentStatus: "PURCHASED", currentRevision: 4 }
);

const differentPg = claimClient({
  inbound_id: 13,
  pg_no: "CL0000000003",
  inbound_status: "INSPECTED",
  revision: 0,
});
assert.deepEqual(
  await claimInboundWorkflowState(differentPg.tx, {
    inboundId: 13,
    pgNo: "CL0000000099",
    expectedStatus: "INSPECTED",
    expectedRevision: 0,
  }),
  { claimed: false, currentStatus: null, currentRevision: null }
);

const missing = claimClient(null);
assert.deepEqual(
  await claimInboundWorkflowState(missing.tx, {
    inboundId: 14,
    pgNo: "CL0000000004",
    expectedStatus: "PURCHASED",
    expectedRevision: 0,
  }),
  { claimed: false, currentStatus: null, currentRevision: null }
);

console.log("Inbound workflow conditional row claims verified.");
