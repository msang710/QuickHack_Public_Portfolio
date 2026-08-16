import type { Prisma } from "@/generated/prisma/client";
import { databaseDateTime } from "@/quickhack_server/core/database/time-boundary";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import {
  maskAddress,
  maskMemo,
  maskName,
  maskPhone,
} from "@/quickhack_server/security/sensitive-data";
import {
  isPersonalDataLifecycleDue,
  reconcilePersonalDataLifecyclesForOrder,
} from "@/quickhack_server/security/personal-data-lifecycle-service";
import { SHIPMENT_PACKAGE_GROUP_STATUS } from "@/quickhack_shared/shipment/package-group";
import { TERMINAL_CARRIER_INVOICE_REPLACEMENT_STATUSES } from "@/quickhack_shared/shipment/invoice-replacement";
import { throwIfWorkerLeaseAborted } from "@/quickhack_server/workers/lease-guard";
import type { WorkerLeaseGuard } from "@/quickhack_server/workers/types";

type TransactionClient = Prisma.TransactionClient;

export type PersonalDataTableSummary = {
  table: string;
  scanned: number;
  updated: number;
};

export type PersonalDataSubjectRedactionResult = {
  eligible: boolean;
  completed: boolean;
  alreadyRedacted: boolean;
  deferredActiveWork: number;
  deferredSharedSubjects: number;
  sanitizedCopies: number;
  tables: PersonalDataTableSummary[];
};

export type PersonalDataSubjectKey = {
  channel: string;
  externalOrderId: string;
  externalShipmentId: string;
};

const SHIPMENT_ADDRESS_CHANGED_EVENT_TYPE = "SHIPMENT_ADDRESS_CHANGED";
const TERMINAL_ADDRESS_CHANGE_STATUSES = new Set([
  "CONFIRMED",
  "IGNORED",
  "FAILED",
]);
const TERMINAL_PACKAGE_GROUP_STATUSES = new Set<string>([
  SHIPMENT_PACKAGE_GROUP_STATUS.invalidated,
  SHIPMENT_PACKAGE_GROUP_STATUS.split,
  SHIPMENT_PACKAGE_GROUP_STATUS.canceled,
  SHIPMENT_PACKAGE_GROUP_STATUS.completed,
]);
const TERMINAL_REPLACEMENT_STATUSES = new Set<string>(
  TERMINAL_CARRIER_INVOICE_REPLACEMENT_STATUSES
);
const PERSONAL_ADDRESS_FIELD_NAMES = new Set([
  "receiver_name",
  "receiver_safe_number",
  "receiver_post_code",
  "receiver_address_1",
  "receiver_address_2",
  "shipping_memo",
]);
const SUMMARY_TABLES = [
  "coupang_order_raw",
  "coupang_raw_change_event_field",
  "shipment_address_change_work_field",
  "shipment_package_groups",
  "carrier_invoice_replacement_works",
  "orders",
] as const;

function changedText(
  left: string | null | undefined,
  right: string | null | undefined
) {
  return String(left ?? "") !== String(right ?? "");
}

function summaryMap() {
  return new Map<string, PersonalDataTableSummary>(
    SUMMARY_TABLES.map((table) => [
      table,
      {
        table,
        scanned: 0,
        updated: 0,
      },
    ])
  );
}

function summaryFor(
  summaries: Map<string, PersonalDataTableSummary>,
  table: (typeof SUMMARY_TABLES)[number]
) {
  return summaries.get(table)!;
}

function subjectKey(input: {
  channel: string;
  externalOrderId: string;
  externalShipmentId: string;
}) {
  return `${input.channel}\u0000${input.externalOrderId}\u0000${input.externalShipmentId}`;
}

function maskAddressChangeValue(
  fieldName: string,
  value: string | null
) {
  if (!PERSONAL_ADDRESS_FIELD_NAMES.has(fieldName)) {
    return value;
  }
  if (fieldName === "receiver_name") return maskName(value) || null;
  if (fieldName === "receiver_safe_number") {
    return maskPhone(value, 4) || null;
  }
  if (
    fieldName === "receiver_address_1" ||
    fieldName === "receiver_address_2" ||
    fieldName === "receiver_post_code"
  ) {
    return maskAddress(value) || null;
  }
  return maskMemo(value) || null;
}

