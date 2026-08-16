import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import {
  createKeysetPage,
  decodeKeysetCursor,
  encodeKeysetCursor,
  normalizeKeysetLimit,
} from "@/quickhack_server/core/database/keyset-page";
import { maskPhone } from "@/quickhack_server/security/sensitive-data";
import { formatModelSeqLabel } from "@/quickhack_shared/device/types";
import { CARRIER_SHIPMENT_STATUS } from "@/quickhack_shared/shipment/carrier-tracking-status";

const CURSOR_CONTRACT = "shipment-in-transit:v1";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;
const VISIBLE_CARRIER_STATUSES = [
  CARRIER_SHIPMENT_STATUS.registered,
  CARRIER_SHIPMENT_STATUS.inTransit,
  CARRIER_SHIPMENT_STATUS.exception,
] as const;

const eligibleWhere = {
  group_status: { in: ["READY", "ON_HOLD"] },
  current_carrier_shipment: {
    is: {
      carrier_code: "LOGEN",
      invoice_status: "REGISTERED",
      shipment_status: { in: [...VISIBLE_CARRIER_STATUSES] },
    },
  },
} satisfies Prisma.shipment_package_groupsWhereInput;

const groupInclude = {
  current_carrier_shipment: {
    include: {
      tracking_events: {
        orderBy: [
          { scan_date: { sort: "desc" as const, nulls: "last" as const } },
          { scan_time: { sort: "desc" as const, nulls: "last" as const } },
          { carrier_tracking_event_id: "desc" as const },
        ],
        take: 1,
      },
    },
  },
  members: {
    where: { removed_at: null },
    orderBy: { member_sequence: "asc" as const },
    include: {
      allocation: {
        include: {
          order: true,
          device: { include: { inventory: true } },
          shipment_list_print_batch_items: {
            orderBy: { print_line_no: "asc" as const },
            include: { batch: { select: { batch_label: true } } },
          },
        },
      },
    },
  },
} satisfies Prisma.shipment_package_groupsInclude;

type GroupRow = Prisma.shipment_package_groupsGetPayload<{
  include: typeof groupInclude;
}>;

type Snapshot = {
  maxPackageGroupId: number;
  packageGroupCount: number;
  memberCount: number;
  inTransitCount: number;
  exceptionCount: number;
  reviewRequiredCount: number;
};

function uniqueText(values: Array<string | number | null | undefined>) {
  return Array.from(
    new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))
  ).join("\n");
}

function shipmentBatchLineLabel(
  allocation: GroupRow["members"][number]["allocation"]
) {
  const printItem =
    allocation.shipment_list_print_batch_items.find(
      (item) =>
        item.shipment_list_print_batch_id ===
        allocation.shipment_list_print_batch_id
    ) ?? null;
  const label = String(
    allocation.shipment_list_print_batch_label ??
      printItem?.batch.batch_label ??
      ""
  ).trim();
  if (label) return printItem ? `${label}-${printItem.print_line_no}` : label;
  return allocation.shipment_list_print_batch_no
    ? `${allocation.shipment_list_print_batch_no}차${
        printItem ? `-${printItem.print_line_no}` : ""
      }`
    : "";
}

function safeCount(value: bigint | number | null | undefined) {
  const count = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("배송 현황 집계 건수가 안전한 범위를 초과했습니다.");
  }
  return count;
}

