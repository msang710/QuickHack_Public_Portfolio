import { LOGEN_API_BASE_PATH } from "../contract.mjs";
import {
  allocateSlipNumbers,
  knownUserId,
  registerShipment,
} from "../database.mjs";
import { listStatus, requiredText } from "../response.mjs";

const FARE_TYPE_NAMES = Object.freeze({
  "010": "선불",
  "020": "착불",
  "030": "신용",
  "040": "본사신용",
});

function requestItems(body) {
  return Array.isArray(body?.data) ? body.data : [];
}

async function contractRow(db, custCd) {
  return db.prepare("SELECT * FROM mock_contracts WHERE cust_cd = ?").get(custCd);
}

async function contractInfo(body, db) {
  const userValid = await knownUserId(db, requiredText(body.userId));
  const data = await Promise.all(requestItems(body).map(async (item) => {
    const custCd = requiredText(item?.custCd);
    const row = await contractRow(db, custCd);
    if (!userValid || !row) {
      return {
        custCd,
        resultCd: "FALSE",
        resultMsg: !userValid
          ? "유효한 연동업체코드가 아닙니다."
          : "유효한 거래처코드가 아닙니다.",
      };
    }
    return {
      custCd: row.cust_cd,
      pickSalesCd: row.pick_sales_cd,
      pickSalesNm: row.pick_sales_nm,
      pickBranCd: row.pick_bran_cd,
      pickBranNm: row.pick_bran_nm,
      fareTy: row.fare_ty,
      fareTyNm: row.fare_ty_nm,
      useYn: row.use_yn,
      resultCd: row.use_yn === "Y" ? "TRUE" : "FALSE",
      resultMsg: row.use_yn === "Y" ? null : "사용 중지된 거래처입니다.",
    };
  }));
  return { data, ...listStatus(data) };
}

async function contractFares(body, db) {
  const userValid = await knownUserId(db, requiredText(body.userId));
  const data = await Promise.all(requestItems(body).map(async (item) => {
    const custCd = requiredText(item?.custCd);
    const fareTy = requiredText(item?.fareTy);
    const contract = await contractRow(db, custCd);
    const rows = contract
      ? await db
          .prepare(`
            SELECT box_ty_cd, box_ty_nm, dlv_fare
            FROM mock_contract_fares
            WHERE cust_cd = ? AND fare_ty = ?
            ORDER BY box_ty_cd
          `)
          .all(custCd, fareTy)
      : [];
    if (!userValid || !contract || rows.length === 0) {
      return {
        custCd,
        fareTy,
        data1: [],
        resultCd: "FAIL",
        resultMsg: !userValid
          ? "유효한 연동업체코드가 아닙니다."
          : "조회 가능한 계약운임이 없습니다.",
      };
    }
    return {
      custCd,
      fareTy,
      data1: rows.map((row) => ({
        boxTyCd: row.box_ty_cd,
        boxTyNm: row.box_ty_nm,
        custCd,
        custNm: contract.cust_nm,
        dlvFare: row.dlv_fare,
      })),
      resultCd: "SUCCESS",
      resultMsg: "",
    };
  }));
  return { data, ...listStatus(data) };
}

function slipNumberFailure(message) {
  return {
    data: {
      startSlipNo: null,
      closeSlipNo: null,
      data1: [{ slipNo: null, resultCd: "FALSE", resultMsg: message }],
    },
    sttsCd: "FAIL",
    sttsMsg: message,
  };
}

async function allocateInvoices(body, db) {
  const userId = requiredText(body.userId);
  if (!(await knownUserId(db, userId))) {
    return slipNumberFailure("유효한 연동업체코드가 아닙니다.");
  }
  const items = requestItems(body);
  const quantities = items.map((item) => Number(item?.slipQty));
  if (
    quantities.length === 0 ||
    quantities.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    quantities.reduce((sum, value) => sum + value, 0) > 9999
  ) {
    return slipNumberFailure("slipQty는 1 이상이며 한 요청 합계는 최대 9999입니다.");
  }
  const slipNumbers = await allocateSlipNumbers(
    db,
    quantities.reduce((sum, value) => sum + value, 0),
    userId
  );
  return {
    data: {
      startSlipNo: slipNumbers[0],
      closeSlipNo: slipNumbers.at(-1),
      data1: slipNumbers.map((slipNo) => ({
        slipNo,
        resultCd: "TRUE",
        resultMsg: "",
      })),
    },
    sttsCd: "SUCCESS",
    sttsMsg: `조회결과 ${slipNumbers.length}건 중, ${slipNumbers.length}건 성공`,
  };
}

