import { LOGEN_API_BASE_PATH } from "../contract.mjs";
import {
  knownUserId,
  registerReturnRequest,
  returnByFixTakeNo,
  returnByTakeNo,
  returnsByOriginalSlip,
  returnStatusName,
} from "../database.mjs";
import { listStatus, requiredText } from "../response.mjs";

function items(body) {
  return Array.isArray(body?.data) ? body.data : [];
}

async function contract(db, custCd) {
  return db.prepare("SELECT * FROM mock_contracts WHERE cust_cd = ? AND use_yn = 'Y'").get(custCd);
}

async function reverseInfo(body, db) {
  const userValid = await knownUserId(db, requiredText(body.userId));
  const data = await Promise.all(items(body).map(async (item) => {
    const custCd = requiredText(item?.custCd);
    const orgnSlipNo = requiredText(item?.orgnSlipNo);
    const row = await contract(db, custCd);
    if (!userValid || !row || !/^\d{11}$/.test(orgnSlipNo)) {
      return {
        custCd,
        resultCd: "FALSE",
        resultMsg: "반품 집하지점·운임 조회 조건이 올바르지 않습니다.",
      };
    }
    return {
      custCd,
      custNm: row.cust_nm,
      dlvBranCd: "543",
      branNm: "문경",
      fareTy: "010",
      fareTyNm: "선불",
      dlvFare: 4000,
      resultCd: "TRUE",
      resultMsg: "",
    };
  }));
  return { data, ...listStatus(data, "총") };
}

async function returnValidation(item, db) {
  const custCd = requiredText(item?.custCd);
  const orgnSlipNo = requiredText(item?.orgnSlipNo);
  const fixTakeNo = requiredText(item?.fixTakeNo);
  if (!orgnSlipNo && (!fixTakeNo || !custCd)) {
    return "orgnSlipNo가 없으면 fixTakeNo와 custCd가 필요합니다.";
  }
  if (orgnSlipNo && !/^\d{11}$/.test(orgnSlipNo)) return "orgnSlipNo는 11자리 숫자 문자열이어야 합니다.";
  if (!custCd || !(await contract(db, custCd))) return "유효한 거래처코드가 아닙니다.";
  const required = ["sndCustNm", "sndCustAddr1", "rcvCustNm", "rcvCustAddr1"];
  const missing = required.filter((name) => !requiredText(item?.[name]));
  if (missing.length > 0) return `필수 필드가 누락되었습니다: ${missing.join(", ")}`;
  if (!requiredText(item.sndTelNo) && !requiredText(item.sndCellNo)) return "송하인 전화번호 또는 휴대폰번호가 필요합니다.";
  if (!requiredText(item.rcvTelNo) && !requiredText(item.rcvCellNo)) return "수하인 전화번호 또는 휴대폰번호가 필요합니다.";
  if (Number(item.qty) !== 1) return "qty는 1이어야 합니다.";
  if (!new Set(["010", "020"]).has(requiredText(item.fareTy))) return "반품 fareTy는 010 또는 020이어야 합니다.";
  if (!Number.isSafeInteger(Number(item.dlvFare)) || Number(item.dlvFare) <= 0) return "dlvFare는 0보다 큰 정수여야 합니다.";
  return null;
}

async function registerReturns(body, db) {
  const userId = requiredText(body.userId);
  const userValid = await knownUserId(db, userId);
  const data = await Promise.all(items(body).map(async (item) => {
    const fixTakeNo = requiredText(item?.fixTakeNo) || null;
    const error = !userValid ? "유효한 연동업체코드가 아닙니다." : await returnValidation(item, db);
    if (error) {
      return { takeNo: null, fixTakeNo, resultCd: "FALSE", resultMsg: error };
    }
    const result = await registerReturnRequest(db, userId, {
      ...item,
      custCd: requiredText(item.custCd),
      orgnSlipNo: requiredText(item.orgnSlipNo),
      fixTakeNo: requiredText(item.fixTakeNo),
    });
    return {
      takeNo: result.takeNo || null,
      fixTakeNo,
      resultCd: result.ok ? "TRUE" : "FALSE",
      resultMsg: result.ok ? "정상적으로 처리되었습니다" : result.message,
    };
  }));
  return { data, ...listStatus(data, "총") };
}

function statusFields(row) {
  return {
    takeNo: row.take_no,
    resvStat: row.resv_stat,
    slipNo: row.return_slip_no,
    delayCd: row.delay_cd,
    procDt: row.proc_dt,
    resultCd: "TRUE",
    resultMsg: null,
  };
}

async function statusByTakeNo(body, db) {
  const userValid = await knownUserId(db, requiredText(body.userId));
  const data = await Promise.all(items(body).map(async (item) => {
    const custCd = requiredText(item?.custCd);
    const takeNo = requiredText(item?.takeNo);
    const row = userValid ? await returnByTakeNo(db, custCd, takeNo) : null;
    return row
      ? statusFields(row)
      : { takeNo, resultCd: "FALSE", resultMsg: "유효한 반품 접수번호가 없습니다." };
  }));
  return { data, ...listStatus(data, "총") };
}

async function statusByFixTakeNo(body, db) {
  const userValid = await knownUserId(db, requiredText(body.userId));
  const data = await Promise.all(items(body).map(async (item) => {
    const custCd = requiredText(item?.custCd);
    const fixTakeNo = requiredText(item?.fixTakeNo);
    const row = userValid ? await returnByFixTakeNo(db, custCd, fixTakeNo) : null;
    return row
      ? { ...statusFields(row), fixTakeNo }
      : { takeNo: null, fixTakeNo, resultCd: "FALSE", resultMsg: "유효한 주문번호가 없습니다." };
  }));
  return { data, ...listStatus(data, "총") };
}

async function returnInfo(body, db) {
  const userValid = await knownUserId(db, requiredText(body.userId));
  const data = await Promise.all(items(body).map(async (item) => {
    const custCd = requiredText(item?.custCd);
    const orgnSlipNo = requiredText(item?.orgnSlipNo);
    const rows = userValid ? await returnsByOriginalSlip(db, custCd, orgnSlipNo) : [];
    if (rows.length === 0) {
      return {
        orgnSlipNo,
        data1: [],
        resultCd: "FALSE",
        resultMsg: "반품접수 정보가 없습니다.",
      };
    }
    return {
      orgnSlipNo,
      data1: rows.map((row) => ({
        takeNo: row.take_no,
        slipNo: row.return_slip_no,
        resvStatNm: returnStatusName(row.resv_stat),
      })),
      resultCd: "TRUE",
      resultMsg: null,
    };
  }));
  return { data, ...listStatus(data, "총") };
}

const handlers = new Map([
  [`${LOGEN_API_BASE_PATH}/reverseChkInfoMulti`, reverseInfo],
  [`${LOGEN_API_BASE_PATH}/registReturnRequest`, registerReturns],
  [`${LOGEN_API_BASE_PATH}/inquiryReserveStateMulti`, statusByTakeNo],
  [`${LOGEN_API_BASE_PATH}/inquiryReserveStateFixTakeNo`, statusByFixTakeNo],
  [`${LOGEN_API_BASE_PATH}/inquiryReturnStateMulti`, returnInfo],
]);

export async function buildReturnResponse(method, path, body, db) {
  const handler = handlers.get(path);
  if (!handler) return null;
  if (method !== "POST") {
    return { statusCode: 405, payload: { sttsCd: "FAIL", sttsMsg: "지원하지 않는 HTTP 메서드입니다." } };
  }
  return { statusCode: 200, payload: await handler(body, db) };
}
