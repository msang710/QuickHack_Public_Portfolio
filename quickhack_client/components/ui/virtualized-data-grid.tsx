// QuickHack note: 대량 재고 목록을 렉 없이 표시하기 위한 가상 스크롤 데이터 그리드입니다.
"use client";

import * as React from "react";
import { ArrowUpDown, ChevronDown, Search, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Input } from "@/quickhack_client/components/ui/input";
import { cn } from "@/quickhack_shared/core/utils";

export type DataGridSortDirection = "asc" | "desc";
type DataGridCellValue = string | number | null | undefined;

export type DataGridSortState<TKey extends string> = {
  key: TKey;
  direction: DataGridSortDirection;
} | null;

export type DataGridHeaderRenderContext<TRow> = {
  rows: TRow[];
  displayRows: TRow[];
  totalRowCount: number;
  displayRowCount: number;
};

// QuickHack object: 가상 스크롤 표에서 컬럼 너비, 렌더링, 필터 값을 정의하는 컬럼 타입입니다.
export type DataGridColumn<TKey extends string, TRow> = {
  key: TKey;
  label: string;
  headerRender?:
    | React.ReactNode
    | ((context: DataGridHeaderRenderContext<TRow>) => React.ReactNode);
  width: string;
  render: (row: TRow) => React.ReactNode;
  text?: (row: TRow) => DataGridCellValue;
  sortValue?: (row: TRow) => DataGridCellValue;
  headerClassName?: string;
  cellClassName?: string;
  placeholder?: string;
  menuAlign?: "left" | "right";
  sortable?: boolean;
  filterable?: boolean;
};

type DataGridColumnHeaderProps<TRow, TKey extends string> = {
  column: DataGridColumn<TKey, TRow>;
  filter: string;
  sort: DataGridSortState<TKey>;
  headerContext: DataGridHeaderRenderContext<TRow>;
  onFilterChange?: (key: TKey, value: string) => void;
  onSortChange?: (sort: DataGridSortState<TKey>) => void;
};

