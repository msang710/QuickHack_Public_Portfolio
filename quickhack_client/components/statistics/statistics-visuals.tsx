"use client";

import * as React from "react";
import { FormSection as Section } from "@/quickhack_client/components/ui/form-layout";
import type {
  StatisticsGroup,
  StatisticsPoint,
} from "@/quickhack_shared/statistics/statistics";
import { cn } from "@/quickhack_shared/core/utils";

export const statisticsChartColors = [
  "#0f766e",
  "#2563eb",
  "#d97706",
  "#7c3aed",
  "#dc2626",
  "#0891b2",
  "#65a30d",
  "#db2777",
] as const;

export function formatNumber(value: number) {
  return value.toLocaleString("ko-KR");
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 0,
    style: "currency",
    currency: "KRW",
  }).format(value);
}

export function groupPercent(count: number, total: number) {
  if (total <= 0) {
    return 0;
  }

  return Math.round((count / total) * 1000) / 10;
}

export function SummaryTile({
  icon: Icon,
  label,
  value,
  description,
  tone = "primary",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  description?: React.ReactNode;
  tone?: "primary" | "success" | "warning" | "purple" | "sky";
}) {
  return (
    <div className="flex min-h-[86px] min-w-0 items-center gap-3 rounded-md border bg-popover px-4">
      <div
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-md",
          tone === "primary" && "bg-secondary text-primary",
          tone === "success" && "bg-emerald-50 text-emerald-700",
          tone === "warning" && "bg-amber-50 text-amber-800",
          tone === "purple" && "bg-purple-50 text-purple-700",
          tone === "sky" && "bg-sky-50 text-sky-700"
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate text-xl font-semibold tabular-nums">
          {value}
        </div>
        {description ? (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyDataState({
  message = "집계할 데이터가 없습니다.",
}: {
  message?: string;
}) {
  return (
    <div className="grid min-h-32 place-items-center rounded-md border border-dashed bg-background px-4 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

export function StatisticsCoverageItem({
  label,
  value,
  description,
}: {
  label: string;
  value: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-md border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums">{value}</div>
      {description ? (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {description}
        </div>
      ) : null}
    </div>
  );
}

export function BarList({
  groups,
  total,
  renderLabel,
}: {
  groups: StatisticsGroup[];
  total: number;
  renderLabel?: (group: StatisticsGroup) => React.ReactNode;
}) {
  if (groups.length === 0) {
    return <EmptyDataState />;
  }

  return (
    <div className="grid gap-2">
      {groups.map((group) => {
        const percent = groupPercent(group.count, total);

        return (
          <div key={group.label} className="grid gap-1">
            <div className="flex items-center justify-between gap-3 text-sm">
              <div className="min-w-0 truncate">
                {renderLabel ? renderLabel(group) : group.label}
              </div>
              <div className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatNumber(group.count)}건 / {percent}%
              </div>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.min(100, percent)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export type CompactTableColumn = {
  label: string;
  align?: "left" | "center" | "right";
  wrap?: boolean;
};

export function CompactTable({
  columns,
  rows,
  gridTemplateColumns,
  minWidth,
  maxHeight,
  wrapCells = false,
  emptyMessage = "표시할 데이터가 없습니다.",
}: {
  columns: Array<string | CompactTableColumn>;
  rows: Array<Array<React.ReactNode>>;
  gridTemplateColumns?: string;
  minWidth?: number | string;
  maxHeight?: number | string;
  wrapCells?: boolean;
  emptyMessage?: string;
}) {
  const template =
    gridTemplateColumns ??
    `repeat(${columns.length}, minmax(0, 1fr))`;
  const resolvedMinWidth =
    typeof minWidth === "number" ? `${minWidth}px` : minWidth;
  const resolvedMaxHeight =
    typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight;

  return (
    <div
      className="overflow-auto rounded-md border bg-background"
      style={{ maxHeight: resolvedMaxHeight }}
    >
      <div style={{ minWidth: resolvedMinWidth }}>
        <div
          className={cn(
            "grid border-b bg-secondary/60 px-3 py-2 text-xs font-semibold text-muted-foreground",
            resolvedMaxHeight && "sticky top-0 z-10"
          )}
          style={{ gridTemplateColumns: template }}
        >
          {columns.map((column, index) => {
            const definition =
              typeof column === "string" ? { label: column } : column;

            return (
              <div
                key={`${definition.label}-${index}`}
                className={cn(
                  "px-1",
                  !definition.wrap && "truncate",
                  definition.align === "center" && "text-center",
                  definition.align === "right" && "text-right"
                )}
              >
                {definition.label}
              </div>
            );
          })}
        </div>
        {rows.length === 0 ? (
          <EmptyDataState message={emptyMessage} />
        ) : (
          rows.map((row, rowIndex) => (
            <div
              key={rowIndex}
              className="grid border-b px-3 py-2 text-sm last:border-b-0"
              style={{ gridTemplateColumns: template }}
            >
              {row.map((cell, cellIndex) => {
                const column = columns[cellIndex];
                const definition =
                  typeof column === "string" || column === undefined
                    ? { label: String(column ?? "") }
                    : column;

                return (
                  <div
                    key={cellIndex}
                    className={cn(
                      "min-w-0 px-1",
                      !(wrapCells || definition.wrap) && "truncate",
                      (wrapCells || definition.wrap) &&
                        "break-words whitespace-normal",
                      definition.align === "center" && "text-center",
                      definition.align === "right" &&
                        "text-right tabular-nums"
                    )}
                  >
                    {cell}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function LineTrendChart({
  title,
  points,
  maxAxisLabels,
  showPointMarkers = true,
}: {
  title: string;
  points: StatisticsPoint[];
  maxAxisLabels?: number;
  showPointMarkers?: boolean;
}) {
  const width = 680;
  const height = 220;
  const padding = 30;
  const maxValue = Math.max(1, ...points.map((point) => point.value));
  const chartPoints = points.map((point, index) => {
    const x =
      points.length === 1
        ? width / 2
        : padding + (index * (width - padding * 2)) / (points.length - 1);
    const y =
      height - padding - (point.value / maxValue) * (height - padding * 2);

    return { ...point, x, y };
  });
  const visibleLabelIndexes = buildAxisLabelIndexes(
    chartPoints.length,
    maxAxisLabels
  );

  return (
    <Section title={title} className="min-h-[300px]">
      {points.length === 0 ? (
        <EmptyDataState />
      ) : (
        <div className="min-w-0 overflow-hidden rounded-md border bg-background p-3">
          <svg
            aria-label={`${title} 선 그래프`}
            className="h-[220px] w-full"
            preserveAspectRatio="none"
            role="img"
            viewBox={`0 0 ${width} ${height}`}
          >
            <line
              stroke="hsl(var(--border))"
              strokeWidth="1"
              x1={padding}
              x2={width - padding}
              y1={height - padding}
              y2={height - padding}
            />
            <line
              stroke="hsl(var(--border))"
              strokeWidth="1"
              x1={padding}
              x2={padding}
              y1={padding}
              y2={height - padding}
            />
            {points.length > 1 ? (
              <polyline
                fill="none"
                points={chartPoints
                  .map((point) => `${point.x},${point.y}`)
                  .join(" ")}
                stroke={statisticsChartColors[1]}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3"
              />
            ) : null}
            {chartPoints.map((point, index) => (
              <g key={point.label}>
                <title>
                  {point.label}: {formatNumber(point.value)}
                </title>
                {showPointMarkers ? (
                  <circle
                    cx={point.x}
                    cy={point.y}
                    fill={statisticsChartColors[0]}
                    r="4"
                  />
                ) : null}
                {visibleLabelIndexes.has(index) ? (
                  <>
                    <text
                      fill="hsl(var(--foreground))"
                      fontSize="12"
                      textAnchor="middle"
                      x={point.x}
                      y={Math.max(16, point.y - 10)}
                    >
                      {formatNumber(point.value)}
                    </text>
                    <text
                      fill="hsl(var(--muted-foreground))"
                      fontSize="11"
                      textAnchor="middle"
                      x={point.x}
                      y={height - 8}
                    >
                      {point.label.slice(2)}
                    </text>
                  </>
                ) : null}
              </g>
            ))}
          </svg>
        </div>
      )}
    </Section>
  );
}

export type MultiLineTrendSeries = {
  key: string;
  label: string;
  color?: string;
  points: Array<{ label: string; value: number | null }>;
};

type PositionedPoint = {
  label: string;
  value: number;
  x: number;
  y: number;
};

export function splitContinuousSegments<T>(points: Array<T | null>) {
  const segments: T[][] = [];
  let current: T[] = [];

  for (const point of points) {
    if (point === null) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(point);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

export function buildAxisLabelIndexes(
  pointCount: number,
  maxAxisLabels?: number
) {
  if (
    pointCount <= 0 ||
    maxAxisLabels === undefined ||
    maxAxisLabels >= pointCount
  ) {
    return new Set(Array.from({ length: pointCount }, (_, index) => index));
  }

  const limit = Math.max(1, Math.floor(maxAxisLabels));

  if (limit === 1) {
    return new Set([pointCount - 1]);
  }

  return new Set(
    Array.from({ length: limit }, (_, index) =>
      Math.round((index * (pointCount - 1)) / (limit - 1))
    )
  );
}

export function MultiLineTrendChart({
  title,
  description,
  series,
  valueFormatter = (value) => `${value}%`,
  maxAxisLabels,
  showPointMarkers = true,
}: {
  title: string;
  description?: string;
  series: MultiLineTrendSeries[];
  valueFormatter?: (value: number) => string;
  maxAxisLabels?: number;
  showPointMarkers?: boolean;
}) {
  const width = 760;
  const height = 260;
  const padding = 38;
  const labels = series[0]?.points.map((point) => point.label) ?? [];
  const numericValues = series.flatMap((item) =>
    item.points.flatMap((point) =>
      point.value === null ? [] : [point.value]
    )
  );
  const maxValue = Math.max(1, ...numericValues);
  const visibleLabelIndexes = buildAxisLabelIndexes(
    labels.length,
    maxAxisLabels
  );
  const position = (
    point: { label: string; value: number | null },
    index: number
  ): PositionedPoint | null => {
    if (point.value === null) {
      return null;
    }
    const x =
      labels.length <= 1
        ? width / 2
        : padding + (index * (width - padding * 2)) / (labels.length - 1);
    const y =
      height -
      padding -
      (point.value / maxValue) * (height - padding * 2);
    return { ...point, value: point.value, x, y };
  };

  if (labels.length === 0 || numericValues.length === 0) {
    return (
      <Section
        title={title}
        description={description}
        className="min-h-[340px]"
      >
        <EmptyDataState />
      </Section>
    );
  }

  return (
    <Section
      title={title}
      description={description}
      className="min-h-[340px]"
    >
      <div className="grid gap-3 rounded-md border bg-background p-3">
        <div className="flex flex-wrap justify-end gap-3 text-xs">
          {series.map((item, index) => (
            <div key={item.key} className="flex items-center gap-1.5">
              <span
                className="size-2.5 rounded-full"
                style={{
                  backgroundColor:
                    item.color ??
                    statisticsChartColors[index % statisticsChartColors.length],
                }}
              />
              <span>{item.label}</span>
            </div>
          ))}
        </div>
        <svg
          aria-label={`${title}. 결측 구간은 선을 연결하지 않습니다.`}
          className="h-[260px] w-full"
          preserveAspectRatio="none"
          role="img"
          viewBox={`0 0 ${width} ${height}`}
        >
          <line
            stroke="hsl(var(--border))"
            strokeWidth="1"
            x1={padding}
            x2={width - padding}
            y1={height - padding}
            y2={height - padding}
          />
          <line
            stroke="hsl(var(--border))"
            strokeWidth="1"
            x1={padding}
            x2={padding}
            y1={padding}
            y2={height - padding}
          />
          {series.map((item, seriesIndex) => {
            const color =
              item.color ??
              statisticsChartColors[
                seriesIndex % statisticsChartColors.length
              ];
            const positioned = item.points.map(position);
            const segments = splitContinuousSegments(positioned);

            return (
              <g key={item.key}>
                {segments.map((segment, segmentIndex) =>
                  segment.length > 1 ? (
                    <polyline
                      key={`${item.key}-${segmentIndex}`}
                      fill="none"
                      points={segment
                        .map((point) => `${point.x},${point.y}`)
                        .join(" ")}
                      stroke={color}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="3"
                    />
                  ) : null
                )}
                {positioned.map((point, pointIndex) =>
                  point ? (
                    <g key={`${item.key}-${point.label}-${pointIndex}`}>
                      {showPointMarkers ? (
                        <circle
                          cx={point.x}
                          cy={point.y}
                          fill={color}
                          r="4"
                        />
                      ) : null}
                      <title>
                        {item.label} {point.label}:{" "}
                        {valueFormatter(point.value)}
                      </title>
                    </g>
                  ) : null
                )}
              </g>
            );
          })}
          {labels.map((label, index) => {
            if (!visibleLabelIndexes.has(index)) {
              return null;
            }

            const x =
              labels.length <= 1
                ? width / 2
                : padding +
                  (index * (width - padding * 2)) / (labels.length - 1);

            return (
              <text
                key={`${label}-${index}`}
                fill="hsl(var(--muted-foreground))"
                fontSize="11"
                textAnchor="middle"
                x={x}
                y={height - 10}
              >
                {label}
              </text>
            );
          })}
        </svg>
      </div>
    </Section>
  );
}

export function ColumnChart({
  title,
  groups,
  total,
}: {
  title: string;
  groups: StatisticsGroup[];
  total: number;
}) {
  const visibleGroups = groups.filter((group) => group.count > 0);
  const maxValue = Math.max(1, ...visibleGroups.map((group) => group.count));

  return (
    <Section title={title} className="min-h-[300px]">
      {visibleGroups.length === 0 || total <= 0 ? (
        <EmptyDataState />
      ) : (
        <div className="grid gap-3 rounded-md border bg-background p-3">
          <div className="flex h-40 items-end gap-2 border-b pb-2">
            {visibleGroups.map((group, index) => (
              <div
                key={group.label}
                className="flex min-w-0 flex-1 flex-col items-center gap-2"
              >
                <div className="text-xs font-semibold tabular-nums">
                  {formatNumber(group.count)}
                </div>
                <div
                  className="w-full rounded-t"
                  style={{
                    backgroundColor:
                      statisticsChartColors[
                        index % statisticsChartColors.length
                      ],
                    height: `${Math.max(
                      8,
                      (group.count / maxValue) * 112
                    )}px`,
                  }}
                />
              </div>
            ))}
          </div>
          <div
            className="grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${visibleGroups.length}, minmax(0, 1fr))`,
            }}
          >
            {visibleGroups.map((group) => (
              <div key={group.label} className="min-w-0 text-center">
                <div className="truncate text-xs font-medium">
                  {group.label}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {groupPercent(group.count, total)}%
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

export function DonutChart({
  title,
  groups,
  total,
}: {
  title: string;
  groups: StatisticsGroup[];
  total: number;
}) {
  let cursor = 0;
  const gradient = groups.length
    ? `conic-gradient(${groups
        .map((group, index) => {
          const start = cursor;
          const end = cursor + groupPercent(group.count, total);
          cursor = end;

          return `${
            statisticsChartColors[index % statisticsChartColors.length]
          } ${start}% ${end}%`;
        })
        .join(", ")})`
    : "hsl(var(--secondary))";

  return (
    <Section title={title} className="min-h-[300px]">
      {groups.length === 0 ? (
        <EmptyDataState />
      ) : (
        <div className="grid gap-4 rounded-md border bg-background p-4 md:grid-cols-[160px_1fr]">
          <div
            className="relative mx-auto size-36 rounded-full"
            style={{ background: gradient }}
          >
            <div className="absolute inset-7 grid place-items-center rounded-full bg-background text-center">
              <div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatNumber(total)}
                </div>
                <div className="text-[11px] text-muted-foreground">건</div>
              </div>
            </div>
          </div>
          <div className="grid content-center gap-2">
            {groups.slice(0, 7).map((group, index) => (
              <div
                key={group.label}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        statisticsChartColors[
                          index % statisticsChartColors.length
                        ],
                    }}
                  />
                  <span className="truncate">{group.label}</span>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatNumber(group.count)} /{" "}
                  {groupPercent(group.count, total)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}
