"use client";

import * as React from "react";
import {
  AlertTriangle,
  Database,
  PackageSearch,
  RefreshCcw,
  Wrench,
} from "lucide-react";
import {
  formatSalesChannelDifference,
  formatSalesChannelInventoryOption,
  formatSalesChannelQuantity,
  formatSalesChannelSyncCheckDate,
  inventoryVerificationStatusVariant,
  isInventoryVerificationRecheckable,
  SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS_LABELS,
} from "@/quickhack_client/components/admin/sales-channel-sync-check-presentation";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { DialogFrame } from "@/quickhack_client/components/ui/dialog-frame";
import {
  DescriptionList,
  DescriptionRow,
} from "@/quickhack_client/components/ui/description-list";
import { cn } from "@/quickhack_shared/core/utils";
import type { SalesChannelInventoryVerificationSyncCheckItem } from "@/quickhack_shared/sales-channel/sync-checks";

function QuantityCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "default" | "danger" | "success";
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-muted/30 p-3",
        tone === "danger" && "border-red-200 bg-red-50",
        tone === "success" && "border-emerald-200 bg-emerald-50"
      )}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-lg font-semibold tabular-nums",
          tone === "danger" && "text-red-700",
          tone === "success" && "text-emerald-700"
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function SalesChannelInventoryVerificationDetail({
  item,
  working,
  onRecheck,
  onRepair,
}: {
  item: SalesChannelInventoryVerificationSyncCheckItem;
  working: boolean;
  onRecheck: () => void | Promise<void>;
  onRepair: () => void | Promise<void>;
}) {
  const [repairDialogOpen, setRepairDialogOpen] = React.useState(false);
  const recheckable = isInventoryVerificationRecheckable(
    item.verificationStatus
  );
  const differenceTone =
    item.difference === 0
      ? "success"
      : item.difference === null
        ? "default"
        : "danger";
  const repairable =
    item.verificationStatus === "MISMATCH" &&
    item.channelQuantity !== null &&
    Boolean(item.mismatchSince);

  return (
    <div>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-background px-4 py-3">
        <PackageSearch className="size-4 text-red-700" />
        <h3 className="text-sm font-semibold">재고 점검 #{item.id}</h3>
        <Badge
          className="ml-auto"
          variant={inventoryVerificationStatusVariant(item.verificationStatus)}
        >
          {SALES_CHANNEL_INVENTORY_VERIFICATION_STATUS_LABELS[
            item.verificationStatus
          ] ?? item.verificationStatus}
        </Badge>
      </div>

      <DescriptionList className="px-4 py-2">
        <DescriptionRow
          label="채널"
          value={item.channel || "-"}
          labelWidth="116px"
        />
        <DescriptionRow
          label="상품 ID"
          value={
            <span className="break-all font-mono text-xs">
              {item.externalProductId || "-"}
            </span>
          }
          labelWidth="116px"
        />
        <DescriptionRow
          label="vendorItemId"
          value={
            <span className="break-all font-mono text-xs">
              {item.externalVendorItemId || "-"}
            </span>
          }
          labelWidth="116px"
        />
        <DescriptionRow
          label="외부 옵션"
          value={
            <span className="break-words">
              {item.externalOptionName || "-"}
            </span>
          }
          labelWidth="116px"
        />
        <DescriptionRow
          label="판매 오퍼"
          value={item.offerCode || "-"}
          labelWidth="116px"
        />
        <DescriptionRow
          label="모델"
          value={item.model || "-"}
          labelWidth="116px"
        />
        <DescriptionRow
          label="용량"
          value={formatSalesChannelInventoryOption(
            item.storageMatchMode,
            item.storage
          )}
          labelWidth="116px"
        />
        <DescriptionRow
          label="색상"
          value={formatSalesChannelInventoryOption(
            item.colorMatchMode,
            item.color
          )}
          labelWidth="116px"
        />
        <DescriptionRow
          label="보증"
          value={item.warranty || "-"}
          labelWidth="116px"
        />
      </DescriptionList>

      <div className="border-t border-border p-4">
        <div className="mb-3 flex items-center gap-2">
          <Database className="size-4 text-muted-foreground" />
          <h4 className="text-xs font-semibold text-muted-foreground">
            수량 판정 근거
          </h4>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <QuantityCard
            label="원장 판매가능"
            value={formatSalesChannelQuantity(item.ledgerQuantity)}
          />
          <QuantityCard
            label="미반영 주문"
            value={formatSalesChannelQuantity(item.pendingOrderQuantity)}
          />
          <QuantityCard
            label="기대 채널"
            value={formatSalesChannelQuantity(item.expectedChannelQuantity)}
          />
          <QuantityCard
            label="실제 채널"
            value={formatSalesChannelQuantity(item.channelQuantity)}
          />
          <div className="sm:col-span-2">
            <QuantityCard
              label="차이 (실제 - 기대)"
              value={formatSalesChannelDifference(item.difference)}
              tone={differenceTone}
            />
          </div>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          기대 채널수량 = max(0, 원장 판매가능수량 - 미반영 주문수량)
        </p>
      </div>

      <DescriptionList className="border-t border-border px-4 py-2">
        <DescriptionRow
          label="기준 버전"
          value={item.desiredVersion}
          labelWidth="116px"
        />
        <DescriptionRow
          label="처리 버전"
          value={item.processingVersion ?? "-"}
          labelWidth="116px"
        />
        <DescriptionRow
          label="최근 점검"
          value={formatSalesChannelSyncCheckDate(item.lastCheckedAt)}
          labelWidth="116px"
        />
        <DescriptionRow
          label="불일치 시작"
          value={formatSalesChannelSyncCheckDate(item.mismatchSince)}
          labelWidth="116px"
        />
        <DescriptionRow
          label="점검 실패 횟수"
          value={item.retryCount}
          labelWidth="116px"
        />
        <DescriptionRow
          label="해소 시각"
          value={formatSalesChannelSyncCheckDate(item.resolvedAt)}
          labelWidth="116px"
        />
        <DescriptionRow
          label="최근 오류"
          value={
            <span className="break-words">
              {[item.lastErrorCode, item.lastErrorMessage]
                .filter(Boolean)
                .join(" · ") || "-"}
            </span>
          }
          labelWidth="116px"
        />
        <DescriptionRow
          label="API 로그 / 작업"
          value={`${item.lastApiCallLogId ?? "-"} / ${item.lastWorkerJobId ?? "-"}`}
          labelWidth="116px"
        />
      </DescriptionList>

      <div className="border-t border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <div className="flex gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            다시 점검하면 최신 원장과 미반영 주문으로 기대수량을 다시 계산한 뒤
            해당 쿠팡 옵션을 한 번 조회합니다. 이 작업은 쿠팡 재고수량을
            수정하지 않습니다.
          </p>
        </div>
        {recheckable ? (
          <div className="mt-3 grid grid-cols-1 gap-2">
            <Button
              className="w-full"
              variant="outline"
              disabled={working}
              onClick={() => void onRecheck()}
            >
              <RefreshCcw className={cn("size-4", working && "animate-spin")} />
              {working ? "처리 중..." : "최신 수량으로 다시 점검"}
            </Button>
            {repairable ? (
              <Button
                className="w-full"
                disabled={working}
                onClick={() => setRepairDialogOpen(true)}
              >
                <Wrench className="size-4" />
                쿠팡 재고수량 복구
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-xs">
            수량 불일치 또는 점검 실패 상태에서만 다시 점검할 수 있습니다.
          </p>
        )}
      </div>

      <DialogFrame
        open={repairDialogOpen}
        onOpenChange={(open) => {
          if (!working) setRepairDialogOpen(open);
        }}
        title="쿠팡 재고수량 복구"
        description="최신 상태가 아래 snapshot과 같을 때만 exact vendorItemId 한 건을 기대수량으로 변경합니다."
        icon={<Wrench className="size-5 text-red-700" />}
        closeDisabled={working}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={working}
              onClick={() => setRepairDialogOpen(false)}
            >
              취소
            </Button>
            <Button
              type="button"
              disabled={working}
              onClick={async () => {
                await onRepair();
                setRepairDialogOpen(false);
              }}
            >
              <Wrench className="size-4" />
              {working
                ? "복구 확인 중..."
                : `기대수량 ${item.expectedChannelQuantity.toLocaleString("ko-KR")}개로 복구`}
            </Button>
          </div>
        }
      >
        <DescriptionList>
          <DescriptionRow
            label="vendorItemId"
            value={
              <span className="break-all font-mono text-xs">
                {item.externalVendorItemId}
              </span>
            }
            labelWidth="132px"
          />
          <DescriptionRow
            label="원장 판매가능"
            value={formatSalesChannelQuantity(item.ledgerQuantity)}
            labelWidth="132px"
          />
          <DescriptionRow
            label="미반영 주문"
            value={formatSalesChannelQuantity(item.pendingOrderQuantity)}
            labelWidth="132px"
          />
          <DescriptionRow
            label="현재 쿠팡"
            value={formatSalesChannelQuantity(item.channelQuantity)}
            labelWidth="132px"
          />
          <DescriptionRow
            label="복구 기대수량"
            value={formatSalesChannelQuantity(item.expectedChannelQuantity)}
            labelWidth="132px"
          />
          <DescriptionRow
            label="차이 (실제 - 기대)"
            value={formatSalesChannelDifference(item.difference)}
            labelWidth="132px"
          />
        </DescriptionList>
        <p className="mt-4 border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
          복구 직전에 원장·미반영 주문·쿠팡 수량을 다시 확인합니다. 값이
          달라졌거나 처리 결과를 확정할 수 없으면 자동으로 다시 쓰지 않고
          판매 채널 동기화 점검의 쓰기 결과에 남깁니다.
        </p>
      </DialogFrame>
    </div>
  );
}
