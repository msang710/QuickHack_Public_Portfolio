// QuickHack note: ADB 실행 파일 경로와 배포 환경별 platform-tools 탐색 기준을 정의합니다.
﻿type CameraConfig = {
  name: string;
  focus: string;
};

function cameras(...items: Array<[string, string]>): CameraConfig[] {
  return items.map(([name, focus]) => ({ name, focus }));
}

const sTriple = cameras(
  ["0.6x", "초점X"],
  ["1x", "AF"],
  ["3x", "AF"],
  ["전면", "AF"]
);
const sTripleFrontFixed = cameras(
  ["0.6x", "초점X"],
  ["1x", "AF"],
  ["3x", "AF"],
  ["전면", "초점X"]
);
const ultraTen = cameras(
  ["0.6x", "AF"],
  ["1x", "AF"],
  ["3x", "AF"],
  ["10x", "AF"],
  ["전면", "AF"]
);
const ultraFive = cameras(
  ["0.6x", "AF"],
  ["1x", "AF"],
  ["3x", "AF"],
  ["5x", "AF"],
  ["전면", "AF"]
);
const flip = cameras(["0.6x", "초점X"], ["1x", "AF"], ["전면", "초점X"]);
const fold = cameras(
  ["0.6x", "초점X"],
  ["1x", "AF"],
  ["3x", "AF"],
  ["커버전면", "초점X"],
  ["내부전면", "초점X"]
);
const aSeries = cameras(
  ["0.5x", "초점X"],
  ["1x", "AF"],
  ["접사", "초점X"],
  ["전면", "초점X"]
);
const developer = cameras(
  ["0.6x", "초점X"],
  ["1x", "AF"],
  ["2.6x", "AF"],
  ["전면", "초점X"]
);

const wide5 = cameras(["0.5x", "초점X"], ["1x", "AF"], ["전면", "초점X"]);
const wide6Jump = cameras(["1x", "AF"], ["접사", "초점X"], ["전면", "초점X"]);

export const MODEL_MAP: Record<string, string> = {
  "SM-S911N": "Galaxy S23",
  "SM-S916N": "Galaxy S23+",
  "SM-S918N": "Galaxy S23 Ultra",
  "SM-S921N": "Galaxy S24",
  "SM-S926N": "Galaxy S24+",
  "SM-S928N": "Galaxy S24 Ultra",
  "SM-S931N": "Galaxy S25",
  "SM-S936N": "Galaxy S25+",
  "SM-S938N": "Galaxy S25 Ultra",
  "SM-S711N": "Galaxy S23 FE",
  "SM-S721N": "Galaxy S24 FE",
  "SM-F731N": "Galaxy Z Flip5",
  "SM-F741N": "Galaxy Z Flip6",
  "SM-F766N": "Galaxy Z Flip7",
  "SM-F946N": "Galaxy Z Fold5",
  "SM-F956N": "Galaxy Z Fold6",
  "SM-A156N": "Galaxy A15",
  "SM-A256N": "Galaxy A25",
  "SM-A346N": "Galaxy A34",
  "SM-A165N": "Galaxy A16",
  "SM-A235N": "Galaxy A23",
  "SM-A356N": "Galaxy A35",
  "SM-A556N": "Galaxy A55",
  "SM-A245N": "Galaxy A24",
  "SM-A546S": "Galaxy Quantum4",
  "SM-A556S": "Galaxy Quantum5",
  "SM-A566S": "Galaxy Quantum6",
  "SM-A236L": "Galaxy Buddy2",
  "SM-E426S": "Galaxy Wide5",
  "SM-A136S": "Galaxy Wide6",
  "SM-M156S": "Galaxy Wide7",
  "SM-M446K": "Galaxy Jump3",
  "SM-M366K": "Galaxy Jump4",
  "24129PN74G": "★ 만든놈폰",
};

export const CSC_MAP: Record<string, string> = {
  SKC: "SKT",
  KTC: "KT",
  LUC: "LG U+",
  KOO: "자급제",
};

export const CAMERA_CHECK_MAP: Record<string, CameraConfig[]> = {
  "SM-S911N": sTriple,
  "SM-S916N": sTriple,
  "SM-S918N": ultraTen,
  "SM-S921N": sTriple,
  "SM-S926N": sTriple,
  "SM-S928N": ultraFive,
  "SM-S931N": sTriple,
  "SM-S936N": sTriple,
  "SM-S938N": ultraFive,
  "SM-S711N": sTripleFrontFixed,
  "SM-S721N": sTripleFrontFixed,
  "SM-F731N": flip,
  "SM-F741N": flip,
  "SM-F766N": flip,
  "SM-F946N": fold,
  "SM-F956N": fold,
  "SM-A156N": aSeries,
  "SM-A256N": aSeries,
  "SM-A346N": aSeries,
  "SM-A165N": aSeries,
  "SM-A235N": aSeries,
  "SM-A356N": aSeries,
  "SM-A556N": aSeries,
  "SM-A245N": aSeries,
  "SM-A546S": aSeries,
  "SM-A556S": aSeries,
  "SM-A566S": aSeries,
  "SM-A236L": aSeries,
  "SM-E426S": wide5,
  "SM-A136S": wide6Jump,
  "SM-M156S": aSeries,
  "SM-M446K": wide6Jump,
  "SM-M366K": wide6Jump,
  "24129PN74G": developer

};

const modelCodeByProduct = Object.fromEntries(
  Object.entries(MODEL_MAP).map(([modelCode, product]) => [product, modelCode])
);

export function formatCameraCheck(cameras: CameraConfig[]) {
  if (cameras.length === 0) {
    return "-";
  }

  return cameras.map((camera) => `${camera.name}[${camera.focus}]`).join(" / ");
}

export function getCameraCheckByModelCode(modelCode: string) {
  return formatCameraCheck(CAMERA_CHECK_MAP[modelCode.trim()] ?? []);
}

export function getCameraCheckByProduct(product: string) {
  const normalized = product.trim();

  if (!normalized || normalized === "-") {
    return "-";
  }

  return getCameraCheckByModelCode(modelCodeByProduct[normalized] ?? normalized);
}

export const DEVICE_ACTIONS = {
  accounts: ["am", "start", "-a", "android.settings.SYNC_SETTINGS"],
  camera: ["am", "start", "-a", "android.media.action.STILL_IMAGE_CAMERA"],
} as const;
