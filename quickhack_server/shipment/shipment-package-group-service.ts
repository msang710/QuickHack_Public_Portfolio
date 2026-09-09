import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { publicConflict } from "@/quickhack_server/core/public-error";
import {
  ACTIVE_SHIPMENT_PACKAGE_GROUP_STATUSES,
  SHIPMENT_PACKAGE_GROUP_STATUS,
  shipmentPackageCandidateKey,
  shipmentPackageGroupRows,
} from "@/quickhack_shared/shipment/package-group";
import { personalDataRetentionCutoff } from "@/quickhack_server/security/personal-data-lifecycle-service";
import { findExpiredPersonalDataSubjects } from "@/quickhack_server/security/personal-data-redaction-service";
import type { DateTimeInput } from "@/quickhack_shared/core/time";
import { databaseDateTime } from "@/quickhack_server/core/database/time-boundary";

type PackageGroupClient = Prisma.TransactionClient;

export type PackageGroupAllocation = {
  allocation_id: number;
  external_order_id: string;
  external_shipment_id: string;
  pg_no: string;
  order: {
    receiver_name: string | null;
    receiver_safe_number: string | null;
    receiver_post_code: string | null;
    receiver_address_1: string | null;
    receiver_address_2: string | null;
    shipping_memo: string | null;
    ordered_at: Date | string | null;
  };
};

export type PackageGroupAssignment = {
  packageGroupId: number;
  packageGroupKey: string;
  packageGroupSize: number;
  memberSequence: number;
};

function compactText(values: Array<string | number | null | undefined>) {
  return values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" / ");
}

function receiverAddress(allocation: PackageGroupAllocation) {
  return compactText([
    allocation.order.receiver_post_code,
    allocation.order.receiver_address_1,
    allocation.order.receiver_address_2,
  ]);
}

export function packageGroupKeyForAllocation(
  allocation: PackageGroupAllocation
) {
  return shipmentPackageCandidateKey({
    receiverName: allocation.order.receiver_name,
    receiverAddress: receiverAddress(allocation),
    fallbackKey: `allocation:${allocation.allocation_id}`,
  });
}

function persistedGroupingKey(channel: string, candidateKey: string) {
  return createHash("sha256")
    .update(`${channel}\u0000${candidateKey}`)
    .digest("hex");
}

function compareAllocations(
  left: PackageGroupAllocation,
  right: PackageGroupAllocation
) {
  const orderedAtResult = String(left.order.ordered_at ?? "").localeCompare(
    String(right.order.ordered_at ?? "")
  );

  return orderedAtResult || left.allocation_id - right.allocation_id;
}

export function expandPackageGroupSelection<T extends PackageGroupAllocation>(
  selectedAllocations: T[],
  eligibleAllocations: T[]
) {
  const selectedKeys = new Set(
    selectedAllocations.map(packageGroupKeyForAllocation)
  );

  return eligibleAllocations
    .filter((allocation) =>
      selectedKeys.has(packageGroupKeyForAllocation(allocation))
    )
    .sort(compareAllocations);
}

export async function createDraftShipmentPackageGroups<
  T extends PackageGroupAllocation,
