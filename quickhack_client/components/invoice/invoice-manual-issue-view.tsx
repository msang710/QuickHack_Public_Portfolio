"use client";

import * as React from "react";
import {
  AlertTriangle,
  PackagePlus,
  RefreshCcw,
  RotateCcw,
  Search,
} from "lucide-react";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import { Badge } from "@/quickhack_client/components/ui/badge";
import { Button } from "@/quickhack_client/components/ui/button";
import { MasterDetailLayout } from "@/quickhack_client/components/ui/workspace-layout";
import {
  shipmentOutputFocusForReplacement,
  type ShipmentOutputFocus,
} from "@/quickhack_client/components/shipment/shipment-output-focus";
import { cn } from "@/quickhack_shared/core/utils";
import { InvoiceReplacementProgress } from "./invoice-replacement-progress";
import {
  createManualInvoiceReplacementDraftSnapshot,
  invoiceReplacementFormIds,
  manualInvoiceReplacementDraftIsDirty,
} from "./invoice-operation-draft-state";
import { recoverCarrierRegistration } from "./invoice-replacement-recovery";
import type {
  InvoiceManualCandidate,
  InvoiceReplacement,
} from "./invoice-operation-types";

type ReplacementResponse = {
  ok: boolean;
  message?: string;
  items?: InvoiceReplacement[];
  replacement?: InvoiceReplacement;
  nextCursor?: string | null;
  hasMore?: boolean;
  totalCount?: number;
};

type CandidateResponse = {
  ok: boolean;
  reviewRequired?: boolean;
  partial?: boolean;
  requestIds?: number[];
  message?: string;
  items?: InvoiceManualCandidate[];
  issueBatch?: { status: string; errorMessage?: string | null };
  nextCursor?: string | null;
  hasMore?: boolean;
  totalCount?: number;
};

function formatDate(value: string | null | undefined) {
  return value ? value.replace("T", " ").slice(0, 19) : "-";
}

function statusVariant(status: string | null | undefined) {
  if (status === "COMPLETED" || status === "ALLOCATED")
    return "success" as const;
  if (status === "REVIEW_REQUIRED" || status === "FAILED")
    return "danger" as const;
  if (status === "WAITING_MANUAL" || status === "WAITING_LABEL")
    return "warning" as const;
  return "secondary" as const;
}

