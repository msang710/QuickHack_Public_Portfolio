import { publicConflict } from "@/quickhack_server/core/public-error";
import {
  SALES_CHANNEL_WRITE_REQUEST_TYPE,
  type SalesChannelWriteRequestType,
} from "@/quickhack_shared/sales-channel/write-requests";

export type SalesChannelWriteGroupTarget = {
  sales_channel_write_request_target_id: number;
  target_external_id: string | null;
  external_shipment_id: string | null;
  external_vendor_item_id: string | null;
  inventory_verification_state_id: number | null;
};

export type SalesChannelWriteTargetGroup<
  TTarget extends SalesChannelWriteGroupTarget = SalesChannelWriteGroupTarget,
> = {
  groupKey: string;
  representativeTargetId: number;
  targetIds: number[];
  targets: TTarget[];
};

export type SalesChannelWriteTargetGroupingInput<
  TTarget extends SalesChannelWriteGroupTarget = SalesChannelWriteGroupTarget,
> = {
  requestType: SalesChannelWriteRequestType | string;
  requestTargetExternalId: string | null;
  targets: readonly TTarget[];
};

function requiredIdentity(value: unknown, label: string) {
  const identity = String(value ?? "").trim();
  if (!identity) {
    throw new Error(`Sales-channel write target has no ${label}.`);
  }
  return identity;
}

export function salesChannelWriteTargetGroupKey(
  requestType: SalesChannelWriteRequestType | string,
  requestTargetExternalId: string | null,
  target: SalesChannelWriteGroupTarget
) {
  if (
    requestType === SALES_CHANNEL_WRITE_REQUEST_TYPE.orderStatusInstruct ||
    requestType === SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpload ||
    requestType === SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInvoiceUpdate
  ) {
    return `SHIPMENT:${requiredIdentity(
      target.external_shipment_id ?? target.target_external_id,
      "external shipment identity"
    )}`;
  }

  if (
    requestType === SALES_CHANNEL_WRITE_REQUEST_TYPE.returnStoppedShipment ||
    requestType ===
      SALES_CHANNEL_WRITE_REQUEST_TYPE.returnReceiveConfirmation ||
    requestType === SALES_CHANNEL_WRITE_REQUEST_TYPE.returnApproval
  ) {
    return `RETURN:${requiredIdentity(
      requestTargetExternalId,
      "external return receipt identity"
    )}`;
  }

  if (
    requestType ===
    SALES_CHANNEL_WRITE_REQUEST_TYPE.coupangInventoryQuantityUpdate
  ) {
    return `INVENTORY:${requiredIdentity(
      target.inventory_verification_state_id ??
        target.external_vendor_item_id ??
        target.target_external_id,
      "inventory verification identity"
    )}`;
  }

  throw new Error(`Unsupported sales-channel write request type: ${requestType}`);
}

export function groupSalesChannelWriteTargets<
  TTarget extends SalesChannelWriteGroupTarget,
>(input: SalesChannelWriteTargetGroupingInput<TTarget>) {
  const groups = new Map<string, SalesChannelWriteTargetGroup<TTarget>>();

  for (const target of input.targets) {
    const groupKey = salesChannelWriteTargetGroupKey(
      input.requestType,
      input.requestTargetExternalId,
      target
    );
    const existing = groups.get(groupKey);
    if (existing) {
      existing.targetIds.push(target.sales_channel_write_request_target_id);
      existing.targets.push(target);
      continue;
    }

    groups.set(groupKey, {
      groupKey,
      representativeTargetId:
        target.sales_channel_write_request_target_id,
      targetIds: [target.sales_channel_write_request_target_id],
      targets: [target],
    });
  }

  return [...groups.values()];
}

export function findSalesChannelWriteTargetGroup<
  TTarget extends SalesChannelWriteGroupTarget,
>(input: {
  requestType: SalesChannelWriteRequestType | string;
  requestTargetExternalId: string | null;
  targets: readonly TTarget[];
  targetId: number;
}) {
  const group = groupSalesChannelWriteTargets({
    requestType: input.requestType,
    requestTargetExternalId: input.requestTargetExternalId,
    targets: input.targets,
  }).find((candidate) => candidate.targetIds.includes(input.targetId));

  if (!group) {
    throw publicConflict(
      "SALES_CHANNEL_TARGET_GROUP_NOT_FOUND",
      "SALES_CHANNEL_TARGET_GROUP_NOT_FOUND"
    );
  }

  return group;
}
