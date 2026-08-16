export type StatisticsMetricPresentation = {
  value: string;
  detail: string;
};

export type StatisticsRateMetricLike = {
  value: number | null;
  numerator: number;
  denominator: number;
  unavailableReason?: string;
};

export type StatisticsAmountMetricLike = {
  amount: number | null;
  pricedCount: number;
  totalCount: number;
  coveragePercent: number;
};

export type StatisticsDurationMetricLike = {
  sampleCount: number;
  medianHours: number | null;
  p90Hours: number | null;
  excludedAnomalyCount: number;
};

const percentFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 1,
});

const numberFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 0,
});

const currencyFormatter = new Intl.NumberFormat("ko-KR", {
  currency: "KRW",
  maximumFractionDigits: 0,
  style: "currency",
});

const kstDateTimeFormatter = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Seoul",
});

export function formatStatisticsCount(value: number) {
  return numberFormatter.format(value);
}

export function formatStatisticsPercent(value: number) {
  return percentFormatter.format(value);
}

export function formatStatisticsCurrency(value: number) {
  return currencyFormatter.format(value);
}

export function formatStatisticsRate(
  metric: StatisticsRateMetricLike,
  options: { unavailableValue?: string } = {}
): StatisticsMetricPresentation {
  if (metric.value === null) {
    return {
      value: options.unavailableValue ?? "-",
      detail:
        metric.unavailableReason ??
        `표본 ${formatStatisticsCount(metric.denominator)}건`,
    };
  }

  return {
    value: `${formatStatisticsPercent(metric.value)}%`,
    detail: `${formatStatisticsCount(
      metric.numerator
    )} / ${formatStatisticsCount(metric.denominator)}건`,
  };
}

export function formatStatisticsAmount(
  metric: StatisticsAmountMetricLike
): StatisticsMetricPresentation {
  if (metric.amount === null || metric.pricedCount === 0) {
    return {
      value: "-",
      detail: `가격 확인 ${formatStatisticsCount(
        metric.pricedCount
      )} / ${formatStatisticsCount(metric.totalCount)}건`,
    };
  }

  return {
    value: formatStatisticsCurrency(metric.amount),
    detail: `가격 확인 ${formatStatisticsCount(
      metric.pricedCount
    )} / ${formatStatisticsCount(
      metric.totalCount
    )}건 · ${formatStatisticsPercent(metric.coveragePercent)}%`,
  };
}

export function formatStatisticsDuration(
  metric: StatisticsDurationMetricLike
): StatisticsMetricPresentation {
  if (metric.sampleCount === 0 || metric.medianHours === null) {
    return {
      value: "-",
      detail:
        metric.excludedAnomalyCount > 0
          ? `표본 없음 · 이상치 ${formatStatisticsCount(
              metric.excludedAnomalyCount
            )}건 제외`
          : "표본 없음",
    };
  }

  const p90 =
    metric.p90Hours === null
      ? "P90 -"
      : `P90 ${formatStatisticsPercent(metric.p90Hours)}시간`;
  const anomaly =
    metric.excludedAnomalyCount > 0
      ? ` · 이상치 ${formatStatisticsCount(
          metric.excludedAnomalyCount
        )}건 제외`
      : "";

  return {
    value: `${formatStatisticsPercent(metric.medianHours)}시간`,
    detail: `${p90} · 표본 ${formatStatisticsCount(
      metric.sampleCount
    )}건${anomaly}`,
  };
}

export function formatStatisticsDate(value: string | null) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return kstDateTimeFormatter.format(date);
}

export function formatStatisticsMonth(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) {
    return value;
  }

  return `${match[1]}년 ${Number(match[2])}월`;
}
