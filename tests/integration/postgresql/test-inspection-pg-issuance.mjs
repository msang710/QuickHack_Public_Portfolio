import assert from "node:assert/strict";
import {
  configureIntegrationTestEnvironment,
  createTemporaryDatabase,
} from "../../support/postgresql-test-scope.mjs";

const temporaryDatabase = createTemporaryDatabase("quickhack-inspection-pg-");
configureIntegrationTestEnvironment(temporaryDatabase.databaseUrl);

let prisma;
try {
  ({ prisma } = await import("@/quickhack_server/core/prisma"));
  const issuance = await import("@/quickhack_server/inspection/pg-issuance-service");
  const { saveInspectionRecord } = await import(
    "@/quickhack_server/inspection/inspection-save-service"
  );
  const now = new Date("2026-09-04T00:00:00.000Z");
  const userRow = await prisma.users.create({
    data: {
      username: "pg-issuance-worker",
      password_hash: "integration-test-only",
      role: "STAFF",
      is_active: 1,
      created_at: now,
      updated_at: now,
    },
  });
  const user = {
    userId: userRow.user_id,
    username: userRow.username,
    displayName: "PG issuance worker",
    role: "STAFF",
    isDeveloper: false,
    mobilePackingEnabled: false,
    mustChangePassword: false,
  };

  const first = await issuance.reserveInspectionPg(
    prisma,
    { clientRecordId: "appearance-row-1", inspectionKind: "appearance" },
    user,
    { now }
  );
  assert.match(first.pgNo, /^[A-Z]{2}\d{10}$/);
  const replay = await issuance.reserveInspectionPg(
    prisma,
    { clientRecordId: "appearance-row-1", inspectionKind: "appearance" },
    user,
    { now }
  );
  assert.equal(replay.pgNo, first.pgNo);
  assert.equal(replay.replayed, true);

  await assert.rejects(
    () =>
      saveInspectionRecord(prisma, {
        PG: first.pgNo,
        외관등급: "A",
        외관검수자: user.displayName,
        외관검수일시: "2026-09-04 09:00:00",
      }, user.userId),
    (error) => error?.code === "PG_RESERVED_FOR_INSPECTION_ROW"
  );

  const saved = await saveInspectionRecord(
    prisma,
    {
      PG: first.pgNo,
      외관등급: "A",
      외관검수자: user.displayName,
      외관검수일시: "2026-09-04 09:00:00",
    },
    user.userId,
    { clientRecordId: "appearance-row-1", inspectionKind: "appearance" }
  );
  assert.equal(saved.pg_no, first.pgNo);
  const consumed = await prisma.inspection_pg_reservations.findUniqueOrThrow({
    where: { client_record_id: "appearance-row-1" },
  });
  assert.equal(consumed.status, "CONSUMED");
  assert.ok(consumed.result_payload);

  const savedReplay = await saveInspectionRecord(
    prisma,
    { PG: first.pgNo, 외관등급: "A", 외관검수자: user.displayName, 외관검수일시: "2026-09-04 09:00:00" },
    user.userId,
    { clientRecordId: "appearance-row-1", inspectionKind: "appearance" }
  );
  assert.deepEqual(savedReplay, saved);

  const abandonedReservation = await issuance.reserveInspectionPg(
    prisma,
    { clientRecordId: "function-row-1", inspectionKind: "function" },
    user,
    { now }
  );
  await issuance.abandonInspectionPg(prisma, "function-row-1", user);
  const abandoned = await prisma.inspection_pg_reservations.findUniqueOrThrow({
    where: { client_record_id: "function-row-1" },
  });
  assert.equal(abandoned.pg_no, abandonedReservation.pgNo);
  assert.equal(abandoned.status, "ABANDONED");

  const expired = await issuance.reserveInspectionPg(
    prisma,
    { clientRecordId: "function-row-expired", inspectionKind: "function" },
    user,
    { now: new Date("2026-09-01T00:00:00.000Z") }
  );
  const expiry = await issuance.expireInspectionPgReservations({ now, limit: 10 });
  assert.equal(expiry.abandonedCount, 1);
  const expiredRow = await prisma.inspection_pg_reservations.findUniqueOrThrow({
    where: { pg_no: expired.pgNo },
  });
  assert.equal(expiredRow.status, "ABANDONED");

  console.log("inspection PG issuance PostgreSQL integration: PASS");
} finally {
  if (prisma) await prisma.$disconnect();
  temporaryDatabase.cleanup();
}
