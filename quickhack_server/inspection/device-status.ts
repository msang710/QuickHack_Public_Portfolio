// QuickHack note: 검수/재고/출고 상태를 Device 상태값으로 일관되게 계산하는 서비스입니다.
import type { Prisma } from "@/generated/prisma/client";
import { inferInspectionStatus } from "@/quickhack_shared/inspection/inspection-status";
import {
  inboundInspectionEvidenceSelect,
  loadInboundInspectionEvidence,
} from "@/quickhack_server/inbound/inbound-inspection-evidence-loader";

export const inspectionStatusSelect = inboundInspectionEvidenceSelect;

export async function inferStoredDeviceStatus(
  tx: Prisma.TransactionClient,
  pgNo: string,
  inboundId: number
) {
  const evidenceByInboundId = await loadInboundInspectionEvidence(tx, [
    { pgNo, inboundId },
  ]);
  return inferInspectionStatus(evidenceByInboundId.get(inboundId) ?? []);
}
