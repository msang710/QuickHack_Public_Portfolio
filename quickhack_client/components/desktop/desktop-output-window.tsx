"use client";

import * as React from "react";

type OutputPreview = { issueBatchId: number; revision: number; count: number; blockers: string[]; label: string; status: string };
export function DesktopOutputWindow() {
  const [preview, setPreview] = React.useState<OutputPreview | null>(null);
  const [message, setMessage] = React.useState("");
  const load = React.useCallback(async (issueBatchId: number) => {
    setMessage("출력 상태를 확인하는 중입니다.");
    const response = await fetch(`/api/invoices/issue-batches/${issueBatchId}/label-print`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as { ok?: boolean; message?: string; labelPrint?: { issueBatchId: number; batchRevision: number; shipmentListPrintBatchLabel?: string; labelPrintStatus: string; targetIssueItemIds?: number[]; blockers?: Array<{ message?: string; code?: string }> } } | null;
    if (!response.ok || !payload?.ok || !payload.labelPrint) { setPreview(null); setMessage(payload?.message ?? "출력 상태를 불러오지 못했습니다."); return; }
    const view = payload.labelPrint;
    setPreview({ issueBatchId: view.issueBatchId, revision: view.batchRevision, count: view.targetIssueItemIds?.length ?? 0, blockers: (view.blockers ?? []).map((item) => item.message ?? item.code ?? "차단 사유"), label: view.shipmentListPrintBatchLabel ?? `#${view.issueBatchId}`, status: view.labelPrintStatus });
    setMessage("");
  }, []);
  React.useEffect(() => {
    const channel = new BroadcastChannel("quickhack-output-preview-v1");
    channel.onmessage = (event) => {
      const value = event.data as { type?: unknown; issueBatchId?: unknown } | null;
      if (value?.type !== "SELECT_ISSUE_BATCH" || !Number.isInteger(value.issueBatchId)) return;
      void load(Number(value.issueBatchId));
    };
    channel.postMessage({ type: "REQUEST_CURRENT_PREVIEW" });
    return () => channel.close();
  }, [load]);
  return <main className="min-h-screen bg-background p-6 text-foreground"><div className="mx-auto max-w-5xl space-y-4"><div><h1 className="text-xl font-semibold">출력 미리보기</h1><p className="text-sm text-muted-foreground">읽기 전용 창입니다. 출력 확정과 재고·송장 변경은 메인 창에서만 수행합니다.</p></div>{message ? <p className="rounded border p-4 text-sm text-muted-foreground">{message}</p> : null}{preview ? <section className="space-y-3 rounded border p-5"><div className="flex gap-6 text-sm"><span>{preview.label}</span><span>revision {preview.revision}</span><span>{preview.count}건</span><span>{preview.status}</span></div>{preview.blockers.length ? <ul className="list-disc pl-5 text-sm text-red-600">{preview.blockers.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="text-sm text-emerald-700">현재 배치를 서버에서 다시 검증했습니다.</p>}</section> : !message ? <p className="rounded border p-6 text-sm text-muted-foreground">메인 창의 송장 출력 화면에서 미리보기 배치를 선택하세요.</p> : null}</div></main>;
}
