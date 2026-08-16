import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/quickhack_server/core/prisma";
import { runConsistentReadSnapshot } from "@/quickhack_server/core/database/consistent-read-snapshot";
import {
  createKeysetPage,
  decodeKeysetCursor,
  encodeKeysetCursor,
  KeysetCursorError,
} from "@/quickhack_server/core/database/keyset-page";
import { maskPhone } from "@/quickhack_server/security/sensitive-data";
import { formatModelSeqLabel } from "@/quickhack_shared/device/types";
import {
  SHIPMENT_DELIVERY_DATE_BASIS,
  SHIPMENT_DELIVERY_STAGE,
  SHIPMENT_PACKING_TYPE,
  type ShipmentDeliveryDateBasis,
  type ShipmentDeliveryLastActivitySource,
  type ShipmentDeliverySearchDetail,
  type ShipmentDeliveryReview,
  type ShipmentDeliverySearchRow,
  type ShipmentDeliveryStage,
} from "@/quickhack_shared/shipment/delivery-search";
import {
  SALES_CHANNEL_WRITE_REQUEST_TYPE,
  SALES_CHANNEL_WRITE_REVIEW_STATUSES,
} from "@/quickhack_shared/sales-channel/write-requests";
import {
  apiDateTime,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;
const CURSOR_CONTRACT = "shipment-delivery-search:v1";
const ALL_FILTER = "ALL";
const TERMINAL_GROUP_STATUSES = ["CANCELED", "INVALIDATED", "SPLIT"] as const;
const INVOICE_WRITE_TYPES = [
  SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpload,
  SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpdate,
] as const;
const REGISTRATION_REVIEW_STATUSES = ["BLOCKED", "REVIEW_REQUIRED"] as const;
const REPLACEMENT_ACTIVE_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "BLOCKED",
  "REVIEW_REQUIRED",
  "FAILED",
] as const;
const VALID_DATE_BASES = new Set<string>(
  Object.values(SHIPMENT_DELIVERY_DATE_BASIS)
);
const VALID_STAGES = new Set<string>(Object.values(SHIPMENT_DELIVERY_STAGE));
const VALID_PACKING_FILTERS = new Set(["ALL", "SINGLE", "COMBINED"]);
const VALID_REVIEW_FILTERS = new Set(["ALL", "REQUIRED"]);

export class ShipmentDeliverySearchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipmentDeliverySearchValidationError";
  }
}

export class ShipmentDeliverySearchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipmentDeliverySearchNotFoundError";
  }
}

const deliveryPackageInclude = {
  members: {
    where: { removed_at: null },
    orderBy: { member_sequence: "asc" as const },
    include: {
      allocation: {
        include: {
          order: true,
          device: {
            include: {
              inventory: true,
            },
          },
        },
      },
    },
  },
  shipment_print_items: {
    orderBy: { print_line_no: "asc" as const },
    include: {
      batch: true,
    },
  },
  current_carrier_shipment: {
    include: {
      tracking_events: {
        orderBy: [
          { scan_date: "desc" as const },
          { scan_time: "desc" as const },
          { carrier_tracking_event_id: "desc" as const },
        ],
        take: 1,
      },
      invoice_issue_item: {
        include: {
          issue_batch: true,
        },
      },
      registration_work: true,
    },
  },
  sales_channel_write_requests: {
    where: {
      request_type: { in: [...INVOICE_WRITE_TYPES] },
    },
    orderBy: {
      requested_at: "desc" as const,
    },
    take: 1,
  },
  invoice_replacement_works: {
    orderBy: {
      carrier_invoice_replacement_work_id: "desc" as const,
    },
    take: 1,
  },
} satisfies Prisma.shipment_package_groupsInclude;

type DeliveryPackageRow = Prisma.shipment_package_groupsGetPayload<{
  include: typeof deliveryPackageInclude;
}>;

const deliveryPackageDetailInclude = {
  ...deliveryPackageInclude,
  current_carrier_shipment: {
    include: {
      tracking_events: {
        orderBy: [
          { scan_date: "desc" as const },
          { scan_time: "desc" as const },
          { carrier_tracking_event_id: "desc" as const },
        ],
        take: 1,
      },
      invoice_issue_item: {
        include: {
          issue_batch: true,
        },
      },
      registration_work: true,
    },
  },
  carrier_shipments: {
    orderBy: [
      { revision_no: "asc" as const },
      { carrier_shipment_id: "asc" as const },
    ],
  },
} satisfies Prisma.shipment_package_groupsInclude;

type DeliveryPackageDetailRow =
  Prisma.shipment_package_groupsGetPayload<{
    include: typeof deliveryPackageDetailInclude;
  }>;

type ParsedSearchInput = {
  dateBasis: ShipmentDeliveryDateBasis;
  from: string;
  to: string;
  stage: ShipmentDeliveryStage | "ALL";
  carrier: string;
  packing: "ALL" | "SINGLE" | "COMBINED";
  review: "ALL" | "REQUIRED";
  search: string;
  cursor: string | null;
  limit: number;
};