>(
  client: PackageGroupClient,
  input: {
    channel: string;
    allocations: T[];
    createdAt: DateTimeInput;
  }
) {
  const createdAt = databaseDateTime(input.createdAt);
  const allocationIds = input.allocations.map(
    (allocation) => allocation.allocation_id
  );

  if (allocationIds.length === 0) {
    throw new Error("합포장 그룹에 포함할 출고 항목이 없습니다.");
  }

  const expiredSubjects = await findExpiredPersonalDataSubjects(client, {
    channel: input.channel,
    subjects: input.allocations.map((allocation) => ({
      externalOrderId: allocation.external_order_id,
      externalShipmentId: allocation.external_shipment_id,
    })),
    cutoff: personalDataRetentionCutoff(
      createdAt
    ),
  });
  if (expiredSubjects.length > 0) {
    throw new Error(
      "개인정보 보존기간이 만료된 주문은 새 합포장 그룹을 만들 수 없습니다."
    );
  }

  const activeMemberships =
    await client.shipment_package_group_members.findMany({
      where: {
        allocation_id: { in: allocationIds },
        removed_at: null,
        package_group: {
          group_status: {
            in: [...ACTIVE_SHIPMENT_PACKAGE_GROUP_STATUSES],
          },
        },
      },
      include: {
        package_group: true,
      },
    });

  if (activeMemberships.length > 0) {
    const details = activeMemberships
      .map(
        (member) =>
          `${member.allocation_id}(그룹 ${member.package_group_id}/${member.package_group.group_status})`
      )
      .join(", ");
    throw new Error(`이미 활성 합포장 그룹에 포함된 항목입니다: ${details}`);
  }

  const grouped = shipmentPackageGroupRows(
    [...input.allocations].sort(compareAllocations),
    packageGroupKeyForAllocation
  );
  const assignments = new Map<number, PackageGroupAssignment>();
  const groups = [];

  for (const [candidateKey, allocations] of grouped) {
    const first = allocations[0];
    const name = String(first.order.receiver_name ?? "").trim() || "수취인 미입력";
    const address = receiverAddress(first) || "주소 미입력";

    const group = await client.shipment_package_groups.create({
      data: {
        channel: input.channel,
        grouping_key: persistedGroupingKey(input.channel, candidateKey),
        receiver_name_snapshot: name,
        receiver_address_snapshot: address,
        receiver_phone_snapshot: first.order.receiver_safe_number,
        receiver_post_code_snapshot: first.order.receiver_post_code,
        receiver_address_1_snapshot: first.order.receiver_address_1,
        receiver_address_2_snapshot: first.order.receiver_address_2,
        shipping_memo_snapshot: first.order.shipping_memo,
        group_status: SHIPMENT_PACKAGE_GROUP_STATUS.draft,
        created_at: createdAt,
        updated_at: createdAt,
      },
    });

    await client.shipment_package_group_members.createMany({
      data: allocations.map((allocation, index) => ({
        package_group_id: group.package_group_id,
        allocation_id: allocation.allocation_id,
        external_order_id: allocation.external_order_id,
        external_shipment_id: allocation.external_shipment_id,
        member_sequence: index + 1,
        added_at: createdAt,
      })),
    });

    allocations.forEach((allocation, index) => {
      assignments.set(allocation.allocation_id, {
        packageGroupId: group.package_group_id,
        packageGroupKey: candidateKey,
        packageGroupSize: allocations.length,
        memberSequence: index + 1,
      });
    });
    groups.push(group);
  }

  return { groups, assignments };
}

export async function freezeShipmentPackageGroups(
  client: PackageGroupClient,
  packageGroupIds: number[],
  frozenAtInput: DateTimeInput
) {
  if (packageGroupIds.length === 0) return;

  const frozenAt = databaseDateTime(frozenAtInput);
  const uniquePackageGroupIds = Array.from(new Set(packageGroupIds));

  const updated = await client.shipment_package_groups.updateMany({
    where: {
      package_group_id: { in: uniquePackageGroupIds },
      group_status: SHIPMENT_PACKAGE_GROUP_STATUS.draft,
    },
    data: {
      group_status: SHIPMENT_PACKAGE_GROUP_STATUS.frozen,
      frozen_at: frozenAt,
      updated_at: frozenAt,
    },
  });

  if (updated.count !== uniquePackageGroupIds.length) {
    throw publicConflict(
      "SHIPMENT_PACKAGE_GROUP_STATE_CONFLICT",
      "SHIPMENT_PACKAGE_GROUP_STATE_CONFLICT",
      {
        packageGroupIds: uniquePackageGroupIds,
        expectedStatus: SHIPMENT_PACKAGE_GROUP_STATUS.draft,
        requestedStatus: SHIPMENT_PACKAGE_GROUP_STATUS.frozen,
        updatedCount: updated.count,
      }
    );
  }
}