function addressClassification(address) {
  if (/제주/.test(address)) {
    return {
      branCd: "501",
      dongNm: "제주",
      classCd: "J1-501",
      zipCd: "63115",
      jejuRegYn: "Y",
      shipYn: "N",
      montYn: "N",
      salesNm: "제주영업소",
      branShareYn: "N",
      tmlNm: "제주TM",
    };
  }
  if (/울릉|연륙도서|도서/.test(address)) {
    return {
      branCd: "801",
      dongNm: "도서지역",
      classCd: "I1-801",
      zipCd: "40200",
      jejuRegYn: "N",
      shipYn: "Y",
      montYn: "N",
      salesNm: "도서지역영업소",
      branShareYn: "N",
      tmlNm: "도서TM",
    };
  }
  if (/정선|산간/.test(address)) {
    return {
      branCd: "244",
      dongNm: "산간지역",
      classCd: "M1-244",
      zipCd: "26131",
      jejuRegYn: "N",
      shipYn: "N",
      montYn: "Y",
      salesNm: "정선영업소",
      branShareYn: "N",
      tmlNm: "원주TM",
    };
  }
  return {
    branCd: "216",
    dongNm: "상도1동",
    classCd: "G4-216",
    zipCd: "06912",
    jejuRegYn: "N",
    shipYn: "N",
    montYn: "N",
    salesNm: "상도영업소",
    branShareYn: "N",
    tmlNm: "원주TM",
  };
}

async function integratedInquiry(body, db) {
  const userValid = await knownUserId(db, requiredText(body.userId));
  const data = await Promise.all(requestItems(body).map(async (item) => {
    const custCd = requiredText(item?.custCd);
    const addr = requiredText(item?.addr);
    if (!userValid || !(await contractRow(db, custCd)) || !addr) {
      return {
        custCd,
        addr,
        resultCd: "FALSE",
        resultMsg: !addr
          ? "주소가 필요합니다."
          : !userValid
            ? "유효한 연동업체코드가 아닙니다."
            : "유효한 거래처코드가 아닙니다.",
      };
    }
    return {
      custCd,
      addr,
      ...addressClassification(addr),
      resultCd: "TRUE",
      resultMsg: null,
    };
  }));
  return { data, ...listStatus(data) };
}

// The public document exposes examples but not the proprietary surcharge formula.
// This deterministic mock-only rule reproduces the documented 15,000,000 -> 42,750 example.
function mockExtraFare(goodsAmount) {
  if (goodsAmount >= 10_000_000) return Math.round(goodsAmount * 0.00285);
  if (goodsAmount >= 5_000_000) return Math.round(goodsAmount * 0.002);
  if (goodsAmount >= 3_000_000) return Math.round(goodsAmount * 0.0015);
  return 0;
}

async function extraFare(body, db) {
  const userValid = await knownUserId(db, requiredText(body.userId));
  const data = await Promise.all(requestItems(body).map(async (item) => {
    const custCd = requiredText(item?.custCd);
    const fareTy = requiredText(item?.fareTy);
    const goodsAmt = Number(item?.goodsAmt ?? 0);
    const dlvFare = Number(item?.dlvFare ?? 0);
    const invalid =
      !userValid ||
      !(await contractRow(db, custCd)) ||
      !FARE_TYPE_NAMES[fareTy] ||
      !Number.isSafeInteger(goodsAmt) ||
      goodsAmt < 0 ||
      !Number.isSafeInteger(dlvFare) ||
      dlvFare < 0;
    if (invalid) {
      return {
        custCd,
        fareTy,
        goodsAmt,
        dlvFare,
        extraFare: 0,
        resultCd: "FALSE",
        resultMsg: "할증운임 조회 조건이 올바르지 않습니다.",
      };
    }
    return {
      custCd,
      fareTy,
      goodsAmt,
      dlvFare,
      extraFare: mockExtraFare(goodsAmt),
      resultCd: "TRUE",
      resultMsg: null,
    };
  }));
  return { data, ...listStatus(data) };
}

