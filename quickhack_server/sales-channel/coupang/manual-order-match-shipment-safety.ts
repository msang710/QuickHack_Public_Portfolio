import type { Prisma } from "@/generated/prisma/client";
import { CARRIER_INVOICE_STATUS } from "@/quickhack_shared/shipment/carrier-invoice-status";
import { CARRIER_SHIPMENT_STATUS } from "@/quickhack_shared/shipment/carrier-tracking-status";
import {
  ACTIVE_CARRIER_INVOICE_REPLACEMENT_STATUSES,
} from "@/quickhack_shared/shipment/invoice-replacement";
import {
  ACTIVE_CARRIER_INVOICE_ISSUE_BATCH_STATUSES,
  ACTIVE_CARRIER_REGISTRATION_WORK_STATUSES,
  ACTIVE_SHIPMENT_ADDRESS_CHANGE_STATUSES,
} from "@/quickhack_shared/shipment/carrier-workflow-status";
import { ACTIVE_SHIPMENT_PACKAGE_GROUP_STATUSES } from "@/quickhack_shared/shipment/package-group";

type SafetyClient = Prisma.TransactionClient;

function numbers(values: Array<number | null | undefined>) {
  return [...new Set(values.filter((value): value is number => value != null))]
    .sort((left, right) => left - right);
}

function strings(values: string[]) {
  return [...new Set(values)].sort();
}

export function manualOrderMatchShipmentSafetyBlockers(input: {
  memberships: Array<{
    removed_at: Date | null;
    package_group: { group_status: string };
  }>;
  carrierShipments: Array<{ invoice_status: string; shipment_status: string }>;
  issueItems: Array<{ issue_batch: { batch_status: string } }>;
  registrationWorks: Array<{ work_status: string }>;
  replacementWorks: Array<{ work_status: string }>;
  addressWorks: Array<{ change_status: string }>;
  carrierReturnCount: number;
}) {
  const blockerCodes: string[] = [];
  if (
    input.memberships.some(
      (row) =>
        row.removed_at === null &&
        (ACTIVE_SHIPMENT_PACKAGE_GROUP_STATUSES as readonly string[]).includes(
          row.package_group.group_status
        )
    )
  ) {
    blockerCodes.push("ACTIVE_PACKAGE_GROUP");
  }
  if (
    input.carrierShipments.some(
      (row) =>
        row.invoice_status !== CARRIER_INVOICE_STATUS.voidLocal ||
        row.shipment_status !== CARRIER_SHIPMENT_STATUS.allocated
    )
  ) {
    blockerCodes.push("CARRIER_SHIPMENT_EXISTS");
  }
  if (
    input.issueItems.some((row) =>
      (ACTIVE_CARRIER_INVOICE_ISSUE_BATCH_STATUSES as readonly string[]).includes(
        row.issue_batch.batch_status
      )
    ) ||
    input.registrationWorks.some((row) =>
      (ACTIVE_CARRIER_REGISTRATION_WORK_STATUSES as readonly string[]).includes(
        row.work_status
      )
    ) ||
    input.replacementWorks.some((row) =>
      (ACTIVE_CARRIER_INVOICE_REPLACEMENT_STATUSES as readonly string[]).includes(
        row.work_status
      )
    )
  ) {
    blockerCodes.push("CARRIER_OPERATION_ACTIVE");
  }
  if (
    input.addressWorks.some((row) =>
      (ACTIVE_SHIPMENT_ADDRESS_CHANGE_STATUSES as readonly string[]).includes(
        row.change_status
      )
    )
  ) {
    blockerCodes.push("SHIPMENT_ADDRESS_CHANGE_ACTIVE");
  }
  if (input.carrierReturnCount > 0) blockerCodes.push("RETURN_STARTED");
  return strings(blockerCodes);
}