function DataGridColumnHeader<TRow, TKey extends string>({
  column,
  filter,
  sort,
  headerContext,
  onFilterChange,
  onSortChange,
}: DataGridColumnHeaderProps<TRow, TKey>) {
  const t = useTranslations("common.dataGrid");
  const [open, setOpen] = React.useState(false);
  const [draftFilterState, setDraftFilterState] = React.useState(() => ({
    sourceFilter: filter,
    value: filter,
  }));
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const sortable = column.sortable !== false && Boolean(onSortChange);
  const filterable = column.filterable !== false && Boolean(onFilterChange);
  const hasMenu = sortable || filterable;
  const isActiveSort = sort?.key === column.key;
  const isActiveFilter = filter.trim() !== "";
  const draftFilter =
    draftFilterState.sourceFilter === filter ? draftFilterState.value : filter;
  const headerContent =
    typeof column.headerRender === "function"
      ? column.headerRender(headerContext)
      : column.headerRender ?? column.label;

  function setDraftFilter(value: string) {
    setDraftFilterState({
      sourceFilter: filter,
      value,
    });
  }

  React.useEffect(() => {
    if (!open) {
      return;
    }

    function closeOnOutsideClick(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function setSort(direction: DataGridSortDirection) {
    onSortChange?.({ key: column.key, direction });
    setOpen(false);
  }

  function applyFilter() {
    onFilterChange?.(column.key, draftFilter.trim());
    setOpen(false);
  }

  function clearFilter() {
    setDraftFilter("");
    onFilterChange?.(column.key, "");
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative flex min-w-0 items-center gap-1">
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate">{headerContent}</span>
        {isActiveSort ? (
          <span className="shrink-0 text-[10px] font-semibold text-primary">
            {sort.direction === "asc" ? "A-Z" : "Z-A"}
          </span>
        ) : null}
        {isActiveFilter ? (
          <span className="size-1.5 shrink-0 rounded-full bg-primary" />
        ) : null}
      </div>

      {hasMenu ? (
        <button
          type="button"
          className={cn(
            "inline-flex size-5 shrink-0 items-center justify-center rounded border border-input bg-background text-muted-foreground hover:bg-secondary hover:text-foreground",
            (isActiveSort || isActiveFilter) && "border-primary text-primary"
          )}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => {
              const nextOpen = !current;

              if (nextOpen) {
                setDraftFilterState({
                  sourceFilter: filter,
                  value: filter,
                });
              }

              return nextOpen;
            });
          }}
          title={t("menuTitle", { column: column.label })}
        >
          <ChevronDown className="size-3" />
        </button>
      ) : null}

      {open ? (
        <div
          className={cn(
            "absolute top-full z-50 mt-1 w-64 rounded-md border bg-popover p-2 text-popover-foreground shadow-lg",
            column.menuAlign === "right" ? "right-0" : "left-0"
          )}
          onClick={(event) => event.stopPropagation()}
        >
          {sortable ? (
            <>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-secondary"
                onClick={() => setSort("asc")}
              >
                <ArrowUpDown className="size-3.5" />
                {t("ascending")}
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-secondary"
                onClick={() => setSort("desc")}
              >
                <ArrowUpDown className="size-3.5" />
                {t("descending")}
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!isActiveSort}
                onClick={() => {
                  onSortChange?.(null);
                  setOpen(false);
                }}
              >
                <X className="size-3.5" />
                {t("clearSort")}
              </button>
            </>
          ) : null}

          {filterable ? (
            <div className={cn(sortable && "mt-2 border-t pt-2")}>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-8 pl-7 text-xs font-normal"
                  value={draftFilter}
                  placeholder={column.placeholder ?? t("searchPlaceholder", { column: column.label })}
                  autoFocus
                  onChange={(event) => setDraftFilter(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      applyFilter();
                    }
                  }}
                />
              </div>
              <p className="mt-1 px-1 text-[11px] text-muted-foreground">
                {t("applyHint")}
              </p>
              <button
                type="button"
                className="mt-2 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!isActiveFilter && !draftFilter}
                onClick={clearFilter}
              >
                <X className="size-3.5" />
                {t("clearFilter")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function compareDataGridValues(left: DataGridCellValue, right: DataGridCellValue, locale: string) {
  const leftEmpty = left === null || left === undefined || left === "";
  const rightEmpty = right === null || right === undefined || right === "";

  if (leftEmpty && rightEmpty) {
    return 0;
  }

  if (leftEmpty) {
    return 1;
  }

  if (rightEmpty) {
    return -1;
  }

  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  return String(left).localeCompare(String(right), locale, {
    numeric: true,
    sensitivity: "base",
  });
}

function cssSize(value: number | string) {
  return typeof value === "number" ? `${value}px` : value;
}

type VirtualizedDataGridProps<TRow, TKey extends string> = {
  rows: TRow[];
  columns: DataGridColumn<TKey, TRow>[];
  rowKey: (row: TRow) => React.Key;
  emptyMessage: string;
  selectedRowKey?: React.Key | null;
  onRowClick?: (row: TRow) => void;
  getRowClassName?: (row: TRow) => string | undefined;
  filters?: Partial<Record<TKey, string>>;
  sort?: DataGridSortState<TKey>;
  onFilterChange?: (key: TKey, value: string) => void;
  onSortChange?: (sort: DataGridSortState<TKey>) => void;
  className?: string;
  minWidth?: number | string;
  rowHeight?: number;
  headerHeight?: number;
  overscan?: number;
};

// QuickHack object: 대량 행을 필요한 만큼만 렌더링하고 컬럼 필터/정렬을 제공하는 공통 표 컴포넌트입니다.
export function VirtualizedDataGrid<TRow, TKey extends string>({
  rows,
  columns,
  rowKey,
  emptyMessage,
  selectedRowKey = null,
  onRowClick,
  getRowClassName,
  filters = {},
  sort = null,
  onFilterChange,
  onSortChange,
  className,
  minWidth = "100%",
  rowHeight = 52,
  headerHeight = 36,
  overscan = 8,
}: VirtualizedDataGridProps<TRow, TKey>) {
  const locale = useLocale();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [virtualState, setVirtualState] = React.useState({
    scrollTop: 0,
    viewportHeight: 0,
  });
  const [internalFilters, setInternalFilters] = React.useState<
    Partial<Record<TKey, string>>
  >({});
  const [internalSort, setInternalSort] =
    React.useState<DataGridSortState<TKey>>(null);
  const gridTemplateColumns = React.useMemo(
    () => columns.map((column) => column.width).join(" "),
    [columns]
  );
  const gridWidth = React.useMemo(() => {
    const value = cssSize(minWidth);

    return value === "100%" ? "100%" : `max(100%, ${value})`;
  }, [minWidth]);
  const effectiveFilters = onFilterChange ? filters : internalFilters;
  const effectiveSort = onSortChange ? sort : internalSort;
  const handleFilterChange = React.useCallback(
    (key: TKey, value: string) => {
      if (onFilterChange) {
        onFilterChange(key, value);
        return;
      }

      setInternalFilters((current) => ({
        ...current,
        [key]: value,
      }));
    },
    [onFilterChange]
  );
  const handleSortChange = React.useCallback(
    (nextSort: DataGridSortState<TKey>) => {
      if (onSortChange) {
        onSortChange(nextSort);
        return;
      }

      setInternalSort(nextSort);
    },
    [onSortChange]
  );
  const displayRows = React.useMemo(() => {
    const activeFilters = onFilterChange
      ? []
      : Object.entries(effectiveFilters)
          .map(
            ([key, value]) =>
              [key as TKey, String(value).trim().toLowerCase()] as const
          )
          .filter(([, value]) => value !== "");
    const filteredRows =
      activeFilters.length === 0
        ? rows
        : rows.filter((row) =>
            activeFilters.every(([key, value]) => {
              const column = columns.find((item) => item.key === key);

              if (!column?.text) {
                return true;
              }

              return String(column.text(row) ?? "")
                .toLowerCase()
                .includes(value);
            })
          );

    if (onSortChange || !effectiveSort) {
      return filteredRows;
    }

    const sortColumn = columns.find((column) => column.key === effectiveSort.key);
    const valueForSort = sortColumn?.sortValue ?? sortColumn?.text;

    if (!valueForSort) {
      return filteredRows;
    }

    return [...filteredRows].sort((left, right) => {
      const result = compareDataGridValues(valueForSort(left), valueForSort(right), locale);

      return effectiveSort.direction === "asc" ? result : -result;
    });
  }, [
    columns,
    effectiveFilters,
    effectiveSort,
    locale,
    onFilterChange,
    onSortChange,
    rows,
  ]);

  const syncVirtualState = React.useCallback(
    (element: HTMLDivElement) => {
      const nextState = {
        scrollTop: Math.max(0, element.scrollTop - headerHeight),
        viewportHeight: element.clientHeight,
      };

      setVirtualState((current) =>
        current.scrollTop === nextState.scrollTop &&
        current.viewportHeight === nextState.viewportHeight
          ? current
          : nextState
      );
    },
    [headerHeight]
  );

  React.useEffect(() => {
    const element = scrollRef.current;

    if (!element) {
      return;
    }

    syncVirtualState(element);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => syncVirtualState(element));
    observer.observe(element);

    return () => observer.disconnect();
  }, [displayRows.length, syncVirtualState]);

  const totalRows = displayRows.length;
  const visibleCount =
    virtualState.viewportHeight > 0
      ? Math.ceil(virtualState.viewportHeight / rowHeight) + overscan * 2
      : 60;
  const maxStartIndex = Math.max(0, totalRows - visibleCount);
  const startIndex = Math.min(
    maxStartIndex,
    Math.max(0, Math.floor(virtualState.scrollTop / rowHeight) - overscan)
  );
  const endIndex = Math.min(totalRows, startIndex + visibleCount);
  const visibleRows = displayRows.slice(startIndex, endIndex);
  const topSpacerHeight = startIndex * rowHeight;
  const bottomSpacerHeight = (totalRows - endIndex) * rowHeight;
  const bodyHeight =
    topSpacerHeight + visibleRows.length * rowHeight + bottomSpacerHeight;
  const headerContext = React.useMemo<DataGridHeaderRenderContext<TRow>>(
    () => ({
      rows,
      displayRows,
      totalRowCount: rows.length,
      displayRowCount: displayRows.length,
    }),
    [displayRows, rows]
  );

  return (
    <div
      ref={scrollRef}
      className={cn(
        "min-h-0 flex-1 overflow-auto rounded-md border bg-popover",
        className
      )}
      onScroll={(event) => syncVirtualState(event.currentTarget)}
    >
      <div className="text-sm" role="table" style={{ width: gridWidth }}>
        <div
          className="sticky top-0 z-10 grid w-full border-b bg-secondary"
          role="row"
          style={{
            gridTemplateColumns,
            height: headerHeight,
          }}
        >
          {columns.map((column) => (
            <div
              key={column.key}
              className={cn(
                "flex items-center px-3 text-xs font-semibold text-muted-foreground",
                column.headerClassName
              )}
              role="columnheader"
            >
              <DataGridColumnHeader
                column={column}
                filter={effectiveFilters[column.key] ?? ""}
                sort={effectiveSort}
                headerContext={headerContext}
                onFilterChange={
                  column.text || onFilterChange ? handleFilterChange : undefined
                }
                onSortChange={
                  column.text || column.sortValue || onSortChange
                    ? handleSortChange
                    : undefined
                }
              />
            </div>
          ))}
        </div>

        {displayRows.length === 0 ? (
          <div className="grid h-80 place-items-center text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          <div
            className="relative w-full"
            style={{ height: bodyHeight }}
          >
            {visibleRows.map((row, index) => {
              const key = rowKey(row);

              return (
                <div
                  key={key}
                  role="row"
                  aria-rowindex={startIndex + index + 1}
                  className={cn(
                    "absolute left-0 grid w-full border-b bg-popover transition-colors hover:bg-secondary/60",
                    onRowClick && "cursor-pointer",
                    selectedRowKey === key && "bg-secondary",
                    getRowClassName?.(row)
                  )}
                  style={{
                    gridTemplateColumns,
                    height: rowHeight,
                    top: (startIndex + index) * rowHeight,
                  }}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((column) => (
                    <div
                      key={column.key}
                      role="cell"
                      className={cn("min-w-0", column.cellClassName)}
                    >
                      {column.render(row)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