export async function cancelShipmentPackageGroups(
  client: PackageGroupClient,
  packageGroupIds: number[],
  canceledAtInput: DateTimeInput
) {
  if (packageGroupIds.length === 0) return;

  const canceledAt = databaseDateTime(canceledAtInput);
  const uniquePackageGroupIds = Array.from(new Set(packageGroupIds));

  const updated = await client.shipment_package_groups.updateMany({
    where: {
      package_group_id: { in: uniquePackageGroupIds },
      group_status: SHIPMENT_PACKAGE_GROUP_STATUS.draft,
    },
    data: {
      group_status: SHIPMENT_PACKAGE_GROUP_STATUS.canceled,
      invalidated_at: canceledAt,
      invalidation_reason: "SHIPMENT_PRINT_BATCH_CANCELED",
      updated_at: canceledAt,
    },
  });

  if (updated.count !== uniquePackageGroupIds.length) {
    throw publicConflict(
      "SHIPMENT_PACKAGE_GROUP_STATE_CONFLICT",
      "SHIPMENT_PACKAGE_GROUP_STATE_CONFLICT",
      {
        packageGroupIds: uniquePackageGroupIds,
        expectedStatus: SHIPMENT_PACKAGE_GROUP_STATUS.draft,
        requestedStatus: SHIPMENT_PACKAGE_GROUP_STATUS.canceled,
        updatedCount: updated.count,
      }
    );
  }
}

