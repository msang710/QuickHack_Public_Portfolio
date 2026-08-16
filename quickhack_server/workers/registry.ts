import type { RegisteredWorker } from "@/quickhack_server/workers/types";
import {
  COUPANG_SYNC_WORKER_KEY,
  LOGEN_WORKER_KEY,
  OBSERVABILITY_WORKER_KEY,
  ORDER_MATCHING_WORKER_KEY,
  STATISTICS_WORKER_KEY,
} from "@/quickhack_server/workers/worker-keys";
import { BACKUP_CONSOLE_WORKER } from "@/quickhack_server/admin/backup-worker-policy";

export const registeredWorkers: RegisteredWorker[] = [
  {
    key: BACKUP_CONSOLE_WORKER.automaticBackup,
    name: "PostgreSQL native encrypted backup",
    type: "DATABASE_MAINTENANCE",
    defaultIntervalSeconds: 24 * 60 * 60,
    defaultScheduleEnabled: true,
    dailyScheduleKstTime: "02:30",
    initialScheduleMode: "NEXT_SCHEDULE",
    maxAttempts: 2,
    lockSeconds: 30 * 60,
    async run(context) {
      const { createOperationalPostgresqlBackup } = await import(
        "@/quickhack_server/admin/postgresql-backup-service"
      );
      const result = await createOperationalPostgresqlBackup();
      await context.updateProgress(1, 1);
      return {
        summary: {
          fileName: result.backup.fileName,
          sizeBytes: result.backup.encryptedSize,
          removedCount: result.retention.removed.length,
        },
        progressCurrent: 1,
        progressTotal: 1,
      };
    },
  },
  {
    key: BACKUP_CONSOLE_WORKER.retentionAndIntegrity,
    name: "PostgreSQL backup retention and integrity",
    type: "DATABASE_MAINTENANCE",
    defaultIntervalSeconds: 7 * 24 * 60 * 60,
    defaultScheduleEnabled: true,
    dailyScheduleKstTime: "03:00",
    initialScheduleMode: "NEXT_SCHEDULE",
    maxAttempts: 2,
    lockSeconds: 60 * 60,
    async run(context) {
      const { verifyOperationalPostgresqlBackups } = await import(
        "@/quickhack_server/admin/postgresql-backup-service"
      );
      const result = await verifyOperationalPostgresqlBackups();
      await context.updateProgress(result.verifiedCount, result.candidateCount);
      return {
        summary: result,
        progressCurrent: result.verifiedCount,
        progressTotal: result.candidateCount,
      };
    },
  },
  {
    key: LOGEN_WORKER_KEY.shipmentRegistration,
    name: "Logen shipment registration",
    type: "CARRIER_SYNC",
    defaultIntervalSeconds: 30,
    defaultScheduleEnabled: true,
    maxAttempts: 3,
    lockSeconds: 300,
    async run(context) {
      const { processLogenShipmentRegistrationWorks } = await import(
        "@/quickhack_server/shipment/carrier-integration/logen/shipment-registration-service"
      );
      const result = await processLogenShipmentRegistrationWorks({
        limit: 30,
        workerJobId: context.workerJobId,
        workerLease: context,
      });
      await context.updateProgress(result.processedCount, null);
      return {
        summary: result,
        progressCurrent: result.processedCount,
        progressTotal: null,
      };
    },
  },
  {
    key: LOGEN_WORKER_KEY.shipmentTracking,
    name: "Logen shipment tracking sync",
    type: "CARRIER_SYNC",
    defaultIntervalSeconds: 5 * 60,
    defaultScheduleEnabled: true,
    maxAttempts: 3,
    lockSeconds: 300,
    async run(context) {
      const { processLogenShipmentTracking } = await import(
        "@/quickhack_server/shipment/carrier-integration/logen/tracking-sync-service"
      );
      const result = await processLogenShipmentTracking({
        limit: 300,
        workerJobId: context.workerJobId,
        workerLease: context,
      });
      await context.updateProgress(
        result.processedCount,
        result.candidateCount
      );
      return {
        summary: result,
        progressCurrent: result.processedCount,
        progressTotal: result.candidateCount,
      };
    },
  },
  {
    key: COUPANG_SYNC_WORKER_KEY.acceptOrders,
    name: "Coupang ACCEPT order sync",
    type: "COUPANG_SYNC",
    defaultIntervalSeconds: 60,
    maxAttempts: 3,
    lockSeconds: 300,
    async run(context) {
      const { syncCoupangAcceptOrders } = await import(
        "@/quickhack_server/sales-channel/coupang/sync-service"
      );
      const result = await syncCoupangAcceptOrders({
        reason: "scheduled-worker",
        workerLease: context,
      });

      await context.updateProgress(result.orders, null);

      return {
        summary: result,
        progressCurrent: result.orders,
        progressTotal: null,
      };
    },
  },
  {
    key: COUPANG_SYNC_WORKER_KEY.preShipmentVerification,
    name: "Coupang pre-shipment verification sync",
    type: "COUPANG_SYNC",
    defaultIntervalSeconds: 60 * 60,
    maxAttempts: 3,
    lockSeconds: 300,
    async run(context) {
      const { syncCoupangPreShipmentVerification } = await import(
        "@/quickhack_server/sales-channel/coupang/sync-service"
      );
      const result = await syncCoupangPreShipmentVerification({
        reason: "worker",
        workerLease: context,
      });

      await context.updateProgress(result.orders, null);

      return {
        summary: result,
        progressCurrent: result.orders,
        progressTotal: null,
      };
    },
  },
  {
    key: COUPANG_SYNC_WORKER_KEY.preShipmentReturns,
    name: "Coupang pre-shipment return sync",
    type: "COUPANG_SYNC",
    defaultIntervalSeconds: 60 * 60,
    maxAttempts: 3,
    lockSeconds: 300,
    async run(context) {
      const { syncCoupangPreShipmentReturns } = await import(
        "@/quickhack_server/sales-channel/coupang/sync-service"
      );
      const result = await syncCoupangPreShipmentReturns({
        reason: "worker",
        workerLease: context,
      });

      await context.updateProgress(result.returns, null);

      return {
        summary: result,
        progressCurrent: result.returns,
        progressTotal: null,
      };
    },
  },
  {
    key: COUPANG_SYNC_WORKER_KEY.shipmentStatus,
    name: "Coupang shipment status sync",
    type: "COUPANG_SYNC",
    defaultIntervalSeconds: 60 * 60,
    maxAttempts: 3,
    lockSeconds: 300,
    async run(context) {
      const { syncCoupangShipmentStatuses } = await import(
        "@/quickhack_server/sales-channel/coupang/sync-service"
      );
      const result = await syncCoupangShipmentStatuses({
        reason: "scheduled-worker",
        workerLease: context,
      });

      await context.updateProgress(result.orders, null);

      return {
        summary: result,
        progressCurrent: result.orders,
        progressTotal: null,
      };
    },
  },
  {
    key: COUPANG_SYNC_WORKER_KEY.afterShipmentClaims,
    name: "Coupang after-shipment claim sync",
    type: "COUPANG_SYNC",
    defaultIntervalSeconds: 60 * 60,
    maxAttempts: 3,
    lockSeconds: 300,
    async run(context) {
      const { syncCoupangAfterShipmentClaims } = await import(
        "@/quickhack_server/sales-channel/coupang/sync-service"
      );
      const result = await syncCoupangAfterShipmentClaims({
        reason: "scheduled-worker",
        workerLease: context,
      });
      const processed =
        result.returns.returns +
        result.exchanges.exchanges +
        result.withdrawals.withdrawals;

      await context.updateProgress(processed, null);

      return {
        summary: result,
        progressCurrent: processed,
        progressTotal: null,
      };
    },
  },
  {
    key: ORDER_MATCHING_WORKER_KEY,
    name: "Order inventory matching",
    type: "ORDER_MATCHING",
    defaultIntervalSeconds: 120,
    maxAttempts: 3,
    lockSeconds: 300,
    async run(context) {
      const { matchOrderInventory } = await import(
        "@/quickhack_server/sales-channel/order-inventory-matching-service"
      );
      const result = await matchOrderInventory(
        { limit: 100 },
        context.triggeredBy,
        context
      );

      await context.updateProgress(result.summary.processedItemCount, null);

      return {
        summary: result.summary,
        progressCurrent: result.summary.processedItemCount,
        progressTotal: null,
      };
    },
  },
  {
    key: "shipment-address-change-tracking",
    name: "Shipment address change tracking",
    type: "SHIPMENT_CHANGE_TRACKING",
    defaultIntervalSeconds: 60,
    maxAttempts: 3,
    lockSeconds: 120,
    async run(context) {
      const { trackShipmentAddressChangeWork } = await import(
        "@/quickhack_server/shipment/shipment-address-change-tracking-service"
      );
      const result = await trackShipmentAddressChangeWork({
        limit: 100,
        workerLease: context,
      });

      await context.updateProgress(result.processedCount, result.candidateCount);

      return {
        summary: result,
        progressCurrent: result.processedCount,
        progressTotal: result.candidateCount,
      };
    },
  },
  {
    key: "inventory-quantity-ledger-audit",
    name: "Inventory quantity ledger audit",
    type: "INVENTORY_AUDIT",
    defaultIntervalSeconds: 60 * 60,
    defaultScheduleEnabled: true,
    maxAttempts: 2,
    lockSeconds: 60 * 10,
    async run(context) {
      const { auditInventoryQuantityLedger } = await import(
        "@/quickhack_server/inventory/inventory-quantity-ledger-audit-service"
      );
      const result = await auditInventoryQuantityLedger(context);

      await context.updateProgress(
        result.inventoryRowCount,
        result.inventoryRowCount
      );

      return {
        summary: result,
        progressCurrent: result.inventoryRowCount,
        progressTotal: result.inventoryRowCount,
      };
    },
  },
  {
    key: "inventory-consistency-audit",
    name: "Inventory consistency audit",
    type: "INVENTORY_AUDIT",
    defaultIntervalSeconds: 60 * 60,
    maxAttempts: 2,
    lockSeconds: 60 * 10,
    async run(context) {
      const { auditInventoryConsistency } = await import(
        "@/quickhack_server/inventory/inventory-consistency-audit-service"
      );
      const result = await auditInventoryConsistency(context);

      await context.updateProgress(result.issueTypeCount, null);

      return {
        summary: result,
        progressCurrent: result.issueTypeCount,
        progressTotal: null,
      };
    },
  },
  {
    key: "privacy-redact-expired-personal-data",
    name: "Privacy redact expired personal data",
    type: "SECURITY_MAINTENANCE",
    defaultIntervalSeconds: 60 * 60 * 24,
    defaultScheduleEnabled: true,
    scheduleRequired: true,
    initialScheduleMode: "IMMEDIATE",
    maxAttempts: 2,
    lockSeconds: 60 * 10,
    async run(context) {
      const { redactExpiredSalesChannelPersonalData } = await import(
        "@/quickhack_server/admin/privacy-maintenance-service"
      );
      const result = await redactExpiredSalesChannelPersonalData({
        workerLease: context,
      });

      await context.updateProgress(
        result.completedSubjects,
        result.eligibleSubjects
      );

      return {
        summary: result,
        progressCurrent: result.completedSubjects,
        progressTotal: result.eligibleSubjects,
      };
    },
  },
  {
    key: OBSERVABILITY_WORKER_KEY.traceRetention,
    name: "Observability trace retention",
    type: "OBSERVABILITY_MAINTENANCE",
    defaultIntervalSeconds: 24 * 60 * 60,
    defaultScheduleEnabled: true,
    dailyScheduleKstTime: "04:10",
    initialScheduleMode: "NEXT_SCHEDULE",
    maxAttempts: 2,
    lockSeconds: 10 * 60,
    async run(context) {
      const { runObservabilityTraceRetention } = await import(
        "@/quickhack_server/observability/trace-retention-service"
      );
      const result = await runObservabilityTraceRetention({ context });

      return {
        summary: result,
        summaryText: result.summaryText,
        progressCurrent: result.deletedCount,
        progressTotal: null,
      };
    },
  },
  {
    key: STATISTICS_WORKER_KEY.dailySnapshot,
    name: "Daily statistics snapshot",
    type: "STATISTICS_SNAPSHOT",
    defaultIntervalSeconds: 24 * 60 * 60,
    defaultScheduleEnabled: true,
    dailyScheduleKstTime: "03:30",
    maxAttempts: 3,
    lockSeconds: 30 * 60,
    async run(context) {
      const { runDailyStatisticsSnapshot } = await import(
        "@/quickhack_server/statistics/statistics-snapshot-worker"
      );
      const result = await runDailyStatisticsSnapshot({
        context,
      });

      return {
        summary: result,
        progressCurrent: result.completedDomainCount,
        progressTotal: 4,
      };
    },
  },
];

export function findRegisteredWorker(workerKey: string) {
  return registeredWorkers.find((worker) => worker.key === workerKey) ?? null;
}