function requiredShipmentError(data) {
  const required = [
    "printYn",
    "slipNo",
    "custCd",
    "sndCustNm",
    "sndTelNo",
    "sndCustAddr1",
    "sndCustAddr2",
    "rcvCustNm",
    "rcvTelNo",
    "rcvCustAddr1",
    "rcvCustAddr2",
    "fareTy",
    "rcvBranCd",
    "takeDt",
  ];
  const missing = required.filter((name) => !requiredText(data?.[name]));
  if (missing.length > 0) return `필수 필드가 누락되었습니다: ${missing.join(", ")}`;
  if (!/^\d{11}$/.test(requiredText(data.slipNo))) return "slipNo는 11자리 숫자 문자열이어야 합니다.";
  if (!/^\d{8}$/.test(requiredText(data.takeDt))) return "takeDt는 YYYYMMDD 형식이어야 합니다.";
  if (Number(data.qty) !== 1) return "qty는 1이어야 합니다.";
  if (!FARE_TYPE_NAMES[requiredText(data.fareTy)]) return "유효한 fareTy가 아닙니다.";
  for (const name of ["dlvFare", "extraFare", "goodsAmt"]) {
    if (!Number.isSafeInteger(Number(data[name])) || Number(data[name]) < 0) {
      return `${name}는 0 이상의 정수여야 합니다.`;
    }
  }
  return null;
}

async function registerPrintedInvoice(body, db) {
  const userId = requiredText(body.userId);
  const data = body?.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? body.data
    : {};
  const slipNo = requiredText(data.slipNo);
  let message = !(await knownUserId(db, userId))
    ? "유효한 연동업체코드가 아닙니다."
    : requiredShipmentError(data);
  if (!message && !(await contractRow(db, requiredText(data.custCd)))) {
    message = "유효한 거래처코드가 아닙니다.";
  }
  if (!message) {
    const result = await registerShipment(db, {
      ...data,
      slipNo,
      custCd: requiredText(data.custCd),
      printYn: requiredText(data.printYn),
      slipTy: requiredText(data.slipTy) || "100",
      fareTy: requiredText(data.fareTy),
      takeDt: requiredText(data.takeDt),
      sndCustNm: requiredText(data.sndCustNm),
      rcvCustNm: requiredText(data.rcvCustNm),
      rcvCustAddr1: requiredText(data.rcvCustAddr1),
      rcvCustAddr2: requiredText(data.rcvCustAddr2),
      fixTakeNo: requiredText(data.fixTakeNo),
    });
    if (!result.ok) message = result.message;
  }
  const success = !message;
  return {
    data: {
      slipNo,
      resultCd: success ? "TRUE" : "FALSE",
      resultMsg: success ? "" : message,
    },
    sttsCd: success ? "SUCCESS" : "FAIL",
    sttsMsg: `총1건 - 처리결과 : 1건 처리 중 ${success ? 1 : 0}건 성공`,
  };
}

const handlers = new Map([
  [`${LOGEN_API_BASE_PATH}/contractTotalInfo`, contractInfo],
  [`${LOGEN_API_BASE_PATH}/contPickFares`, contractFares],
  [`${LOGEN_API_BASE_PATH}/getSlipNo`, allocateInvoices],
  [`${LOGEN_API_BASE_PATH}/integratedInquiry`, integratedInquiry],
  [`${LOGEN_API_BASE_PATH}/slipPrintM`, registerPrintedInvoice],
  [`${LOGEN_API_BASE_PATH}/custExtraFare`, extraFare],
]);

export async function buildCoreResponse(method, path, body, db) {
  const handler = handlers.get(path);
  if (!handler) return null;
  if (method !== "POST") {
    return {
      statusCode: 405,
      payload: { sttsCd: "FAIL", sttsMsg: "지원하지 않는 HTTP 메서드입니다." },
    };
  }
  return { statusCode: 200, payload: await handler(body, db) };
}
