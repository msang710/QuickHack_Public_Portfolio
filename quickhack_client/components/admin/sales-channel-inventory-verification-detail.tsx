"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
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
  const t = useTranslations("admin.inventoryVerification");
  const syncT = useTranslations("admin.syncCheck");
  const locale = useLocale();
  const formatOptions = {
    locale,
    unknownLabel: syncT("format.unknown"),
    anyLabel: syncT("format.any"),
    randomLabel: syncT("format.random"),
  };
  const statusLabel = {
    PENDING: t("status.pending"),
    CHECKING: t("status.checking"),
    MATCHED: t("status.matched"),
    MISMATCH: t("status.mismatch"),
    CHECK_FAILED: t("status.checkFailed"),
    SKIPPED: t("status.skipped"),
  }[item.verificationStatus];
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
        <h3 className="text-sm font-semibold">{t("title", { id: item.id })}</h3>
        <Badge
          className="ml-auto"
          variant={inventoryVerificationStatusVariant(item.verificationStatus)}
        >
          {statusLabel}
        </Badge>
      </div>

      <DescriptionList className="px-4 py-2">
        <DescriptionRow
          label={t("fields.channel")}
          value={item.channel || "-"}
          labelWidth="116px"
        />
        <DescriptionRow
          label={t("fields.productId")}
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
          label={t("fields.externalOption")}
          value={
            <span className="break-words">
              {item.externalOptionName || "-"}
            </span>
          }
          labelWidth="116px"
        />
        <DescriptionRow
          label={t("fields.offer")}
          value={item.offerCode || "-"}
          labelWidth="116px"
        />
        <DescriptionRow
          label={t("fields.model")}
          value={item.model || "-"}
          labelWidth="116px"
        />
        <DescriptionRow
          label={t("fields.storage")}
          value={formatSalesChannelInventoryOption(
            item.storageMatchMode,
            item.storage,
            formatOptions
          )}
          labelWidth="116px"
        />
        <DescriptionRow
          label={t("fields.color")}
          value={formatSalesChannelInventoryOption(
            item.colorMatchMode,
            item.color,
            formatOptions
          )}
          labelWidth="116px"
        />
        <DescriptionRow
          label={t("fields.warranty")}
          value={item.warranty || "-"}
          labelWidth="116px"
        />
      </DescriptionList>

      <div className="border-t border-border p-4">
        <div className="mb-3 flex items-center gap-2">
          <Database className="size-4 text-muted-foreground" />
          <h4 className="text-xs font-semibold text-muted-foreground">
            {t("quantity.title")}
          </h4>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <QuantityCard
            label={t("quantity.ledger")}
            value={formatSalesChannelQuantity(item.ledgerQuantity, formatOptions)}
          />
          <QuantityCard
            label={t("quantity.pending")}
            value={formatSalesChannelQuantity(item.pendingOrderQuantity, formatOptions)}
          />
          <QuantityCard
            label={t("quantity.expected")}
            value={formatSalesChannelQuantity(item.expectedChannelQuantity, formatOptions)}
          />
          <QuantityCard
            label={t("quantity.actual")}
            value={formatSalesChannelQuantity(item.channelQuantity, formatOptions)}
          />
          <div className="sm:col-span-2">
            <QuantityCard
              label={t("quantity.difference")}
              value={formatSalesChannelDifference(item.difference, formatOptions)}
              tone={differenceTone}
            />
          </div>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          {t("quantity.formula")}
        </p>
      </div>

      <DescriptionList className="border-t border-border px-4 py-2">
        <DescriptionRow
          label={t("fields.desiredVersion")}
          value={item.desiredVersion}
          labelWidth="116px"
        />
        <DescriptionRow
          label={t("fields.processingVersion")}
          value={item.processingVersion ?? "-"}
          labelWidth="116px"
        />
        <DescriptionRow
          label={t("fields.lastChecked")}
          value={formatSalesChannelSyncCheckDate(item.lastCheckedAt)}
          labelWidth="116px"
        />
        <DescriptionRow
          label={t("fields.mismatchSince")}
          value={formatSalesChannelSyncCheckDate(item.mismatchSince)}
          labelWidth="116px"
        />
        <DescriptionRow
          label={t("fields.retries")}
          value={item.retryCount}
          labelWidth="116px"
        />
        <DescriptionRow
          label={t("fields.resolvedAt")}
          value={formatSalesChannelSyncCheckDate(item.resolvedAt)}
          labelWidth="116px"
        />
        <DescriptionRow
          label={t("fields.lastError")}
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
          label={t("fields.apiJob")}
          value={`${item.lastApiCallLogId ?? "-"} / ${item.lastWorkerJobId ?? "-"}`}
          labelWidth="116px"
        />
      </DescriptionList>

      <div className="border-t border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <div className="flex gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            {t("recheck.explanation")}
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
              {working ? t("recheck.working") : t("recheck.action")}
            </Button>
            {repairable ? (
              <Button
                className="w-full"
                disabled={working}
                onClick={() => setRepairDialogOpen(true)}
              >
                <Wrench className="size-4" />
                {t("repair.action")}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-xs">
            {t("recheck.unavailable")}
          </p>
        )}
      </div>

      <DialogFrame
        open={repairDialogOpen}
        onOpenChange={(open) => {
          if (!working) setRepairDialogOpen(open);
        }}
        title={t("repair.action")}
        description={t("repair.description")}
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
              {t("repair.cancel")}
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
                ? t("repair.checking")
                : t("repair.confirm", { count: item.expectedChannelQuantity })}
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
            label={t("quantity.ledger")}
            value={formatSalesChannelQuantity(item.ledgerQuantity, formatOptions)}
            labelWidth="132px"
          />
          <DescriptionRow
            label={t("quantity.pending")}
            value={formatSalesChannelQuantity(item.pendingOrderQuantity, formatOptions)}
            labelWidth="132px"
          />
          <DescriptionRow
            label={t("quantity.current")}
            value={formatSalesChannelQuantity(item.channelQuantity, formatOptions)}
            labelWidth="132px"
          />
          <DescriptionRow
            label={t("quantity.repairExpected")}
            value={formatSalesChannelQuantity(item.expectedChannelQuantity, formatOptions)}
            labelWidth="132px"
          />
          <DescriptionRow
            label={t("quantity.difference")}
            value={formatSalesChannelDifference(item.difference, formatOptions)}
            labelWidth="132px"
          />
        </DescriptionList>
        <p className="mt-4 border border-amber-300 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
          {t("repair.warning")}
        </p>
      </DialogFrame>
    </div>
  );
}
