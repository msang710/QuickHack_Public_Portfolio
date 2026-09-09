"use client";

import * as React from "react";
import { legacyApiMessage } from "@/quickhack_client/api/legacy-api-message";
import { useTranslations } from "next-intl";
import type { LogenLabelBlockerCode, LogenLabelPrintStatus } from "@/quickhack_shared/shipment/logen-label";

type OutputPreview = { issueBatchId: number; revision: number; count: number; blockers: LogenLabelBlockerCode[]; label: string; status: LogenLabelPrintStatus };
export function DesktopOutputWindow() {
  const t = useTranslations("desktop.outputWindow");
  const [preview, setPreview] = React.useState<OutputPreview | null>(null);
  const [message, setMessage] = React.useState("");
  const load = React.useCallback(async (issueBatchId: number) => {
    setMessage(t("loading"));
    const response = await fetch(`/api/invoices/issue-batches/${issueBatchId}/label-print`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as { ok?: boolean; code?: string; message?: string; labelPrint?: { issueBatchId: number; batchRevision: number; shipmentListPrintBatchLabel?: string; labelPrintStatus: LogenLabelPrintStatus; targetIssueItemIds?: number[]; blockers?: Array<{ code: LogenLabelBlockerCode }> } } | null;
    if (!response.ok || !payload?.ok || !payload.labelPrint) { setPreview(null); setMessage(legacyApiMessage(payload, t("loadFailed"))); return; }
    const view = payload.labelPrint;
    setPreview({ issueBatchId: view.issueBatchId, revision: view.batchRevision, count: view.targetIssueItemIds?.length ?? 0, blockers: (view.blockers ?? []).map((item) => item.code), label: view.shipmentListPrintBatchLabel ?? `#${view.issueBatchId}`, status: view.labelPrintStatus });
    setMessage("");
  }, [t]);
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
  return <main className="min-h-screen bg-background p-6 text-foreground"><div className="mx-auto max-w-5xl space-y-4"><div><h1 className="text-xl font-semibold">{t("title")}</h1><p className="text-sm text-muted-foreground">{t("description")}</p></div>{message ? <p className="rounded border p-4 text-sm text-muted-foreground">{message}</p> : null}{preview ? <section className="space-y-3 rounded border p-5"><div className="flex gap-6 text-sm"><span>{preview.label}</span><span>{t("revision", { revision: preview.revision })}</span><span>{t("count", { count: preview.count })}</span><span>{t(`status.${preview.status}`)}</span></div>{preview.blockers.length ? <ul className="list-disc pl-5 text-sm text-red-600">{preview.blockers.map((item) => <li key={item}>{t(`blockerCode.${item}`)}</li>)}</ul> : <p className="text-sm text-emerald-700">{t("verified")}</p>}</section> : !message ? <p className="rounded border p-6 text-sm text-muted-foreground">{t("select")}</p> : null}</div></main>;
}
