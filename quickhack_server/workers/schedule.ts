import {
  addSeconds,
  formatKstDate,
  parseKstSqlDateTime,
} from "@/quickhack_shared/core/time";
import type { RegisteredWorker } from "@/quickhack_server/workers/types";

const DAILY_KST_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAILY_SCHEDULE_COMPATIBILITY_INTERVAL_SECONDS = 24 * 60 * 60;

export type WorkerScheduleKind =
  | "DAILY_KST"
  | "INTERVAL"
  | "MANUAL";

function normalizeDailyKstTime(value: string) {
  const normalized = value.trim();

  if (!DAILY_KST_TIME_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid worker daily KST schedule time: ${value}`
    );
  }

  return normalized;
}

export function nextDailyKstRunAt(from: Date, dailyKstTime: string) {
  const normalizedTime = normalizeDailyKstTime(dailyKstTime);
  const today = formatKstDate(from);
  const candidate = parseKstSqlDateTime(
    `${today} ${normalizedTime}:00`
  );

  if (!candidate) {
    throw new Error(
      `Could not resolve worker daily KST schedule: ${dailyKstTime}`
    );
  }

  const next =
    candidate.getTime() > from.getTime()
      ? candidate
      : addSeconds(
          candidate,
          DAILY_SCHEDULE_COMPATIBILITY_INTERVAL_SECONDS
        );

  return next;
}

export function registeredWorkerIntervalSeconds(
  worker: RegisteredWorker
) {
  if (worker.dailyScheduleKstTime) {
    normalizeDailyKstTime(worker.dailyScheduleKstTime);
    return DAILY_SCHEDULE_COMPATIBILITY_INTERVAL_SECONDS;
  }

  return worker.defaultIntervalSeconds ?? null;
}

export function nextRegisteredWorkerRunAt(
  worker: RegisteredWorker,
  from: Date,
  intervalSeconds?: number | null
) {
  if (worker.dailyScheduleKstTime) {
    return nextDailyKstRunAt(from, worker.dailyScheduleKstTime);
  }

  const resolvedInterval =
    intervalSeconds ?? worker.defaultIntervalSeconds ?? null;

  if (!resolvedInterval || resolvedInterval <= 0) {
    return null;
  }

  return addSeconds(from, resolvedInterval);
}

export function registeredWorkerScheduleKind(
  worker: RegisteredWorker | null
): WorkerScheduleKind {
  if (worker?.dailyScheduleKstTime) {
    return "DAILY_KST";
  }
  if (worker?.defaultIntervalSeconds) {
    return "INTERVAL";
  }
  return "MANUAL";
}

export function registeredWorkerScheduleLabel(
  worker: RegisteredWorker | null
) {
  if (worker?.dailyScheduleKstTime) {
    return `매일 ${normalizeDailyKstTime(
      worker.dailyScheduleKstTime
    )} KST`;
  }

  return "";
}