export async function readManualOrderMatchShipmentSafety(
  tx: SafetyClient,
  input: {
    externalOrderId: string;
    externalShipmentId: string;
    allocationIds: number[];
  }
) {
  const allocationIds = numbers(input.allocationIds);
  const memberships = allocationIds.length
    ? await tx.shipment_package_group_members.findMany({
        where: { allocation_id: { in: allocationIds } },
        select: {
          package_group_member_id: true,
          package_group_id: true,
          allocation_id: true,
          removed_at: true,
          package_group: {
            select: {
              revision: true,
              group_status: true,
              current_carrier_shipment_id: true,
            },
          },
        },
        orderBy: { package_group_member_id: "asc" },
      })
    : [];
  const packageGroupIds = numbers(memberships.map((row) => row.package_group_id));

  const [carrierShipments, issueItems, registrationWorks, replacementWorks, addressWorks] =
    await Promise.all([
      tx.carrier_shipments.findMany({
        where: {
          OR: [
            ...(allocationIds.length ? [{ allocation_id: { in: allocationIds } }] : []),
            ...(packageGroupIds.length ? [{ package_group_id: { in: packageGroupIds } }] : []),
            {
              channel: "COUPANG",
              external_order_id: input.externalOrderId,
              external_shipment_id: input.externalShipmentId,
            },
          ],
        },
        select: {
          carrier_shipment_id: true,
          revision: true,
          allocation_id: true,
          package_group_id: true,
          invoice_status: true,
          shipment_status: true,
          replaces_carrier_shipment_id: true,
        },
        orderBy: { carrier_shipment_id: "asc" },
      }),
      packageGroupIds.length
        ? tx.carrier_invoice_issue_items.findMany({
            where: { package_group_id: { in: packageGroupIds } },
            select: {
              carrier_invoice_issue_item_id: true,
              package_group_id: true,
              item_status: true,
              label_print_status: true,
              carrier_shipment_id: true,
              issue_batch: {
                select: {
                  carrier_invoice_issue_batch_id: true,
                  revision: true,
                  batch_status: true,
                  label_print_status: true,
                },
              },
            },
            orderBy: { carrier_invoice_issue_item_id: "asc" },
          })
        : Promise.resolve([]),
      packageGroupIds.length
        ? tx.carrier_shipment_registration_works.findMany({
            where: { package_group_id: { in: packageGroupIds } },
            select: {
              carrier_shipment_registration_work_id: true,
              revision: true,
              package_group_id: true,
              carrier_shipment_id: true,
              work_status: true,
              execution_token: true,
            },
            orderBy: { carrier_shipment_registration_work_id: "asc" },
          })
        : Promise.resolve([]),
      packageGroupIds.length
        ? tx.carrier_invoice_replacement_works.findMany({
            where: { package_group_id: { in: packageGroupIds } },
            select: {
              carrier_invoice_replacement_work_id: true,
              package_group_id: true,
              workflow_version: true,
              work_status: true,
              current_stage: true,
              old_carrier_shipment_id: true,
              candidate_carrier_shipment_id: true,
            },
            orderBy: { carrier_invoice_replacement_work_id: "asc" },
          })
        : Promise.resolve([]),
      tx.shipment_address_change_work.findMany({
        where: {
          external_order_id: input.externalOrderId,
          external_shipment_id: input.externalShipmentId,
        },
        select: {
          shipment_address_change_work_id: true,
          allocation_id: true,
          package_group_id: true,
          carrier_shipment_id_at_detection: true,
          change_status: true,
          shipment_stage_at_detection: true,
          updated_at: true,
        },
        orderBy: { shipment_address_change_work_id: "asc" },
      }),
    ]);

  const carrierShipmentIds = numbers(
    carrierShipments.map((row) => row.carrier_shipment_id)
  );
  const carrierReturns = carrierShipmentIds.length
    ? await tx.carrier_return_requests.findMany({
        where: { carrier_shipment_id: { in: carrierShipmentIds } },
        select: {
          carrier_return_request_id: true,
          carrier_shipment_id: true,
          request_status: true,
          reservation_status: true,
          updated_at: true,
        },
        orderBy: { carrier_return_request_id: "asc" },
      })
    : [];

  const blockerCodes = manualOrderMatchShipmentSafetyBlockers({
    memberships,
    carrierShipments,
    issueItems,
    registrationWorks,
    replacementWorks,
    addressWorks,
    carrierReturnCount: carrierReturns.length,
  });

  return {
    blockerCodes: strings(blockerCodes),
    memberships,
    carrierShipments,
    issueItems,
    registrationWorks,
    replacementWorks,
    addressWorks,
    carrierReturns,
  };
}