export async function applyPreShipmentReturnToPackageGroups(
  client: PackageGroupClient,
  input: {
    allocationIds: readonly number[];
    returnedAt: DateTimeInput;
    operationKey: string;
  }
) {
  const returnedAt = databaseDateTime(input.returnedAt);
  const allocationIds = Array.from(
    new Set(input.allocationIds.filter((id) => Number.isSafeInteger(id) && id > 0))
  ).sort((left, right) => left - right);
  if (allocationIds.length === 0) return { affectedGroupIds: [] as number[] };

  const memberships = await client.shipment_package_group_members.findMany({
    where: {
      allocation_id: { in: allocationIds },
      removed_at: null,
      package_group: {
        group_status: { in: [...ACTIVE_SHIPMENT_PACKAGE_GROUP_STATUSES] },
      },
    },
    select: { package_group_id: true },
  });
  const groupIds = Array.from(
    new Set(memberships.map((membership) => membership.package_group_id))
  ).sort((left, right) => left - right);
  const returnedAllocationIds = new Set(allocationIds);

  for (const groupId of groupIds) {
    await client.$queryRaw`
      SELECT package_group_id
      FROM shipment_package_groups
      WHERE package_group_id = ${groupId}
      FOR UPDATE
    `;
    const group = await client.shipment_package_groups.findUnique({
      where: { package_group_id: groupId },
      include: {
        members: {
          where: { removed_at: null },
          orderBy: [{ member_sequence: "asc" }, { package_group_member_id: "asc" }],
        },
      },
    });
    if (!group) throw new Error(`합포장 그룹을 찾을 수 없습니다: ${groupId}`);

    const returnedMembers = group.members.filter((member) =>
      returnedAllocationIds.has(member.allocation_id)
    );
    if (returnedMembers.length === 0) continue;
    const remainingMembers = group.members.filter(
      (member) => !returnedAllocationIds.has(member.allocation_id)
    );
    const returnedMemberIds = returnedMembers.map(
      (member) => member.package_group_member_id
    );

    if (group.group_status === SHIPMENT_PACKAGE_GROUP_STATUS.draft) {
      if (group.current_carrier_shipment_id !== null) {
        throw new Error(`DRAFT 합포장 그룹 ${groupId}에 현재 송장이 연결되어 있습니다.`);
      }
      await client.shipment_package_group_members.updateMany({
        where: { package_group_member_id: { in: returnedMemberIds }, removed_at: null },
        data: { removed_at: returnedAt },
      });
      if (remainingMembers.length === 0) {
        await client.shipment_package_groups.update({
          where: { package_group_id: groupId },
          data: {
            group_status: SHIPMENT_PACKAGE_GROUP_STATUS.canceled,
            invalidated_at: returnedAt,
            invalidation_reason: "PRE_SHIPMENT_RETURN_ALL_MEMBERS",
            revision: { increment: 1 },
            updated_at: returnedAt,
          },
        });
      } else {
        await client.shipment_package_groups.update({
          where: { package_group_id: groupId },
          data: { revision: { increment: 1 }, updated_at: returnedAt },
        });
      }
      continue;
    }

    if (group.group_status === SHIPMENT_PACKAGE_GROUP_STATUS.frozen) {
      if (group.current_carrier_shipment_id !== null) {
        throw new Error(`FROZEN 합포장 그룹 ${groupId}에 현재 송장이 연결되어 있습니다.`);
      }
      await client.shipment_package_group_members.updateMany({
        where: { package_group_id: groupId, removed_at: null },
        data: { removed_at: returnedAt },
      });
      await client.shipment_package_groups.update({
        where: { package_group_id: groupId },
        data: {
          group_status: SHIPMENT_PACKAGE_GROUP_STATUS.invalidated,
          invalidated_at: returnedAt,
          invalidation_reason: "PRE_SHIPMENT_RETURN_FROZEN_GROUP",
          revision: { increment: 1 },
          updated_at: returnedAt,
        },
      });
      if (remainingMembers.length > 0) {
        const successor = await client.shipment_package_groups.create({
          data: {
            channel: group.channel,
            grouping_key: persistedGroupingKey(
              group.channel,
              `${group.grouping_key}:return:${input.operationKey}:${groupId}`
            ),
            receiver_name_snapshot: group.receiver_name_snapshot,
            receiver_address_snapshot: group.receiver_address_snapshot,
            receiver_phone_snapshot: group.receiver_phone_snapshot,
            receiver_post_code_snapshot: group.receiver_post_code_snapshot,
            receiver_address_1_snapshot: group.receiver_address_1_snapshot,
            receiver_address_2_snapshot: group.receiver_address_2_snapshot,
            shipping_memo_snapshot: group.shipping_memo_snapshot,
            group_status: SHIPMENT_PACKAGE_GROUP_STATUS.draft,
            split_from_group_id: groupId,
            created_at: returnedAt,
            updated_at: returnedAt,
          },
        });
        await client.shipment_package_group_members.createMany({
          data: remainingMembers.map((member, index) => ({
            package_group_id: successor.package_group_id,
            allocation_id: member.allocation_id,
            external_order_id: member.external_order_id,
            external_shipment_id: member.external_shipment_id,
            member_sequence: index + 1,
            added_at: returnedAt,
          })),
        });
      }
      continue;
    }

    if (
      group.group_status === SHIPMENT_PACKAGE_GROUP_STATUS.ready ||
      group.group_status === SHIPMENT_PACKAGE_GROUP_STATUS.onHold
    ) {
      if (group.current_carrier_shipment_id === null) {
        throw new Error(`송장 단계 합포장 그룹 ${groupId}에 현재 송장이 없습니다.`);
      }
      await client.shipment_package_group_members.updateMany({
        where: { package_group_member_id: { in: returnedMemberIds }, removed_at: null },
        data: { removed_at: returnedAt },
      });
      await client.shipment_package_groups.update({
        where: { package_group_id: groupId },
        data: {
          group_status:
            remainingMembers.length === 0
              ? SHIPMENT_PACKAGE_GROUP_STATUS.invalidated
              : SHIPMENT_PACKAGE_GROUP_STATUS.onHold,
          invalidated_at: remainingMembers.length === 0 ? returnedAt : null,
          invalidation_reason:
            remainingMembers.length === 0
              ? "PRE_SHIPMENT_RETURN_ALL_MEMBERS_WITH_INVOICE"
              : "PRE_SHIPMENT_RETURN_INVOICE_SCOPE_CHANGED",
          revision: { increment: 1 },
          updated_at: returnedAt,
        },
      });
      continue;
    }

    throw new Error(
      `합포장 그룹 ${groupId}의 ${group.group_status} 상태에서는 출고중지 반품을 확정할 수 없습니다.`
    );
  }

  return { affectedGroupIds: groupIds };
}

