"use client";

import * as React from "react";
import { canAccessRole, type AuthUser } from "@/quickhack_shared/auth/auth-constants";
import { Button } from "@/quickhack_client/components/ui/button";
import { Input } from "@/quickhack_client/components/ui/input";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { SensitiveMenuGate } from "@/quickhack_client/components/security/sensitive-action-guards";
import {
  SearchSelect,
  type SearchSelectOption,
} from "@/quickhack_client/components/ui/search-select";
import {
  canPreviewManualOrderMatch,
  initialManualOrderMatchCommandDraft,
  manualOrderMatchCommandBody,
  manualOrderMatchCommandDraftReducer,
  type ManualOrderMatchPreview,
} from "@/quickhack_client/components/sales-channel/manual-order-match-command-draft";

type Allocation = { allocationId: number; pgNo: string; status: string; reasonCodes: string[] };
type WorkItem = { workItemId: number; externalOrderId: string; externalShipmentId: string; itemName: string | null; matchableQuantity: number; workStatus: string; recoveryStatus: string; recoveryReason: string | null; allocations: Allocation[] };
type Candidate = { pgNo: string; model: string; storage: string | null; color: string | null; saleGrade: string | null; warranty: string | null; selectionReceiptId: string };

const reasonLabels: Record<string, string> = {
  ALLOCATION_NOT_FOUND: "현재 배정을 찾을 수 없습니다.",
  ALLOCATION_NOT_REVERSIBLE: "현재 단계에서는 배정을 변경할 수 없습니다.",
  SHIPMENT_LIST_PRINTED: "출고 목록이 이미 출력됐습니다.",
  ACTIVE_PACKAGE_GROUP: "활성 포장 그룹에 포함돼 있습니다.",
  SALES_RECORDED: "매출이 이미 확정됐습니다.",
  RETURN_STARTED: "반품 처리가 시작됐습니다.",
  CHANNEL_WRITE_PENDING: "판매채널 쓰기가 진행 중입니다.",
  CARRIER_SHIPMENT_EXISTS: "택배 송장 또는 배송 처리가 이미 시작됐습니다.",
  CARRIER_OPERATION_ACTIVE: "택배 송장 발급·등록·교체 작업이 진행 중입니다.",
  SHIPMENT_ADDRESS_CHANGE_ACTIVE: "배송지 변경 요청 처리가 진행 중입니다.",
  MATCH_QUANTITY_CONFLICT: "주문 필요 수량이 이미 모두 배정됐습니다.",
  PG_NOT_SELLABLE: "선택한 PG가 판매 가능 상태가 아닙니다.",
  PG_ALREADY_ALLOCATED: "선택한 PG가 이미 이 주문에 배정돼 있습니다.",
  PG_NOT_FOUND: "선택한 PG를 찾을 수 없습니다.",
  ORDER_STATE_NOT_ELIGIBLE: "현재 판매채널 주문 상태에서는 PG를 변경할 수 없습니다.",
  PG_SELECTION_REQUIRED: "현재 주문에서 검색 결과의 PG를 다시 선택해 주세요.",
  ORDER_ITEM_CANCELED: "취소된 주문 품목에는 PG를 배정하거나 교체할 수 없습니다.",
  MANUAL_REASSIGNMENT_REQUIRED: "PG 재배정이 끝날 때까지 출고가 차단됩니다.",
};