type ReviewLookup = {
  packageGroupIds: number[];
  trackingNumbers: string[];
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function uniqueText(values: Array<string | number | null | undefined>) {
  return Array.from(
    new Set(values.map((value) => text(value)).filter(Boolean))
  );
}

function parsePositiveInt(
  value: unknown,
  fallback: number,
  max: number,
  label: string
) {
  const normalized = text(value);

  if (!normalized) return fallback;

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ShipmentDeliverySearchValidationError(
      `${label}이(가) 올바르지 않습니다.`
    );
  }
  return Math.min(parsed, max);
}

function parseCursor(value: unknown) {
  return text(value) || null;
}

function validDateText(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseDate(value: unknown, label: string) {
  const normalized = text(value);
  if (normalized && !validDateText(normalized)) {
    throw new ShipmentDeliverySearchValidationError(
      `${label}은 YYYY-MM-DD 형식이어야 합니다.`
    );
  }
  return normalized;
}

function parseSearchInput(input: {
  dateBasis?: unknown;
  from?: unknown;
  to?: unknown;
  stage?: unknown;
  carrier?: unknown;
  packing?: unknown;
  review?: unknown;
  search?: unknown;
  cursor?: unknown;
  limit?: unknown;
}): ParsedSearchInput {
  const dateBasis =
    text(input.dateBasis).toUpperCase() ||
    SHIPMENT_DELIVERY_DATE_BASIS.orderedAt;
  const from = parseDate(input.from, "조회 시작일");
  const to = parseDate(input.to, "조회 종료일");
  const stage = text(input.stage).toUpperCase() || ALL_FILTER;
  const carrier = text(input.carrier).toUpperCase() || ALL_FILTER;
  const packing = text(input.packing).toUpperCase() || ALL_FILTER;
  const review = text(input.review).toUpperCase() || ALL_FILTER;
  const search = text(input.search).slice(0, 100);

  if (!VALID_DATE_BASES.has(dateBasis)) {
    throw new ShipmentDeliverySearchValidationError(
      "조회 기간 기준이 올바르지 않습니다."
    );
  }
  if (from && to && from > to) {
    throw new ShipmentDeliverySearchValidationError(
      "조회 시작일은 종료일보다 늦을 수 없습니다."
    );
  }
  if (stage !== ALL_FILTER && !VALID_STAGES.has(stage)) {
    throw new ShipmentDeliverySearchValidationError(
      "배송 상태 필터가 올바르지 않습니다."
    );
  }
  if (!VALID_PACKING_FILTERS.has(packing)) {
    throw new ShipmentDeliverySearchValidationError(
      "포장 유형 필터가 올바르지 않습니다."
    );
  }
  if (!VALID_REVIEW_FILTERS.has(review)) {
    throw new ShipmentDeliverySearchValidationError(
      "확인 필요 필터가 올바르지 않습니다."
    );
  }

  return {
    dateBasis: dateBasis as ShipmentDeliveryDateBasis,
    from,
    to,
    stage: stage as ShipmentDeliveryStage | "ALL",
    carrier,
    packing: packing as ParsedSearchInput["packing"],
    review: review as ParsedSearchInput["review"],
    search,
    cursor: String(parseCursor(input.cursor) ?? "") || null,
    limit: parsePositiveInt(input.limit, DEFAULT_LIMIT, MAX_LIMIT, "조회 개수"),
  };
}

function sqlDateRange(from: string, to: string) {
  return {
    ...(from ? { gte: `${from} 00:00:00` } : {}),
    ...(to ? { lte: `${to} 23:59:59` } : {}),
  };
}

function compactDateRange(from: string, to: string) {
  return {
    ...(from ? { gte: from.replaceAll("-", "") } : {}),
    ...(to ? { lte: to.replaceAll("-", "") } : {}),
  };
}

function dateBasisWhere(
  dateBasis: ShipmentDeliveryDateBasis,
  from: string,
  to: string
): Prisma.shipment_package_groupsWhereInput | null {
  if (!from && !to) return null;

  const sqlRange = sqlDateRange(from, to);

  if (dateBasis === SHIPMENT_DELIVERY_DATE_BASIS.orderedAt) {
    return {
      members: {
        some: {
          removed_at: null,
          allocation: {
            order: {
              ordered_at: sqlRange,
            },
          },
        },
      },
    };
  }
  if (dateBasis === SHIPMENT_DELIVERY_DATE_BASIS.outboundConfirmedAt) {
    return {
      shipment_print_items: {
        some: {
          batch: {
            confirmed_at: sqlRange,
          },
        },
      },
    };
  }
  if (dateBasis === SHIPMENT_DELIVERY_DATE_BASIS.invoiceAllocatedAt) {
    return {
      current_carrier_shipment: {
        is: {
          allocated_at: sqlRange,
        },
      },
    };
  }
  if (dateBasis === SHIPMENT_DELIVERY_DATE_BASIS.carrierRegisteredAt) {
    return {
      current_carrier_shipment: {
        is: {
          carrier_registered_at: sqlRange,
        },
      },
    };
  }
  return {
    current_carrier_shipment: {
      is: {
        tracking_events: {
          some: {
            scan_date: compactDateRange(from, to),
          },
        },
      },
    },
  };
}

function activeGroupWhere(): Prisma.shipment_package_groupsWhereInput {
  return {
    group_status: {
      notIn: [...TERMINAL_GROUP_STATUSES, "ON_HOLD"],
    },
  };
}

function stageWhere(
  stage: ShipmentDeliveryStage | "ALL"
): Prisma.shipment_package_groupsWhereInput | null {
  if (stage === ALL_FILTER) return null;

  if (stage === SHIPMENT_DELIVERY_STAGE.closed) {
    return { group_status: { in: [...TERMINAL_GROUP_STATUSES] } };
  }
  if (stage === SHIPMENT_DELIVERY_STAGE.onHold) {
    return { group_status: "ON_HOLD" };
  }
  if (stage === SHIPMENT_DELIVERY_STAGE.exception) {
    return {
      AND: [
        activeGroupWhere(),
        {
          current_carrier_shipment: {
            is: { shipment_status: "EXCEPTION" },
          },
        },
      ],
    };
  }
  if (stage === SHIPMENT_DELIVERY_STAGE.delivered) {
    return {
      AND: [
        activeGroupWhere(),
        {
          OR: [
            { group_status: "COMPLETED" },
            {
              current_carrier_shipment: {
                is: { shipment_status: "DELIVERED" },
              },
            },
          ],
        },
        {
          NOT: {
            current_carrier_shipment: {
              is: { shipment_status: "EXCEPTION" },
            },
          },
        },
      ],
    };
  }
  if (stage === SHIPMENT_DELIVERY_STAGE.inTransit) {
    return {
      AND: [
        activeGroupWhere(),
        { group_status: { not: "COMPLETED" } },
        {
          current_carrier_shipment: {
            is: { shipment_status: "IN_TRANSIT" },
          },
        },
      ],
    };
  }
  if (stage === SHIPMENT_DELIVERY_STAGE.registered) {
    return {
      AND: [
        activeGroupWhere(),
        { group_status: { not: "COMPLETED" } },
        {
          current_carrier_shipment: {
            is: { shipment_status: "REGISTERED" },
          },
        },
      ],
    };
  }
  if (stage === SHIPMENT_DELIVERY_STAGE.invoiceAllocated) {
    return {
      AND: [
        activeGroupWhere(),
        { group_status: { not: "COMPLETED" } },
        {
          current_carrier_shipment: {
            is: { shipment_status: "ALLOCATED" },
          },
        },
      ],
    };
  }
  return {
    AND: [
      activeGroupWhere(),
      { group_status: { not: "COMPLETED" } },
      { current_carrier_shipment_id: null },
    ],
  };
}

function searchWhere(search: string): Prisma.shipment_package_groupsWhereInput | null {
  if (!search) return null;

  return {
    OR: [
      { receiver_name_snapshot: { contains: search } },
      {
        current_carrier_shipment: {
          is: {
            OR: [
              { tracking_number: { contains: search } },
              { previous_tracking_number: { contains: search } },
            ],
          },
        },
      },
      {
        carrier_shipments: {
          some: {
            OR: [
              { tracking_number: { contains: search } },
              { previous_tracking_number: { contains: search } },
            ],
          },
        },
      },
      {
        members: {
          some: {
            removed_at: null,
            OR: [
              { external_order_id: { contains: search } },
              { external_shipment_id: { contains: search } },
              {
                allocation: {
                  pg_no: { contains: search },
                },
              },
            ],
          },
        },
      },
    ],
  };
}

async function unresolvedReviewLookup(
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<ReviewLookup> {
  const rows = await client.carrier_reconciliation_works.findMany({
    where: {
      reconciliation_status: { not: "RESOLVED" },
      lookup_key_type: { in: ["PACKAGE_GROUP_ID", "TRACKING_NUMBER"] },
    },
    select: {
      lookup_key_type: true,
      lookup_key_value: true,
    },
  });
  const packageGroupIds: number[] = [];
  const trackingNumbers: string[] = [];

  for (const row of rows) {
    if (row.lookup_key_type === "PACKAGE_GROUP_ID") {
      const id = Number(row.lookup_key_value);
      if (Number.isSafeInteger(id) && id > 0) packageGroupIds.push(id);
    } else if (row.lookup_key_type === "TRACKING_NUMBER") {
      const trackingNumber = text(row.lookup_key_value);
      if (trackingNumber) trackingNumbers.push(trackingNumber);
    }
  }

  return {
    packageGroupIds: Array.from(new Set(packageGroupIds)),
    trackingNumbers: Array.from(new Set(trackingNumbers)),
  };
}

function reviewWhere(lookup: ReviewLookup): Prisma.shipment_package_groupsWhereInput {
  const reconciliationConditions: Prisma.shipment_package_groupsWhereInput[] = [];

  if (lookup.packageGroupIds.length > 0) {
    reconciliationConditions.push({
      package_group_id: { in: lookup.packageGroupIds },
    });
  }
  if (lookup.trackingNumbers.length > 0) {
    reconciliationConditions.push({
      current_carrier_shipment: {
        is: { tracking_number: { in: lookup.trackingNumbers } },
      },
    });
  }

  return {
    OR: [
      ...reconciliationConditions,
      {
        sales_channel_write_requests: {
          some: {
            request_type: { in: [...INVOICE_WRITE_TYPES] },
            request_status: { in: [...SALES_CHANNEL_WRITE_REVIEW_STATUSES] },
          },
        },
      },
      {
        current_carrier_shipment: {
          is: {
            OR: [
              {
                registration_work: {
                  is: {
                    work_status: {
                      in: [...REGISTRATION_REVIEW_STATUSES],
                    },
                  },
                },
              },
              {
                invoice_issue_item: {
                  is: {
                    issue_batch: {
                      batch_status: "REVIEW_REQUIRED",
                    },
                  },
                },
              },
            ],
          },
        },
      },
      {
        invoice_replacement_works: {
          some: {
            work_status: { in: [...REPLACEMENT_ACTIVE_STATUSES] },
            OR: [
              { review_required_at: { not: null } },
              { work_status: { in: ["BLOCKED", "REVIEW_REQUIRED", "FAILED"] } },
            ],
          },
        },
      },
    ],
  };
}

function buildWhere(
  input: ParsedSearchInput,
  lookup: ReviewLookup
): Prisma.shipment_package_groupsWhereInput {
  const and: Prisma.shipment_package_groupsWhereInput[] = [
    { members: { some: { removed_at: null } } },
  ];
  const dateFilter = dateBasisWhere(input.dateBasis, input.from, input.to);
  const stageFilter = stageWhere(input.stage);
  const searchFilter = searchWhere(input.search);

  if (dateFilter) and.push(dateFilter);
  if (stageFilter) and.push(stageFilter);
  if (searchFilter) and.push(searchFilter);
  if (input.carrier !== ALL_FILTER) {
    and.push({
      current_carrier_shipment: {
        is: { carrier_code: input.carrier },
      },
    });
  }
  if (input.packing === "COMBINED") {
    and.push({
      members: {
        some: {
          removed_at: null,
          member_sequence: { gt: 1 },
        },
      },
    });
  } else if (input.packing === "SINGLE") {
    and.push({
      members: {
        none: {
          removed_at: null,
          member_sequence: { gt: 1 },
        },
      },
    });
  }
  if (input.review === "REQUIRED") {
    and.push(reviewWhere(lookup));
  }

  return { AND: and };
}

export function resolveShipmentDeliveryStage(input: {
  groupStatus: string;
  hasCurrentShipment: boolean;
  shipmentStatus?: string | null;
}): ShipmentDeliveryStage {
  if (
    TERMINAL_GROUP_STATUSES.includes(
      input.groupStatus as (typeof TERMINAL_GROUP_STATUSES)[number]
    )
  ) {
    return SHIPMENT_DELIVERY_STAGE.closed;
  }
  if (input.groupStatus === "ON_HOLD") {
    return SHIPMENT_DELIVERY_STAGE.onHold;
  }
  if (input.shipmentStatus === "EXCEPTION") {
    return SHIPMENT_DELIVERY_STAGE.exception;
  }
  if (
    input.groupStatus === "COMPLETED" ||
    input.shipmentStatus === "DELIVERED"
  ) {
    return SHIPMENT_DELIVERY_STAGE.delivered;
  }
  if (input.shipmentStatus === "IN_TRANSIT") {
    return SHIPMENT_DELIVERY_STAGE.inTransit;
  }
  if (input.shipmentStatus === "REGISTERED") {
    return SHIPMENT_DELIVERY_STAGE.registered;
  }
  if (input.hasCurrentShipment) {
    return SHIPMENT_DELIVERY_STAGE.invoiceAllocated;
  }
  return SHIPMENT_DELIVERY_STAGE.preparing;
}

export function summarizeShipmentDestination(
  address: string | null | undefined
) {
  const parts = text(address).split(/\s+/).filter(Boolean);
  if (parts.length <= 2) return parts.join(" ");

  const first = parts[0] ?? "";
  const targetLength = first.endsWith("도") ? 3 : 2;
  return parts.slice(0, targetLength).join(" ");
}

function formatTrackingEventAt(
  scanDate: string | null | undefined,
  scanTime: string | null | undefined
) {
  const date = text(scanDate).replace(/\D/g, "");
  const time = text(scanTime).replace(/\D/g, "");

  if (date.length !== 8) return null;
  const dateText = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  if (time.length < 4) return `${dateText} 00:00:00`;
  return `${dateText} ${time.slice(0, 2)}:${time.slice(2, 4)}:${
    time.length >= 6 ? time.slice(4, 6) : "00"
  }`;
}

function productName(row: DeliveryPackageRow["members"][number]) {
  const allocation = row.allocation;
  return (
    allocation.seller_product_item_name ||
    allocation.vendor_item_name ||
    allocation.seller_product_name ||
    allocation.external_vendor_item_id ||
    "-"
  );
}

function reviewStateForPackage(
  _row: DeliveryPackageRow,
  reviewCount: number
) {
  return {
    reviewRequired: reviewCount > 0,
    reviewCount,
  };
}

function lastActivity(row: DeliveryPackageRow) {
  const latestEvent = row.current_carrier_shipment?.tracking_events[0] ?? null;
  const candidates: Array<{
    at: string;
    source: ShipmentDeliveryLastActivitySource;
  }> = [
    {
      at: requiredApiDateTime(row.updated_at),
      source: "PACKAGE_GROUP",
    },
  ];
  const trackingAt = formatTrackingEventAt(
    latestEvent?.scan_date,
    latestEvent?.scan_time
  );
  if (trackingAt) candidates.push({ at: trackingAt, source: "TRACKING" });
  if (row.current_carrier_shipment?.updated_at) {
    candidates.push({
      at: requiredApiDateTime(row.current_carrier_shipment.updated_at),
      source: "CARRIER",
    });
  }
  const latestWrite = row.sales_channel_write_requests[0];
  if (latestWrite?.updated_at) {
    candidates.push({
      at: requiredApiDateTime(latestWrite.updated_at),
      source: "CHANNEL",
    });
  }

  return candidates.sort((left, right) => right.at.localeCompare(left.at))[0];
}

function toSearchRow(
  row: DeliveryPackageRow,
  reconciliationCount = 0
): ShipmentDeliverySearchRow {
  const shipment = row.current_carrier_shipment;
  const latestEvent = shipment?.tracking_events[0] ?? null;
  const orderIds = uniqueText(
    row.members.map((member) => member.external_order_id)
  );
  const shipmentBoxIds = uniqueText(
    row.members.map((member) => member.external_shipment_id)
  );
  const channelStatuses = uniqueText(
    row.members.map(
      (member) => member.allocation.order.external_order_status
    )
  );
  const products = uniqueText(row.members.map(productName));
  const batchLabels = uniqueText(
    row.shipment_print_items.map((item) => item.batch.batch_label)
  );
  const printLineNumbers = Array.from(
    new Set(row.shipment_print_items.map((item) => item.print_line_no))
  ).sort((left, right) => left - right);
  const activity = lastActivity(row);
  const review = reviewStateForPackage(row, reconciliationCount);

  return {
    packageGroupId: row.package_group_id,
    deliveryStage: resolveShipmentDeliveryStage({
      groupStatus: row.group_status,
      hasCurrentShipment: Boolean(shipment),
      shipmentStatus: shipment?.shipment_status,
    }),
    groupStatus: row.group_status,
    channelStatuses,
    ...review,
    carrierShipmentId: shipment?.carrier_shipment_id ?? null,
    carrierCode: shipment?.carrier_code ?? null,
    trackingNumber: shipment?.tracking_number ?? null,
    revisionNo: shipment?.revision_no ?? null,
    reissued: Boolean(
      shipment &&
        (shipment.revision_no > 1 || shipment.previous_tracking_number)
    ),
    representativeOrderId: orderIds[0] ?? "-",
    orderCount: orderIds.length,
    shipmentBoxCount: shipmentBoxIds.length,
    representativeProductName: products[0] ?? "-",
    memberCount: row.members.length,
    packingType:
      row.members.length > 1
        ? SHIPMENT_PACKING_TYPE.combined
        : SHIPMENT_PACKING_TYPE.single,
    splitShipment: Boolean(row.split_from_group_id),
    outboundBatchLabel: batchLabels[0] ?? null,
    printLineNumbers,
    receiverName: row.receiver_name_snapshot,
    receiverPostCode: row.receiver_post_code_snapshot,
    receiverRegion: summarizeShipmentDestination(
      row.receiver_address_1_snapshot || row.receiver_address_snapshot
    ),
    latestTrackingStatus: latestEvent?.status_name ?? null,
    latestBranchName: latestEvent?.branch_name ?? null,
    latestTrackingAt: formatTrackingEventAt(
      latestEvent?.scan_date,
      latestEvent?.scan_time
    ),
    lastActivityAt: activity.at,
    lastActivitySource: activity.source,
  };
}

async function reconciliationByPackage(
  rows: DeliveryPackageRow[],
  client: Prisma.TransactionClient | typeof prisma = prisma
) {
  const packageGroupIds = rows.map((row) => String(row.package_group_id));
  const trackingNumbers = rows
    .map((row) => row.current_carrier_shipment?.tracking_number)
    .filter((value): value is string => Boolean(value));
  if (packageGroupIds.length === 0 && trackingNumbers.length === 0) {
    return new Map<number, number>();
  }

  const reviews = await client.carrier_reconciliation_works.findMany({
    where: {
      reconciliation_status: { not: "RESOLVED" },
      OR: [
        {
          lookup_key_type: "PACKAGE_GROUP_ID",
          lookup_key_value: { in: packageGroupIds },
        },
        {
          lookup_key_type: "TRACKING_NUMBER",
          lookup_key_value: { in: trackingNumbers },
        },
      ],
    },
    select: {
      lookup_key_type: true,
      lookup_key_value: true,
    },
  });
  const packageGroupByTracking = new Map(
    rows
      .filter((row) => row.current_carrier_shipment?.tracking_number)
      .map((row) => [
        row.current_carrier_shipment!.tracking_number,
        row.package_group_id,
      ])
  );
  const counts = new Map<number, number>();

  for (const review of reviews) {
    const packageGroupId =
      review.lookup_key_type === "PACKAGE_GROUP_ID"
        ? Number(review.lookup_key_value)
        : packageGroupByTracking.get(review.lookup_key_value);
    if (!packageGroupId) continue;
    counts.set(packageGroupId, (counts.get(packageGroupId) ?? 0) + 1);
  }
  return counts;
}

async function operationalReviewCountsByPackage(
  rows: DeliveryPackageRow[],
  client: Prisma.TransactionClient | typeof prisma = prisma
) {
  const counts = await reconciliationByPackage(rows, client);
  const packageGroupIds = rows.map((row) => row.package_group_id);
  if (packageGroupIds.length === 0) return counts;
  const [writes, registrations, issueItems, replacements] = await Promise.all([
    client.sales_channel_write_requests.findMany({
      where: {
        package_group_id: { in: packageGroupIds },
        request_type: { in: [...INVOICE_WRITE_TYPES] },
        request_status: { in: [...SALES_CHANNEL_WRITE_REVIEW_STATUSES] },
      },
      select: { package_group_id: true },
    }),
    client.carrier_shipment_registration_works.findMany({
      where: {
        package_group_id: { in: packageGroupIds },
        work_status: { in: [...REGISTRATION_REVIEW_STATUSES] },
      },
      select: { package_group_id: true },
    }),
    client.carrier_invoice_issue_items.findMany({
      where: {
        package_group_id: { in: packageGroupIds },
        issue_batch: { batch_status: "REVIEW_REQUIRED" },
      },
      select: { package_group_id: true },
    }),
    client.carrier_invoice_replacement_works.findMany({
      where: {
        package_group_id: { in: packageGroupIds },
        work_status: { in: [...REPLACEMENT_ACTIVE_STATUSES] },
        OR: [
          { review_required_at: { not: null } },
          { work_status: { in: ["BLOCKED", "REVIEW_REQUIRED", "FAILED"] } },
        ],
      },
      select: { package_group_id: true },
    }),
  ]);
  for (const row of [...writes, ...registrations, ...issueItems, ...replacements]) {
    const packageGroupId = row.package_group_id;
    if (!packageGroupId) continue;
    counts.set(packageGroupId, (counts.get(packageGroupId) ?? 0) + 1);
  }
  return counts;
}

export async function searchShipmentDeliveryPackages(input: {
  dateBasis?: unknown;
  from?: unknown;
  to?: unknown;
  stage?: unknown;
  carrier?: unknown;
  packing?: unknown;
  review?: unknown;
  search?: unknown;
  cursor?: unknown;
  limit?: unknown;
} = {}) {
  const parsed = parseSearchInput(input);
  const queryIdentity = {
    dateBasis: parsed.dateBasis,
    from: parsed.from,
    to: parsed.to,
    stage: parsed.stage,
    carrier: parsed.carrier,
    packing: parsed.packing,
    review: parsed.review,
    search: parsed.search,
  };
  let decoded: ReturnType<
    typeof decodeKeysetCursor<
      { maxPackageGroupId: number; totalCount: number },
      { packageGroupId: number }
    >
  > | null = null;
  try {
    decoded = parsed.cursor
      ? decodeKeysetCursor({
          cursor: parsed.cursor,
          contract: CURSOR_CONTRACT,
          queryIdentity,
        })
      : null;
  } catch (error) {
    if (error instanceof KeysetCursorError) {
      throw new ShipmentDeliverySearchValidationError(
        "배송 조회 cursor가 현재 검색 조건과 일치하지 않습니다."
      );
    }
    throw error;
  }

  return runConsistentReadSnapshot(
    prisma,
    "shipment.delivery-search.read",
    async (tx) => {
      const lookup =
        parsed.review === "REQUIRED"
          ? await unresolvedReviewLookup(tx)
          : { packageGroupIds: [], trackingNumbers: [] };
      const where = buildWhere(parsed, lookup);
      const snapshot = decoded?.snapshot ??
        (await (async () => {
          const [aggregate, totalCount] = await Promise.all([
            tx.shipment_package_groups.aggregate({
              where,
              _max: { package_group_id: true },
            }),
            tx.shipment_package_groups.count({ where }),
          ]);
          return {
            maxPackageGroupId: aggregate._max.package_group_id ?? 0,
            totalCount,
          };
        })());
      const beforeId = decoded?.position.packageGroupId ?? null;
      const rows = await tx.shipment_package_groups.findMany({
        where: {
          AND: [
            where,
            { package_group_id: { lte: snapshot.maxPackageGroupId } },
            ...(beforeId ? [{ package_group_id: { lt: beforeId } }] : []),
          ],
        },
        include: deliveryPackageInclude,
        orderBy: { package_group_id: "desc" },
        take: parsed.limit + 1,
      });
      const page = createKeysetPage({
        rows,
        limit: parsed.limit,
        coverage: "FILTERED",
        totalCount: snapshot.totalCount,
        cursorFor: (last) =>
          encodeKeysetCursor({
            contract: CURSOR_CONTRACT,
            queryIdentity,
            snapshot,
            position: { packageGroupId: last.package_group_id },
          }),
      });
      const reviewCounts = await operationalReviewCountsByPackage(page.items, tx);
      return {
        totalCount: snapshot.totalCount,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        coverage: page.coverage,
        items: page.items.map((row) =>
          toSearchRow(row, reviewCounts.get(row.package_group_id) ?? 0)
        ),
      };
    }
  );
}

async function detailReviews(row: DeliveryPackageDetailRow) {
  const trackingNumbers = row.carrier_shipments.map(
    (shipment) => shipment.tracking_number
  );
  const [reconciliations, writes, registrations, issueItems, replacements] =
    await Promise.all([
      prisma.carrier_reconciliation_works.findMany({
        where: {
          reconciliation_status: { not: "RESOLVED" },
          OR: [
            {
              lookup_key_type: "PACKAGE_GROUP_ID",
              lookup_key_value: String(row.package_group_id),
            },
            {
              lookup_key_type: "TRACKING_NUMBER",
              lookup_key_value: { in: trackingNumbers },
            },
          ],
        },
      }),
      prisma.sales_channel_write_requests.findMany({
        where: {
          package_group_id: row.package_group_id,
          request_type: { in: [...INVOICE_WRITE_TYPES] },
          request_status: { in: [...SALES_CHANNEL_WRITE_REVIEW_STATUSES] },
        },
      }),
      prisma.carrier_shipment_registration_works.findMany({
        where: {
          package_group_id: row.package_group_id,
          work_status: { in: [...REGISTRATION_REVIEW_STATUSES] },
        },
      }),
      prisma.carrier_invoice_issue_items.findMany({
        where: {
          package_group_id: row.package_group_id,
          issue_batch: { batch_status: "REVIEW_REQUIRED" },
        },
        include: { issue_batch: true },
      }),
      prisma.carrier_invoice_replacement_works.findMany({
        where: {
          package_group_id: row.package_group_id,
          work_status: { in: [...REPLACEMENT_ACTIVE_STATUSES] },
          OR: [
            { review_required_at: { not: null } },
            { work_status: { in: ["BLOCKED", "REVIEW_REQUIRED", "FAILED"] } },
          ],
        },
      }),
    ]);
  const reviews: ShipmentDeliveryReview[] = [
    ...reconciliations.map((review) => ({
      id: review.carrier_reconciliation_work_id,
      source: "CARRIER_RECONCILIATION" as const,
      operationType: review.operation_type,
      status: review.reconciliation_status,
      reason: review.reason,
      errorMessage: review.last_error_message,
      updatedAt: requiredApiDateTime(review.updated_at),
    })),
    ...writes.map((request) => ({
      id: request.sales_channel_write_request_id,
      source: "CHANNEL_WRITE" as const,
      operationType: request.request_type,
      status: request.request_status,
      reason: "판매 채널 송장 반영을 확인해야 합니다.",
      errorMessage: request.error_message,
      updatedAt: requiredApiDateTime(request.updated_at),
    })),
    ...registrations.map((work) => ({
      id: work.carrier_shipment_registration_work_id,
      source: "CARRIER_REGISTRATION" as const,
      operationType: "LOGEN_SHIPMENT_REGISTRATION",
      status: work.work_status,
      reason: "택배사 송장 등록을 확인해야 합니다.",
      errorMessage: work.last_error_message,
      updatedAt: requiredApiDateTime(work.updated_at),
    })),
    ...issueItems.map((item) => ({
      id: item.carrier_invoice_issue_batch_id,
      source: "INVOICE_ISSUE" as const,
      operationType: "LOGEN_INVOICE_ISSUE",
      status: item.issue_batch.batch_status,
      reason: "송장번호 채번 결과를 확인해야 합니다.",
      errorMessage: item.issue_batch.error_message,
      updatedAt: requiredApiDateTime(item.issue_batch.updated_at),
    })),
    ...replacements.map((work) => ({
      id: work.carrier_invoice_replacement_work_id,
      source: "INVOICE_REPLACEMENT" as const,
      operationType: "CARRIER_INVOICE_REPLACEMENT",
      status: work.work_status,
      reason: "송장 교체 작업을 확인해야 합니다.",
      errorMessage: work.last_error_message,
      updatedAt: requiredApiDateTime(work.updated_at),
    })),
  ];
  return reviews.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
}

function detailWorkflows(row: DeliveryPackageDetailRow) {
  const shipment = row.current_carrier_shipment;
  const issueItem = shipment?.invoice_issue_item;
  const issueBatch = issueItem?.issue_batch;
  const registration = shipment?.registration_work;
  const latestWrite = row.sales_channel_write_requests[0];
  const replacement = row.invoice_replacement_works[0];
  const workflows: ShipmentDeliverySearchDetail["workflows"] = [];

  if (issueBatch) {
    workflows.push(
      {
        key: "INVOICE_ISSUE",
        label: "송장 채번",
        status: issueBatch.batch_status,
        occurredAt: apiDateTime(
          issueBatch.completed_at ?? issueBatch.started_at
        ),
        errorCode: issueBatch.error_code,
        errorMessage: issueBatch.error_message,
        relatedId: issueBatch.carrier_invoice_issue_batch_id,
      },
      {
        key: "LABEL_PRINT",
        label: "송장 출력",
        status: issueBatch.label_print_status,
        occurredAt: apiDateTime(
          issueBatch.label_confirmed_at ?? issueBatch.label_last_spooled_at
        ),
        errorCode: issueBatch.label_last_error_code,
        errorMessage: issueBatch.label_last_error_message,
        relatedId: issueBatch.carrier_invoice_issue_batch_id,
      }
    );
  }
  if (latestWrite) {
    workflows.push({
      key: "CHANNEL_WRITE",
      label: "쿠팡 송장 등록",
      status: latestWrite.request_status,
      occurredAt: apiDateTime(
        latestWrite.completed_at ?? latestWrite.requested_at
      ),
      errorCode: latestWrite.error_code,
      errorMessage: latestWrite.error_message,
      relatedId: latestWrite.sales_channel_write_request_id,
    });
  }
  if (registration) {
    workflows.push({
      key: "CARRIER_REGISTRATION",
      label: "로젠 주문 등록",
      status: registration.work_status,
      occurredAt: apiDateTime(
        registration.registered_at ?? registration.prepared_at
      ),
      errorCode: registration.last_error_code,
      errorMessage: registration.last_error_message,
      relatedId: registration.carrier_shipment_registration_work_id,
    });
  }
  if (replacement) {
    workflows.push({
      key: "INVOICE_REPLACEMENT",
      label: "송장 재발급",
      status: replacement.work_status,
      occurredAt: apiDateTime(
        replacement.completed_at ??
          replacement.failed_at ??
          replacement.requested_at
      ),
      errorCode: replacement.last_error_code,
      errorMessage: replacement.last_error_message,
      relatedId: replacement.carrier_invoice_replacement_work_id,
    });
  }
  return workflows;
}

export async function getShipmentDeliveryPackageDetail(input: {
  packageGroupId?: unknown;
}) {
  const packageGroupId = parsePositiveInt(
    input.packageGroupId,
    0,
    Number.MAX_SAFE_INTEGER,
    "포장 그룹 ID"
  );
  const row = await prisma.shipment_package_groups.findUnique({
    where: { package_group_id: packageGroupId },
    include: deliveryPackageDetailInclude,
  });
  if (!row) {
    throw new ShipmentDeliverySearchNotFoundError(
      "배송 건을 찾을 수 없습니다."
    );
  }

  const reviews = await detailReviews(row);
  const summary = toSearchRow(row, reviews.length);
  const printItemByAllocation = new Map(
    row.shipment_print_items.map((item) => [item.allocation_id, item])
  );
  const trackingEvents = row.current_carrier_shipment?.tracking_events ?? [];

  return {
    summary,
    receiver: {
      name: row.receiver_name_snapshot,
      maskedPhone: maskPhone(row.receiver_phone_snapshot, 4),
      postCode: row.receiver_post_code_snapshot,
      address1: row.receiver_address_1_snapshot,
      address2: row.receiver_address_2_snapshot,
      fullAddress: row.receiver_address_snapshot,
      shippingMemo: row.shipping_memo_snapshot,
    },
    packageGroup: {
      groupStatus: row.group_status,
      splitFromGroupId: row.split_from_group_id,
      frozenAt: apiDateTime(row.frozen_at),
      invalidatedAt: apiDateTime(row.invalidated_at),
      invalidationReason: row.invalidation_reason,
      createdAt: requiredApiDateTime(row.created_at),
      updatedAt: requiredApiDateTime(row.updated_at),
    },
    members: row.members.map((member) => {
      const allocation = member.allocation;
      const printItem = printItemByAllocation.get(allocation.allocation_id);
      return {
        allocationId: allocation.allocation_id,
        memberSequence: member.member_sequence,
        externalOrderId: member.external_order_id,
        externalShipmentId: member.external_shipment_id,
        productName: productName(member),
        pgNo: allocation.pg_no,
        uniqueNo: formatModelSeqLabel(
          allocation.device.model,
          allocation.device.model_seq
        ),
        inventoryStatus: allocation.device.inventory?.inventory_status ?? null,
        channelStatus: allocation.order.external_order_status,
        batchLabel: printItem?.batch.batch_label ?? null,
        printLineNo: printItem?.print_line_no ?? null,
      };
    }),
    revisions: row.carrier_shipments.map((shipment) => ({
      carrierShipmentId: shipment.carrier_shipment_id,
      isCurrent:
        row.current_carrier_shipment_id === shipment.carrier_shipment_id,
      carrierCode: shipment.carrier_code,
      trackingNumber: shipment.tracking_number,
      previousTrackingNumber: shipment.previous_tracking_number,
      revisionNo: shipment.revision_no,
      invoiceStatus: shipment.invoice_status,
      shipmentStatus: shipment.shipment_status,
      allocatedAt: apiDateTime(shipment.allocated_at),
      carrierRegisteredAt: apiDateTime(shipment.carrier_registered_at),
      lastTrackedAt: apiDateTime(shipment.last_tracked_at),
      createdAt: requiredApiDateTime(shipment.created_at),
    })),
    workflows: detailWorkflows(row),
    trackingEvents: trackingEvents.map((event) => ({
      id: event.carrier_tracking_event_id,
      scanDate: event.scan_date,
      scanTime: event.scan_time,
      occurredAt: formatTrackingEventAt(event.scan_date, event.scan_time),
      statusName: event.status_name,
      branchName: event.branch_name,
      salesOfficeName: event.sales_office_name,
      recipientTypeName: event.recipient_type_name,
    })),
    trackingEventsTruncated: false,
    reviews,
  } satisfies ShipmentDeliverySearchDetail;
}
