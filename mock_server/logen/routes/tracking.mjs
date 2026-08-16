import { LOGEN_API_BASE_PATH } from "../contract.mjs";
import { knownUserId, trackingEvents } from "../database.mjs";
import { listStatus, requiredText } from "../response.mjs";

function items(body) {
  return Array.isArray(body?.data) ? body.data : [];
}

function eventPayload(row) {
  return {
    scanDt: row.scan_dt,
    scanTm: row.scan_tm,
    statNm: row.stat_nm,
    branCd: row.bran_cd,
    branNm: row.bran_nm,
    oppBranCd: row.opp_bran_cd,
    oppBranNm: row.opp_bran_nm,
    salesCd: row.sales_cd,
    salesNm: row.sales_nm,
    sndBranNm: row.snd_bran_nm,
    rcvBranNm: row.rcv_bran_nm,
    acptorTyNm: row.acptor_ty_nm,
  };
}

async function allTracking(body, db) {
  const userValid = await knownUserId(db, requiredText(body.userId));
  const data = await Promise.all(items(body).map(async (item) => {
    const slipNo = requiredText(item?.slipNo);
    const rows = userValid ? await trackingEvents(db, slipNo) : [];
    return rows.length > 0
      ? { slipNo, data1: rows.map(eventPayload), resultCd: "TRUE", resultMsg: null }
      : { slipNo, data1: [], resultCd: "FALSE", resultMsg: "유효한 운송장번호가 없습니다." };
  }));
  return { data, ...listStatus(data, "총") };
}

async function latestTracking(body, db) {
  const userValid = await knownUserId(db, requiredText(body.userId));
  const data = await Promise.all(items(body).map(async (item) => {
    const slipNo = requiredText(item?.slipNo);
    const rows = userValid ? await trackingEvents(db, slipNo) : [];
    const latest = rows.at(-1);
    if (!latest) {
      return { slipNo, resultCd: "FALSE", resultMsg: "유효한 운송장번호가 없습니다." };
    }
    const event = eventPayload(latest);
    return {
      slipNo,
      scanDt: event.scanDt,
      scanTm: event.scanTm,
      statNm: event.statNm,
      branCd: event.branCd,
      branNm: event.branNm,
      oppBranCd: event.oppBranCd,
      oppBranNm: event.oppBranNm,
      salesCd: event.salesCd,
      salesNm: event.salesNm,
      salesCellNo: "010-0000-0000",
      resultCd: "TRUE",
      resultMsg: null,
    };
  }));
  return { data, ...listStatus(data, "총") };
}

export async function buildTrackingResponse(method, path, body, db) {
  if (method !== "POST") return null;
  if (path === `${LOGEN_API_BASE_PATH}/inquiryCargoTrackingMulti`) {
    return { statusCode: 200, payload: await allTracking(body, db) };
  }
  if (path === `${LOGEN_API_BASE_PATH}/inquiryCargoTrackingMultiLast`) {
    return { statusCode: 200, payload: await latestTracking(body, db) };
  }
  return null;
}