async function redactRawOrder(
  tx: TransactionClient,
  input: PersonalDataSubjectKey,
  redactedAt: Date,
  summaries: Map<string, PersonalDataTableSummary>
) {
  const summary = summaryFor(summaries, "coupang_order_raw");
  const order = await tx.coupang_order_raw.findUnique({
    where: {
      external_order_id_external_shipment_id: {
        external_order_id: input.externalOrderId,
        external_shipment_id: input.externalShipmentId,
      },
    },
    select: {
      coupang_order_raw_id: true,
      orderer_name: true,
      receiver_name: true,
      receiver_safe_number: true,
      receiver_post_code: true,
      receiver_address_1: true,
      receiver_address_2: true,
      shipping_memo: true,
    },
  });
  if (!order) return;

  summary.scanned += 1;
  const data = {
    orderer_name: maskName(order.orderer_name) || null,
    receiver_name: maskName(order.receiver_name) || null,
    receiver_safe_number: maskPhone(order.receiver_safe_number, 4) || null,
    receiver_post_code: maskAddress(order.receiver_post_code) || null,
    receiver_address_1: maskAddress(order.receiver_address_1) || null,
    receiver_address_2: maskAddress(order.receiver_address_2) || null,
    shipping_memo: maskMemo(order.shipping_memo) || null,
  };
  const changed =
    changedText(order.orderer_name, data.orderer_name) ||
    changedText(order.receiver_name, data.receiver_name) ||
    changedText(order.receiver_safe_number, data.receiver_safe_number) ||
    changedText(order.receiver_post_code, data.receiver_post_code) ||
    changedText(order.receiver_address_1, data.receiver_address_1) ||
    changedText(order.receiver_address_2, data.receiver_address_2) ||
    changedText(order.shipping_memo, data.shipping_memo);
  if (!changed) return;

  await tx.coupang_order_raw.update({
    where: { coupang_order_raw_id: order.coupang_order_raw_id },
    data: {
      ...data,
      updated_at: redactedAt,
    },
  });
  summary.updated += 1;
}

async function redactAddressChangeEventFields(
  tx: TransactionClient,
  input: PersonalDataSubjectKey,
  summaries: Map<string, PersonalDataTableSummary>,
  workerLease?: WorkerLeaseGuard
) {
  const summary = summaryFor(
    summaries,
    "coupang_raw_change_event_field"
  );
  const events = await tx.coupang_raw_change_event.findMany({
    where: {
      external_order_id: input.externalOrderId,
      external_shipment_id: input.externalShipmentId,
      event_type: SHIPMENT_ADDRESS_CHANGED_EVENT_TYPE,
    },
    select: {
      fields: {
        where: {
          field_name: { in: [...PERSONAL_ADDRESS_FIELD_NAMES] },
        },
        select: {
          coupang_raw_change_event_field_id: true,
          field_name: true,
          before_value: true,
          after_value: true,
        },
      },
    },
  });

  for (const event of events) {
    for (const field of event.fields) {
      throwIfWorkerLeaseAborted(workerLease);
      summary.scanned += 1;
      const beforeValue = maskAddressChangeValue(
        field.field_name,
        field.before_value
      );
      const afterValue = maskAddressChangeValue(
        field.field_name,
        field.after_value
      );
      if (
        !changedText(field.before_value, beforeValue) &&
        !changedText(field.after_value, afterValue)
      ) {
        continue;
      }
      await tx.coupang_raw_change_event_field.update({
        where: {
          coupang_raw_change_event_field_id:
            field.coupang_raw_change_event_field_id,
        },
        data: {
          before_value: beforeValue,
          after_value: afterValue,
        },
      });
      summary.updated += 1;
    }
  }
}

