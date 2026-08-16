import type { KeysetPageCoverage } from "@/quickhack_shared/core/keyset-page";

export const ADMIN_LOG_DEFAULT_LIMIT = 100;
export const ADMIN_LOG_MAX_LIMIT = 200;

export type ActivityLogDto = {
  id: number;
  userId: number | null;
  username: string;
  displayName: string;
  actionType: string;
  targetType: string;
  targetId: string;
  beforeSummaryText: string;
  afterSummaryText: string;
  changes: Array<{ fieldName: string; beforeValue: string; afterValue: string }>;
  result: string;
  createdAt: string;
};

export type ServerJobLogDto = {
  id: number;
  jobType: string;
  jobName: string;
  status: string;
  triggeredByUserId: number | null;
  username: string;
  displayName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number | null;
  summaryText: string;
  summaryProcessedCount: number | null;
  summarySucceededCount: number | null;
  summaryFailedCount: number | null;
  summarySkippedCount: number | null;
  summaryCreatedCount: number | null;
  summaryUpdatedCount: number | null;
  summaryWarningCount: number | null;
  errorCode: string;
  errorMessage: string;
  fields: Array<{ fieldName: string; fieldValue: string }>;
  createdAt: string;
};

export type ActivityLogSummary = {
  total: number;
  success: number;
  failure: number;
  actorCount: number;
  workers: number;
};

export type ServerJobLogSummary = {
  total: number;
  running: number;
  success: number;
  failure: number;
};

export type AdminLogPageResponse<TItem, TSummary> = {
  ok: true;
  items: TItem[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
  coverage: KeysetPageCoverage;
  summary: TSummary;
};
