export const STATISTICS_LOAD_BATCH_SIZE = 400;

export class StatisticsLoaderCursorError extends Error {
  readonly code = "STATISTICS_LOADER_CURSOR_NOT_ADVANCING";

  constructor() {
    super("Statistics loader cursor must advance between pages.");
    this.name = "StatisticsLoaderCursorError";
  }
}

export async function loadStatisticsCursorPages<Row>(input: {
  loadPage: (
    cursor: number | undefined,
    take: number
  ) => Promise<readonly Row[]>;
  getCursor: (row: Row) => number;
  batchSize?: number;
}) {
  const batchSize = input.batchSize ?? STATISTICS_LOAD_BATCH_SIZE;

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new TypeError("batchSize must be a positive integer.");
  }

  const rows: Row[] = [];
  let cursor: number | undefined;

  for (;;) {
    const page = await input.loadPage(cursor, batchSize);

    rows.push(...page);

    if (page.length < batchSize) {
      return rows;
    }

    const nextCursor = input.getCursor(page[page.length - 1]!);

    if (
      !Number.isSafeInteger(nextCursor) ||
      (cursor !== undefined && nextCursor <= cursor)
    ) {
      throw new StatisticsLoaderCursorError();
    }

    cursor = nextCursor;
  }
}