export function ManualOrderMatchView({ user }: { user: AuthUser }) {
  const [search, setSearch] = React.useState("");
  const [items, setItems] = React.useState<WorkItem[]>([]);
  const [selected, setSelected] = React.useState<WorkItem | null>(null);
  const [draft, dispatchDraft] = React.useReducer(
    manualOrderMatchCommandDraftReducer,
    initialManualOrderMatchCommandDraft
  );
  const [candidateOptions, setCandidateOptions] = React.useState<SearchSelectOption[]>([]);
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [mutationEnabled, setMutationEnabled] = React.useState(false);
  const canWrite = canAccessRole(user.role, "MANAGER");

  const resetCandidate = React.useCallback(() => {
    dispatchDraft({ type: "CANDIDATE_INVALIDATED" });
    setCandidateOptions([]);
  }, []);

  const loadCandidates = React.useCallback(async (query: string) => {
    if (!selected || draft.operation === "RELEASE") return;
    try {
      const params = new URLSearchParams({
        mode: "candidates",
        search: query,
        limit: "40",
        workItemId: String(selected.workItemId),
        operation: draft.operation,
      });
      const response = await fetch(`/api/coupang/manual-order-matches?${params}`, {
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || "PG 후보를 불러오지 못했습니다.");
      }
      const candidates = payload.data.items as Candidate[];
      setCandidateOptions(
        candidates.map((candidate) => ({
          value: candidate.pgNo,
          label: candidate.pgNo,
          description: [candidate.model, candidate.storage, candidate.color, candidate.saleGrade]
            .filter(Boolean)
            .join(" "),
          searchText: [candidate.model, candidate.storage, candidate.color, candidate.warranty]
            .filter(Boolean)
            .join(" "),
          receiptId: candidate.selectionReceiptId,
        }))
      );
    } catch (error) {
      setCandidateOptions([]);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [draft.operation, selected]);

  const candidateSearchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchCandidates = React.useCallback((query: string) => {
    if (candidateSearchTimer.current) clearTimeout(candidateSearchTimer.current);
    candidateSearchTimer.current = setTimeout(() => void loadCandidates(query), 200);
  }, [loadCandidates]);

  React.useEffect(() => () => {
    if (candidateSearchTimer.current) clearTimeout(candidateSearchTimer.current);
  }, []);

  const load = React.useCallback(async () => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/coupang/manual-order-matches?search=${encodeURIComponent(search)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message || "목록을 불러오지 못했습니다.");
      setItems(payload.data.items);
      setMutationEnabled(payload.data.capabilities?.mutationEnabled === true);
      if (selected) setSelected(payload.data.items.find((item: WorkItem) => item.workItemId === selected.workItemId) ?? null);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }, [search, selected]);

  async function previewChange() {
    if (!selected) return;
    const requestBody = manualOrderMatchCommandBody(draft, {
      action: "PREVIEW",
      workItemId: selected.workItemId,
    });
    if (!requestBody) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/coupang/manual-order-matches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message || "변경 영향을 확인하지 못했습니다.");
      dispatchDraft({ type: "PREVIEW_SUCCEEDED", preview: payload.data as ManualOrderMatchPreview, commandKey: crypto.randomUUID() });
    } catch (error) { dispatchDraft({ type: "PREVIEW_FAILED" }); setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function executeChange() {
    if (!selected || !draft.preview?.eligible || !canWrite || !mutationEnabled) return;
    const requestBody = manualOrderMatchCommandBody(draft, {
      action: "EXECUTE",
      workItemId: selected.workItemId,
    });
    if (!requestBody) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/coupang/manual-order-matches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message || "PG 변경을 실행하지 못했습니다.");
      const postCycle = payload.data?.postCycle;
      dispatchDraft({ type: "EXECUTE_FINISHED" });
      setMessage(
        postCycle?.status === "FAILED"
          ? postCycle.message
          : postCycle?.status === "PENDING"
            ? "PG 변경은 반영됐고 판매채널 후속 처리는 진행 중입니다."
            : "주문 PG 변경과 후속 처리를 반영했습니다."
      );
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <section className="grid h-full min-h-0 grid-cols-[minmax(420px,1fr)_minmax(420px,520px)] gap-4 overflow-hidden p-5">
    <div className="flex min-h-0 flex-col gap-3 rounded-md border bg-card p-4">
      <div><h2 className="font-semibold">주문 변경 요청</h2><p className="text-sm text-muted-foreground">판매채널에 이미 접수된 주문만 처리합니다. 독립 출고는 재고 수정에서 상태를 보류로 변경하세요.</p></div>
      <div className="flex gap-2"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="주문번호, 출고번호, 상품명" onKeyDown={(e) => { if (e.key === "Enter") void load(); }} /><Button onClick={() => void load()} disabled={busy}>검색</Button></div>
      <div className="min-h-0 overflow-auto rounded border">
        {items.length === 0 ? <p className="p-4 text-sm text-muted-foreground">조회된 판매채널 주문이 없습니다.</p> : items.map((item) => <button key={item.workItemId} className={`block w-full border-b p-3 text-left text-sm hover:bg-muted ${selected?.workItemId === item.workItemId ? "bg-muted" : ""}`} onClick={() => { setSelected(item); dispatchDraft({ type: "ORDER_SELECTED", allocationId: item.allocations[0]?.allocationId ?? null }); setCandidateOptions([]); }}>
          <div className="font-medium">{item.externalOrderId} · {item.itemName ?? item.externalShipmentId}</div><div className="text-muted-foreground">{item.workStatus} · {item.allocations.length}/{item.matchableQuantity} · {item.allocations.map((a) => a.pgNo).join(", ") || "PG 없음"}</div>{item.recoveryStatus !== "NONE" && <div className="mt-1 text-amber-700">복구 필요: {reasonLabels[item.recoveryReason ?? ""] ?? item.recoveryReason ?? item.recoveryStatus}</div>}
        </button>)}
      </div>
    </div>
    <div className="min-h-0 overflow-auto rounded-md border bg-card p-4">
      {!selected ? <p className="text-sm text-muted-foreground">변경할 주문 품목을 선택하세요.</p> : <div className="grid gap-4">
        <div><h3 className="font-semibold">{selected.externalOrderId}</h3><p className="text-sm text-muted-foreground">출고 {selected.externalShipmentId} · {selected.itemName}</p></div>
        <label className="grid gap-1 text-sm">작업<select className="h-9 rounded-md border bg-background px-3" value={draft.operation} onChange={(e) => { const next = e.target.value as typeof draft.operation; dispatchDraft({ type: "OPERATION_CHANGED", operation: next, allocationId: selected.allocations[0]?.allocationId ?? null }); setCandidateOptions([]); }}><option value="ASSIGN">PG 배정</option><option value="REPLACE">PG 교체</option><option value="RELEASE">PG 해제</option></select></label>
        {(draft.operation === "REPLACE" || draft.operation === "RELEASE") && <label className="grid gap-1 text-sm">현재 PG<select className="h-9 rounded-md border bg-background px-3" value={draft.allocationId ?? ""} onChange={(e) => dispatchDraft({ type: "ALLOCATION_CHANGED", allocationId: Number(e.target.value) })}>{selected.allocations.map((a) => <option key={a.allocationId} value={a.allocationId}>{a.pgNo} · {a.status}</option>)}</select></label>}
        {draft.operation !== "RELEASE" && <SearchSelect label="새 PG" value={draft.pgNo} options={candidateOptions} placeholder="판매 가능 PG 검색" allowEmpty={false} selectionMode="explicit-option" onSearchChange={searchCandidates} onSelectionInvalidated={resetCandidate} onValueChange={(value) => dispatchDraft({ type: "CANDIDATE_SELECTED", pgNo: value, selectionReceiptId: candidateOptions.find((option) => option.value === value)?.receiptId ?? "" })} />}
        <label className="grid gap-1 text-sm">요청 접수 경로<select className="h-9 rounded-md border bg-background px-3" value={draft.requestChannel} onChange={(e) => dispatchDraft({ type: "REQUEST_CHANNEL_CHANGED", requestChannel: e.target.value })}><option value="COUPANG_INQUIRY">쿠팡 문의</option><option value="PHONE">유선 문의</option><option value="OTHER">기타</option></select></label>
        <label className="grid gap-1 text-sm">변경 사유<Input value={draft.reason} onChange={(e) => dispatchDraft({ type: "REASON_CHANGED", reason: e.target.value })} maxLength={500} /></label>
        {!canWrite && <FeedbackBanner tone="warning">STAFF는 조회만 가능하며 MANAGER와 OTP 인증이 변경에 필요합니다.</FeedbackBanner>}
        {canWrite && !mutationEnabled && <FeedbackBanner tone="warning">주문 PG 변경 기능이 운영 설정에서 비활성화되어 있습니다. 영향 확인만 가능합니다.</FeedbackBanner>}
        <Button onClick={() => void previewChange()} disabled={busy || !canPreviewManualOrderMatch(draft, Boolean(selected))}>변경 영향 확인</Button>
        {draft.preview && <div className="grid gap-2 rounded-md border p-3 text-sm"><div className="font-medium">{draft.preview.eligible ? "변경 가능" : "변경 불가"}</div>{draft.preview.candidate && <div>선택 PG {draft.preview.candidate.pgNo} · {draft.preview.candidate.model} {draft.preview.candidate.storage} {draft.preview.candidate.color}</div>}{draft.preview.candidate?.differences.map((d) => <div key={d.field} className="text-amber-700">{d.field}: 주문 {d.required} → 출고 {d.actual}</div>)}{draft.preview.reasonCodes.map((code) => <div key={code} className="text-red-700">{reasonLabels[code] ?? code}</div>)}{canWrite ? <SensitiveMenuGate item={{ id: "sales-channel-manual-order-match", label: "주문 PG 변경 확정" }}><Button onClick={() => void executeChange()} disabled={busy || !draft.preview.eligible || !mutationEnabled}>확정 실행</Button></SensitiveMenuGate> : <Button disabled>확정 실행</Button>}</div>}
        {message && <FeedbackBanner tone="warning">{message}</FeedbackBanner>}
      </div>}
    </div>
  </section>;
}
