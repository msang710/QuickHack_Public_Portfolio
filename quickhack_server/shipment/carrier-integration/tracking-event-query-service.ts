import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import {
  createKeysetPage,
  decodeKeysetCursor,
  encodeKeysetCursor,
  normalizeKeysetLimit,
} from "@/quickhack_server/core/database/keyset-page";

const CURSOR_CONTRACT = "carrier-tracking-events:v1";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

type TrackingEventPosition = {
  scanDate: string | null;
  scanTime: string | null;
  eventId: number;
};

type TrackingEventRow = {
  carrier_tracking_event_id: number;
  scan_date: string | null;
  scan_time: string | null;
  status_name: string;
  branch_code: string | null;
  branch_name: string | null;
  sales_office_code: string | null;
  sales_office_name: string | null;
  recipient_type_name: string | null;
};

function positiveId(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("송장 식별자가 올바르지 않습니다.");
  }
  return parsed;
}

export async function listCarrierTrackingEventPage(input: {
  carrierShipmentId?: unknown;
  cursor?: unknown;
  limit?: unknown;
}) {
  const carrierShipmentId = positiveId(input.carrierShipmentId);
  const limit = normalizeKeysetLimit(input.limit, {
    defaultLimit: DEFAULT_LIMIT,
    maxLimit: MAX_LIMIT,
  });
  const queryIdentity = { carrierShipmentId };
  const cursorText = String(input.cursor ?? "").trim();
  const decoded = cursorText
    ? decodeKeysetCursor<
        { maxEventId: number; totalCount: number },
        TrackingEventPosition
      >({
        cursor: cursorText,
        contract: CURSOR_CONTRACT,
        queryIdentity,
      })
    : null;

  return runConsistentReadSnapshot(
    prisma,
    "shipment.tracking-events.read",
    async (tx) => {
      const shipment = await tx.carrier_shipments.findUnique({
        where: { carrier_shipment_id: carrierShipmentId },
        select: {
          carrier_shipment_id: true,
          package_group_id: true,
          tracking_number: true,
          revision_no: true,
        },
      });
      if (!shipment) throw new Error("송장을 찾을 수 없습니다.");

      const snapshot = decoded?.snapshot ??
        (await (async () => {
          const [aggregate, totalCount] = await Promise.all([
            tx.carrier_tracking_events.aggregate({
              where: { carrier_shipment_id: carrierShipmentId },
              _max: { carrier_tracking_event_id: true },
            }),
            tx.carrier_tracking_events.count({
              where: { carrier_shipment_id: carrierShipmentId },
            }),
          ]);
          return {
            maxEventId: aggregate._max.carrier_tracking_event_id ?? 0,
            totalCount,
          };
        })());
      const position = decoded?.position ?? null;
      const positionPredicate = position
        ? Prisma.sql`AND (
            COALESCE(scan_date, ''),
            COALESCE(scan_time, ''),
            carrier_tracking_event_id
          ) < (
            COALESCE(${position.scanDate}, ''),
            COALESCE(${position.scanTime}, ''),
            ${position.eventId}
          )`
        : Prisma.empty;
      const rows = await tx.$queryRaw<TrackingEventRow[]>`
        SELECT
          carrier_tracking_event_id,
          scan_date,
          scan_time,
          status_name,
          branch_code,
          branch_name,
          sales_office_code,
          sales_office_name,
          recipient_type_name
        FROM carrier_tracking_events
        WHERE carrier_shipment_id = ${carrierShipmentId}
          AND carrier_tracking_event_id <= ${snapshot.maxEventId}
          ${positionPredicate}
        ORDER BY
          scan_date DESC NULLS LAST,
          scan_time DESC NULLS LAST,
          carrier_tracking_event_id DESC
        LIMIT ${limit + 1}
      `;
      const page = createKeysetPage({
        rows,
        limit,
        coverage: "COMPLETE",
        totalCount: snapshot.totalCount,
        cursorFor: (last) =>
          encodeKeysetCursor({
            contract: CURSOR_CONTRACT,
            queryIdentity,
            snapshot,
            position: {
              scanDate: last.scan_date,
              scanTime: last.scan_time,
              eventId: last.carrier_tracking_event_id,
            },
          }),
      });

      return {
        shipment: {
          carrierShipmentId: shipment.carrier_shipment_id,
          packageGroupId: shipment.package_group_id,
          trackingNumber: shipment.tracking_number,
          revisionNo: shipment.revision_no,
        },
        ...page,
        items: page.items.map((row) => ({
          id: row.carrier_tracking_event_id,
          scanDate: row.scan_date,
          scanTime: row.scan_time,
          occurredAt:
            [row.scan_date, row.scan_time].filter(Boolean).join(" ") || null,
          statusName: row.status_name,
          branchCode: row.branch_code,
          branchName: row.branch_name,
          salesOfficeCode: row.sales_office_code,
          salesOfficeName: row.sales_office_name,
          recipientTypeName: row.recipient_type_name,
        })),
      };
    }
  );
}
