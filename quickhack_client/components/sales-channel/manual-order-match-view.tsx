"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
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
import { allocationStatusLabel } from "@/quickhack_client/components/sales-channel/allocation-status-presentation";

type Allocation = { allocationId: number; pgNo: string; status: string; reasonCodes: string[] };
type WorkItem = { workItemId: number; externalOrderId: string; externalShipmentId: string; itemName: string | null; matchableQuantity: number; workStatus: string; recoveryStatus: string; recoveryReason: string | null; allocations: Allocation[] };
type Candidate = { pgNo: string; model: string; storage: string | null; color: string | null; saleGrade: string | null; warranty: string | null; selectionReceiptId: string };

const REASON_MESSAGE_KEYS = { ALLOCATION_NOT_FOUND: "allocationNotFound", ALLOCATION_NOT_REVERSIBLE: "allocationNotReversible", SHIPMENT_LIST_PRINTED: "shipmentListPrinted", ACTIVE_PACKAGE_GROUP: "activePackageGroup", SALES_RECORDED: "salesRecorded", RETURN_STARTED: "returnStarted", CHANNEL_WRITE_PENDING: "channelWritePending", CARRIER_SHIPMENT_EXISTS: "carrierShipmentExists", CARRIER_OPERATION_ACTIVE: "carrierOperationActive", SHIPMENT_ADDRESS_CHANGE_ACTIVE: "shipmentAddressChangeActive", MATCH_QUANTITY_CONFLICT: "matchQuantityConflict", PG_NOT_SELLABLE: "pgNotSellable", PG_ALREADY_ALLOCATED: "pgAlreadyAllocated", PG_NOT_FOUND: "pgNotFound", ORDER_STATE_NOT_ELIGIBLE: "orderStateNotEligible", PG_SELECTION_REQUIRED: "pgSelectionRequired", ORDER_ITEM_CANCELED: "orderItemCanceled", MANUAL_REASSIGNMENT_REQUIRED: "manualReassignmentRequired" } as const;