export function InvoiceManualIssueView({
  onOpenSourceMenu,
  onOpenShipmentOutput,
  onOpenWriteReview,
}: {
  onOpenSourceMenu?: (menuId: string, search?: string) => void;
  onOpenShipmentOutput?: (focus: ShipmentOutputFocus) => void;
  onOpenWriteReview?: (requestId: number) => void;
}) {
  const [replacements, setReplacements] = React.useState<
    InvoiceReplacement[]
  >([]);
  const [candidates, setCandidates] = React.useState<
    InvoiceManualCandidate[]
  >([]);
  const [openCursor, setOpenCursor] = React.useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = React.useState<string | null>(null);
  const [candidateCursor, setCandidateCursor] = React.useState<string | null>(null);
  const [openTotal, setOpenTotal] = React.useState(0);
  const [historyTotal, setHistoryTotal] = React.useState(0);
  const [candidateTotal, setCandidateTotal] = React.useState(0);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [packageGroupId, setPackageGroupId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [appliedSearch, setAppliedSearch] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [manualReplacementSaving, setManualReplacementSaving] =
    React.useState(false);
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const { runGuardedAction } = useUnsavedChanges();
  const selected =
    replacements.find(
      (replacement) => replacement.replacementWorkId === selectedId
    ) ?? null;
  const openReplacements = replacements.filter(
    (replacement) => !["COMPLETED", "FAILED", "CANCELED"].includes(replacement.status)
  );
  const historyReplacements = replacements.filter((replacement) =>
    ["COMPLETED", "FAILED", "CANCELED"].includes(replacement.status)
  );
  const selectedOutputFocus = selected
    ? shipmentOutputFocusForReplacement(selected, "invoice-manual-issue")
    : null;

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const openParams = new URLSearchParams({ scope: "OPEN", limit: "100" });
      const historyParams = new URLSearchParams({ scope: "HISTORY", limit: "100" });
      const candidateParams = new URLSearchParams({ limit: "100" });
      if (appliedSearch) {
        openParams.set("search", appliedSearch);
        historyParams.set("search", appliedSearch);
        candidateParams.set("search", appliedSearch);
      }
      const [replacementResponse, historyResponse, candidateResponse] = await Promise.all([
        fetch(`/api/invoices/replacements?${openParams.toString()}`, {
          cache: "no-store",
        }),
        fetch(`/api/invoices/replacements?${historyParams.toString()}`, {
          cache: "no-store",
        }),
        fetch(
          `/api/invoices/manual-candidates?${candidateParams.toString()}`,
          { cache: "no-store" }
        ),
      ]);
      const replacementPayload =
        (await replacementResponse.json()) as ReplacementResponse;
      const historyPayload =
        (await historyResponse.json()) as ReplacementResponse;
      const candidatePayload =
        (await candidateResponse.json()) as CandidateResponse;
      if (!replacementResponse.ok || !replacementPayload.ok) {
        throw new Error(
          replacementPayload.message || "송장 재발급 작업을 불러오지 못했습니다."
        );
      }
      if (!candidateResponse.ok || !candidatePayload.ok) {
        throw new Error(
          candidatePayload.message || "수동 발급 후보를 불러오지 못했습니다."
        );
      }
      if (!historyResponse.ok || !historyPayload.ok) {
        throw new Error(
          historyPayload.message || "송장 교체 완료 이력을 불러오지 못했습니다."
        );
      }
      const nextReplacements = [
        ...(replacementPayload.items ?? []),
        ...(historyPayload.items ?? []),
      ];
      setReplacements(nextReplacements);
      setCandidates(candidatePayload.items ?? []);
      setOpenCursor(
        replacementPayload.hasMore
          ? replacementPayload.nextCursor ?? null
          : null
      );
      setHistoryCursor(
        historyPayload.hasMore ? historyPayload.nextCursor ?? null : null
      );
      setCandidateCursor(
        candidatePayload.hasMore ? candidatePayload.nextCursor ?? null : null
      );
      setOpenTotal(
        replacementPayload.totalCount ?? replacementPayload.items?.length ?? 0
      );
      setHistoryTotal(
        historyPayload.totalCount ?? historyPayload.items?.length ?? 0
      );
      setCandidateTotal(
        candidatePayload.totalCount ?? candidatePayload.items?.length ?? 0
      );
      setSelectedId((current) =>
        current &&
        nextReplacements.some(
          (replacement) => replacement.replacementWorkId === current
        )
          ? current
          : nextReplacements[0]?.replacementWorkId ?? null
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [appliedSearch]);

  const loadMoreReplacements = React.useCallback(async (
    scope: "OPEN" | "HISTORY",
    cursor: string
  ) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ scope, limit: "100", cursor });
      if (appliedSearch) params.set("search", appliedSearch);
      const response = await fetch(
        `/api/invoices/replacements?${params.toString()}`,
        { cache: "no-store" }
      );
      const payload = (await response.json().catch(() => null)) as
        | ReplacementResponse
        | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "송장 교체 작업을 더 불러오지 못했습니다.");
      }
      setReplacements((current) => {
        const byId = new Map(
          current.map((item) => [item.replacementWorkId, item])
        );
        for (const item of payload.items ?? []) {
          byId.set(item.replacementWorkId, item);
        }
        return [...byId.values()];
      });
      const next = payload.hasMore ? payload.nextCursor ?? null : null;
      if (scope === "OPEN") setOpenCursor(next);
      else setHistoryCursor(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [appliedSearch]);

  const loadMoreCandidates = React.useCallback(async () => {
    if (!candidateCursor) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: "100", cursor: candidateCursor });
      if (appliedSearch) params.set("search", appliedSearch);
      const response = await fetch(
        `/api/invoices/manual-candidates?${params.toString()}`,
        { cache: "no-store" }
      );
      const payload = (await response.json().catch(() => null)) as
        | CandidateResponse
        | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "수동 처리 후보를 더 불러오지 못했습니다.");
      }
      setCandidates((current) => [...current, ...(payload.items ?? [])]);
      setCandidateCursor(payload.hasMore ? payload.nextCursor ?? null : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, candidateCursor]);

  const manualReplacementSnapshot =
    createManualInvoiceReplacementDraftSnapshot({
      packageGroupId,
      reason,
    });

  useUnsavedForm({
    id: "invoice.manual-replacement",
    label: "관리자 요청 송장 재발급",
    isDirty: manualInvoiceReplacementDraftIsDirty(
      manualReplacementSnapshot
    ),
    isBusy: manualReplacementSaving,
    discard: () => {
      setPackageGroupId("");
      setReason("");
      setError("");
    },
  });

  React.useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  React.useEffect(() => {
    if (
      !selectedId ||
      !selected ||
      ["COMPLETED", "CANCELED", "FAILED"].includes(selected.status)
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void fetch(`/api/invoices/replacements/${selectedId}`, {
        cache: "no-store",
      })
        .then((response) => response.json())
        .then((payload: ReplacementResponse) => {
          if (payload.ok && payload.replacement) {
            setReplacements((current) =>
              current.map((item) =>
                item.replacementWorkId === selectedId
                  ? payload.replacement!
                  : item
              )
            );
          }
        });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [selected, selectedId]);

  async function startReplacement() {
    const parsedGroupId = Number(packageGroupId);
    if (!Number.isSafeInteger(parsedGroupId) || parsedGroupId <= 0) {
      setError("합포장 그룹 ID를 올바르게 입력하세요.");
      return;
    }
    if (!reason.trim()) {
      setError("재발급 사유를 입력하세요.");
      return;
    }
    setWorking(true);
    setManualReplacementSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/invoices/replacements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          packageGroupId: parsedGroupId,
          sourceType: "MANUAL",
          reasonCode: "MANUAL_REISSUE",
          reasonNote: reason.trim(),
        }),
      });
      const payload = (await response.json()) as ReplacementResponse;
      if (!response.ok || !payload.ok || !payload.replacement) {
        throw new Error(payload.message || "송장 재발급을 시작하지 못했습니다.");
      }
      setMessage(
        "재발급을 시작했습니다. 아래 단계 표시에서 현재 처리 위치와 다음 할 일을 확인하세요."
      );
      setPackageGroupId("");
      setReason("");
      await load();
      setSelectedId(payload.replacement.replacementWorkId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorking(false);
      setManualReplacementSaving(false);
    }
  }

  async function runReplacementAction(action: string, note?: string) {
    if (!selected) return false;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/invoices/replacements/${selected.replacementWorkId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, note }),
        }
      );
      const payload = (await response.json()) as ReplacementResponse;
      if (!response.ok || !payload.ok || !payload.replacement) {
        throw new Error(payload.message || "재발급 작업을 진행하지 못했습니다.");
      }
      setReplacements((current) =>
        current.map((item) =>
          item.replacementWorkId === selected.replacementWorkId
            ? payload.replacement!
            : item
        )
      );
      setMessage(
        action === "confirmOldInvoiceHandling"
          ? "기존 송장 처리 확인을 저장했습니다. 새 송장 채번과 쿠팡 반영을 계속합니다."
          : action === "cancel"
            ? "송장 재발급을 취소하고 기존 송장을 유지했습니다."
            : "안전하게 재개할 수 있는 단계부터 상태를 다시 확인했습니다."
      );
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function runCarrierRegistrationRecovery() {
    if (!selected) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      setMessage(await recoverCarrierRegistration(selected));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorking(false);
    }
  }

  async function retryCandidate(candidate: InvoiceManualCandidate) {
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/invoices/manual-candidates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "retryAllocation",
          issueBatchId: candidate.issueBatchId,
        }),
      });
      const payload = (await response.json()) as CandidateResponse;
      if (!response.ok) {
        throw new Error(payload.message || "송장 채번을 다시 시도하지 못했습니다.");
      }
      setMessage(
        payload.message ??
          (payload.issueBatch?.status === "ALLOCATED"
            ? "송장번호를 다시 채번했습니다. 이어지는 쿠팡 등록 상태를 확인하세요."
            : "재시도를 접수했습니다. 표시된 결과를 다시 확인하세요.")
      );
      if (payload.reviewRequired && payload.requestIds?.[0]) {
        onOpenWriteReview?.(payload.requestIds[0]);
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorking(false);
    }
  }

  function requestSelectReplacement(nextId: number | null) {
    if (!nextId) return;
    if (nextId === selectedId) return;
    runGuardedAction({
      intent: "internal-change",
      formIds: invoiceReplacementFormIds(selectedId),
      targetLabel: "다른 송장 재발급 작업",
      action: () => setSelectedId(nextId),
    });
  }

  function requestLoad() {
    runGuardedAction({
      intent: "internal-change",
      formIds: invoiceReplacementFormIds(selectedId),
      targetLabel: "송장 재발급 목록 조회",
      action: () => {
        const nextSearch = search.trim();
        if (nextSearch === appliedSearch) {
          void load();
        } else {
          setSelectedId(null);
          setOpenCursor(null);
          setHistoryCursor(null);
          setCandidateCursor(null);
          setAppliedSearch(nextSearch);
        }
      },
    });
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
      <div className="border-b pb-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto">
            <h2 className="text-base font-semibold">수동 송장 발급</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              실패한 자동 채번을 안전하게 재시도하거나, 현재 송장을 보존한 채
              합포장 그룹 전체의 재발급을 시작합니다.
            </p>
          </div>
          <div className="relative min-w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  requestLoad();
                }
              }}
              placeholder="송장번호, 주문번호, PG 검색"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={requestLoad}
          >
            <RefreshCcw className={cn("size-4", loading && "animate-spin")} />
            새로고침
          </Button>
        </div>
      </div>

      {error || message ? (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            error
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          )}
        >
          {error || message}
        </div>
      ) : null}

      <div className="rounded-md border bg-muted/20 p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <PackagePlus className="size-4" />
          관리자 요청 재발급
        </div>
        <div className="grid gap-2 lg:grid-cols-[180px_minmax(260px,1fr)_auto]">
          <input
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            value={packageGroupId}
            onChange={(event) => setPackageGroupId(event.target.value)}
            placeholder="합포장 그룹 ID"
          />
          <input
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="재발급 사유 (주소는 쿠팡 최신 주문에서 다시 확인합니다)"
          />
          <Button disabled={working} onClick={() => void startReplacement()}>
            안전한 재발급 시작
          </Button>
        </div>
      </div>

      {candidates.length ? (
        <div className="rounded-md border border-amber-200 bg-amber-50/60">
          <div className="flex items-center gap-2 border-b border-amber-200 px-3 py-2 text-sm font-semibold text-amber-900">
            <AlertTriangle className="size-4" />
            자동 발급 확인 필요 {candidates.length} / {candidateTotal}건
          </div>
          <div className="max-h-44 overflow-auto">
            {candidates.map((candidate) => (
              <div
                key={candidate.issueBatchId}
                className="flex flex-wrap items-center gap-3 border-b border-amber-100 px-3 py-2 text-xs last:border-0"
              >
                <span className="font-semibold">
                  {candidate.shipmentListPrintBatchLabel}
                </span>
                <Badge variant={statusVariant(candidate.status)}>
                  {candidate.status}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-red-700">
                  {candidate.errorMessage || candidate.errorCode || "처리 결과 확인 필요"}
                </span>
                {candidate.nextAction.code === "RETRY_ALLOCATION" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={working}
                    onClick={() => void retryCandidate(candidate)}
                  >
                    <RotateCcw className="size-3.5" />
                    {candidate.nextAction.label}
                  </Button>
                ) : candidate.replacementWorkId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      requestSelectReplacement(candidate.replacementWorkId)
                    }
                  >
                    {candidate.nextAction.label}
                  </Button>
                ) : (
                  <span className="text-amber-800">
                    {candidate.nextAction.label}
                  </span>
                )}
              </div>
            ))}
            {candidateCursor ? (
              <div className="p-3 text-center">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading}
                  onClick={() => void loadMoreCandidates()}
                >
                  수동 처리 후보 더 보기
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <MasterDetailLayout className="gap-3 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div className="min-h-48 overflow-auto rounded-md border bg-background">
          <div className="sticky top-0 z-10 border-b bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground">
            처리 필요 {openReplacements.length} / {openTotal}건
          </div>
          {openReplacements.map((replacement) => (
            <button
              type="button"
              key={replacement.replacementWorkId}
              onClick={() =>
                requestSelectReplacement(replacement.replacementWorkId)
              }
              className={cn(
                "w-full border-b px-3 py-3 text-left text-xs hover:bg-muted/50",
                selectedId === replacement.replacementWorkId && "bg-primary/5"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">
                  그룹 #{replacement.packageGroupId}
                </span>
                <Badge variant={statusVariant(replacement.status)}>
                  {replacement.statusLabel}
                </Badge>
              </div>
              <div className="mt-1 font-mono">
                {replacement.oldTrackingNumber} →{" "}
                {replacement.candidateTrackingNumber ?? "채번 전"}
              </div>
              <div className="mt-1 text-muted-foreground">
                {replacement.stageLabel} · {formatDate(replacement.updatedAt)}
              </div>
            </button>
          ))}
          {openCursor ? (
            <Button
              className="m-3"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void loadMoreReplacements("OPEN", openCursor)}
            >
              처리 필요 더 보기
            </Button>
          ) : null}
          <div className="border-y bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground">
            완료 이력 {historyReplacements.length} / {historyTotal}건
          </div>
          {historyReplacements.map((replacement) => (
            <button
              type="button"
              key={replacement.replacementWorkId}
              onClick={() =>
                requestSelectReplacement(replacement.replacementWorkId)
              }
              className={cn(
                "w-full border-b px-3 py-3 text-left text-xs hover:bg-muted/50",
                selectedId === replacement.replacementWorkId && "bg-primary/5"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">
                  그룹 #{replacement.packageGroupId}
                </span>
                <Badge variant={statusVariant(replacement.status)}>
                  {replacement.statusLabel}
                </Badge>
              </div>
              <div className="mt-1 font-mono">
                {replacement.oldTrackingNumber} →{" "}
                {replacement.candidateTrackingNumber ?? "채번 전"}
              </div>
              <div className="mt-1 text-muted-foreground">
                {replacement.stageLabel} · {formatDate(replacement.updatedAt)}
              </div>
            </button>
          ))}
          {historyCursor ? (
            <Button
              className="m-3"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void loadMoreReplacements("HISTORY", historyCursor)}
            >
              완료 이력 더 보기
            </Button>
          ) : null}
          {!loading && replacements.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              재발급 작업이 없습니다.
            </div>
          ) : null}
        </div>

        <div className="min-h-0 overflow-auto rounded-md border bg-muted/10 p-4">
          {selected ? (
            <>
              <InvoiceReplacementProgress
                key={selected.replacementWorkId}
                replacement={selected}
                busy={working}
                onRefresh={() => void load()}
                onAction={runReplacementAction}
                onOpenChannelRecovery={
                  onOpenSourceMenu
                    ? () =>
                        onOpenSourceMenu(
                          "invoice-registration-failures",
                          selected.candidateTrackingNumber ??
                            selected.oldTrackingNumber
                        )
                    : undefined
                }
                onOpenShipmentOutput={
                  onOpenShipmentOutput && selectedOutputFocus
                    ? () => onOpenShipmentOutput(selectedOutputFocus)
                    : undefined
                }
                onRecoverCarrierRegistration={() =>
                  void runCarrierRegistrationRecovery()
                }
              />
            </>
          ) : (
            <div className="flex h-full min-h-52 items-center justify-center text-sm text-muted-foreground">
              왼쪽에서 재발급 작업을 선택하세요.
            </div>
          )}
        </div>
      </MasterDetailLayout>
    </section>
  );
}
