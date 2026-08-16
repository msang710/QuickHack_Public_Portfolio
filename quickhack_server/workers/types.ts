import type { AuthUser } from "@/quickhack_shared/auth/auth-constants";

export const WORKER_JOB_STATUSES = [
  "IDLE",
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "RETRY_WAITING",
  "DISABLED",
] as const;

export type WorkerJobStatus = (typeof WORKER_JOB_STATUSES)[number];

export type WorkerLeaseGuard = {
  workerJobId?: number;
  leaseToken?: string;
  claimGeneration?: number;
  signal: AbortSignal;
  assertLeaseActive: () => Promise<void>;
};

export type OwnedWorkerLeaseGuard = WorkerLeaseGuard & {
  workerJobId: number;
};

export type WorkerRunContext = {
  workerJobId: number;
  leaseToken: string;
  claimGeneration: number;
  workerKey: string;
  triggeredBy: AuthUser | null;
  signal: AbortSignal;
  assertLeaseActive: () => Promise<void>;
  updateProgress: (current: number, total?: number | null) => Promise<void>;
};

export type WorkerRunResult = {
  summary?: unknown;
  summaryText?: string;
  progressCurrent?: number;
  progressTotal?: number | null;
};

export type RegisteredWorker = {
  key: string;
  name: string;
  type: string;
  defaultIntervalSeconds?: number;
  defaultScheduleEnabled?: boolean;
  scheduleRequired?: boolean;
  dailyScheduleKstTime?: `${number}${number}:${number}${number}`;
  initialScheduleMode?: "IMMEDIATE" | "NEXT_SCHEDULE";
  maxAttempts?: number;
  lockSeconds?: number;
  run: (context: WorkerRunContext) => Promise<WorkerRunResult | unknown>;
};
