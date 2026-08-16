import fs from "node:fs";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const menu = read(
  "quickhack_client/components/app-shell/device-workspace-menu.ts"
);
const workspace = read(
  "quickhack_client/components/app-shell/device-workspace.tsx"
);
const view = read(
  "quickhack_client/components/shipment/shipment-delivery-search-view.tsx"
);
const detail = read(
  "quickhack_client/components/shipment/shipment-delivery-search-detail-sheet.tsx"
);

assert(
  menu.includes('id: "shipment-in-transit"') &&
    menu.includes('label: "현재 배송 중 목록"'),
  "The active-delivery menu is not named 현재 배송 중 목록."
);
assert(
  menu.includes('id: "shipment-delivery-search"') &&
    menu.includes('label: "전체 배송 건 검색"'),
  "The all-delivery search menu is missing."
);
assert(
  workspace.includes('selectedMenuId === "shipment-delivery-search"') &&
    workspace.includes("<ShipmentDeliverySearchView"),
  "The delivery search menu is not connected to its workspace view."
);
assert(
  view.includes("/api/shipments/search?") &&
    view.includes("/api/shipments/search/${packageGroupId}"),
  "The delivery search view is not connected to both list and detail APIs."
);

for (const columnLabel of [
  "상태",
  "송장",
  "주문",
  "상품·포장",
  "출고",
  "수취인·지역",
  "최근 배송 현황",
  "최근 처리",
]) {
  assert(
    view.includes(`label: "${columnLabel}"`),
    `The delivery search table is missing the ${columnLabel} column.`
  );
}

assert(
  view.includes('sortable: false') &&
    view.includes('filterable: false'),
  "The paged delivery table still exposes page-local column controls."
);
assert(
  !view.includes("프리셋") && !view.includes("컬럼 선택"),
  "The delivery search view unexpectedly contains column presets."
);
assert(
  detail.includes("배송지 정보") &&
    detail.includes("처리 진행 상태") &&
    detail.includes("포장 구성") &&
    detail.includes("송장 이력") &&
    detail.includes("배송 추적 이력"),
  "The delivery detail sheet is missing a required information section."
);

console.log("Shipment delivery search UI contract verified.");