async function redactAddressChangeWorkFields(
  tx: TransactionClient,
  input: PersonalDataSubjectKey,
  summaries: Map<string, PersonalDataTableSummary>,
  workerLease?: WorkerLeaseGuard
) {
  const summary = summaryFor(
    summaries,
    "shipment_address_change_work_field"
  );
  let deferredActiveWork = 0;
  const works = await tx.shipment_address_change_work.findMany({
    where: {
      external_order_id: input.externalOrderId,
      external_shipment_id: input.externalShipmentId,
    },
    select: {
      change_status: true,
      fields: {
        where: {
          field_name: { in: [...PERSONAL_ADDRESS_FIELD_NAMES] },
        },
        select: {
          shipment_address_change_work_field_id: true,
          field_name: true,
          before_value: true,
          after_value: true,
        },
      },
    },
  });

  for (const work of works) {
    throwIfWorkerLeaseAborted(workerLease);
    if (!TERMINAL_ADDRESS_CHANGE_STATUSES.has(work.change_status)) {
      deferredActiveWork += 1;
      continue;
    }
    for (const field of work.fields) {
      throwIfWorkerLeaseAborted(workerLease);
      summary.scanned += 1;
      const beforeValue = maskAddressChangeValue(
        field.field_name,
        field.before_value
      );
      const afterValue = maskAddressChangeValue(
        field.field_name,
        field.after_value
      );
      if (
        !changedText(field.before_value, beforeValue) &&
        !changedText(field.after_value, afterValue)
      ) {
        continue;
      }
      await tx.shipment_address_change_work_field.update({
        where: {
          shipment_address_change_work_field_id:
            field.shipment_address_change_work_field_id,
        },
        data: {
          before_value: beforeValue,
          after_value: afterValue,
        },
      });
      summary.updated += 1;
    }
  }
  return deferredActiveWork;
}

function lifecycleMap(
  rows: Array<{
    channel: string;
    external_order_id: string;
    external_shipment_id: string;
    active_claim_count: number;
    retention_started_at: Date | null;
  }>
) {
  return new Map(
    rows.map((row) => [
      subjectKey({
        channel: row.channel,
        externalOrderId: row.external_order_id,
        externalShipmentId: row.external_shipment_id,
      }),
      row,
    ])
  );
}

async function packageGroupIsDue(
  tx: TransactionClient,
  group: {
    channel: string;
    group_status: string;
    members: Array<{
      external_order_id: string;
      external_shipment_id: string;
    }>;
    invoice_replacement_works: Array<{ work_status: string }>;
  },
  cutoff: Date
) {
  if (!TERMINAL_PACKAGE_GROUP_STATUSES.has(group.group_status)) {
    return { due: false, activeWork: true };
  }
  if (
    group.invoice_replacement_works.some(
      (work) => !TERMINAL_REPLACEMENT_STATUSES.has(work.work_status)
    )
  ) {
    return { due: false, activeWork: true };
  }
  const members = Array.from(
    new Map(
      group.members.map((member) => [
        `${member.external_order_id}\u0000${member.external_shipment_id}`,
        member,
      ])
    ).values()
  );
  if (members.length === 0) {
    return { due: false, activeWork: false };
  }
  const lifecycles =
    await tx.sales_channel_personal_data_lifecycles.findMany({
      where: {
        channel: group.channel,
        OR: members.map((member) => ({
          external_order_id: member.external_order_id,
          external_shipment_id: member.external_shipment_id,
        })),
      },
      select: {
        channel: true,
        external_order_id: true,
        external_shipment_id: true,
        active_claim_count: true,
        retention_started_at: true,
      },
    });
  const bySubject = lifecycleMap(lifecycles);
  const everyMemberDue = members.every((member) => {
    const lifecycle = bySubject.get(
      subjectKey({
        channel: group.channel,
        externalOrderId: member.external_order_id,
        externalShipmentId: member.external_shipment_id,
      })
    );
    return Boolean(lifecycle && isPersonalDataLifecycleDue(lifecycle, cutoff));
  });
  return { due: everyMemberDue, activeWork: false };
}

