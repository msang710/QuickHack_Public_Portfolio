import { LOGEN_API_BASE_PATH } from "../contract.mjs";
import {
  ilogenOrderByFixTakeNo,
  knownUserId,
  listIlogenOrders,
  registerIlogenOrder,
} from "../database.mjs";
import { listStatus, requiredText } from "../response.mjs";

function items(body) {
  return Array.isArray(body?.data) ? body.data : [];
}

async function contractExists(db, custCd) {
  return Boolean(await db.prepare("SELECT 1 FROM mock_contracts WHERE cust_cd = ? AND use_yn = 'Y'").get(custCd));
}

async function orderValidation(item, db) {
  const required = ["custCd", "takeDt", "fixTakeNo", "sndCustNm", "sndCustAddr", "rcvCustNm", "rcvCustAddr", "fareTy"];
  const missing = required.filter((name) => !requiredText(item?.[name]));
  if (missing.length > 0) return `필수 필드가 누락되었습니다: ${missing.join(", ")}`;
  if (!(await contractExists(db, requiredText(item.custCd)))) return "유효한 거래처코드가 아닙니다.";
  if (!/^\d{8}$/.test(requiredText(item.takeDt))) return "takeDt는 YYYYMMDD 형식이어야 합니다.";
  if (!requiredText(item.sndTelNo) && !requiredText(item.sndCellNo)) return "송하인 전화번호 또는 휴대폰번호가 필요합니다.";
  if (!requiredText(item.rcvTelNo) && !requiredText(item.rcvCellNo)) return "수하인 전화번호 또는 휴대폰번호가 필요합니다.";
  if (!new Set(["010", "020", "030", "040"]).has(requiredText(item.fareTy))) return "유효한 fareTy가 아닙니다.";
  if (!Number.isSafeInteger(Number(item.qty)) || Number(item.qty) < 1) return "qty는 1 이상의 정수여야 합니다.";
  if (!Number.isSafeInteger(Number(item.dlvFare)) || Number(item.dlvFare) < 0) return "dlvFare는 0 이상의 정수여야 합니다.";
  return null;
}

async function registerOrders(body, db) {
  const userId = requiredText(body.userId);
  const userValid = await knownUserId(db, userId);
  const data = await Promise.all(items(body).map(async (item) => {
    const fixTakeNo = requiredText(item?.fixTakeNo);
    const error = !userValid ? "유효한 연동업체코드가 아닙니다." : await orderValidation(item, db);
    if (error) return { fixTakeNo, resultCd: "FALSE", resultMsg: error };
    const result = await registerIlogenOrder(db, userId, {
      ...item,
      custCd: requiredText(item.custCd),
      takeDt: requiredText(item.takeDt),
      fixTakeNo,
    });
    return {
      fixTakeNo,
      resultCd: result.ok ? "TRUE" : "FALSE",
      resultMsg: result.ok ? null : result.message,
    };
  }));
  return { data, ...listStatus(data, "총") };
}

async function inquirySlipNumbers(body, db) {
  const userValid = await knownUserId(db, requiredText(body.userId));
  const data = await Promise.all(items(body).map(async (item) => {
    const custCd = requiredText(item?.custCd);
    const fixTakeNo = requiredText(item?.fixTakeNo);
    const row = userValid && custCd && fixTakeNo
      ? await ilogenOrderByFixTakeNo(db, custCd, fixTakeNo)
      : null;
    if (!row) {
      return {
        fixTakeNo,
        data1: [],
        resultCd: "FALSE",
        resultMsg: "유효한 주문번호가 없습니다.",
      };
    }
    return {
      fixTakeNo,
      data1: row.slip_no ? [{ slipNo: row.slip_no, delYn: row.del_yn }] : [],
      resultCd: "TRUE",
      resultMsg: null,
    };
  }));
  return { data, ...listStatus(data, "총") };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function buildIlogenPopupHtml(url, db) {
  const userId = requiredText(url.searchParams.get("userId"));
  const custCd = requiredText(url.searchParams.get("custCd"));
  const takeDt = requiredText(url.searchParams.get("takeDt"));
  let error = null;
  if (!(await knownUserId(db, userId))) error = "유효한 연동업체코드가 아닙니다.";
  else if (!(await contractExists(db, custCd))) error = "유효한 거래처코드가 아닙니다.";
  else if (!/^\d{8}$/.test(takeDt)) error = "takeDt는 YYYYMMDD 형식이어야 합니다.";
  const orders = error ? [] : await listIlogenOrders(db, custCd, takeDt);
  const rows = orders.map((order) => {
    const action = order.slip_no
      ? `<span class="printed">출력됨 ${escapeHtml(order.slip_no)}</span>`
      : `<button type="button" data-fix="${escapeHtml(order.fix_take_no)}" onclick="printOrder(this.dataset.fix, this)">Mock 출력</button>`;
    return `<tr><td>${escapeHtml(order.fix_take_no)}</td><td>${escapeHtml(order.take_dt)}</td><td>${action}</td></tr>`;
  }).join("");
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>로젠 Mock 송장 출력</title>
<style>body{font-family:sans-serif;max-width:900px;margin:40px auto;padding:0 20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:10px;text-align:left}button{padding:8px 14px}.error{color:#b00020}.printed{color:#087f23;font-weight:700}</style></head>
<body><h1>로젠 Mock 송장 출력</h1><p>거래처 ${escapeHtml(custCd)} · 접수일 ${escapeHtml(takeDt)}</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : `<table><thead><tr><th>주문번호</th><th>접수일</th><th>출력</th></tr></thead><tbody>${rows || '<tr><td colspan="3">등록된 주문이 없습니다.</td></tr>'}</tbody></table>`}
<script>async function printOrder(fixTakeNo,button){button.disabled=true;const r=await fetch('/admin/ilogen/print',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fixTakeNo})});const p=await r.json();if(p.ok){button.outerHTML='<span class="printed">출력됨 '+p.slipNo+'</span>';}else{button.disabled=false;alert(p.message||'출력 실패');}}</script></body></html>`;
}

export async function buildIlogenResponse(method, path, body, db) {
  if (method !== "POST") return null;
  if (path === `${LOGEN_API_BASE_PATH}/registerOrderData`) {
    return { statusCode: 200, payload: await registerOrders(body, db) };
  }
  if (path === `${LOGEN_API_BASE_PATH}/inquirySlipNoMulti`) {
    return { statusCode: 200, payload: await inquirySlipNumbers(body, db) };
  }
  return null;
}
