import { formatKstDate, kstDateTimeParts } from "@/quickhack_shared/core/time";

const MINUTE_MS = 60_000;
const RECENT_LOOKBACK_MINUTES = 30;
const MAX_QUERY_MINUTES = 10;

export type RecentOrdersheetWindow = {
  from: string;
  to: string;
};

function formatKstMinute(date: Date) {
  const parts = kstDateTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}+09:00`;
}

export function recentOrdersheetWindows(now: Date): RecentOrdersheetWindow[] {
  const end = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const start = end - RECENT_LOOKBACK_MINUTES * MINUTE_MS;
  const windows: RecentOrdersheetWindow[] = [];

  for (let cursor = start; cursor < end;) {
    const day = formatKstDate(new Date(cursor));
    const lastMinuteOfDay = Date.parse(`${day}T23:59:00+09:00`);
    const stop = Math.min(
      end,
      cursor + MAX_QUERY_MINUTES * MINUTE_MS,
      lastMinuteOfDay
    );
    windows.push({
      from: formatKstMinute(new Date(cursor)),
      to: formatKstMinute(new Date(stop)),
    });
    cursor = stop === lastMinuteOfDay ? stop + MINUTE_MS : stop;
  }

  return windows;
}