async function redactPackageGroup(
  tx: TransactionClient,
  packageGroupId: number,
  cutoff: Date,
  redactedAt: Date,
  summaries: Map<string, PersonalDataTableSummary>,
  workerLease?: WorkerLeaseGuard
) {
  const groupSummary = summaryFor(summaries, "shipment_package_groups");
  const replacementSummary = summaryFor(
    summaries,
    "carrier_invoice_replacement_works"
  );
  const group = await tx.shipment_package_groups.findUnique({
    where: { package_group_id: packageGroupId },
    select: {
      package_group_id: true,
      channel: true,
      group_status: true,
      receiver_name_snapshot: true,
      receiver_address_snapshot: true,
      receiver_phone_snapshot: true,
      receiver_post_code_snapshot: true,
      receiver_address_1_snapshot: true,
      receiver_address_2_snapshot: true,
      shipping_memo_snapshot: true,
      members: {
        select: {
          external_order_id: true,
          external_shipment_id: true,
        },
      },
      invoice_replacement_works: {
        select: {
          carrier_invoice_replacement_work_id: true,
          work_status: true,
          before_receiver_name: true,
          before_receiver_phone: true,
          before_receiver_post_code: true,
          before_receiver_address_1: true,
          before_receiver_address_2: true,
          before_shipping_memo: true,
          after_receiver_name: true,
          after_receiver_phone: true,
          after_receiver_post_code: true,
          after_receiver_address_1: true,
          after_receiver_address_2: true,
          after_shipping_memo: true,
        },
      },
    },
  });
  if (!group) {
    return { deferredActiveWork: 0, deferredSharedSubjects: 0 };
  }

  const eligibility = await packageGroupIsDue(tx, group, cutoff);
  if (!eligibility.due) {
    return {
      deferredActiveWork: eligibility.activeWork ? 1 : 0,
      deferredSharedSubjects: eligibility.activeWork ? 0 : 1,
    };
  }

  throwIfWorkerLeaseAborted(workerLease);
  groupSummary.scanned += 1;
  const groupData = {
    receiver_name_snapshot: maskName(group.receiver_name_snapshot),
    receiver_address_snapshot: maskAddress(
      group.receiver_address_snapshot
    ),
    receiver_phone_snapshot:
      maskPhone(group.receiver_phone_snapshot, 4) || null,
    receiver_post_code_snapshot:
      maskAddress(group.receiver_post_code_snapshot) || null,
    receiver_address_1_snapshot:
      maskAddress(group.receiver_address_1_snapshot) || null,
    receiver_address_2_snapshot:
      maskAddress(group.receiver_address_2_snapshot) || null,
    shipping_memo_snapshot:
      maskMemo(group.shipping_memo_snapshot) || null,
  };
  const groupChanged =
    changedText(
      group.receiver_name_snapshot,
      groupData.receiver_name_snapshot
    ) ||
    changedText(
      group.receiver_address_snapshot,
      groupData.receiver_address_snapshot
    ) ||
    changedText(
      group.receiver_phone_snapshot,
      groupData.receiver_phone_snapshot
    ) ||
    changedText(
      group.receiver_post_code_snapshot,
      groupData.receiver_post_code_snapshot
    ) ||
    changedText(
      group.receiver_address_1_snapshot,
      groupData.receiver_address_1_snapshot
    ) ||
    changedText(
      group.receiver_address_2_snapshot,
      groupData.receiver_address_2_snapshot
    ) ||
    changedText(
      group.shipping_memo_snapshot,
      groupData.shipping_memo_snapshot
    );
  if (groupChanged) {
    await tx.shipment_package_groups.update({
      where: { package_group_id: group.package_group_id },
      data: {
        ...groupData,
        updated_at: redactedAt,
      },
    });
    groupSummary.updated += 1;
  }

  for (const work of group.invoice_replacement_works) {
    throwIfWorkerLeaseAborted(workerLease);
    replacementSummary.scanned += 1;
    const data = {
      before_receiver_name: maskName(work.before_receiver_name) || null,
      before_receiver_phone:
        maskPhone(work.before_receiver_phone, 4) || null,
      before_receiver_post_code:
        maskAddress(work.before_receiver_post_code) || null,
      before_receiver_address_1:
        maskAddress(work.before_receiver_address_1) || null,
      before_receiver_address_2:
        maskAddress(work.before_receiver_address_2) || null,
      before_shipping_memo: maskMemo(work.before_shipping_memo) || null,
      after_receiver_name: maskName(work.after_receiver_name) || null,
      after_receiver_phone:
        maskPhone(work.after_receiver_phone, 4) || null,
      after_receiver_post_code:
        maskAddress(work.after_receiver_post_code) || null,
      after_receiver_address_1:
        maskAddress(work.after_receiver_address_1) || null,
      after_receiver_address_2:
        maskAddress(work.after_receiver_address_2) || null,
      after_shipping_memo: maskMemo(work.after_shipping_memo) || null,
    };
    const changed = Object.entries(data).some(([key, value]) =>
      changedText(
        work[key as keyof typeof data] as string | null | undefined,
        value
      )
    );
    if (!changed) continue;
    await tx.carrier_invoice_replacement_works.update({
      where: {
        carrier_invoice_replacement_work_id:
          work.carrier_invoice_replacement_work_id,
      },
      data: {
        ...data,
        updated_at: redactedAt,
      },
    });
    replacementSummary.updated += 1;
  }

  return { deferredActiveWork: 0, deferredSharedSubjects: 0 };
}

