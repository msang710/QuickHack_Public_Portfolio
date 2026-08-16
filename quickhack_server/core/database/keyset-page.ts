import { createHash, timingSafeEqual } from "node:crypto";
import type {
  KeysetCursorState,
  KeysetCursorValue,
  KeysetPage,
  KeysetPageCoverage,
} from "@/quickhack_shared/core/keyset-page";

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 16_384;
const MAX_VALUE_DEPTH = 8;
const MAX_VALUE_ENTRIES = 128;

type CursorEnvelope = KeysetCursorState & { checksum: string };

export class KeysetCursorError extends Error {
  readonly code = "KEYSET_CURSOR_INVALID";

  constructor() {
    super("The keyset cursor is invalid or belongs to a different query.");
    this.name = "KeysetCursorError";
  }
}

function requiredContract(value: string) {
  const contract = value.trim();
  if (!contract || contract.length > 120) {
    throw new Error("A bounded keyset cursor contract is required.");
  }
  return contract;
}

function stableJson(value: unknown, ancestors = new Set<object>()): string {
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new TypeError("Keyset query identity must contain JSON-compatible values.");
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Keyset query identity cannot contain a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (ancestors.has(value)) {
    throw new TypeError("Keyset query identity cannot contain a cycle.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new TypeError("Keyset query identity must contain plain objects.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableJson(item, ancestors)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function equalDigest(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function assertCursorValue(value: unknown, depth = 0): asserts value is KeysetCursorValue {
  if (depth > MAX_VALUE_DEPTH) throw new KeysetCursorError();
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new KeysetCursorError();
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_VALUE_ENTRIES) throw new KeysetCursorError();
    for (const child of value) assertCursorValue(child, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") throw new KeysetCursorError();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_VALUE_ENTRIES) throw new KeysetCursorError();
  for (const [key, child] of entries) {
    if (!key || key.length > 120) throw new KeysetCursorError();
    assertCursorValue(child, depth + 1);
  }
}

export function keysetQueryFingerprint(queryIdentity: unknown) {
  return sha256(stableJson(queryIdentity));
}

export function prepareKeysetQuery<TPredicate>(input: {
  queryIdentity: unknown;
  buildPredicate: () => TPredicate;
}) {
  const queryFingerprint = keysetQueryFingerprint(input.queryIdentity);
  const predicate = input.buildPredicate();
  return {
    predicate,
    queryFingerprint,
  } as const;
}

export function encodeKeysetCursor<
  TSnapshot extends KeysetCursorValue,
  TPosition extends KeysetCursorValue,
>(input: {
  contract: string;
  queryIdentity: unknown;
  snapshot: TSnapshot;
  position: TPosition;
}) {
  assertCursorValue(input.snapshot);
  assertCursorValue(input.position);
  const payload: KeysetCursorState<TSnapshot, TPosition> = {
    version: CURSOR_VERSION,
    contract: requiredContract(input.contract),
    queryFingerprint: keysetQueryFingerprint(input.queryIdentity),
    snapshot: input.snapshot,
    position: input.position,
  };
  const envelope: CursorEnvelope = {
    ...payload,
    checksum: sha256(stableJson(payload)),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function decodeKeysetCursor<
  TSnapshot extends KeysetCursorValue,
  TPosition extends KeysetCursorValue,
>(input: {
  cursor: string;
  contract: string;
  queryIdentity: unknown;
}): KeysetCursorState<TSnapshot, TPosition> {
  const cursor = input.cursor.trim();
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH) throw new KeysetCursorError();

  try {
    const envelope = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    ) as Partial<CursorEnvelope>;
    if (
      envelope.version !== CURSOR_VERSION ||
      envelope.contract !== requiredContract(input.contract) ||
      envelope.queryFingerprint !== keysetQueryFingerprint(input.queryIdentity) ||
      typeof envelope.checksum !== "string"
    ) {
      throw new KeysetCursorError();
    }
    assertCursorValue(envelope.snapshot);
    assertCursorValue(envelope.position);
    const payload: KeysetCursorState = {
      version: CURSOR_VERSION,
      contract: envelope.contract,
      queryFingerprint: envelope.queryFingerprint,
      snapshot: envelope.snapshot,
      position: envelope.position,
    };
    if (!equalDigest(envelope.checksum, sha256(stableJson(payload)))) {
      throw new KeysetCursorError();
    }
    return payload as KeysetCursorState<TSnapshot, TPosition>;
  } catch (error) {
    if (error instanceof KeysetCursorError) throw error;
    throw new KeysetCursorError();
  }
}

export function normalizeKeysetLimit(
  value: unknown,
  input: { defaultLimit: number; maxLimit: number }
) {
  if (
    !Number.isSafeInteger(input.defaultLimit) ||
    !Number.isSafeInteger(input.maxLimit) ||
    input.defaultLimit <= 0 ||
    input.maxLimit <= 0 ||
    input.defaultLimit > input.maxLimit
  ) {
    throw new Error("Keyset limit defaults must define a positive bounded range.");
  }
  const parsed = Number(value ?? input.defaultLimit);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return input.defaultLimit;
  return Math.min(parsed, input.maxLimit);
}

export function createKeysetPage<T>(input: {
  rows: readonly T[];
  limit: number;
  coverage: KeysetPageCoverage;
  totalCount?: number;
  cursorFor: (last: T) => string;
}): KeysetPage<T> {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new Error("A positive keyset page limit is required.");
  }
  if (
    input.totalCount !== undefined &&
    (!Number.isSafeInteger(input.totalCount) || input.totalCount < 0)
  ) {
    throw new Error("Keyset page totalCount must be a non-negative safe integer.");
  }
  const hasMore = input.rows.length > input.limit;
  const items = input.rows.slice(0, input.limit);
  const last = items.at(-1) ?? null;
  return {
    items: [...items],
    hasMore,
    nextCursor: hasMore && last ? input.cursorFor(last) : null,
    coverage: input.coverage,
    ...(input.totalCount === undefined ? {} : { totalCount: input.totalCount }),
  };
}