export function ManualOrderMatchView({ user }: { user: AuthUser }) {
  const t = useTranslations("salesChannel.manualMatch");
  const reasonLabel = React.useCallback((code: string | null | undefined) => {
    const normalized = code ?? "";
    if (normalized === "MANUAL_ORDER_MATCH_OPERATION_INVALID") {
      return t("reason.allocationNotReversible");
    }
    const key = REASON_MESSAGE_KEYS[normalized as keyof typeof REASON_MESSAGE_KEYS];
    return key ? t(`reason.${key}`) : normalized;
  }, [t]);
  const workStatusLabel = React.useCallback((status: string) => {
    const known = ["UNMATCHED", "MATCHED", "PARTIAL", "FAILED", "SKIPPED", "EXPIRED"];
    return known.includes(status)
      ? t(`workStatus.${status}` as never)
      : t("workStatus.unknown", { code: status });
  }, [t]);
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
        throw new Error(legacyApiMessage(payload, t("message.candidatesLoadFailed")));
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
  }, [draft.operation, selected, t]);

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
      if (!response.ok || !payload.ok) throw new Error(legacyApiMessage(payload, t("message.listLoadFailed")));
      setItems(payload.data.items);
      setMutationEnabled(payload.data.capabilities?.mutationEnabled === true);
      if (selected) setSelected(payload.data.items.find((item: WorkItem) => item.workItemId === selected.workItemId) ?? null);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }, [search, selected, t]);

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
      if (!response.ok || !payload.ok) throw new Error(legacyApiMessage(payload, t("message.previewFailed")));
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
      if (!response.ok || !payload.ok) throw new Error(legacyApiMessage(payload, t("message.executeFailed")));
      const postCycle = payload.data?.postCycle;
      dispatchDraft({ type: "EXECUTE_FINISHED" });
      setMessage(
        postCycle?.status === "FAILED"
          ? t("message.postCycleFailed")
          : postCycle?.status === "PENDING"
            ? t("message.postCyclePending")
            : t("message.executeComplete")
      );
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <section className="grid h-full min-h-0 grid-cols-[minmax(420px,1fr)_minmax(420px,520px)] gap-4 overflow-hidden p-5">
    <div className="flex min-h-0 flex-col gap-3 rounded-md border bg-card p-4">
      <div><h2 className="font-semibold">{t("title")}</h2><p className="text-sm text-muted-foreground">{t("description")}</p></div>
      <div className="flex gap-2"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchPlaceholder")} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} /><Button onClick={() => void load()} disabled={busy}>{t("search")}</Button></div>
      <div className="min-h-0 overflow-auto rounded border">
        {items.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t("empty")}</p> : items.map((item) => <button key={item.workItemId} className={`block w-full border-b p-3 text-left text-sm hover:bg-muted ${selected?.workItemId === item.workItemId ? "bg-muted" : ""}`} onClick={() => { setSelected(item); dispatchDraft({ type: "ORDER_SELECTED", allocationId: item.allocations[0]?.allocationId ?? null }); setCandidateOptions([]); }}>
          <div className="font-medium">{item.externalOrderId} · {item.itemName ?? item.externalShipmentId}</div><div className="text-muted-foreground">{workStatusLabel(item.workStatus)} · {item.allocations.length}/{item.matchableQuantity} · {item.allocations.map((a) => a.pgNo).join(", ") || t("noPg")}</div>{item.recoveryStatus !== "NONE" && <div className="mt-1 text-amber-700">{t("recovery", { reason: reasonLabel(item.recoveryReason) || t("recoveryStatus.reassignmentRequired") })}</div>}
        </button>)}
      </div>
    </div>
    <div className="min-h-0 overflow-auto rounded-md border bg-card p-4">
      {!selected ? <p className="text-sm text-muted-foreground">{t("selectOrder")}</p> : <div className="grid gap-4">
        <div><h3 className="font-semibold">{selected.externalOrderId}</h3><p className="text-sm text-muted-foreground">{t("shipment", { id: selected.externalShipmentId, item: selected.itemName ?? "" })}</p></div>
        <label className="grid gap-1 text-sm">{t("form.operation")}<select className="h-9 rounded-md border bg-background px-3" value={draft.operation} onChange={(e) => { const next = e.target.value as typeof draft.operation; dispatchDraft({ type: "OPERATION_CHANGED", operation: next, allocationId: selected.allocations[0]?.allocationId ?? null }); setCandidateOptions([]); }}><option value="ASSIGN">{t("form.assign")}</option><option value="REPLACE">{t("form.replace")}</option><option value="RELEASE">{t("form.release")}</option></select></label>
        {(draft.operation === "REPLACE" || draft.operation === "RELEASE") && <label className="grid gap-1 text-sm">{t("form.currentPg")}<select className="h-9 rounded-md border bg-background px-3" value={draft.allocationId ?? ""} onChange={(e) => dispatchDraft({ type: "ALLOCATION_CHANGED", allocationId: Number(e.target.value) })}>{selected.allocations.map((a) => <option key={a.allocationId} value={a.allocationId}>{a.pgNo} · {allocationStatusLabel(a.status, t)}</option>)}</select></label>}
        {draft.operation !== "RELEASE" && <SearchSelect label={t("form.newPg")} value={draft.pgNo} options={candidateOptions} placeholder={t("form.pgSearch")} allowEmpty={false} selectionMode="explicit-option" onSearchChange={searchCandidates} onSelectionInvalidated={resetCandidate} onValueChange={(value) => dispatchDraft({ type: "CANDIDATE_SELECTED", pgNo: value, selectionReceiptId: candidateOptions.find((option) => option.value === value)?.receiptId ?? "" })} />}
        <label className="grid gap-1 text-sm">{t("form.requestChannel")}<select className="h-9 rounded-md border bg-background px-3" value={draft.requestChannel} onChange={(e) => dispatchDraft({ type: "REQUEST_CHANNEL_CHANGED", requestChannel: e.target.value })}><option value="COUPANG_INQUIRY">{t("form.coupang")}</option><option value="PHONE">{t("form.phone")}</option><option value="OTHER">{t("form.other")}</option></select></label>
        <label className="grid gap-1 text-sm">{t("form.reason")}<Input value={draft.reason} onChange={(e) => dispatchDraft({ type: "REASON_CHANGED", reason: e.target.value })} maxLength={500} /></label>
        {!canWrite && <FeedbackBanner tone="warning">{t("permission.readOnly")}</FeedbackBanner>}
        {canWrite && !mutationEnabled && <FeedbackBanner tone="warning">{t("permission.disabled")}</FeedbackBanner>}
        <Button onClick={() => void previewChange()} disabled={busy || !canPreviewManualOrderMatch(draft, Boolean(selected))}>{t("preview.action")}</Button>
        {draft.preview && <div className="grid gap-2 rounded-md border p-3 text-sm"><div className="font-medium">{draft.preview.eligible ? t("preview.eligible") : t("preview.ineligible")}</div>{draft.preview.candidate && <div>{t("preview.selected", { pg: draft.preview.candidate.pgNo, model: draft.preview.candidate.model, storage: draft.preview.candidate.storage ?? "", color: draft.preview.candidate.color ?? "" })}</div>}{draft.preview.candidate?.differences.map((d) => <div key={d.field} className="text-amber-700">{t("preview.difference", { field: d.field, required: d.required, actual: d.actual })}</div>)}{draft.preview.reasonCodes.map((code) => <div key={code} className="text-red-700">{reasonLabel(code)}</div>)}{canWrite ? <SensitiveMenuGate item={{ id: "sales-channel-manual-order-match", label: t("preview.confirmLabel") }}><Button onClick={() => void executeChange()} disabled={busy || !draft.preview.eligible || !mutationEnabled}>{t("preview.execute")}</Button></SensitiveMenuGate> : <Button disabled>{t("preview.execute")}</Button>}</div>}
        {message && <FeedbackBanner tone="warning">{message}</FeedbackBanner>}
      </div>}
    </div>
  </section>;
}
