import { prisma } from "@/quickhack_server/core/prisma";
import { runMeasuredTransaction } from "@/quickhack_server/observability/transaction-trace";
import {
  formatKstSqlDateTime,
  quickHackClock,
} from "@/quickhack_shared/core/time";

const DEFAULT_STALE_AFTER_MINUTES = 15;

type RecoveryOptions = {
  now?: Date;
  staleAfterMinutes?: number;
};

function positiveNumber(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function recoveryState(requestDispatched: boolean) {
  if (!requestDispatched) {
    return {
      batchStatus: "FAILED",
      itemStatus: "FAILED",
      errorCode: "PROCESS_INTERRUPTED_BEFORE_ALLOCATION_DISPATCH",
      itemResultCode: "REQUEST_NOT_DISPATCHED",
      errorMessage:
        "The server stopped before the tracking-number allocation request was dispatched. The allocation can be retried safely.",
      reviewRequired: false,
    } as const;
  }

  return {
    batchStatus: "REVIEW_REQUIRED",
    itemStatus: "MISSING_RESPONSE",
    errorCode: "PROCESS_INTERRUPTED_AFTER_ALLOCATION_DISPATCH",
    itemResultCode: "OUTCOME_UNCERTAIN",
    errorMessage:
      "The server stopped after the tracking-number allocation request was dispatched. Verify the carrier result before continuing.",
    reviewRequired: true,
  } as const;
}

export async function recoverInterruptedCarrierInvoiceIssues(
  options: RecoveryOptions = {}
) {
  const now = options.now ?? quickHackClock.nowDate();
  const staleAfterMinutes = positiveNumber(
    options.staleAfterMinutes,
    DEFAULT_STALE_AFTER_MINUTES
  );
  const staleBefore = new Date(
    now.getTime() - staleAfterMinutes * 60 * 1000
  );

  return runMeasuredTransaction(
    prisma,
    "carrier.invoice-issue.recover-interrupted",
    async (tx) => {
      const candidates = await tx.carrier_invoice_issue_batches.findMany({
        where: {
          batch_status: "ALLOCATING",
          started_at: { lte: staleBefore },
        },
        orderBy: { carrier_invoice_issue_batch_id: "asc" },
        select: {
          carrier_invoice_issue_batch_id: true,
          attempt_count: true,
          allocation_request_dispatched: true,
          started_at: true,
        },
      });

      const recoveredIds: number[] = [];
      let retryableCount = 0;
      let reviewRequiredCount = 0;
      let changedBeforeRecoveryCount = 0;

      for (const candidate of candidates) {
        const requestDispatched =
          candidate.allocation_request_dispatched === 1;
        const recovery = recoveryState(requestDispatched);
        const recovered =
          await tx.carrier_invoice_issue_batches.updateMany({
            where: {
              carrier_invoice_issue_batch_id:
                candidate.carrier_invoice_issue_batch_id,
              batch_status: "ALLOCATING",
              attempt_count: candidate.attempt_count,
              allocation_request_dispatched:
                candidate.allocation_request_dispatched,
              started_at: candidate.started_at,
            },
            data: {
              batch_status: recovery.batchStatus,
              error_code: recovery.errorCode,
              error_message: recovery.errorMessage,
              completed_at: now,
              review_required_at: recovery.reviewRequired ? now : null,
              updated_at: now,
            },
          });

        if (recovered.count !== 1) {
          changedBeforeRecoveryCount += 1;
          continue;
        }

        await tx.carrier_invoice_issue_items.updateMany({
          where: {
            carrier_invoice_issue_batch_id:
              candidate.carrier_invoice_issue_batch_id,
          },
          data: {
            item_status: recovery.itemStatus,
            result_code: recovery.itemResultCode,
            result_message: recovery.errorMessage,
            updated_at: now,
          },
        });

        recoveredIds.push(candidate.carrier_invoice_issue_batch_id);
        if (recovery.reviewRequired) {
          reviewRequiredCount += 1;
        } else {
          retryableCount += 1;
        }
      }

      if (recoveredIds.length > 0) {
        await tx.server_job_logs.create({
          data: {
            job_type: "CARRIER_INVOICE_ISSUE_RECOVERY",
            job_name: "Carrier invoice issue interruption recovery",
            status: "SUCCESS",
            started_at: now,
            finished_at: now,
            duration_ms: 0,
            summary_text: `Recovered ${recoveredIds.length} interrupted tracking-number allocation(s): ${retryableCount} safe to retry, ${reviewRequiredCount} requiring carrier verification.`,
            summary_processed_count: candidates.length,
            summary_succeeded_count: recoveredIds.length,
            summary_failed_count: 0,
            summary_skipped_count: changedBeforeRecoveryCount,
            summary_warning_count: reviewRequiredCount,
            created_at: now,
          },
        });
      }

      return {
        checkedCount: candidates.length,
        recoveredCount: recoveredIds.length,
        retryableCount,
        reviewRequiredCount,
        changedBeforeRecoveryCount,
        recoveredIds,
        staleBefore: formatKstSqlDateTime(staleBefore),
      };
    }
  );
}