async function loadSnapshot(tx: Prisma.TransactionClient): Promise<Snapshot> {
  const [group, memberCount, inTransitCount, exceptionCount, reviewRows] =
    await Promise.all([
      tx.shipment_package_groups.aggregate({
        where: eligibleWhere,
        _max: { package_group_id: true },
        _count: { _all: true },
      }),
      tx.shipment_package_group_members.count({
        where: { removed_at: null, package_group: eligibleWhere },
      }),
      tx.shipment_package_groups.count({
        where: {
          AND: [
            eligibleWhere,
            {
              current_carrier_shipment: {
                is: { shipment_status: CARRIER_SHIPMENT_STATUS.inTransit },
              },
            },
          ],
        },
      }),
      tx.shipment_package_groups.count({
        where: {
          AND: [
            eligibleWhere,
            {
              current_carrier_shipment: {
                is: { shipment_status: CARRIER_SHIPMENT_STATUS.exception },
              },
            },
          ],
        },
      }),
      tx.$queryRaw<Array<{ review_count: bigint }>>`
        SELECT COUNT(DISTINCT g.package_group_id)::bigint AS review_count
        FROM shipment_package_groups AS g
        JOIN carrier_shipments AS s
          ON s.carrier_shipment_id = g.current_carrier_shipment_id
        WHERE g.group_status IN ('READY', 'ON_HOLD')
          AND s.carrier_code = 'LOGEN'
          AND s.invoice_status = 'REGISTERED'
          AND s.shipment_status IN ('REGISTERED', 'IN_TRANSIT', 'EXCEPTION')
          AND EXISTS (
            SELECT 1
            FROM carrier_reconciliation_works AS r
            WHERE r.reconciliation_status <> 'RESOLVED'
              AND (
                (r.lookup_key_type = 'PACKAGE_GROUP_ID'
                  AND r.lookup_key_value = g.package_group_id::text)
                OR
                (r.lookup_key_type = 'TRACKING_NUMBER'
                  AND r.lookup_key_value = s.tracking_number)
              )
          )
      `,
    ]);
  return {
    maxPackageGroupId: group._max.package_group_id ?? 0,
    packageGroupCount: group._count._all,
    memberCount,
    inTransitCount,
    exceptionCount,
    reviewRequiredCount: safeCount(reviewRows[0]?.review_count),
  };
}

async function loadReviews(tx: Prisma.TransactionClient, rows: GroupRow[]) {
  const packageGroupIds = rows.map((row) => String(row.package_group_id));
  const trackingNumbers = rows.flatMap((row) =>
    row.current_carrier_shipment?.tracking_number
      ? [row.current_carrier_shipment.tracking_number]
      : []
  );
  if (packageGroupIds.length === 0 && trackingNumbers.length === 0) return [];
  return tx.carrier_reconciliation_works.findMany({
    where: {
      reconciliation_status: { not: "RESOLVED" },
      OR: [
        { lookup_key_type: "PACKAGE_GROUP_ID", lookup_key_value: { in: packageGroupIds } },
        { lookup_key_type: "TRACKING_NUMBER", lookup_key_value: { in: trackingNumbers } },
      ],
    },
    orderBy: [{ updated_at: "desc" }, { carrier_reconciliation_work_id: "desc" }],
  });
}

