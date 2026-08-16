import { advanceReturn, advanceShipment } from "./database.mjs";

export function startLifecycleGenerators(db, config) {
  const timers = [];

  if (config.lifecycle.trackingIntervalMs > 0) {
    const timer = setInterval(async () => {
      const row = await db
        .prepare(`
          SELECT slip_no FROM mock_shipments
          WHERE shipment_state NOT IN ('DELIVERED', 'EXCEPTION')
          ORDER BY updated_at, slip_no
          LIMIT 1
        `)
        .get();
      if (row) await advanceShipment(db, row.slip_no);
    }, config.lifecycle.trackingIntervalMs);
    timer.unref();
    timers.push(timer);
  }

  if (config.lifecycle.returnIntervalMs > 0) {
    const timer = setInterval(async () => {
      const row = await db
        .prepare(`
          SELECT take_no FROM mock_returns
          WHERE resv_stat IN ('10', '30')
          ORDER BY updated_at, take_no
          LIMIT 1
        `)
        .get();
      if (row) await advanceReturn(db, row.take_no);
    }, config.lifecycle.returnIntervalMs);
    timer.unref();
    timers.push(timer);
  }

  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}