async function redactLinkedPackageGroups(
  tx: TransactionClient,
  input: PersonalDataSubjectKey,
  cutoff: Date,
  redactedAt: Date,
  summaries: Map<string, PersonalDataTableSummary>,
  workerLease?: WorkerLeaseGuard
) {
  const memberships = await tx.shipment_package_group_members.findMany({
    where: {
      external_order_id: input.externalOrderId,
      external_shipment_id: input.externalShipmentId,
    },
    select: { package_group_id: true },
  });
  let deferredActiveWork = 0;
  let deferredSharedSubjects = 0;
  for (const packageGroupId of new Set(
    memberships.map((membership) => membership.package_group_id)
  )) {
    throwIfWorkerLeaseAborted(workerLease);
    const result = await redactPackageGroup(
      tx,
      packageGroupId,
      cutoff,
      redactedAt,
      summaries,
      workerLease
    );
    deferredActiveWork += result.deferredActiveWork;
    deferredSharedSubjects += result.deferredSharedSubjects;
  }
  return { deferredActiveWork, deferredSharedSubjects };
}

async function redactLegacyOrder(
  tx: TransactionClient,
  input: PersonalDataSubjectKey,
  cutoff: Date,
  redactedAt: Date,
  summaries: Map<string, PersonalDataTableSummary>
) {
  const summary = summaryFor(summaries, "orders");
  const order = await tx.orders.findUnique({
    where: {
      platform_platform_order_id: {
        platform: input.channel,
        platform_order_id: input.externalOrderId,
      },
    },
    select: {
      order_id: true,
      buyer_name: true,
      receiver_name: true,
      phone: true,
      shipping_address: true,
      shipping_memo: true,
    },
  });
  if (!order) return 0;

  const lifecycles =
    await tx.sales_channel_personal_data_lifecycles.findMany({
      where: {
        channel: input.channel,
        external_order_id: input.externalOrderId,
      },
      select: {
        active_claim_count: true,
        retention_started_at: true,
      },
    });
  if (
    lifecycles.length === 0 ||
    lifecycles.some(
      (lifecycle) => !isPersonalDataLifecycleDue(lifecycle, cutoff)
    )
  ) {
    return 1;
  }

  summary.scanned += 1;
  const data = {
    buyer_name: maskName(order.buyer_name) || null,
    receiver_name: maskName(order.receiver_name) || null,
    phone: maskPhone(order.phone, 4) || null,
    shipping_address: maskAddress(order.shipping_address) || null,
    shipping_memo: maskMemo(order.shipping_memo) || null,
  };
  const changed =
    changedText(order.buyer_name, data.buyer_name) ||
    changedText(order.receiver_name, data.receiver_name) ||
    changedText(order.phone, data.phone) ||
    changedText(order.shipping_address, data.shipping_address) ||
    changedText(order.shipping_memo, data.shipping_memo);
  if (changed) {
    await tx.orders.update({
      where: { order_id: order.order_id },
      data: {
        ...data,
        updated_at: redactedAt,
      },
    });
    summary.updated += 1;
  }
  return 0;
}