export async function splitDraftShipmentPackageGroup(
  client: PackageGroupClient,
  input: {
    packageGroupId: number;
    allocationIds: number[];
    splitAt: DateTimeInput;
  }
) {
  const splitAt = databaseDateTime(input.splitAt);
  const group = await client.shipment_package_groups.findUnique({
    where: { package_group_id: input.packageGroupId },
    include: {
      members: {
        where: { removed_at: null },
        orderBy: { member_sequence: "asc" },
      },
      shipment_print_items: {
        select: { shipment_list_print_batch_item_id: true },
      },
    },
  });

  if (!group) throw new Error("합포장 그룹을 찾지 못했습니다.");
  if (group.group_status !== SHIPMENT_PACKAGE_GROUP_STATUS.draft) {
    throw new Error("확정되거나 종료된 합포장 그룹은 분할할 수 없습니다.");
  }
  if (group.shipment_print_items.length > 0) {
    throw new Error("출고 출력 차수에 포함된 합포장 그룹은 분할할 수 없습니다.");
  }

  const selectedIds = new Set(
    input.allocationIds.filter((id) => Number.isInteger(id) && id > 0)
  );
  const selected = group.members.filter((member) =>
    selectedIds.has(member.allocation_id)
  );
  const remaining = group.members.filter(
    (member) => !selectedIds.has(member.allocation_id)
  );

  if (selected.length === 0 || remaining.length === 0) {
    throw new Error("분할은 그룹 구성원의 일부만 선택해야 합니다.");
  }
  if (selected.length !== selectedIds.size) {
    throw new Error("선택한 항목 중 현재 합포장 그룹에 속하지 않은 항목이 있습니다.");
  }

  await client.shipment_package_groups.update({
    where: { package_group_id: group.package_group_id },
    data: {
      group_status: SHIPMENT_PACKAGE_GROUP_STATUS.split,
      invalidated_at: splitAt,
      invalidation_reason: "MANUAL_SPLIT",
      updated_at: splitAt,
    },
  });

  const childGroups = [];

  for (const [suffix, members] of [
    ["A", remaining],
    ["B", selected],
  ] as const) {
    const child = await client.shipment_package_groups.create({
      data: {
        channel: group.channel,
        grouping_key: persistedGroupingKey(
          group.channel,
          `${group.grouping_key}:split:${suffix}:${members
            .map((member) => member.allocation_id)
            .join(",")}`
        ),
        receiver_name_snapshot: group.receiver_name_snapshot,
        receiver_address_snapshot: group.receiver_address_snapshot,
        receiver_phone_snapshot: group.receiver_phone_snapshot,
        receiver_post_code_snapshot: group.receiver_post_code_snapshot,
        receiver_address_1_snapshot: group.receiver_address_1_snapshot,
        receiver_address_2_snapshot: group.receiver_address_2_snapshot,
        shipping_memo_snapshot: group.shipping_memo_snapshot,
        group_status: SHIPMENT_PACKAGE_GROUP_STATUS.draft,
        split_from_group_id: group.package_group_id,
        created_at: splitAt,
        updated_at: splitAt,
      },
    });

    await client.shipment_package_group_members.createMany({
      data: members.map((member, index) => ({
        package_group_id: child.package_group_id,
        allocation_id: member.allocation_id,
        external_order_id: member.external_order_id,
        external_shipment_id: member.external_shipment_id,
        member_sequence: index + 1,
        added_at: splitAt,
      })),
    });
    childGroups.push(child);
  }

  await client.shipment_package_group_members.updateMany({
    where: {
      package_group_id: group.package_group_id,
      removed_at: null,
    },
    data: { removed_at: splitAt },
  });

  return childGroups;
}
