import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import {
  databaseDateTime,
  databaseNow,
  requiredApiDate,
} from "@/quickhack_server/core/database/time-boundary";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import { prisma } from "@/quickhack_server/core/prisma";
import {
  publicConflict,
  publicNotFound,
} from "@/quickhack_server/core/public-error";
import {
  assertNoShipmentReturnConflicts,
  isShipmentReturnConflictError,
} from "@/quickhack_server/returns/shipment-return-conflict-service";
import {
  CarrierApiCallFailureError,
  firstLogenResponseItem,
  getLogenContractFaresForRegistration,
  getLogenContractInfoForRegistration,
  getLogenExtraFareForRegistration,
  getLogenLatestTrackingForReconciliation,
  getLogenPrintInfoForRegistration,
  isLogenResponseItemSucceeded,
  registerLogenPrintedShipment,
} from "@/quickhack_server/shipment/carrier-integration/logen/workflow-service";
import {
  assertLogenWriteAllowed,
  getLogenRegistrationConfig,
} from "@/quickhack_server/shipment/carrier-integration/logen/config";
import {
  assertLogenPreparedCredentialMatchesWriteSession,
  openLogenRequestCredentialSession,
} from "@/quickhack_server/shipment/carrier-integration/logen/credential-session";
import {
  applyObservedCarrierShipmentStatus,
  CarrierShipmentStateConflictError,
  transitionCarrierInvoiceStatus,
} from "@/quickhack_server/shipment/carrier-integration/carrier-shipment-state-service";
import { projectReplacementFromRegistrationWork } from "@/quickhack_server/shipment/carrier-integration/carrier-invoice-replacement-projection-service";
import type { CarrierRequestItem } from "@/quickhack_server/shipment/carrier-integration/types";
import { assertWorkerLeaseActive } from "@/quickhack_server/workers/lease-guard";
import type { WorkerLeaseGuard } from "@/quickhack_server/workers/types";
import { addSeconds, quickHackClock } from "@/quickhack_shared/core/time";
import { CARRIER_INVOICE_STATUS } from "@/quickhack_shared/shipment/carrier-invoice-status";
import { ACTIVE_CARRIER_INVOICE_REPLACEMENT_STATUSES } from "@/quickhack_shared/shipment/invoice-replacement";
import { CARRIER_SHIPMENT_STATUS } from "@/quickhack_shared/shipment/carrier-tracking-status";

const TRACKING_NUMBER_PATTERN = /^\d{11}$/;
const MAX_GOODS_AMOUNT = 9_999_999;
const RETRY_SECONDS = 60;
const MAX_RECONCILIATION_ATTEMPTS = 3;
const MAX_PREPARATION_ATTEMPTS = 5;
const ELIGIBLE_CHANNEL_STATUSES = new Set([
  "DEPARTURE",
  "DELIVERING",
  "FINAL_DELIVERY",
]);

const WORK_STATUS = {
  pending: "PENDING",
  prepared: "PREPARED",
  submitting: "SUBMITTING",
  retryWaiting: "RETRY_WAITING",
  reconciling: "RECONCILING",
  registered: "REGISTERED",
  blocked: "BLOCKED",
  reviewRequired: "REVIEW_REQUIRED",
} as const;

const AUTOMATIC_WORK_STATUSES = [
  WORK_STATUS.pending,
  WORK_STATUS.prepared,
  WORK_STATUS.submitting,
  WORK_STATUS.retryWaiting,
  WORK_STATUS.reconciling,
] as const;

type RegistrationWorkerLease = WorkerLeaseGuard & { leaseToken: string };

class RegistrationBlockedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RegistrationBlockedError";
    this.code = code;
  }
}

class RegistrationExecutionOwnershipLostError extends Error {
  readonly code = "LOGEN_REGISTRATION_EXECUTION_OWNERSHIP_LOST";

  constructor() {
    super("Logen registration execution ownership changed.");
    this.name = "RegistrationExecutionOwnershipLostError";
  }
}

function registrationExecutionOwnershipLost() {
  return new RegistrationExecutionOwnershipLostError();
}

function isRegistrationExecutionOwnershipLost(error: unknown) {
  return error instanceof RegistrationExecutionOwnershipLostError;
}

