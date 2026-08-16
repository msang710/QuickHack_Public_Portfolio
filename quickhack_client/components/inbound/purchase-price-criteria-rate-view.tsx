// QuickHack note: 상품 기준 조합별 매입가를 날짜와 조건 메모 기준으로 입력하는 화면입니다.
"use client";

import * as React from "react";
import {
  BadgeDollarSign,
  CheckCheck,
  Database,
  ListChecks,
  Save,
  X,
} from "lucide-react";
import type { StatusTone } from "@/quickhack_shared/device/types";
import type { ProductCriteriaPayload } from "@/quickhack_shared/catalog/product-criteria";
import { Button } from "@/quickhack_client/components/ui/button";
import { FeedbackBanner } from "@/quickhack_client/components/ui/feedback-banner";
import { Input } from "@/quickhack_client/components/ui/input";
import { SearchInput } from "@/quickhack_client/components/ui/search-input";
import {
  SummaryMetric as SummaryCell,
  SummaryStrip,
} from "@/quickhack_client/components/ui/summary-metric";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/quickhack_client/components/ui/select";
import {
  PurchaseConditionNoteInput,
  PurchasePriceMatrixTable,
  addDaysToDateString,
  parsePriceInput,
  purchasePriceOptionKey,
  todayKstDate,
  type PurchasePriceCriteriaCell,
  type PurchasePreviousPriceDraftTarget,
  type PurchasePriceDraft,
  type PurchasePriceMatrixRow,
} from "@/quickhack_client/components/inbound/purchase-price-tools";
import {
  useUnsavedChanges,
  useUnsavedForm,
} from "@/quickhack_client/components/app-shell/unsaved-changes-provider";
import type { MutationReceipt } from "@/quickhack_shared/core/mutation-receipt";

type ProductCriteriaApiResponse = {
  ok: boolean;
  message?: string;
  data?: ProductCriteriaPayload;
};

