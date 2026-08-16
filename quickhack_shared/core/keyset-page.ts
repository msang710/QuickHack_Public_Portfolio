export type KeysetPageCoverage = "COMPLETE" | "FILTERED";

export type KeysetPage<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount?: number;
  coverage: KeysetPageCoverage;
};

export type KeysetCursorScalar = string | number | boolean | null;
export type KeysetCursorValue =
  | KeysetCursorScalar
  | KeysetCursorValue[]
  | { [key: string]: KeysetCursorValue };

export type KeysetCursorState<
  TSnapshot extends KeysetCursorValue = KeysetCursorValue,
  TPosition extends KeysetCursorValue = KeysetCursorValue,
> = {
  version: 1;
  contract: string;
  queryFingerprint: string;
  snapshot: TSnapshot;
  position: TPosition;
};