export async function redactPersonalDataCopiesForSubject(
  tx: TransactionClient,
  input: {
    lifecycleId: number;
    cutoff: Date;
    redactedAt: DateTimeInput;
    workerLease?: WorkerLeaseGuard;
  }
): Promise<PersonalDataSubjectRedactionResult> {
  throwIfWorkerLeaseAborted(input.workerLease);
  const redactedAt = databaseDateTime(input.redactedAt);
  const lifecycle =
    await tx.sales_channel_personal_data_lifecycles.findUnique({
      where: { personal_data_lifecycle_id: input.lifecycleId },
    });
  const emptyTables = Array.from(summaryMap().values());
  if (!lifecycle) {
    return {
      eligible: false,
      completed: false,
      alreadyRedacted: false,
      deferredActiveWork: 0,
      deferredSharedSubjects: 0,
      sanitizedCopies: 0,
      tables: emptyTables,
    };
  }

  await reconcilePersonalDataLifecyclesForOrder(tx, {
    channel: lifecycle.channel,
    externalOrderId: lifecycle.external_order_id,
    externalShipmentId: lifecycle.external_shipment_id,
    now: redactedAt,
  });
  const current =
    await tx.sales_channel_personal_data_lifecycles.findUnique({
      where: { personal_data_lifecycle_id: input.lifecycleId },
    });
  if (
    !current ||
    !isPersonalDataLifecycleDue(current, input.cutoff)
  ) {
    return {
      eligible: false,
      completed: false,
      alreadyRedacted: false,
      deferredActiveWork: 0,
      deferredSharedSubjects: 0,
      sanitizedCopies: 0,
      tables: emptyTables,
    };
  }
  if (current.redacted_at) {
    return {
      eligible: true,
      completed: true,
      alreadyRedacted: true,
      deferredActiveWork: 0,
      deferredSharedSubjects: 0,
      sanitizedCopies: 0,
      tables: emptyTables,
    };
  }

  const summaries = summaryMap();
  const subject = {
    channel: current.channel,
    externalOrderId: current.external_order_id,
    externalShipmentId: current.external_shipment_id,
  };
  await redactRawOrder(tx, subject, redactedAt, summaries);
  await redactAddressChangeEventFields(
    tx,
    subject,
    summaries,
    input.workerLease
  );
  let deferredActiveWork = await redactAddressChangeWorkFields(
    tx,
    subject,
    summaries,
    input.workerLease
  );
  const groupResult = await redactLinkedPackageGroups(
    tx,
    subject,
    input.cutoff,
    redactedAt,
    summaries,
    input.workerLease
  );
  deferredActiveWork += groupResult.deferredActiveWork;
  let deferredSharedSubjects = groupResult.deferredSharedSubjects;
  deferredSharedSubjects += await redactLegacyOrder(
    tx,
    subject,
    input.cutoff,
    redactedAt,
    summaries
  );

  const completed =
    deferredActiveWork === 0 && deferredSharedSubjects === 0;
  if (completed) {
    await tx.sales_channel_personal_data_lifecycles.update({
      where: {
        personal_data_lifecycle_id: current.personal_data_lifecycle_id,
      },
      data: {
        redacted_at: redactedAt,
        updated_at: redactedAt,
      },
    });
  }
  const tables = Array.from(summaries.values());
  return {
    eligible: true,
    completed,
    alreadyRedacted: false,
    deferredActiveWork,
    deferredSharedSubjects,
    sanitizedCopies: tables.reduce(
      (sum, summary) => sum + summary.updated,
      0
    ),
    tables,
  };
}

export async function findExpiredPersonalDataSubjects(
  tx: TransactionClient,
  input: {
    channel: string;
    subjects: Array<{
      externalOrderId: string;
      externalShipmentId: string;
    }>;
    cutoff: Date;
  }
) {
  const subjects = Array.from(
    new Map(
      input.subjects.map((subject) => [
        `${subject.externalOrderId}\u0000${subject.externalShipmentId}`,
        subject,
      ])
    ).values()
  );
  if (subjects.length === 0) return [];
  const lifecycles =
    await tx.sales_channel_personal_data_lifecycles.findMany({
      where: {
        channel: input.channel,
        OR: subjects.map((subject) => ({
          external_order_id: subject.externalOrderId,
          external_shipment_id: subject.externalShipmentId,
        })),
      },
      select: {
        external_order_id: true,
        external_shipment_id: true,
        active_claim_count: true,
        retention_started_at: true,
        redacted_at: true,
      },
    });
  return lifecycles
    .filter(
      (lifecycle) =>
        Boolean(lifecycle.redacted_at) ||
        isPersonalDataLifecycleDue(lifecycle, input.cutoff)
    )
    .map((lifecycle) => ({
      externalOrderId: lifecycle.external_order_id,
      externalShipmentId: lifecycle.external_shipment_id,
    }));
}
