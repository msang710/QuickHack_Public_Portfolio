import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function normalizeLineEndings(source) {
  return source.replace(/\r\n?/g, "\n");
}

function read(relativePath) {
  return normalizeLineEndings(
    fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")
  );
}

assert.equal(
  normalizeLineEndings("first\r\nsecond\rthird\n"),
  "first\nsecond\nthird\n",
  "Source contract line endings are not normalized."
);

const menu = read(
  "quickhack_client/components/app-shell/device-workspace-menu.ts"
);
const workspace = read(
  "quickhack_client/components/app-shell/device-workspace.tsx"
);
const view = read(
  "quickhack_client/components/admin/sales-channel-sync-check-view.tsx"
);
const inventoryDetail = read(
  "quickhack_client/components/admin/sales-channel-inventory-verification-detail.tsx"
);
const unifiedUi = `${view}\n${inventoryDetail}`;
const writeView = read(
  "quickhack_client/components/admin/sales-channel-write-review-view.tsx"
);
const performanceLabels = read(
  "quickhack_shared/observability/response-performance.ts"
);
const userFacingSources = [
  menu,
  workspace,
  view,
  inventoryDetail,
  writeView,
  read("quickhack_server/api/admin/sales-channel-write-requests.ts"),
  read("quickhack_server/api/sales-channel/coupang/returns.ts"),
  read(
    "quickhack_server/shipment/carrier-integration/coupang-invoice-replacement-service.ts"
  ),
  read(
    "quickhack_client/components/shipment/shipment-delivery-search-detail-sheet.tsx"
  ),
  performanceLabels,
].join("\n");

assert(
  menu.includes('id: "admin-sales-channel-sync-check"') &&
    menu.includes('label: "판매 채널 동기화 점검"') &&
    menu.includes('minRole: "STAFF"'),
  "The STAFF sync-check menu contract is missing."
);
const salesChannelGroupIndex = menu.indexOf('id: "sales-channel"');
const syncCheckMenuIndex = menu.indexOf(
  'id: "admin-sales-channel-sync-check"'
);
const systemAdminGroupIndex = menu.indexOf('id: "system-admin"');
assert(
  salesChannelGroupIndex >= 0 &&
    syncCheckMenuIndex > salesChannelGroupIndex &&
    syncCheckMenuIndex < systemAdminGroupIndex,
  "The sync-check menu must belong to the sales-channel group."
);
assert(
  !menu.includes("admin-sales-channel-write-review") &&
    !workspace.includes("admin-sales-channel-write-review"),
  "The old menu id still has a direct client caller."
);
assert(
  workspace.includes("<SalesChannelSyncCheckView") &&
    workspace.includes("initialWriteRequestId={focusedSyncCheckWriteRequestId}"),
  "The unified view is not wired to focused write-request navigation."
);
assert(
  (
    workspace.match(/requestMenuChange\("admin-sales-channel-sync-check"/g) ??
    []
  ).length === 5,
  "All five shipment, invoice, and return write-review deep links must target the unified menu."
);
assert(
  workspace.includes(
    "/api/admin/sales-channel-sync-checks?kind=ALL&status=UNRESOLVED&limit=1"
  ) &&
    workspace.includes("salesChannelSyncCheckUnresolvedCount > 99") &&
    workspace.includes('? "99+"'),
  "The sidebar badge is not using the unified global unresolved count."
);

for (const contract of [
  "SALES_CHANNEL_SYNC_CHECK_KIND.writeRequest",
  "SALES_CHANNEL_SYNC_CHECK_KIND.inventoryVerification",
  'action: "recheckInventory"',
  "/api/admin/sales-channel-sync-checks",
  "/api/admin/sales-channel-write-requests",
  "salesChannelSyncCheckItemKey",
  "salesChannelWriteReviewFormId",
  "runGuardedAction",
  "ledgerQuantity",
  "pendingOrderQuantity",
  "expectedChannelQuantity",
  "channelQuantity",
  "difference",
  "이 작업은 쿠팡 재고수량을",
  "수정하지 않습니다.",
  'action: "repairInventory"',
  "observedDesiredVersion",
  "observedMismatchSince",
  "observedExpectedChannelQuantity",
  "observedChannelQuantity",
  "쿠팡 재고수량 복구가 완료되었습니다.",
  "쿠팡 반영은 성공했지만 처리 중 기준 재고가 변경되어 새 불일치가 남았습니다.",
  "쿠팡 반영은 성공했지만 이후 재고 점검이 실패했습니다.",
  "쿠팡 재고수량 복구",
  "기대수량",
  "DialogFrame",
]) {
  assert(unifiedUi.includes(contract), `The unified view is missing ${contract}.`);
}

assert(
  inventoryDetail.includes('item.verificationStatus === "MISMATCH"') &&
    inventoryDetail.includes("isInventoryVerificationRecheckable"),
  "Inventory repair and recheck eligibility are not independently guarded."
);
assert(
  !unifiedUi.includes('method: "PUT"'),
  "The client must not call the Coupang quantity PUT directly."
);
assert(
  writeView.includes("export function SalesChannelWriteReviewDetail") &&
    writeView.includes("export function SalesChannelWriteControlAlerts"),
  "The existing write detail and paused controls were not reused."
);
assert(
  writeView.includes(
    "const actionDisabled = working || reviewOperationInProgress"
  ) &&
    writeView.includes('item.activeReviewOperation === "LOCAL_FINALIZE"') &&
    writeView.includes("판매 채널 상태를 재점검하고 있습니다.") &&
    writeView.includes("disabled={actionDisabled}"),
  "Persisted write-review ownership is not reflected in the shared detail UI."
);
assert(
  writeView.includes("target.resolutionGroupKey") &&
    writeView.includes("target.resolutionGroupRepresentativeTargetId") &&
    writeView.includes('target.externalResultStatus === "UNKNOWN"') &&
    writeView.includes('"CHANNEL_APPLIED",') &&
    writeView.includes('"CHANNEL_NOT_APPLIED",') &&
    writeView.includes("targetId: representativeTargetId"),
  "Write-review decisions are not scoped to unresolved target groups."
);
assert(
  view.includes(
    "async function decideWrite(\n    decision: string,\n    representativeTargetId: number\n  )"
  ) &&
    view.includes(
      'action: "decision",\n        requestId: selectedWrite.id,\n        targetId: representativeTargetId,\n        decision,\n        note: submittedNote'
    ) &&
    view.includes("onDecision={decideWrite}"),
  "The unified sync-check view drops the selected resolution-group target ID."
);
assert(
  !userFacingSources.includes("외부 API 처리 확인"),
  "A user-facing legacy menu name remains."
);
assert(
  performanceLabels.includes(
    '"sales-channel.sync-check.read": "판매 채널 동기화 점검 조회"'
  ) &&
    performanceLabels.includes(
      '"sales-channel.sync-check.recheck-inventory": "판매 채널 재고 다시 점검"'
    ) &&
    performanceLabels.includes(
      '"sales-channel.sync-check.repair-inventory": "판매 채널 재고수량 복구"'
    ),
  "Sync-check operations do not have user-facing performance labels."
);

console.log("Sales-channel sync-check UI contracts verified.");