type PurchasePriceRateDto = {
  id: number;
  revision: number;
  modelOptionId: number;
  modelOptionKey: string;
  model: string;
  storageOptionId: number;
  storageOptionKey: string;
  storage: string;
  appearanceGradeOptionId: number;
  appearanceGradeOptionKey: string;
  appearanceGrade: string;
  priceDate: string;
  purchasePrice: number;
  note: string;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

type PurchasePriceApiResponse = {
  ok: boolean;
  message?: string;
  rates?: PurchasePriceRateDto[];
  notes?: string[];
  queryContext?: { priceDate: string; note: string };
  receipt?: MutationReceipt<{ savedRates: PurchasePriceRateDto[] }>;
};

function mergeSavedPurchasePriceRates(
  current: PurchasePriceRateDto[],
  saved: PurchasePriceRateDto[]
) {
  const savedById = new Map(saved.map((rate) => [rate.id, rate]));
  const merged = current.map((rate) => savedById.get(rate.id) ?? rate);
  const existingIds = new Set(current.map((rate) => rate.id));
  merged.push(...saved.filter((rate) => !existingIds.has(rate.id)));
  return merged;
}

const PURCHASE_PRICE_CRITERIA_FORM_ID = "inbound.purchase-price-criteria";

// QuickHack object: 상품 기준 조합별 매입가를 날짜와 조건 메모 기준으로 입력하는 화면입니다.
export function PurchasePriceCriteriaRateView() {
  const [criteria, setCriteria] = React.useState<ProductCriteriaPayload | null>(
    null
  );
  const [rates, setRates] = React.useState<PurchasePriceRateDto[]>([]);
  const [previousRates, setPreviousRates] = React.useState<PurchasePriceRateDto[]>(
    []
  );
  const [drafts, setDrafts] = React.useState<Record<string, PurchasePriceDraft>>(
    {}
  );
  const [priceDate, setPriceDate] = React.useState(todayKstDate);
  const [conditionNote, setConditionNote] = React.useState("");
  const [conditionNoteOptions, setConditionNoteOptions] = React.useState<string[]>(
    []
  );
  const [query, setQuery] = React.useState("");
  const [storageFilter, setStorageFilter] = React.useState("ALL");
  const [gradeFilter, setGradeFilter] = React.useState("ALL");
  const [priceStatus, setPriceStatus] = React.useState<
    "all" | "unpriced" | "priced"
  >("unpriced");
  const [isLoadingSkus, setIsLoadingSkus] = React.useState(false);
  const [isLoadingRates, setIsLoadingRates] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [loadedQueryKey, setLoadedQueryKey] = React.useState<string | null>(null);
  const requestGenerationRef = React.useRef(0);
  const [message, setMessage] = React.useState("");
  const [messageTone, setMessageTone] = React.useState<StatusTone>("neutral");
  const { runGuardedAction } = useUnsavedChanges();
  const normalizedQuery = query.trim().toLowerCase();
  const previousPriceDate = addDaysToDateString(priceDate, -1);
  const currentQueryKey = `${priceDate}\u001f${conditionNote}`;
  const queryReady = loadedQueryKey === currentQueryKey;
  const ratesByKey = React.useMemo(() => {
    const next = new Map<string, PurchasePriceRateDto>();

    for (const rate of rates) {
      next.set(
        purchasePriceOptionKey({
          modelOptionId: rate.modelOptionId,
          storageOptionId: rate.storageOptionId,
          appearanceGradeOptionId: rate.appearanceGradeOptionId,
        }),
        rate
      );
    }

    return next;
  }, [rates]);
  const previousRatesByKey = React.useMemo(() => {
    const next = new Map<string, PurchasePriceRateDto>();

    for (const rate of previousRates) {
      next.set(
        purchasePriceOptionKey({
          modelOptionId: rate.modelOptionId,
          storageOptionId: rate.storageOptionId,
          appearanceGradeOptionId: rate.appearanceGradeOptionId,
        }),
        rate
      );
    }

    return next;
  }, [previousRates]);
  const allCriteriaRows = React.useMemo(() => {
    const rowsByKey = new Map<PurchasePriceMatrixRow["key"], PurchasePriceMatrixRow>();

    if (!criteria) {
      return [];
    }

    const activeOptions = criteria.rawOptions.filter((option) => option.isActive);
    const optionById = new Map(
      activeOptions.map((option) => [option.optionId, option])
    );
    const saleGrades = activeOptions
      .filter((option) => option.category === "APPEARANCE_GRADE")
      .sort((left, right) => left.sortOrder - right.sortOrder || left.optionId - right.optionId);
    const modelStorageLinks = criteria.rawLinks
      .filter(
        (link) => link.isActive && link.relationType === "MODEL_STORAGE"
      )
      .sort((left, right) => left.sortOrder - right.sortOrder || left.linkId - right.linkId);

    for (const link of modelStorageLinks) {
      const model = optionById.get(link.parentOptionId);
      const storage = optionById.get(link.childOptionId);

      if (
        !model ||
        model.category !== "PRODUCT_MODEL" ||
        !storage ||
        storage.category !== "STORAGE"
      ) {
        continue;
      }

      const key = `${model.optionId}\u001f${storage.optionId}`;
      const cells: PurchasePriceCriteriaCell[] = saleGrades.map((grade) => ({
        key: purchasePriceOptionKey({
          modelOptionId: model.optionId,
          storageOptionId: storage.optionId,
          appearanceGradeOptionId: grade.optionId,
        }),
        modelOptionId: model.optionId,
        storageOptionId: storage.optionId,
        appearanceGradeOptionId: grade.optionId,
        appearanceGrade: grade.label,
      }));

      rowsByKey.set(key, {
        key,
        modelOptionId: model.optionId,
        storageOptionId: storage.optionId,
        model: model.label,
        storage: storage.label,
        cells,
        searchText: [
          model.label,
          model.optionKey,
          storage.label,
          storage.optionKey,
          ...saleGrades.flatMap((grade) => [grade.label, grade.optionKey]),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
      });
    }

    return Array.from(rowsByKey.values()).sort((a, b) =>
      [a.model, a.storage].join(" ").localeCompare(
        [b.model, b.storage].join(" "),
        "ko-KR"
      )
    );
  }, [criteria]);
  const storageOptions = React.useMemo(
    () =>
      Array.from(new Set(allCriteriaRows.map((row) => row.storage))).sort(
        (a, b) => a.localeCompare(b, "ko-KR")
      ),
    [allCriteriaRows]
  );
  const gradeOptions = React.useMemo(() => {
    const seen = new Set<number>();
    const next: Array<{ optionId: number; label: string }> = [];

    for (const row of allCriteriaRows) {
      for (const cell of row.cells) {
        if (!seen.has(cell.appearanceGradeOptionId)) {
          seen.add(cell.appearanceGradeOptionId);
          next.push({
            optionId: cell.appearanceGradeOptionId,
            label: cell.appearanceGrade,
          });
        }
      }
    }

    return next;
  }, [allCriteriaRows]);
  const visibleGradeOptions = React.useMemo(
    () =>
      gradeFilter === "ALL"
        ? gradeOptions
        : gradeOptions.filter((grade) => String(grade.optionId) === gradeFilter),
    [gradeFilter, gradeOptions]
  );
  const criteriaRows = React.useMemo(() => {
    return allCriteriaRows.filter((row) => {
      if (normalizedQuery && !row.searchText.includes(normalizedQuery)) {
        return false;
      }

      if (storageFilter !== "ALL" && row.storage !== storageFilter) {
        return false;
      }

      const visibleCells =
        gradeFilter === "ALL"
          ? row.cells
          : row.cells.filter(
              (cell) => String(cell.appearanceGradeOptionId) === gradeFilter
            );

      if (visibleCells.length === 0) {
        return false;
      }

      const hasPricedCell = visibleCells.some((cell) => ratesByKey.has(cell.key));
      const hasUnpricedCell = visibleCells.some(
        (cell) => !ratesByKey.has(cell.key)
      );

      if (priceStatus === "unpriced" && !hasUnpricedCell) {
        return false;
      }

      if (priceStatus === "priced" && !hasPricedCell) {
        return false;
      }

      return true;
    });
  }, [
    allCriteriaRows,
    gradeFilter,
    normalizedQuery,
    priceStatus,
    ratesByKey,
    storageFilter,
  ]);
  const totalCriteriaCount = allCriteriaRows.length;
  const criteriaCellByKey = React.useMemo(
    () =>
      new Map(
        allCriteriaRows.flatMap((row) =>
          row.cells.map((cell) => [cell.key, cell] as const)
        )
      ),
    [allCriteriaRows]
  );
  const changedDraftEntries = React.useMemo(
    () =>
      Object.entries(drafts).filter(([key, draft]) => {
        if (draft.purchasePrice.trim() === "") {
          return false;
        }

        const parsedPrice = parsePriceInput(draft.purchasePrice);
        return (
          parsedPrice === null ||
          parsedPrice !== ratesByKey.get(key)?.purchasePrice
        );
      }),
    [drafts, ratesByKey]
  );
  const hasDraftEntries = changedDraftEntries.length > 0;

  const discardPriceDrafts = React.useCallback(() => {
    setDrafts({});
    setMessage("");
  }, []);

  useUnsavedForm({
    id: PURCHASE_PRICE_CRITERIA_FORM_ID,
    label: `${priceDate} 매입가 기준`,
    isDirty: hasDraftEntries,
    isBusy: isSaving,
    discard: discardPriceDrafts,
  });

  React.useEffect(() => {
    let ignore = false;

    async function loadCriteria() {
      setIsLoadingSkus(true);

      try {
        const criteriaResponse = await fetch("/api/product-criteria", {
          cache: "no-store",
        });
        const payload = (await criteriaResponse.json().catch(() => null)) as
          | ProductCriteriaApiResponse
          | null;

        if (!criteriaResponse.ok || !payload?.ok || !payload.data) {
          throw new Error(payload?.message || "상품 기준값을 불러오지 못했습니다.");
        }

        if (!ignore) {
          setCriteria(payload.data);
        }
      } catch (error) {
        if (!ignore) {
          setMessage(error instanceof Error ? error.message : String(error));
          setMessageTone("warning");
        }
      } finally {
        if (!ignore) {
          setIsLoadingSkus(false);
        }
      }
    }

    void loadCriteria();

    return () => {
      ignore = true;
    };
  }, []);

  React.useEffect(() => {
    let ignore = false;

    async function loadRates() {
      const generation = ++requestGenerationRef.current;
      setIsLoadingRates(true);
      setLoadedQueryKey(null);
      setRates([]);
      setPreviousRates([]);

      try {
        if (!priceDate || !previousPriceDate) {
          if (!ignore) {
            setRates([]);
            setPreviousRates([]);
            setConditionNoteOptions([]);
            setDrafts({});
          }
          return;
        }

        const [response, previousResponse] = await Promise.all([
          fetch(
            `/api/inbound/purchase-prices?priceDate=${encodeURIComponent(priceDate)}&note=${encodeURIComponent(conditionNote)}`,
            { cache: "no-store" }
          ),
          fetch(
            `/api/inbound/purchase-prices?priceDate=${encodeURIComponent(previousPriceDate)}&note=${encodeURIComponent(conditionNote)}`,
            { cache: "no-store" }
          ),
        ]);
        const payload = (await response.json().catch(() => null)) as
          | PurchasePriceApiResponse
          | null;
        const previousPayload = (await previousResponse.json().catch(
          () => null
        )) as PurchasePriceApiResponse | null;

        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.message || "매입가 기준을 불러오지 못했습니다.");
        }

        if (!previousResponse.ok || !previousPayload?.ok) {
          throw new Error(
            previousPayload?.message || "전일 매입가 기준을 불러오지 못했습니다."
          );
        }

        const responseContext = payload.queryContext;
        const previousResponseContext = previousPayload.queryContext;

        if (
          responseContext?.priceDate !== priceDate ||
          responseContext.note !== conditionNote ||
          previousResponseContext?.priceDate !== previousPriceDate ||
          previousResponseContext.note !== conditionNote
        ) {
          throw new Error("요청한 날짜와 조건이 아닌 매입가 응답을 받았습니다.");
        }

        if (!ignore && requestGenerationRef.current === generation) {
          setRates(payload.rates ?? []);
          setPreviousRates(previousPayload.rates ?? []);
          setConditionNoteOptions(
            Array.from(
              new Set([...(payload.notes ?? []), ...(previousPayload.notes ?? [])])
            )
          );
          setDrafts({});
          setLoadedQueryKey(`${priceDate}\u001f${conditionNote}`);
        }
      } catch (error) {
        if (!ignore && requestGenerationRef.current === generation) {
          setMessage(error instanceof Error ? error.message : String(error));
          setMessageTone("warning");
        }
      } finally {
        if (!ignore && requestGenerationRef.current === generation) {
          setIsLoadingRates(false);
        }
      }
    }

    void loadRates();

    return () => {
      ignore = true;
    };
  }, [conditionNote, previousPriceDate, priceDate]);

  function defaultDraftForCell() {
    return {
      purchasePrice: "",
    };
  }

  function draftForCell(key: string) {
    return drafts[key] ?? defaultDraftForCell();
  }

  function updateRateDraft(
    key: string,
    updater: (current: PurchasePriceDraft) => PurchasePriceDraft
  ) {
    setDrafts((current) => {
      const before = current[key] ?? defaultDraftForCell();
      const nextDraft = updater(before);

      if (!nextDraft.purchasePrice.trim()) {
        const next = { ...current };
        delete next[key];
        return next;
      }

      return {
        ...current,
        [key]: nextDraft,
      };
    });
  }

  function applyPreviousPriceDraft(
    key: string,
    previousPrice: number,
    checked: boolean
  ) {
    applyPreviousPriceDrafts([{ key, previousPrice }], checked);
  }

  function applyPreviousPriceDrafts(
    targets: PurchasePreviousPriceDraftTarget[],
    checked: boolean
  ) {
    setDrafts((current) => {
      const next = { ...current };

      for (const target of targets) {
        const previousPriceText = target.previousPrice.toLocaleString("ko-KR");

        if (checked) {
          next[target.key] = {
            ...(current[target.key] ?? defaultDraftForCell()),
            purchasePrice: previousPriceText,
          };
          continue;
        }

        if (current[target.key]?.purchasePrice === previousPriceText) {
          delete next[target.key];
        }
      }

      return next;
    });
  }

  function requestPriceDateChange(value: string) {
    if (value === priceDate) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [PURCHASE_PRICE_CRITERIA_FORM_ID],
      targetLabel: `${value || "미지정"} 매입가 기준 열기`,
      action: () => setPriceDate(value),
    });
  }

  function requestConditionNoteChange(value: string) {
    if (value === conditionNote) {
      return;
    }

    runGuardedAction({
      intent: "internal-change",
      formIds: [PURCHASE_PRICE_CRITERIA_FORM_ID],
      targetLabel: `${value || "기본"} 조건 매입가 열기`,
      action: () => setConditionNote(value),
    });
  }

  async function saveChangedRates() {
    if (!queryReady) {
      setMessage("현재 날짜와 조건의 매입가 기준을 불러온 뒤 저장해 주세요.");
      setMessageTone("warning");
      return;
    }

    if (changedDraftEntries.length === 0 || isSaving) {
      setMessage("저장할 매입가를 입력하세요. ");
      setMessageTone("warning");
      return;
    }

    setIsSaving(true);
    setMessage("");

    try {
      const ratesForSave = changedDraftEntries.map(([key, draft]) => {
        const cell = criteriaCellByKey.get(key);
        const purchasePrice = parsePriceInput(draft.purchasePrice);

        if (!cell) {
          throw new Error("매입가 저장 대상 조합을 확인할 수 없습니다. ");
        }

        if (purchasePrice === null) {
          throw new Error(
            cell.appearanceGrade +
              " 매입가를 숫자로 입력하세요."
          );
        }

        return {
          modelOptionId: cell.modelOptionId,
          storageOptionId: cell.storageOptionId,
          appearanceGradeOptionId: cell.appearanceGradeOptionId,
          expectedRevision: ratesByKey.get(key)?.revision ?? null,
          purchasePrice,
        };
      });
      const response = await fetch("/api/inbound/purchase-prices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priceDate,
          note: conditionNote,
          rates: ratesForSave,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | PurchasePriceApiResponse
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "매입가 기준 저장에 실패했습니다. ");
      }

      if (
        payload.queryContext?.priceDate !== priceDate ||
        payload.queryContext.note !== conditionNote
      ) {
        throw new Error("저장한 날짜와 조건이 아닌 매입가 응답을 받았습니다.");
      }

      const refreshDeferred = payload.receipt?.refreshRequired === true;
      if (payload.rates) {
        setRates(payload.rates);
      } else if (refreshDeferred) {
        setRates((current) =>
          mergeSavedPurchasePriceRates(
            current,
            payload.receipt?.result.savedRates ?? []
          )
        );
      }
      if (payload.notes) {
        setConditionNoteOptions(payload.notes);
      } else if (refreshDeferred && conditionNote) {
        setConditionNoteOptions((current) =>
          current.includes(conditionNote) ? current : [...current, conditionNote]
        );
      }
      setDrafts({});
      setLoadedQueryKey(currentQueryKey);
      setMessage(
        refreshDeferred
          ? `${payload.message || "매입가 기준을 저장했습니다."} 전체 목록은 새로고침해 확인하세요.`
          : payload.message || "매입가 기준을 저장했습니다. "
      );
      setMessageTone(refreshDeferred ? "warning" : "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageTone("warning");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 p-5">
      <SummaryStrip className="grid-cols-4">
        <SummaryCell icon={Database} label="기종/용량 조합" value={totalCriteriaCount} />
        <SummaryCell
          icon={BadgeDollarSign}
          label="저장된 매입가"
          value={rates.length}
        />
        <SummaryCell
          icon={ListChecks}
          label="표시 행"
          value={criteriaRows.length}
        />
        <SummaryCell
          icon={CheckCheck}
          label="입력 셀"
          value={changedDraftEntries.length}
        />
      </SummaryStrip>

      <section className="grid gap-3 rounded-md border bg-popover p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid w-[170px] gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">적용일</span>
            <Input
              type="date"
              value={priceDate}
              onChange={(event) => requestPriceDateChange(event.target.value)}
            />
          </label>
          <PurchaseConditionNoteInput
            value={conditionNote}
            options={conditionNoteOptions}
            onChange={requestConditionNoteChange}
          />
          <SearchInput
            label="기종 검색"
            wrapperClassName="min-w-[240px] flex-1"
            placeholder="기종명 또는 모델코드 검색"
            value={query}
            onValueChange={setQuery}
          />
          <label className="grid w-[140px] gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">용량</span>
            <Select value={storageFilter} onValueChange={setStorageFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">전체</SelectItem>
                {storageOptions.map((storage) => (
                  <SelectItem key={storage} value={storage}>
                    {storage}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid w-[140px] gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">외관등급</span>
            <Select value={gradeFilter} onValueChange={setGradeFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">전체</SelectItem>
                {gradeOptions.map((grade) => (
                  <SelectItem
                    key={grade.optionId}
                    value={String(grade.optionId)}
                  >
                    {grade.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid w-[150px] gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">표시</span>
            <Select
              value={priceStatus}
              onValueChange={(value) =>
                setPriceStatus(value as "all" | "unpriced" | "priced")
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unpriced">매입가 미입력</SelectItem>
                <SelectItem value="priced">매입가 입력됨</SelectItem>
                <SelectItem value="all">전체</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <Button
            variant="outline"
            onClick={() => setDrafts({})}
            disabled={!queryReady || !hasDraftEntries || isSaving}
          >
            <X className="size-4" />
            입력 초기화
          </Button>
          <Button
            onClick={() => void saveChangedRates()}
            disabled={!queryReady || isSaving || changedDraftEntries.length === 0}
          >
            <Save className="size-4" />
            {isSaving
              ? "저장중"
              : "입력 셀 " +
                changedDraftEntries.length.toLocaleString("ko-KR") +
                "개 저장"}
          </Button>
        </div>

        {message ? (
          <FeedbackBanner
            tone={messageTone === "success" ? "success" : "warning"}
          >
            {message}
          </FeedbackBanner>
        ) : null}
      </section>

      <PurchasePriceMatrixTable
        rows={criteriaRows}
        visibleGradeOptions={visibleGradeOptions}
        ratesByKey={ratesByKey}
        previousRatesByKey={previousRatesByKey}
        draftForCell={draftForCell}
        applyPreviousPriceDraft={applyPreviousPriceDraft}
        applyPreviousPriceDrafts={applyPreviousPriceDrafts}
        updateRateDraft={updateRateDraft}
      />

      {isLoadingSkus || isLoadingRates ? (
        <div className="text-xs text-muted-foreground">
          {isLoadingSkus
            ? "매입가 입력 기준 조합을 불러오는 중입니다."
            : "매입가 기준을 불러오는 중입니다."}
        </div>
      ) : null}
    </section>
  );
}
