import { openPostgresqlMockDatabase } from "../postgresql-mock-database.mjs";

function nowIso() {
  return new Date().toISOString();
}

async function createSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS mock_counters (
      name TEXT PRIMARY KEY,
      value BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mock_credentials (
      secret_key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mock_ip_allowlist (
      ip_address TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mock_contracts (
      cust_cd TEXT PRIMARY KEY,
      cust_nm TEXT NOT NULL,
      pick_sales_cd TEXT NOT NULL,
      pick_sales_nm TEXT NOT NULL,
      pick_bran_cd TEXT NOT NULL,
      pick_bran_nm TEXT NOT NULL,
      fare_ty TEXT NOT NULL,
      fare_ty_nm TEXT NOT NULL,
      use_yn TEXT NOT NULL DEFAULT 'Y',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mock_contract_fares (
      cust_cd TEXT NOT NULL,
      fare_ty TEXT NOT NULL,
      box_ty_cd TEXT NOT NULL,
      box_ty_nm TEXT NOT NULL,
      dlv_fare INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (cust_cd, fare_ty, box_ty_cd),
      FOREIGN KEY (cust_cd) REFERENCES mock_contracts(cust_cd)
    );

    CREATE TABLE IF NOT EXISTS mock_invoice_allocations (
      slip_no TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ALLOCATED',
      allocated_at TEXT NOT NULL,
      registered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS mock_shipments (
      slip_no TEXT PRIMARY KEY,
      cust_cd TEXT NOT NULL,
      fix_take_no TEXT,
      print_yn TEXT NOT NULL,
      slip_ty TEXT NOT NULL,
      fare_ty TEXT NOT NULL,
      take_dt TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      receiver_name TEXT NOT NULL,
      receiver_address TEXT NOT NULL,
      goods_name TEXT,
      goods_amount INTEGER NOT NULL DEFAULT 0,
      delivery_fare INTEGER NOT NULL DEFAULT 0,
      extra_fare INTEGER NOT NULL DEFAULT 0,
      shipment_state TEXT NOT NULL DEFAULT 'REGISTERED',
      raw_json TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (slip_no) REFERENCES mock_invoice_allocations(slip_no),
      FOREIGN KEY (cust_cd) REFERENCES mock_contracts(cust_cd)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS mock_shipments_fix_take_no_unique
      ON mock_shipments(fix_take_no)
      WHERE fix_take_no IS NOT NULL AND TRIM(fix_take_no) <> '';

    CREATE TABLE IF NOT EXISTS mock_ilogen_orders (
      fix_take_no TEXT PRIMARY KEY,
      cust_cd TEXT NOT NULL,
      take_dt TEXT NOT NULL,
      user_id TEXT NOT NULL,
      slip_no TEXT,
      del_yn TEXT NOT NULL DEFAULT 'N',
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (cust_cd) REFERENCES mock_contracts(cust_cd),
      FOREIGN KEY (slip_no) REFERENCES mock_invoice_allocations(slip_no)
    );

    CREATE INDEX IF NOT EXISTS mock_ilogen_orders_print_lookup
      ON mock_ilogen_orders(cust_cd, take_dt, slip_no);

    CREATE TABLE IF NOT EXISTS mock_returns (
      take_no TEXT PRIMARY KEY,
      fix_take_no TEXT,
      cust_cd TEXT NOT NULL,
      orgn_slip_no TEXT,
      return_slip_no TEXT NOT NULL,
      resv_stat TEXT NOT NULL DEFAULT '10',
      delay_cd TEXT,
      proc_dt TEXT,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (cust_cd) REFERENCES mock_contracts(cust_cd),
      FOREIGN KEY (return_slip_no) REFERENCES mock_invoice_allocations(slip_no)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS mock_returns_fix_take_no_unique
      ON mock_returns(fix_take_no)
      WHERE fix_take_no IS NOT NULL AND TRIM(fix_take_no) <> '';

    CREATE UNIQUE INDEX IF NOT EXISTS mock_returns_orgn_slip_no_unique
      ON mock_returns(orgn_slip_no)
      WHERE orgn_slip_no IS NOT NULL AND TRIM(orgn_slip_no) <> '';

    CREATE TABLE IF NOT EXISTS mock_tracking_events (
      tracking_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      slip_no TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      scan_dt TEXT NOT NULL,
      scan_tm TEXT NOT NULL,
      stat_nm TEXT NOT NULL,
      bran_cd TEXT,
      bran_nm TEXT,
      opp_bran_cd TEXT,
      opp_bran_nm TEXT,
      sales_cd TEXT,
      sales_nm TEXT,
      snd_bran_nm TEXT,
      rcv_bran_nm TEXT,
      acptor_ty_nm TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (slip_no, event_sequence)
    );

    CREATE INDEX IF NOT EXISTS mock_tracking_events_slip_sequence
      ON mock_tracking_events(slip_no, event_sequence);

    CREATE TABLE IF NOT EXISTS mock_api_request_logs (
      request_log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      method TEXT NOT NULL,
      endpoint_path TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      stts_cd TEXT,
      request_json TEXT,
      response_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS mock_api_request_logs_endpoint_created
      ON mock_api_request_logs(endpoint_path, created_at);
  `);
}

async function seedReferenceData(db, config) {
  const now = nowIso();
  await db.prepare(`
    INSERT INTO mock_credentials(secret_key, user_id, enabled, created_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(secret_key) DO UPDATE SET user_id = excluded.user_id, enabled = 1
  `).run(config.seed.secretKey, config.seed.userId, now);

  const seedIp = db.prepare(`
    INSERT INTO mock_ip_allowlist(ip_address, enabled, created_at)
    VALUES (?, 1, ?)
    ON CONFLICT(ip_address) DO UPDATE SET enabled = 1
  `);
  for (const ip of ["127.0.0.1", "::1"]) {
    await seedIp.run(ip, now);
  }

  await db.prepare(`
    INSERT INTO mock_contracts(
      cust_cd, cust_nm, pick_sales_cd, pick_sales_nm, pick_bran_cd,
      pick_bran_nm, fare_ty, fare_ty_nm, use_yn, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Y', ?, ?)
    ON CONFLICT(cust_cd) DO UPDATE SET
      cust_nm = excluded.cust_nm,
      pick_sales_cd = excluded.pick_sales_cd,
      pick_sales_nm = excluded.pick_sales_nm,
      pick_bran_cd = excluded.pick_bran_cd,
      pick_bran_nm = excluded.pick_bran_nm,
      fare_ty = excluded.fare_ty,
      fare_ty_nm = excluded.fare_ty_nm,
      use_yn = 'Y',
      updated_at = excluded.updated_at
  `).run(
    config.seed.custCd,
    "QuickHack 로젠 Mock 거래처",
    "33610000",
    "수지 기본(050-6113-0000)",
    "336",
    "동수지",
    "040",
    "본사신용",
    now,
    now
  );

  const fareRows = [
    ["010", "AS080", "극소1", 3000],
    ["020", "AS080", "극소1", 3000],
    ["030", "AS080", "극소1", 2800],
    ["040", "AS080", "극소1", 2800],
  ];
  const seedFare = db.prepare(`
    INSERT INTO mock_contract_fares(cust_cd, fare_ty, box_ty_cd, box_ty_nm, dlv_fare, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(cust_cd, fare_ty, box_ty_cd) DO UPDATE SET
      box_ty_nm = excluded.box_ty_nm,
      dlv_fare = excluded.dlv_fare
  `);
  for (const [fareTy, boxTyCd, boxTyNm, dlvFare] of fareRows) {
    await seedFare.run(config.seed.custCd, fareTy, boxTyCd, boxTyNm, dlvFare, now);
  }

  await db.prepare(`
    INSERT INTO mock_counters(name, value) VALUES ('slip_no', 9999999999)
    ON CONFLICT(name) DO NOTHING
  `).run();
  await db.prepare(`
    INSERT INTO mock_counters(name, value) VALUES ('return_take_no', 240503999999)
    ON CONFLICT(name) DO NOTHING
  `).run();
}

export async function openLogenMockDatabase(config) {
  const db = openPostgresqlMockDatabase("logenMock", "quickhack-logen-mock");
  await createSchema(db);
  await seedReferenceData(db, config);
  return db;
}

export async function knownUserId(db, userId) {
  return Boolean(
    (await db.prepare("SELECT 1 FROM mock_credentials WHERE user_id = ? AND enabled = 1").get(userId)) ||
    (await db.prepare("SELECT 1 FROM mock_contracts WHERE cust_cd = ? AND use_yn = 'Y'").get(userId))
  );
}

async function allocateSlipNumbersInternal(db, quantity, userId) {
  const counter = await db.prepare("SELECT value FROM mock_counters WHERE name = 'slip_no' FOR UPDATE").get();
  let current = Number(counter?.value ?? 9999999999);
  const now = nowIso();
  const insert = db.prepare(`
    INSERT INTO mock_invoice_allocations(slip_no, user_id, status, allocated_at)
    VALUES (?, ?, 'ALLOCATED', ?)
  `);
  const values = [];
  for (let index = 0; index < quantity; index += 1) {
    current += 1;
    const slipNo = String(current).padStart(11, "0");
    await insert.run(slipNo, userId, now);
    values.push(slipNo);
  }
  await db.prepare("UPDATE mock_counters SET value = ? WHERE name = 'slip_no'").run(current);
  return values;
}

export async function allocateSlipNumbers(db, quantity, userId) {
  return db.transaction(() => allocateSlipNumbersInternal(db, quantity, userId))();
}

function kstScanParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || "00";
  return {
    scanDt: `${value("year")}${value("month")}${value("day")}`,
    scanTm: `${value("hour")}${value("minute")}${value("second")}`,
  };
}

export async function addTrackingEvent(db, slipNo, event) {
  const sequence = Number(
    (await db
      .prepare("SELECT COALESCE(MAX(event_sequence), 0) + 1 AS next FROM mock_tracking_events WHERE slip_no = ?")
      .get(slipNo)).next
  );
  const scan = kstScanParts();
  await db.prepare(`
    INSERT INTO mock_tracking_events(
      slip_no, event_sequence, scan_dt, scan_tm, stat_nm, bran_cd, bran_nm,
      opp_bran_cd, opp_bran_nm, sales_cd, sales_nm, snd_bran_nm, rcv_bran_nm,
      acptor_ty_nm, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    slipNo,
    sequence,
    scan.scanDt,
    scan.scanTm,
    event.statNm,
    event.branCd ?? "336",
    event.branNm ?? "동수지",
    event.oppBranCd ?? null,
    event.oppBranNm ?? null,
    event.salesCd ?? "33610000",
    event.salesNm ?? "QuickHack Mock 영업소",
    event.sndBranNm ?? null,
    event.rcvBranNm ?? null,
    event.acptorTyNm ?? null,
    nowIso()
  );
}

export async function registerShipment(db, body) {
  const register = db.transaction(async () => {
    const allocation = await db
      .prepare("SELECT * FROM mock_invoice_allocations WHERE slip_no = ?")
      .get(body.slipNo);
    if (!allocation) {
      return { ok: false, message: "채번되지 않은 송장번호입니다." };
    }
    if (allocation.status !== "ALLOCATED") {
      return { ok: false, message: "이미 사용된 송장번호입니다. 재발행 시 신규 채번이 필요합니다." };
    }
    if (body.fixTakeNo) {
      const duplicateOrder = await db
        .prepare("SELECT slip_no FROM mock_shipments WHERE fix_take_no = ?")
        .get(body.fixTakeNo);
      if (duplicateOrder) {
        return {
          ok: false,
          message: `이미 등록된 주문번호입니다. 송장번호: ${duplicateOrder.slip_no}`,
        };
      }
    }

    const now = nowIso();
    await db.prepare(`
      INSERT INTO mock_shipments(
        slip_no, cust_cd, fix_take_no, print_yn, slip_ty, fare_ty, take_dt,
        sender_name, receiver_name, receiver_address, goods_name, goods_amount,
        delivery_fare, extra_fare, shipment_state, raw_json, registered_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REGISTERED', ?, ?, ?)
    `).run(
      body.slipNo,
      body.custCd,
      body.fixTakeNo || null,
      body.printYn,
      body.slipTy || "100",
      body.fareTy,
      body.takeDt,
      body.sndCustNm,
      body.rcvCustNm,
      `${body.rcvCustAddr1} ${body.rcvCustAddr2}`.trim(),
      body.goodsNm || null,
      Number(body.goodsAmt || 0),
      Number(body.dlvFare || 0),
      Number(body.extraFare || 0),
      JSON.stringify(body),
      now,
      now
    );
    await db.prepare(`
      UPDATE mock_invoice_allocations
      SET status = 'REGISTERED', registered_at = ?
      WHERE slip_no = ?
    `).run(now, body.slipNo);
    await addTrackingEvent(db, body.slipNo, { statNm: "송장등록" });
    return { ok: true };
  });
  return register();
}

export async function registerIlogenOrder(db, userId, item) {
  const existing = await db
    .prepare("SELECT fix_take_no, slip_no FROM mock_ilogen_orders WHERE fix_take_no = ?")
    .get(item.fixTakeNo);
  if (existing) {
    return {
      ok: false,
      message: existing.slip_no
        ? `이미 등록 및 출력된 주문번호입니다. 송장번호: ${existing.slip_no}`
        : "이미 등록된 주문번호입니다.",
    };
  }
  const now = nowIso();
  await db.prepare(`
    INSERT INTO mock_ilogen_orders(
      fix_take_no, cust_cd, take_dt, user_id, slip_no, del_yn, raw_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, 'N', ?, ?, ?)
  `).run(
    item.fixTakeNo,
    item.custCd,
    item.takeDt,
    userId,
    JSON.stringify(item),
    now,
    now
  );
  return { ok: true };
}

export async function listIlogenOrders(db, custCd, takeDt) {
  return db
    .prepare(`
      SELECT fix_take_no, cust_cd, take_dt, slip_no, del_yn, raw_json, created_at
      FROM mock_ilogen_orders
      WHERE cust_cd = ? AND take_dt = ?
      ORDER BY created_at, fix_take_no
    `)
    .all(custCd, takeDt);
}

export async function ilogenOrderByFixTakeNo(db, custCd, fixTakeNo) {
  return db
    .prepare(`
      SELECT fix_take_no, cust_cd, take_dt, slip_no, del_yn, raw_json, user_id
      FROM mock_ilogen_orders
      WHERE cust_cd = ? AND fix_take_no = ?
    `)
    .get(custCd, fixTakeNo);
}

export async function printIlogenOrder(db, fixTakeNo) {
  return db.transaction(async () => {
    const order = await db
      .prepare("SELECT * FROM mock_ilogen_orders WHERE fix_take_no = ?")
      .get(fixTakeNo);
    if (!order) return { ok: false, message: "유효한 주문번호가 없습니다." };
    if (order.slip_no) return { ok: true, slipNo: order.slip_no, alreadyPrinted: true };

    const item = JSON.parse(order.raw_json);
    const [slipNo] = await allocateSlipNumbersInternal(db, 1, order.user_id);
    const now = nowIso();
    await db.prepare(`
      UPDATE mock_ilogen_orders SET slip_no = ?, updated_at = ? WHERE fix_take_no = ?
    `).run(slipNo, now, fixTakeNo);
    await db.prepare(`
      UPDATE mock_invoice_allocations
      SET status = 'REGISTERED', registered_at = ?
      WHERE slip_no = ?
    `).run(now, slipNo);
    await db.prepare(`
      INSERT INTO mock_shipments(
        slip_no, cust_cd, fix_take_no, print_yn, slip_ty, fare_ty, take_dt,
        sender_name, receiver_name, receiver_address, goods_name, goods_amount,
        delivery_fare, extra_fare, shipment_state, raw_json, registered_at, updated_at
      ) VALUES (?, ?, ?, 'Y', '100', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REGISTERED', ?, ?, ?)
    `).run(
      slipNo,
      order.cust_cd,
      order.fix_take_no,
      item.fareTy,
      order.take_dt,
      item.sndCustNm,
      item.rcvCustNm,
      item.rcvCustAddr,
      item.goodsNm || null,
      Number(item.goodsAmt || 0),
      Number(item.dlvFare || 0),
      Number(item.extraFare || 0),
      order.raw_json,
      now,
      now
    );
    await addTrackingEvent(db, slipNo, { statNm: "송장출력" });
    return { ok: true, slipNo, alreadyPrinted: false };
  })();
}

const SHIPMENT_TRANSITIONS = Object.freeze({
  REGISTERED: { state: "PICKED_UP", statNm: "집하완료", branCd: "336", branNm: "동수지" },
  PICKED_UP: { state: "IN_TRANSIT", statNm: "간선상차", branCd: "100", branNm: "중부권터미널" },
  IN_TRANSIT: { state: "OUT_FOR_DELIVERY", statNm: "배송출발", branCd: "216", branNm: "동동강남" },
  OUT_FOR_DELIVERY: { state: "DELIVERED", statNm: "배송완료", branCd: "216", branNm: "동동강남", acptorTyNm: "현관/문앞" },
});

const SHIPMENT_ADMIN_TRANSITIONS = Object.freeze({
  REGISTERED: { state: "REGISTERED", statNm: "송장등록", branCd: "336", branNm: "동수지" },
  PICKED_UP: { state: "PICKED_UP", statNm: "집하완료", branCd: "336", branNm: "동수지" },
  IN_TRANSIT: { state: "IN_TRANSIT", statNm: "간선상차", branCd: "100", branNm: "중부권터미널" },
  OUT_FOR_DELIVERY: { state: "OUT_FOR_DELIVERY", statNm: "배송출발", branCd: "216", branNm: "동동강남" },
  DELIVERED: { state: "DELIVERED", statNm: "배송완료", branCd: "216", branNm: "동동강남", acptorTyNm: "현관/문앞" },
  EXCEPTION: { state: "EXCEPTION", statNm: "미배송", branCd: "216", branNm: "동동강남" },
  EXCEPTION_ACCIDENT: { state: "EXCEPTION", statNm: "배송사고", branCd: "216", branNm: "동동강남" },
  EXCEPTION_LOST: { state: "EXCEPTION", statNm: "분실", branCd: "216", branNm: "동동강남" },
  EXCEPTION_DAMAGED: { state: "EXCEPTION", statNm: "파손", branCd: "216", branNm: "동동강남" },
  EXCEPTION_RETURNED: { state: "EXCEPTION", statNm: "반송", branCd: "216", branNm: "동동강남" },
});

export async function advanceShipment(db, slipNo, requestedState) {
  return db.transaction(async () => {
    const shipment = await db
      .prepare("SELECT slip_no, shipment_state FROM mock_shipments WHERE slip_no = ?")
      .get(slipNo);
    if (!shipment) return { ok: false, message: "유효한 운송장번호가 없습니다." };
    const requested = String(requestedState ?? "").trim().toUpperCase();
    const transition = requested
      ? SHIPMENT_ADMIN_TRANSITIONS[requested]
      : SHIPMENT_TRANSITIONS[shipment.shipment_state];
    if (requested && !transition) {
      return {
        ok: false,
        message: `지원하지 않는 배송 상태입니다: ${requested}`,
        supportedStates: Object.keys(SHIPMENT_ADMIN_TRANSITIONS),
      };
    }
    if (!transition) {
      return { ok: true, slipNo, state: shipment.shipment_state, completed: true };
    }
    await db.prepare("UPDATE mock_shipments SET shipment_state = ?, updated_at = ? WHERE slip_no = ?")
      .run(transition.state, nowIso(), slipNo);
    await addTrackingEvent(db, slipNo, transition);
    return {
      ok: true,
      slipNo,
      state: transition.state,
      statusName: transition.statNm,
      completed: transition.state === "DELIVERED",
    };
  })();
}

export async function trackingEvents(db, slipNo) {
  return db
    .prepare(`
      SELECT scan_dt, scan_tm, stat_nm, bran_cd, bran_nm, opp_bran_cd, opp_bran_nm,
             sales_cd, sales_nm, snd_bran_nm, rcv_bran_nm, acptor_ty_nm
      FROM mock_tracking_events
      WHERE slip_no = ?
      ORDER BY event_sequence
    `)
    .all(slipNo);
}

async function nextCounterValue(db, name, fallback) {
  const row = await db.prepare("SELECT value FROM mock_counters WHERE name = ? FOR UPDATE").get(name);
  const next = Number(row?.value ?? fallback) + 1;
  await db.prepare(`
    INSERT INTO mock_counters(name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `).run(name, next);
  return next;
}

export async function registerReturnRequest(db, userId, item) {
  return db.transaction(async () => {
    const duplicate = item.fixTakeNo
      ? await db.prepare("SELECT take_no FROM mock_returns WHERE fix_take_no = ?").get(item.fixTakeNo)
      : item.orgnSlipNo
        ? await db.prepare("SELECT take_no FROM mock_returns WHERE orgn_slip_no = ?").get(item.orgnSlipNo)
        : null;
    if (duplicate) {
      return {
        ok: false,
        takeNo: duplicate.take_no,
        message: "반품이중등록입니다.",
      };
    }

    const takeNo = String(await nextCounterValue(db, "return_take_no", 240503999999)).padStart(12, "0");
    const [returnSlipNo] = await allocateSlipNumbersInternal(db, 1, userId);
    const now = nowIso();
    await db.prepare(`
      UPDATE mock_invoice_allocations
      SET status = 'RETURN_REGISTERED', registered_at = ?
      WHERE slip_no = ?
    `).run(now, returnSlipNo);
    await db.prepare(`
      INSERT INTO mock_returns(
        take_no, fix_take_no, cust_cd, orgn_slip_no, return_slip_no,
        resv_stat, delay_cd, proc_dt, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '10', NULL, NULL, ?, ?, ?)
    `).run(
      takeNo,
      item.fixTakeNo || null,
      item.custCd,
      item.orgnSlipNo || null,
      returnSlipNo,
      JSON.stringify(item),
      now,
      now
    );
    await addTrackingEvent(db, returnSlipNo, { statNm: "반품접수" });
    return { ok: true, takeNo, returnSlipNo };
  })();
}

export async function returnByTakeNo(db, custCd, takeNo) {
  return db.prepare("SELECT * FROM mock_returns WHERE cust_cd = ? AND take_no = ?").get(custCd, takeNo);
}

export async function returnByFixTakeNo(db, custCd, fixTakeNo) {
  return db.prepare("SELECT * FROM mock_returns WHERE cust_cd = ? AND fix_take_no = ?").get(custCd, fixTakeNo);
}

export async function returnsByOriginalSlip(db, custCd, orgnSlipNo) {
  return db
    .prepare("SELECT * FROM mock_returns WHERE cust_cd = ? AND orgn_slip_no = ? ORDER BY created_at")
    .all(custCd, orgnSlipNo);
}

const RETURN_STATUS_NAMES = Object.freeze({
  "10": "접수완료",
  "20": "접수취소",
  "30": "집하지시",
  "40": "집하완료",
  "50": "미집하",
  "60": "기타",
});

export function returnStatusName(status) {
  return RETURN_STATUS_NAMES[status] || "기타";
}

export async function advanceReturn(db, takeNo, requestedStatus, delayCd = null) {
  return db.transaction(async () => {
    const row = await db.prepare("SELECT * FROM mock_returns WHERE take_no = ?").get(takeNo);
    if (!row) return { ok: false, message: "유효한 반품 접수번호가 없습니다." };
    const automatic = { "10": "30", "30": "40" };
    const nextStatus = requestedStatus || automatic[row.resv_stat] || row.resv_stat;
    if (!RETURN_STATUS_NAMES[nextStatus]) {
      return { ok: false, message: "유효한 반품 상태코드가 아닙니다." };
    }
    const scan = kstScanParts();
    const procDt = ["20", "40", "50", "60"].includes(nextStatus) ? scan.scanDt : null;
    await db.prepare(`
      UPDATE mock_returns
      SET resv_stat = ?, delay_cd = ?, proc_dt = ?, updated_at = ?
      WHERE take_no = ?
    `).run(nextStatus, nextStatus === "50" ? delayCd || "99" : null, procDt, nowIso(), takeNo);
    if (nextStatus === "30") await addTrackingEvent(db, row.return_slip_no, { statNm: "반품집하지시" });
    if (nextStatus === "40") await addTrackingEvent(db, row.return_slip_no, { statNm: "반품집하완료" });
    return {
      ok: true,
      takeNo,
      status: nextStatus,
      statusName: RETURN_STATUS_NAMES[nextStatus],
      delayCd: nextStatus === "50" ? delayCd || "99" : null,
      procDt,
    };
  })();
}

export async function resetLogenMockDatabase(db, config) {
  const reset = db.transaction(async () => {
    await db.exec(`
      DELETE FROM mock_tracking_events;
      DELETE FROM mock_returns;
      DELETE FROM mock_ilogen_orders;
      DELETE FROM mock_shipments;
      DELETE FROM mock_invoice_allocations;
      DELETE FROM mock_api_request_logs;
      DELETE FROM mock_contract_fares;
      DELETE FROM mock_contracts;
      DELETE FROM mock_credentials;
      DELETE FROM mock_ip_allowlist;
      DELETE FROM mock_counters;
    `);
    await seedReferenceData(db, config);
  });
  await reset();
}

export async function databaseState(db) {
  const count = async (table) =>
    Number((await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count);
  return {
    counts: {
      contracts: await count("mock_contracts"),
      allocations: await count("mock_invoice_allocations"),
      shipments: await count("mock_shipments"),
      ilogenOrders: await count("mock_ilogen_orders"),
      returns: await count("mock_returns"),
      trackingEvents: await count("mock_tracking_events"),
      requestLogs: await count("mock_api_request_logs"),
    },
    allocations: await db
      .prepare("SELECT slip_no, user_id, status, allocated_at, registered_at FROM mock_invoice_allocations ORDER BY slip_no DESC LIMIT 20")
      .all(),
    shipments: await db
      .prepare("SELECT slip_no, cust_cd, fix_take_no, shipment_state, registered_at FROM mock_shipments ORDER BY registered_at DESC LIMIT 20")
      .all(),
    ilogenOrders: await db
      .prepare("SELECT fix_take_no, cust_cd, take_dt, slip_no, del_yn FROM mock_ilogen_orders ORDER BY created_at DESC LIMIT 20")
      .all(),
    returns: await db
      .prepare("SELECT take_no, fix_take_no, orgn_slip_no, return_slip_no, resv_stat, delay_cd, proc_dt FROM mock_returns ORDER BY created_at DESC LIMIT 20")
      .all(),
  };
}

export async function recordApiRequest(db, input) {
  await db.prepare(`
    INSERT INTO mock_api_request_logs(
      method, endpoint_path, http_status, stts_cd, request_json, response_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.method,
    input.endpointPath,
    input.httpStatus,
    input.sttsCd || null,
    input.requestBody ? JSON.stringify(input.requestBody) : null,
    input.responseBody ? JSON.stringify(input.responseBody) : null,
    nowIso()
  );
}