function requireRegistrationWorkerLease(
  guard?: WorkerLeaseGuard | null
): RegistrationWorkerLease {
  if (!guard || !String(guard.leaseToken ?? "").trim()) {
    throw Object.assign(
      new Error("Logen shipment registration requires an owned worker lease."),
      { code: "WORKER_LEASE_REQUIRED" }
    );
  }
  return guard as RegistrationWorkerLease;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function compactText(values: unknown[], separator = " ") {
  return values.map(text).filter(Boolean).join(separator);
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function resultMessage(item: Record<string, unknown> | null) {
  return text(item?.resultMsg) || "로젠 API가 성공 결과를 반환하지 않았습니다.";
}

function errorDetails(error: unknown) {
  if (error instanceof RegistrationBlockedError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code
        : error.name;
    return { code: code || "ERROR", message: error.message };
  }
  return { code: "ERROR", message: String(error) };
}

function retryAt() {
  return addSeconds(quickHackClock.nowDate(), RETRY_SECONDS);
}

function takeDate(value: Date | string) {
  const normalized = (value instanceof Date ? requiredApiDate(value) : text(value)).replace(/-/g, "");
  if (!/^\d{8}$/.test(normalized)) {
    throw new RegistrationBlockedError(
      "INVALID_TAKE_DATE",
      "출고 차수의 접수일자를 YYYYMMDD 형식으로 만들 수 없습니다."
    );
  }
  return normalized;
}

type RegistrationClient = typeof prisma | Prisma.TransactionClient;

const ACTIVE_REPLACEMENT_STATUSES: string[] = [
  ...ACTIVE_CARRIER_INVOICE_REPLACEMENT_STATUSES,
];

function registrationGroupIsEligible(
  group: {
    group_status: string;
    current_carrier_shipment_id: number | null;
    invoice_replacement_works?: Array<{
      candidate_carrier_shipment_id: number | null;
      work_status: string;
    }>;
  },
  carrierShipmentId: number
) {
  if (
    group.group_status === "READY" &&
    group.current_carrier_shipment_id === carrierShipmentId
  ) {
    return true;
  }
  return (
    group.group_status === "ON_HOLD" &&
    group.current_carrier_shipment_id === carrierShipmentId &&
    Boolean(
      group.invoice_replacement_works?.some(
        (work) =>
          work.candidate_carrier_shipment_id === carrierShipmentId &&
          ACTIVE_REPLACEMENT_STATUSES.includes(work.work_status)
      )
    )
  );
}

export async function enqueueLogenRegistrationWork(
  client: RegistrationClient,
  input: {
    carrierShipmentId: number;
    packageGroupId: number;
    createdAt?: DateTimeInput;
    allowActiveReplacementHold?: boolean;
  }
) {
  const item = await client.carrier_invoice_issue_items.findUnique({
    where: { carrier_shipment_id: input.carrierShipmentId },
    include: {
      carrier_shipment: true,
      package_group: {
        include: {
          invoice_replacement_works: {
            where: {
              work_status: { in: ACTIVE_REPLACEMENT_STATUSES },
            },
            select: {
              candidate_carrier_shipment_id: true,
              work_status: true,
            },
          },
        },
      },
      issue_batch: {
        include: {
          shipment_list_print_batch: {
            include: {
              items: {
                select: {
                  allocation_id: true,
                  package_group_id: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (
    !item ||
    item.package_group_id !== input.packageGroupId ||
    item.item_status !== "ALLOCATED" ||
    !registrationGroupIsEligible(
      item.package_group,
      input.carrierShipmentId
    ) ||
    item.carrier_shipment?.invoice_status !== "ALLOCATED"
  ) {
    throw publicConflict(
      "LOGEN_REGISTRATION_ITEM_UNAVAILABLE",
      "로젠 등록 작업에 연결할 송장 발급 항목을 찾지 못했습니다."
    );
  }

  const now = databaseDateTime(input.createdAt ?? databaseNow());
  return client.carrier_shipment_registration_works.upsert({
    where: { carrier_shipment_id: input.carrierShipmentId },
    create: {
      carrier_shipment_id: input.carrierShipmentId,
      carrier_invoice_issue_item_id: item.carrier_invoice_issue_item_id,
      package_group_id: input.packageGroupId,
      work_status: WORK_STATUS.pending,
      fix_take_no: `QH-LOGEN-${input.carrierShipmentId}`,
      take_date: takeDate(item.issue_batch.shipment_list_print_batch.print_date),
      created_at: now,
      updated_at: now,
    },
    update: {},
  });
}

export async function discoverMissingLogenRegistrationWorks(
  client: RegistrationClient = prisma
) {
  const shipments = await client.carrier_shipments.findMany({
    where: {
      carrier_code: "LOGEN",
      invoice_status: "ALLOCATED",
      package_group_id: { not: null },
      package_group: {
        is: {
          group_status: "READY",
        },
      },
      invoice_issue_item: { isNot: null },
      registration_work: { is: null },
    },
    select: {
      carrier_shipment_id: true,
      package_group_id: true,
    },
  });

  for (const shipment of shipments) {
    await enqueueLogenRegistrationWork(client, {
      carrierShipmentId: shipment.carrier_shipment_id,
      packageGroupId: shipment.package_group_id as number,
    });
  }
  return shipments.length;
}

const workInclude = {
  carrier_shipment: true,
  issue_item: {
    include: {
      issue_batch: {
        include: {
          shipment_list_print_batch: {
            include: {
              items: {
                select: {
                  allocation_id: true,
                  package_group_id: true,
                },
              },
            },
          },
        },
      },
    },
  },
  package_group: {
    include: {
      invoice_replacement_works: {
        where: { work_status: { in: ACTIVE_REPLACEMENT_STATUSES } },
        select: {
          candidate_carrier_shipment_id: true,
          work_status: true,
        },
      },
      members: {
        where: { removed_at: null },
        orderBy: { member_sequence: "asc" },
        include: { allocation: { include: { order: true } } },
      },
    },
  },
} satisfies Prisma.carrier_shipment_registration_worksInclude;

type RegistrationWork =
  Prisma.carrier_shipment_registration_worksGetPayload<{
    include: typeof workInclude;
  }>;

async function loadWork(workId: number) {
  return prisma.carrier_shipment_registration_works.findUniqueOrThrow({
    where: { carrier_shipment_registration_work_id: workId },
    include: workInclude,
  });
}

async function updateOwnedRegistrationWork(
  client: RegistrationClient,
  input: {
    workId: number;
    executionToken: string;
    expectedStatuses: readonly string[];
    data: Prisma.carrier_shipment_registration_worksUncheckedUpdateManyInput;
  }
) {
  const updated = await client.carrier_shipment_registration_works.updateMany({
    where: {
      carrier_shipment_registration_work_id: input.workId,
      execution_token: input.executionToken,
      work_status: { in: [...input.expectedStatuses] },
    },
    data: input.data,
  });
  if (updated.count !== 1) {
    throw registrationExecutionOwnershipLost();
  }
}

async function claimRegistrationWork(input: {
  workId: number;
  workerJobId?: number;
  workerLease: RegistrationWorkerLease;
}) {
  await assertWorkerLeaseActive(input.workerLease);
  const observed = await loadWork(input.workId);
  if (
    observed.work_status === WORK_STATUS.registered ||
    observed.execution_token === input.workerLease.leaseToken ||
    !AUTOMATIC_WORK_STATUSES.includes(observed.work_status as never)
  ) {
    return null;
  }

  const claimed = await prisma.carrier_shipment_registration_works.updateMany({
    where: {
      carrier_shipment_registration_work_id: input.workId,
      work_status: observed.work_status,
      attempt_count: observed.attempt_count,
      execution_token: observed.execution_token,
      next_attempt_at: observed.next_attempt_at,
    },
    data: {
      execution_token: input.workerLease.leaseToken,
      worker_job_id: input.workerJobId ?? null,
      attempt_count: { increment: 1 },
      updated_at: databaseNow(),
    },
  });
  if (claimed.count !== 1) {
    return null;
  }

  const owned = await loadWork(input.workId);
  if (owned.execution_token !== input.workerLease.leaseToken) {
    throw registrationExecutionOwnershipLost();
  }
  return owned;
}

async function ensureStructuredReceiverSnapshot(work: RegistrationWork) {
  const group = work.package_group;
  if (
    text(group.receiver_phone_snapshot) &&
    text(group.receiver_address_1_snapshot) &&
    text(group.receiver_address_2_snapshot)
  ) {
    return group;
  }

  const firstOrder = group.members[0]?.allocation.order;
  if (!firstOrder) {
    throw new RegistrationBlockedError(
      "RECEIVER_SNAPSHOT_MISSING",
      "합포장 그룹에 수취정보를 복구할 원주문이 없습니다."
    );
  }
  const combined = compactText(
    [
      firstOrder.receiver_post_code,
      firstOrder.receiver_address_1,
      firstOrder.receiver_address_2,
    ],
    " / "
  );
  if (
    combined !== text(group.receiver_address_snapshot) ||
    text(firstOrder.receiver_name) !== text(group.receiver_name_snapshot)
  ) {
    throw new RegistrationBlockedError(
      "RECEIVER_SNAPSHOT_CHANGED",
      "원주문 수취정보가 확정된 합포장 그룹 스냅샷과 다릅니다."
    );
  }
  if (
    !text(firstOrder.receiver_safe_number) ||
    !text(firstOrder.receiver_address_1) ||
    !text(firstOrder.receiver_address_2)
  ) {
    throw new RegistrationBlockedError(
      "RECEIVER_REQUIRED_FIELD_MISSING",
      "로젠 등록에 필요한 수취인 전화번호 또는 주소가 누락되었습니다."
    );
  }

  return prisma.shipment_package_groups.update({
    where: { package_group_id: group.package_group_id },
    data: {
      receiver_phone_snapshot: firstOrder.receiver_safe_number,
      receiver_post_code_snapshot: firstOrder.receiver_post_code,
      receiver_address_1_snapshot: firstOrder.receiver_address_1,
      receiver_address_2_snapshot: firstOrder.receiver_address_2,
      shipping_memo_snapshot: firstOrder.shipping_memo,
      updated_at: databaseNow(),
    },
    include: {
      members: {
        where: { removed_at: null },
        orderBy: { member_sequence: "asc" },
        include: { allocation: { include: { order: true } } },
      },
    },
  });
}

async function goodsSnapshot(work: RegistrationWork) {
  const members = work.package_group.members;
  const vendorItemIds = members.map((member) =>
    text(member.allocation.external_vendor_item_id)
  );
  if (members.length === 0 || vendorItemIds.some((value) => !value)) {
    throw new RegistrationBlockedError(
      "PACKAGE_GROUP_ITEM_MISSING",
      "합포장 그룹의 상품 식별자가 누락되었습니다."
    );
  }

  const rows = await prisma.order_matching_work_queue.findMany({
    where: {
      OR: members.map((member) => ({
        channel: "COUPANG",
        external_order_id: member.external_order_id,
        external_shipment_id: member.external_shipment_id,
        external_vendor_item_id: text(
          member.allocation.external_vendor_item_id
        ),
      })),
    },
    select: {
      external_order_id: true,
      external_shipment_id: true,
      external_vendor_item_id: true,
      sales_price: true,
    },
  });
  const priceByKey = new Map(
    rows.map((row) => [
      `${row.external_order_id}\u0000${row.external_shipment_id}\u0000${row.external_vendor_item_id}`,
      row.sales_price,
    ])
  );
  const prices = members.map((member) =>
    priceByKey.get(
      `${member.external_order_id}\u0000${member.external_shipment_id}\u0000${text(
        member.allocation.external_vendor_item_id
      )}`
    )
  );
  if (prices.some((price) => price == null || price < 0)) {
    throw new RegistrationBlockedError(
      "GOODS_AMOUNT_MISSING",
      "합포장 구성원의 판매가가 누락되어 로젠 물품가액을 계산할 수 없습니다."
    );
  }
  const goodsAmount = (prices as number[]).reduce(
    (sum, price) => sum + price,
    0
  );
  if (goodsAmount > MAX_GOODS_AMOUNT) {
    throw new RegistrationBlockedError(
      "GOODS_AMOUNT_TOO_LARGE",
      "합포장 물품가액이 로젠 API 7자리 한도를 초과했습니다."
    );
  }

  const firstName =
    text(members[0].allocation.vendor_item_name) ||
    text(members[0].allocation.seller_product_item_name) ||
    text(members[0].allocation.seller_product_name) ||
    "휴대전화";
  return {
    goodsAmount,
    goodsName:
      members.length === 1 ? firstName : `${firstName} 외 ${members.length - 1}건`,
  };
}

function assertWorkPreconditions(work: RegistrationWork) {
  const shipment = work.carrier_shipment;
  const group = work.package_group;
  if (
    !registrationGroupIsEligible(
      group,
      shipment.carrier_shipment_id
    ) ||
    shipment.package_group_id !== group.package_group_id ||
    work.issue_item.carrier_shipment_id !== shipment.carrier_shipment_id ||
    work.issue_item.item_status !== "ALLOCATED" ||
    work.issue_item.revision_no !== shipment.revision_no
  ) {
    throw new RegistrationBlockedError(
      "REGISTRATION_TARGET_CHANGED",
      "합포장 그룹의 현재 송장 또는 발급 revision이 변경되었습니다."
    );
  }
  if (!TRACKING_NUMBER_PATTERN.test(shipment.tracking_number)) {
    throw new RegistrationBlockedError(
      "INVALID_TRACKING_NUMBER",
      "로젠 송장번호는 11자리 숫자여야 합니다."
    );
  }
  const expectedAllocationIds = work.issue_item.issue_batch.shipment_list_print_batch.items
    .filter((item) => item.package_group_id === group.package_group_id)
    .map((item) => item.allocation_id)
    .sort((left, right) => left - right);
  const currentAllocationIds = group.members
    .map((member) => member.allocation_id)
    .sort((left, right) => left - right);
  if (
    expectedAllocationIds.length !== currentAllocationIds.length ||
    expectedAllocationIds.some(
      (allocationId, index) => allocationId !== currentAllocationIds[index]
    )
  ) {
    throw new RegistrationBlockedError(
      "PACKAGE_GROUP_MEMBERSHIP_CHANGED",
      "합포장 그룹 구성원이 확정된 출고 차수와 다릅니다."
    );
  }
  if (
    shipment.invoice_status !== "ALLOCATED" &&
    shipment.invoice_status !== "REGISTERED"
  ) {
    throw new RegistrationBlockedError(
      "INVALID_CARRIER_INVOICE_STATUS",
      `로젠 등록할 수 없는 송장 상태입니다: ${shipment.invoice_status}`
    );
  }
  for (const member of group.members) {
    if (
      member.external_order_id !== member.allocation.external_order_id ||
      member.external_shipment_id !== member.allocation.external_shipment_id ||
      member.allocation.allocation_status !== "SHIPMENT_LIST_PRINTED" ||
      !ELIGIBLE_CHANNEL_STATUSES.has(
        text(member.allocation.order.external_order_status)
      ) ||
      text(member.allocation.order.invoice_number) !== shipment.tracking_number
    ) {
      throw new RegistrationBlockedError(
        "CHANNEL_INVOICE_NOT_CONFIRMED",
        "쿠팡 배송지시 상태 또는 송장번호가 PR3 확정 결과와 다릅니다."
      );
    }
  }
}

async function registrationConfigOrBlock() {
  try {
    await assertLogenWriteAllowed("slipPrintM");
    return await getLogenRegistrationConfig();
  } catch (error) {
    throw new RegistrationBlockedError(
      "LOGEN_REGISTRATION_CONFIG_BLOCKED",
      error instanceof Error ? error.message : String(error)
    );
  }
}

class LogenRegistrationSettingsChangedError extends Error {
  readonly code = "LOGEN_REGISTRATION_SETTINGS_CHANGED";

  constructor() {
    super(
      "로젠 송장 등록 준비 중 운영 설정이 변경되었습니다. 최신 설정으로 준비 단계를 다시 수행합니다."
    );
    this.name = "LogenRegistrationSettingsChangedError";
  }
}

type PreparedRegistration = {
  payload: CarrierRequestItem;
  classificationApiCallLogId: number;
  senderProfileHash: string;
  payloadHash: string;
  customerCode: string;
  credentialFingerprint: string | null;
  settingsRevision: number;
  senderName: string;
  senderTel: string;
  senderCell: string;
  senderZipCode: string;
  senderAddress1: string;
  senderAddress2: string;
  receiverBranchCode: string;
  receiverDongName: string;
  salesOfficeName: string;
  terminalName: string;
  branchShareYn: string;
  classificationCode: string;
  classifiedZipCode: string;
  jejuRegionYn: string;
  islandYn: string;
  mountainYn: string;
  fareType: string;
  boxTypeCode: string;
  deliveryFare: number;
  extraFare: number;
  goodsName: string;
  goodsAmount: number;
};

async function prepareRegistration(
  work: RegistrationWork,
  workerLease?: WorkerLeaseGuard
): Promise<PreparedRegistration> {
  assertWorkPreconditions(work);
  await assertNoShipmentReturnConflicts(
    prisma,
    work.package_group.members.map((member) => member.allocation_id)
  );
  const group = await ensureStructuredReceiverSnapshot(work);
  const goods = await goodsSnapshot(work);
  const config = await registrationConfigOrBlock();
  const credentialSession = await openLogenRequestCredentialSession({
    apiName: "shipmentRegistrationPrepare",
    operationType: "READ",
  });
  const customerCode = credentialSession.customerCode;
  const shipmentId = work.carrier_shipment_id;

  const contractCall = await getLogenContractInfoForRegistration(
    customerCode,
    shipmentId,
    workerLease?.signal,
    credentialSession
  );
  const contract = firstLogenResponseItem(contractCall.result);
  if (!isLogenResponseItemSucceeded(contract)) {
    throw new RegistrationBlockedError(
      "LOGEN_CONTRACT_UNAVAILABLE",
      resultMessage(contract)
    );
  }
  const fareType = text(contract?.fareTy);
  if (!fareType) {
    throw new RegistrationBlockedError(
      "LOGEN_FARE_TYPE_MISSING",
      "로젠 거래처 계약 응답에 운임타입이 없습니다."
    );
  }

  const fareCall = await getLogenContractFaresForRegistration(
    customerCode,
    fareType,
    shipmentId,
    workerLease?.signal,
    credentialSession
  );
  const fareResult = firstLogenResponseItem(fareCall.result);
  const fareRows = Array.isArray(fareResult?.data1)
    ? (fareResult.data1 as Array<Record<string, unknown>>)
    : [];
  const fare = fareRows.find(
    (row) => text(row.boxTyCd) === config.boxTypeCode
  );
  const deliveryFare = Number(fare?.dlvFare);
  if (
    !isLogenResponseItemSucceeded(fareResult) ||
    !fare ||
    !Number.isSafeInteger(deliveryFare) ||
    deliveryFare < 0
  ) {
    throw new RegistrationBlockedError(
      "LOGEN_CONTRACT_FARE_MISSING",
      `박스타입 ${config.boxTypeCode}의 계약운임을 찾지 못했습니다.`
    );
  }

  const fullReceiverAddress = compactText([
    group.receiver_post_code_snapshot,
    group.receiver_address_1_snapshot,
    group.receiver_address_2_snapshot,
  ]);
  const printInfoCall = await getLogenPrintInfoForRegistration(
    customerCode,
    fullReceiverAddress,
    shipmentId,
    workerLease?.signal,
    credentialSession
  );
  const printInfo = firstLogenResponseItem(printInfoCall.result);
  if (!isLogenResponseItemSucceeded(printInfo)) {
    throw new RegistrationBlockedError(
      "LOGEN_ADDRESS_CLASSIFICATION_FAILED",
      resultMessage(printInfo)
    );
  }
  const receiverBranchCode = text(printInfo?.branCd);
  if (!receiverBranchCode) {
    throw new RegistrationBlockedError(
      "LOGEN_RECEIVER_BRANCH_MISSING",
      "로젠 주소 분류 응답에 배송점코드가 없습니다."
    );
  }

  const extraFareCall = await getLogenExtraFareForRegistration(
    {
      custCd: customerCode,
      fareTy: fareType,
      qty: 1,
      goodsAmt: goods.goodsAmount,
      dlvFare: deliveryFare,
    },
    shipmentId,
    workerLease?.signal,
    credentialSession
  );
  const extraFareResult = firstLogenResponseItem(extraFareCall.result);
  const extraFare = Number(extraFareResult?.extraFare ?? 0);
  if (
    !isLogenResponseItemSucceeded(extraFareResult) ||
    !Number.isSafeInteger(extraFare) ||
    extraFare < 0
  ) {
    throw new RegistrationBlockedError(
      "LOGEN_EXTRA_FARE_FAILED",
      resultMessage(extraFareResult)
    );
  }

  const payload: CarrierRequestItem = {
    printYn: "Y",
    slipNo: work.carrier_shipment.tracking_number,
    slipTy: "100",
    orgnSlipNo: "",
    custCd: customerCode,
    sndCustNm: config.sender.name,
    sndTelNo: config.sender.tel,
    sndCellNo: config.sender.cell,
    sndZipCd: config.sender.zipCode,
    sndCustAddr1: config.sender.address1,
    sndCustAddr2: config.sender.address2,
    rcvCustNm: group.receiver_name_snapshot,
    rcvTelNo: group.receiver_phone_snapshot,
    rcvCellNo: group.receiver_phone_snapshot,
    rcvZipCd: group.receiver_post_code_snapshot ?? "",
    rcvCustAddr1: group.receiver_address_1_snapshot,
    rcvCustAddr2: group.receiver_address_2_snapshot,
    fareTy: fareType,
    qty: 1,
    rcvBranCd: receiverBranchCode,
    goodsNm: goods.goodsName.slice(0, 1000),
    dlvFare: deliveryFare,
    extraFare,
    goodsAmt: goods.goodsAmount,
    jejuAmtTy: text(printInfo?.jejuRegYn) === "Y" ? fareType : "",
    shipYn: text(printInfo?.shipYn) || "N",
    takeDt: work.take_date,
    remarks: text(group.shipping_memo_snapshot).slice(0, 1000),
    fixTakeNo: work.fix_take_no,
    jejuAmt: 0,
    shipFare: 0,
    montFare: 0,
    wt: 0,
  };

  return {
    payload,
    classificationApiCallLogId: printInfoCall.apiCallLogId,
    senderProfileHash: hash(config.sender),
    payloadHash: hash(payload),
    customerCode,
    credentialFingerprint: credentialSession.status.keyFingerprint,
    settingsRevision: config.settingsRevision,
    senderName: config.sender.name,
    senderTel: config.sender.tel,
    senderCell: config.sender.cell,
    senderZipCode: config.sender.zipCode,
    senderAddress1: config.sender.address1,
    senderAddress2: config.sender.address2,
    receiverBranchCode,
    receiverDongName: text(printInfo?.dongNm),
    salesOfficeName: text(printInfo?.salesNm),
    terminalName: text(printInfo?.tmlNm),
    branchShareYn: text(printInfo?.branShareYn),
    classificationCode: text(printInfo?.classCd),
    classifiedZipCode: text(printInfo?.zipCd),
    jejuRegionYn: text(printInfo?.jejuRegYn) || "N",
    islandYn: text(printInfo?.shipYn) || "N",
    mountainYn: text(printInfo?.montYn) || "N",
    fareType,
    boxTypeCode: config.boxTypeCode,
    deliveryFare,
    extraFare,
    goodsName: goods.goodsName,
    goodsAmount: goods.goodsAmount,
  };
}

async function finalizeRegistrationSuccess(input: {
  workId: number;
  executionToken: string;
  expectedStatuses: readonly string[];
  apiCallLogId?: number | null;
}) {
  const now = databaseNow();
  const result = await prisma.$transaction(async (tx) => {
    await updateOwnedRegistrationWork(tx, {
      workId: input.workId,
      executionToken: input.executionToken,
      expectedStatuses: input.expectedStatuses,
      data: { updated_at: now },
    });
    const work = await tx.carrier_shipment_registration_works.findUniqueOrThrow({
      where: { carrier_shipment_registration_work_id: input.workId },
      include: {
        carrier_shipment: true,
        package_group: {
          include: {
            invoice_replacement_works: {
              where: { work_status: { in: ACTIVE_REPLACEMENT_STATUSES } },
              select: {
                candidate_carrier_shipment_id: true,
                work_status: true,
              },
            },
          },
        },
      },
    });
    if (
      !registrationGroupIsEligible(
        work.package_group,
        work.carrier_shipment_id
      ) ||
      work.carrier_shipment.package_group_id !== work.package_group_id
    ) {
      throw new RegistrationBlockedError(
        "REGISTRATION_TARGET_CHANGED",
        "로젠 성공 결과를 반영하기 전에 현재 송장이 변경되었습니다."
      );
    }
    try {
      await transitionCarrierInvoiceStatus(tx, {
        carrierShipmentId: work.carrier_shipment_id,
        expectedFrom:
          work.carrier_shipment.invoice_status ===
          CARRIER_INVOICE_STATUS.registered
            ? [CARRIER_INVOICE_STATUS.registered]
            : [CARRIER_INVOICE_STATUS.allocated],
        to: CARRIER_INVOICE_STATUS.registered,
        transitionedAt: now,
        carrierRegisteredAt: work.registered_at ?? now,
        expectedPackageGroupId: work.package_group_id,
        expectedTrackingNumber: work.carrier_shipment.tracking_number,
      });
      await applyObservedCarrierShipmentStatus(tx, {
        carrierShipmentId: work.carrier_shipment_id,
        observedStatus: CARRIER_SHIPMENT_STATUS.registered,
        observedAt: now,
      });
      const updated = await tx.carrier_shipments.updateMany({
        where: {
          carrier_shipment_id: work.carrier_shipment_id,
          package_group_id: work.package_group_id,
          tracking_number: work.carrier_shipment.tracking_number,
          invoice_status: CARRIER_INVOICE_STATUS.registered,
        },
        data: {
          source_type: "SELF_PRINT",
          updated_at: now,
        },
      });
      if (updated.count !== 1) {
        throw new RegistrationBlockedError(
          "CARRIER_SHIPMENT_FINALIZE_CONFLICT",
          "로젠 등록 성공 결과를 현재 송장에 반영하지 못했습니다."
        );
      }
    } catch (error) {
      if (error instanceof CarrierShipmentStateConflictError) {
        throw new RegistrationBlockedError(
          "CARRIER_SHIPMENT_FINALIZE_CONFLICT",
          "Carrier shipment state changed before registration finalization."
        );
      }
      throw error;
    }

    const reconciliation = work.reconciliation_work_id
      ? await tx.carrier_reconciliation_works.findUnique({
          where: {
            carrier_reconciliation_work_id: work.reconciliation_work_id,
          },
        })
      : await tx.carrier_reconciliation_works.findUnique({
          where: {
            carrier_code_operation_type_lookup_key_type_lookup_key_value: {
              carrier_code: "LOGEN",
              operation_type: "slipPrintM",
              lookup_key_type: "TRACKING_NUMBER",
              lookup_key_value: work.carrier_shipment.tracking_number,
            },
          },
        });
    if (reconciliation) {
      await tx.carrier_reconciliation_works.update({
        where: {
          carrier_reconciliation_work_id:
            reconciliation.carrier_reconciliation_work_id,
        },
        data: {
          reconciliation_status: "RESOLVED",
          resolved_at: now,
          last_error_message: null,
          updated_at: now,
        },
      });
      if (reconciliation.api_call_log_id) {
        await tx.carrier_api_call_logs.update({
          where: {
            carrier_api_call_log_id: reconciliation.api_call_log_id,
          },
          data: { processed_status: "RECONCILED" },
        });
      }
    }

    await updateOwnedRegistrationWork(tx, {
      workId: input.workId,
      executionToken: input.executionToken,
      expectedStatuses: input.expectedStatuses,
      data: {
        work_status: WORK_STATUS.registered,
        execution_token: null,
        registration_api_call_log_id:
          input.apiCallLogId ?? reconciliation?.api_call_log_id ?? undefined,
        reconciliation_work_id: null,
        next_attempt_at: null,
        last_error_code: null,
        last_error_message: null,
        registered_at: work.registered_at ?? now,
        review_required_at: null,
        updated_at: now,
      },
    });
    return tx.carrier_shipment_registration_works.findUniqueOrThrow({
      where: { carrier_shipment_registration_work_id: input.workId },
    });
  });
  await projectReplacementFromRegistrationWork({
    registrationWorkId: input.workId,
    projectedAt: now,
  });
  return result;
}

async function reconcileRegistration(
  work: RegistrationWork,
  executionToken: string,
  workerLease: RegistrationWorkerLease
) {
  const call = await getLogenLatestTrackingForReconciliation(
    work.carrier_shipment.tracking_number,
    work.carrier_shipment_id,
    workerLease.signal
  );
  await assertWorkerLeaseActive(workerLease);
  const item = firstLogenResponseItem(call.result);
  if (
    isLogenResponseItemSucceeded(item) &&
    text(item?.slipNo) === work.carrier_shipment.tracking_number
  ) {
    await finalizeRegistrationSuccess({
      workId: work.carrier_shipment_registration_work_id,
      executionToken,
      expectedStatuses: [WORK_STATUS.submitting, WORK_STATUS.reconciling],
    });
    return "registered" as const;
  }

  const now = databaseNow();
  const reviewRequired = work.attempt_count >= MAX_RECONCILIATION_ATTEMPTS;
  const reconciliation = work.reconciliation_work_id
    ? null
    : await prisma.carrier_reconciliation_works.findUnique({
        where: {
          carrier_code_operation_type_lookup_key_type_lookup_key_value: {
            carrier_code: "LOGEN",
            operation_type: "slipPrintM",
            lookup_key_type: "TRACKING_NUMBER",
            lookup_key_value: work.carrier_shipment.tracking_number,
          },
        },
      });
  await updateOwnedRegistrationWork(prisma, {
    workId: work.carrier_shipment_registration_work_id,
    executionToken,
    expectedStatuses: [WORK_STATUS.submitting, WORK_STATUS.reconciling],
    data: {
      work_status: reviewRequired
        ? WORK_STATUS.reviewRequired
        : WORK_STATUS.reconciling,
      execution_token: null,
      reconciliation_work_id:
        work.reconciliation_work_id ??
        reconciliation?.carrier_reconciliation_work_id ??
        undefined,
      next_attempt_at: reviewRequired ? null : retryAt(),
      review_required_at: reviewRequired ? now : null,
      last_error_code: "LOGEN_REGISTRATION_NOT_CONFIRMED",
      last_error_message:
        resultMessage(item) || "로젠 등록 여부를 확인하지 못했습니다.",
      updated_at: now,
    },
  });
  if (reviewRequired) {
    await projectReplacementFromRegistrationWork({
      registrationWorkId: work.carrier_shipment_registration_work_id,
      projectedAt: now,
    });
  }
  return reviewRequired ? ("review" as const) : ("retry" as const);
}

async function processRegistrationWork(
  workId: number,
  workerJobId?: number,
  workerLease?: WorkerLeaseGuard
) {
  const ownedLease = requireRegistrationWorkerLease(workerLease);
  const work = await claimRegistrationWork({
    workId,
    workerJobId,
    workerLease: ownedLease,
  });
  let submissionStarted = false;
  if (!work) return "skipped" as const;
  const executionToken = ownedLease.leaseToken;

  if (
    work.work_status === WORK_STATUS.submitting ||
    work.work_status === WORK_STATUS.reconciling
  ) {
    try {
      return await reconcileRegistration(work, executionToken, ownedLease);
    } catch (error) {
      if (
        isRegistrationExecutionOwnershipLost(error) ||
        ownedLease.signal.aborted
      ) {
        return "skipped" as const;
      }
      throw error;
    }
  }

  try {
    const prepared = await prepareRegistration(work, ownedLease);
    await assertWorkerLeaseActive(ownedLease);
    const now = databaseNow();
    await updateOwnedRegistrationWork(prisma, {
      workId,
      executionToken,
      expectedStatuses: [
        WORK_STATUS.pending,
        WORK_STATUS.prepared,
        WORK_STATUS.retryWaiting,
      ],
      data: {
        work_status: WORK_STATUS.prepared,
        sender_profile_hash: prepared.senderProfileHash,
        payload_hash: prepared.payloadHash,
        customer_code_snapshot: prepared.customerCode,
        sender_name_snapshot: prepared.senderName,
        sender_tel_snapshot: prepared.senderTel,
        sender_cell_snapshot: prepared.senderCell || null,
        sender_zip_code_snapshot: prepared.senderZipCode || null,
        sender_address_1_snapshot: prepared.senderAddress1,
        sender_address_2_snapshot: prepared.senderAddress2,
        receiver_branch_code: prepared.receiverBranchCode,
        receiver_dong_name: prepared.receiverDongName || null,
        sales_office_name: prepared.salesOfficeName || null,
        terminal_name: prepared.terminalName || null,
        branch_share_yn: prepared.branchShareYn || null,
        classification_code: prepared.classificationCode,
        classified_zip_code: prepared.classifiedZipCode,
        jeju_region_yn: prepared.jejuRegionYn,
        island_yn: prepared.islandYn,
        mountain_yn: prepared.mountainYn,
        fare_type: prepared.fareType,
        box_type_code: prepared.boxTypeCode,
        delivery_fare: prepared.deliveryFare,
        extra_fare: prepared.extraFare,
        goods_name_snapshot: prepared.goodsName,
        goods_amount_snapshot: prepared.goodsAmount,
        classification_api_call_log_id:
          prepared.classificationApiCallLogId,
        last_error_code: null,
        last_error_message: null,
        prepared_at: now,
        updated_at: now,
      },
    });

    const currentConfig = await registrationConfigOrBlock();
    if (currentConfig.settingsRevision !== prepared.settingsRevision) {
      throw new LogenRegistrationSettingsChangedError();
    }
    const writeCredentialSession = await openLogenRequestCredentialSession({
      apiName: "slipPrintM",
      operationType: "WRITE",
    });
    assertLogenPreparedCredentialMatchesWriteSession(
      prepared,
      writeCredentialSession
    );
    await assertWorkerLeaseActive(ownedLease);
    await updateOwnedRegistrationWork(prisma, {
      workId,
      executionToken,
      expectedStatuses: [WORK_STATUS.prepared],
      data: {
        work_status: WORK_STATUS.submitting,
        submitting_at: databaseNow(),
        next_attempt_at: null,
        updated_at: databaseNow(),
      },
    });

    submissionStarted = true;
    const submission = await registerLogenPrintedShipment(prepared.payload, {
      carrierShipmentId: work.carrier_shipment_id,
      channel: work.carrier_shipment.channel,
      externalOrderId: work.carrier_shipment.external_order_id,
      externalShipmentId: work.carrier_shipment.external_shipment_id,
      allocationId: work.carrier_shipment.allocation_id,
      pgNo: work.carrier_shipment.pg_no,
      signal: ownedLease.signal,
      credentialSession: writeCredentialSession,
    });
    await assertWorkerLeaseActive(ownedLease);
    if (!submission.succeeded) {
      const blockedAt = databaseNow();
      await updateOwnedRegistrationWork(prisma, {
        workId,
        executionToken,
        expectedStatuses: [WORK_STATUS.submitting],
        data: {
          work_status: WORK_STATUS.blocked,
          execution_token: null,
          registration_api_call_log_id: submission.apiCallLogId,
          last_error_code: "LOGEN_SLIP_PRINT_REJECTED",
          last_error_message: resultMessage(submission.item),
          updated_at: blockedAt,
        },
      });
      await projectReplacementFromRegistrationWork({
        registrationWorkId: workId,
        projectedAt: blockedAt,
      });
      return "blocked" as const;
    }
    await finalizeRegistrationSuccess({
      workId,
      executionToken,
      expectedStatuses: [WORK_STATUS.submitting],
      apiCallLogId: submission.apiCallLogId,
    });
    return "registered" as const;
  } catch (error) {
    if (
      isRegistrationExecutionOwnershipLost(error) ||
      ownedLease.signal.aborted
    ) {
      return "skipped" as const;
    }
    try {
      await assertWorkerLeaseActive(ownedLease);
    } catch {
      return "skipped" as const;
    }
    const details = errorDetails(error);
    const now = databaseNow();
    if (
      error instanceof CarrierApiCallFailureError &&
      error.outcomeUncertain
    ) {
      const reconciliation =
        await prisma.carrier_reconciliation_works.findUnique({
          where: {
            carrier_code_operation_type_lookup_key_type_lookup_key_value: {
              carrier_code: "LOGEN",
              operation_type: "slipPrintM",
              lookup_key_type: "TRACKING_NUMBER",
              lookup_key_value: work.carrier_shipment.tracking_number,
            },
          },
        });
      try {
        await updateOwnedRegistrationWork(prisma, {
          workId,
          executionToken,
          expectedStatuses: [WORK_STATUS.submitting],
          data: {
            work_status: WORK_STATUS.reconciling,
            execution_token: null,
            registration_api_call_log_id: error.apiCallLogId,
            reconciliation_work_id:
              reconciliation?.carrier_reconciliation_work_id ?? null,
            next_attempt_at: retryAt(),
            last_error_code: details.code,
            last_error_message: details.message.slice(0, 2000),
            updated_at: now,
          },
        });
      } catch (ownershipError) {
        if (isRegistrationExecutionOwnershipLost(ownershipError)) {
          return "skipped" as const;
        }
        throw ownershipError;
      }
      return "reconciling" as const;
    }

    const blocked =
      error instanceof RegistrationBlockedError ||
      isShipmentReturnConflictError(error) ||
      (error instanceof CarrierApiCallFailureError && submissionStarted);
    const exhausted = work.attempt_count >= MAX_PREPARATION_ATTEMPTS;
    try {
      await updateOwnedRegistrationWork(prisma, {
        workId,
        executionToken,
        expectedStatuses: submissionStarted
          ? [WORK_STATUS.submitting]
          : [WORK_STATUS.pending, WORK_STATUS.prepared, WORK_STATUS.retryWaiting],
        data: {
          work_status:
            blocked || exhausted
              ? WORK_STATUS.blocked
              : WORK_STATUS.retryWaiting,
          execution_token: null,
          next_attempt_at: blocked || exhausted ? null : retryAt(),
          last_error_code: details.code,
          last_error_message: details.message.slice(0, 2000),
          updated_at: now,
        },
      });
    } catch (ownershipError) {
      if (isRegistrationExecutionOwnershipLost(ownershipError)) {
        return "skipped" as const;
      }
      throw ownershipError;
    }
    if (blocked || exhausted) {
      await projectReplacementFromRegistrationWork({
        registrationWorkId: workId,
        projectedAt: now,
      });
    }
    return blocked || exhausted ? ("blocked" as const) : ("retry" as const);
  }
}

export async function processLogenShipmentRegistrationWorks(input: {
  limit?: number;
  workerJobId?: number;
  workerLease?: WorkerLeaseGuard;
} = {}) {
  const workerLease = requireRegistrationWorkerLease(input.workerLease);
  await assertWorkerLeaseActive(workerLease);
  const discoveredCount = await discoverMissingLogenRegistrationWorks();
  await assertWorkerLeaseActive(workerLease);
  const now = databaseNow();
  const works = await prisma.carrier_shipment_registration_works.findMany({
    where: {
      work_status: { in: [...AUTOMATIC_WORK_STATUSES] },
      AND: [
        {
          OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }],
        },
        {
          OR: [
            { execution_token: null },
            { execution_token: { not: workerLease.leaseToken } },
          ],
        },
      ],
    },
    orderBy: [
      { issue_item: { issue_batch: { created_at: "asc" } } },
      { issue_item: { issue_sequence: "asc" } },
      { carrier_shipment_registration_work_id: "asc" },
    ],
    take: Math.max(1, Math.min(input.limit ?? 30, 100)),
    select: { carrier_shipment_registration_work_id: true },
  });

  const summary = {
    discoveredCount,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    warningCount: 0,
  };
  for (const work of works) {
    await assertWorkerLeaseActive(workerLease);
    const result = await processRegistrationWork(
      work.carrier_shipment_registration_work_id,
      input.workerJobId,
      workerLease
    );
    summary.processedCount += 1;
    if (result === "registered") summary.succeededCount += 1;
    else if (result === "skipped") summary.skippedCount += 1;
    else if (result === "reconciling" || result === "review")
      summary.warningCount += 1;
    else summary.failedCount += 1;
  }
  return summary;
}

export async function queueLogenRegistrationForIssueBatch(input: {
  issueBatchId: number;
  reconcileOnly?: boolean;
}) {
  const batch = await prisma.carrier_invoice_issue_batches.findUnique({
    where: { carrier_invoice_issue_batch_id: input.issueBatchId },
    include: {
      items: {
        include: { carrier_shipment: true, registration_work: true },
      },
    },
  });
  if (!batch) {
    throw publicNotFound(
      "INVOICE_ISSUE_BATCH_NOT_FOUND",
      "송장 발급 차수를 찾지 못했습니다."
    );
  }
  let queuedCount = 0;
  for (const item of batch.items) {
    if (!item.carrier_shipment_id || !item.carrier_shipment) continue;
    const created = !item.registration_work;
    const work =
      item.registration_work ??
      (await enqueueLogenRegistrationWork(prisma, {
        carrierShipmentId: item.carrier_shipment_id,
        packageGroupId: item.package_group_id,
      }));
    if (created) {
      queuedCount += 1;
      continue;
    }
    const statuses = input.reconcileOnly
      ? [
          WORK_STATUS.reconciling,
          WORK_STATUS.reviewRequired,
          WORK_STATUS.submitting,
        ]
      : [WORK_STATUS.blocked, WORK_STATUS.retryWaiting];
    if (statuses.includes(work.work_status as never)) {
      const now = databaseNow();
      const queued =
        await prisma.carrier_shipment_registration_works.updateMany({
          where: {
            carrier_shipment_registration_work_id:
              work.carrier_shipment_registration_work_id,
            work_status: work.work_status,
            attempt_count: work.attempt_count,
            execution_token: work.execution_token,
          },
          data: {
            work_status: input.reconcileOnly
              ? WORK_STATUS.reconciling
              : WORK_STATUS.pending,
            execution_token: null,
            next_attempt_at: now,
            review_required_at: null,
            updated_at: now,
          },
        });
      queuedCount += queued.count;
    }
  }
  return queuedCount;
}
