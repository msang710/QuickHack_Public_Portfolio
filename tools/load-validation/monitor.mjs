import { readFile } from "node:fs/promises";

async function processSample(pid) {
  if (!pid) return null;
  const [stat, status] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/status`, "utf8"),
  ]);
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  const rss = /^VmRSS:\s+(\d+)/m.exec(status);
  return { pid, userTicks: Number(fields[11]), systemTicks: Number(fields[12]), rssKiB: rss ? Number(rss[1]) : null };
}

export async function collectResourceSample(pool, pid = null) {
  const [activity, database, workers, syncCursors, process] = await Promise.all([
    pool.query(`SELECT state, count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() GROUP BY state`),
    pool.query(`SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit, temp_bytes, deadlocks FROM pg_stat_database WHERE datname=current_database()`),
    pool.query(`SELECT worker_key, status, started_at, finished_at, last_error_code
      FROM server_worker_jobs
      WHERE worker_key IN ('coupang-accept-order-sync', 'coupang-order-reconciliation')`),
    pool.query(`SELECT resource, status_filter, last_window_to, last_success_at, last_failure_at
      FROM channel_sync_cursors
      WHERE channel='COUPANG' AND status_filter='ACCEPT'
        AND resource IN ('ordersheets.accept.recent', 'ordersheets.reconciliation')`),
    processSample(pid).catch((error) => ({ pid, errorCode: error.code ?? error.name })),
  ]);
  return { type: "resource", at: new Date().toISOString(), process, database: database.rows[0], connections: activity.rows, workers: workers.rows, syncCursors: syncCursors.rows };
}

export async function monitorResources({ pool, pid, write, signal, intervalMs = 1_000 }) {
  if (intervalMs < 100) throw new TypeError("Resource interval must be at least 100ms.");
  while (!signal.aborted) {
    try { await write(await collectResourceSample(pool, pid)); }
    catch (error) { await write({ type: "resource-error", at: new Date().toISOString(), errorCode: error.code ?? error.name }); }
    await new Promise((resolve) => {
      const onAbort = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, intervalMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
