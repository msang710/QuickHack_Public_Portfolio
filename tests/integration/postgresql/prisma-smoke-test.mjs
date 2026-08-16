// QuickHack note: Prisma 연결, 주요 테이블, 기본 쿼리를 빠르게 확인하는 smoke test입니다.
import { createPrismaClient } from "../../../tools/prisma-client.mjs";
import { saveInspectionRecord } from "../../../tools/prisma-record-service.mjs";

const prisma = createPrismaClient();
const smokePgNo = `SM${String(Date.now()).slice(-10)}`;
const smokeImei = `359${String(Date.now()).slice(-12)}`;

try {
  const deviceCount = await prisma.devices.count();
  const sequenceCount = await prisma.model_sequences.count();

  console.log(`devices=${deviceCount}`);
  console.log(`model_sequences=${sequenceCount}`);

  const saved = await saveInspectionRecord(prisma, {
    PG: smokePgNo,
    IMEI: smokeImei,
    등급: "A",
    외관하자: "",
    기능하자: "",
    반품유무: "N",
    제품명: "SMOKE_MODEL",
    저장공간: "256GB",
    차수: "1",
    외관검수자: "SMOKE",
    외관검수일시: "2026-01-01 00:00:00",
  });

  console.log(`smoke_saved_pg=${saved.pg_no}`);
} finally {
  await prisma.order_items.deleteMany({ where: { pg_no: smokePgNo } });
  await prisma.inventory.deleteMany({ where: { pg_no: smokePgNo } });
  await prisma.inspections.deleteMany({ where: { pg_no: smokePgNo } });
  await prisma.inbounds.deleteMany({ where: { pg_no: smokePgNo } });
  await prisma.devices.deleteMany({ where: { pg_no: smokePgNo } });
  await prisma.$disconnect();
}