export async function listInTransitPackageGroups(
  input: { limit?: unknown; cursor?: unknown } = {}
) {
  const limit = normalizeKeysetLimit(input.limit, {
    defaultLimit: DEFAULT_LIMIT,
    maxLimit: MAX_LIMIT,
  });
  const queryIdentity = { view: "CURRENT_IN_TRANSIT" };
  const cursorText = String(input.cursor ?? "").trim();
  const decoded = cursorText
    ? decodeKeysetCursor<Snapshot, { packageGroupId: number }>({
        cursor: cursorText,
        contract: CURSOR_CONTRACT,
        queryIdentity,
      })
    : null;

  return runConsistentReadSnapshot(
    prisma,
    "shipment.in-transit.read",
    async (tx) => {
      const snapshot = decoded?.snapshot ?? (await loadSnapshot(tx));
      const beforeId = decoded?.position.packageGroupId ?? null;
      const rows = await tx.shipment_package_groups.findMany({
        where: {
          AND: [
            eligibleWhere,
            { package_group_id: { lte: snapshot.maxPackageGroupId } },
            ...(beforeId ? [{ package_group_id: { lt: beforeId } }] : []),
          ],
        },
        orderBy: { package_group_id: "desc" },
        take: limit + 1,
        include: groupInclude,
      });
      const page = createKeysetPage({
        rows,
        limit,
        coverage: "COMPLETE",
        totalCount: snapshot.packageGroupCount,
        cursorFor: (last) =>
          encodeKeysetCursor({
            contract: CURSOR_CONTRACT,
            queryIdentity,
            snapshot,
            position: { packageGroupId: last.package_group_id },
          }),
      });
      const reviewWorks = await loadReviews(tx, page.items);
      const reviewsByKey = new Map<string, typeof reviewWorks>();
      for (const work of reviewWorks) {
        const key = `${work.lookup_key_type}:${work.lookup_key_value}`;
        const current = reviewsByKey.get(key) ?? [];
        current.push(work);
        reviewsByKey.set(key, current);
      }

      const items = page.items.flatMap((group) => {
        const shipment = group.current_carrier_shipment;
        if (!shipment) return [];
        const members = group.members.map((member) => {
          const allocation = member.allocation;
          const device = allocation.device;
          return {
            allocationId: allocation.allocation_id,
            memberSequence: member.member_sequence,
            pgNo: allocation.pg_no,
            uniqueNo: formatModelSeqLabel(device.model, device.model_seq),
            model: device.model,
            storage: device.storage,
            color: device.color,
            saleGrade: device.sale_grade,
            inventoryStatus: device.inventory?.inventory_status ?? null,
            externalOrderId: member.external_order_id,
            externalShipmentId: member.external_shipment_id,
            channelStatus: allocation.order.external_order_status,
            productName:
              allocation.seller_product_item_name ||
              allocation.vendor_item_name ||
              allocation.seller_product_name ||
              allocation.external_vendor_item_id ||
              "-",
            shipmentBatchText: shipmentBatchLineLabel(allocation),
          };
        });
        const latestEvent = shipment.tracking_events[0] ?? null;
        const reviews = [
          ...(reviewsByKey.get(`TRACKING_NUMBER:${shipment.tracking_number}`) ?? []),
          ...(reviewsByKey.get(`PACKAGE_GROUP_ID:${group.package_group_id}`) ?? []),
        ].map((work) => ({
          id: work.carrier_reconciliation_work_id,
          operationType: work.operation_type,
          reason: work.reason,
          error: work.last_error_message,
          status: work.reconciliation_status,
          updatedAt: work.updated_at,
        }));
        return [{
          id: group.package_group_id,
          packageGroupId: group.package_group_id,
          groupStatus: group.group_status,
          carrierShipmentId: shipment.carrier_shipment_id,
          carrierCode: shipment.carrier_code,
          trackingNumber: shipment.tracking_number,
          carrierStatus: shipment.shipment_status,
          carrierRegisteredAt: shipment.carrier_registered_at,
          lastTrackedAt: shipment.last_tracked_at,
          latestStatusName: latestEvent?.status_name ?? null,
          latestScanDate: latestEvent?.scan_date ?? null,
          latestScanTime: latestEvent?.scan_time ?? null,
          latestBranchName: latestEvent?.branch_name ?? null,
          receiverName: group.receiver_name_snapshot,
          receiverSafeNumber: maskPhone(group.receiver_phone_snapshot, 4),
          receiverAddress: group.receiver_address_snapshot,
          packageCount: 1,
          memberCount: members.length,
          externalOrderIds: uniqueText(members.map((member) => member.externalOrderId)),
          externalShipmentIds: uniqueText(members.map((member) => member.externalShipmentId)),
          channelStatusText: uniqueText(members.map((member) => member.channelStatus)),
          productText: uniqueText(members.map((member) => member.productName)),
          pgText: uniqueText(members.map((member) => member.pgNo)),
          uniqueNoText: uniqueText(members.map((member) => member.uniqueNo)),
          inventoryStatusText: uniqueText(members.map((member) => member.inventoryStatus)),
          shipmentBatchText: uniqueText(members.map((member) => member.shipmentBatchText)),
          reviewRequired: reviews.length > 0,
          members,
          reviews,
        }];
      });

      return {
        summary: {
          packageGroupCount: snapshot.packageGroupCount,
          memberCount: snapshot.memberCount,
          inTransitCount: snapshot.inTransitCount,
          exceptionCount: snapshot.exceptionCount,
          reviewRequiredCount: snapshot.reviewRequiredCount,
        },
        items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        totalCount: snapshot.packageGroupCount,
        coverage: page.coverage,
      };
    }
  );
}
