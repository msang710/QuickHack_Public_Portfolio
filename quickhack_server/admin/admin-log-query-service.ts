import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  ADMIN_LOG_DEFAULT_LIMIT,
  ADMIN_LOG_MAX_LIMIT,
  type ActivityLogDto,
  type ActivityLogSummary,
  type AdminLogPageResponse,
  type ServerJobLogDto,
  type ServerJobLogSummary,
} from "@/quickhack_shared/admin/admin-log-contract";
import { serializeCsvRow } from "@/quickhack_shared/core/csv";
import {
  ACTIVITY_ACTION_SEARCH_LABELS,
  ACTIVITY_RESULT_SEARCH_LABELS,
  ACTIVITY_TARGET_SEARCH_LABELS,
  SERVER_FIELD_SEARCH_LABELS,
  SERVER_JOB_SEARCH_LABELS,
  SERVER_STATUS_SEARCH_LABELS,
  searchAliasCodes,
} from "@/quickhack_shared/admin/admin-log-search-aliases";
import {
  createKeysetPage,
  decodeKeysetCursor,
  encodeKeysetCursor,
  normalizeKeysetLimit,
} from "@/quickhack_server/core/database/keyset-page";
import {
  apiDateTime,
  requiredApiDateTime,
} from "@/quickhack_server/core/database/time-boundary";

const ACTIVITY_CURSOR_CONTRACT = "admin-activity-logs:v1";
const SERVER_CURSOR_CONTRACT = "admin-server-job-logs:v1";
const FAILURE_VALUES = ["FAIL", "FAILED", "ERROR"];
const RUNNING_VALUES = ["RUNNING", "PENDING"];

type AdminLogInput = {
  query: string;
  actor: string;
  from: string | null;
  to: string | null;
  limit: number;
  cursor: string | null;
};

export type ActivityLogQueryInput = AdminLogInput & {
  actionType: string;
  result: string;
  targetType: string;
};

export type ServerJobLogQueryInput = AdminLogInput & {
  jobType: string;
  status: string;
};

type CursorSnapshot = { maxId: number };
type CursorPosition = { timestamp: string; id: number };

function normalizedText(value: string | null) {
  return (value ?? "").trim().slice(0, 200);
}

function parsedDate(value: string | null, endOfDay: boolean) {
  const text = normalizedText(value);
  if (!text) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+09:00`)
    : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateSearchRange(query: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query)) return null;
  const from = new Date(`${query}T00:00:00.000+09:00`);
  const to = new Date(`${query}T23:59:59.999+09:00`);
  return { gte: from, lte: to };
}

function commonInput(searchParams: URLSearchParams): AdminLogInput {
  return {
    query: normalizedText(searchParams.get("query")),
    actor: normalizedText(searchParams.get("actor")),
    from: parsedDate(searchParams.get("from"), false)?.toISOString() ?? null,
    to: parsedDate(searchParams.get("to"), true)?.toISOString() ?? null,
    limit: normalizeKeysetLimit(searchParams.get("limit"), {
      defaultLimit: ADMIN_LOG_DEFAULT_LIMIT,
      maxLimit: ADMIN_LOG_MAX_LIMIT,
    }),
    cursor: (searchParams.get("cursor") ?? "").trim() || null,
  };
}

export function parseActivityLogQuery(searchParams: URLSearchParams): ActivityLogQueryInput {
  return {
    ...commonInput(searchParams),
    actionType: normalizedText(searchParams.get("actionType")),
    result: normalizedText(searchParams.get("result")),
    targetType: normalizedText(searchParams.get("targetType")),
  };
}

export function parseServerJobLogQuery(searchParams: URLSearchParams): ServerJobLogQueryInput {
  return {
    ...commonInput(searchParams),
    jobType: normalizedText(searchParams.get("jobType")),
    status: normalizedText(searchParams.get("status")),
  };
}

function activityIdentity(input: ActivityLogQueryInput) {
  return {
    query: input.query,
    actor: input.actor,
    from: input.from,
    to: input.to,
    actionType: input.actionType,
    result: input.result,
    targetType: input.targetType,
  };
}

function serverIdentity(input: ServerJobLogQueryInput) {
  return {
    query: input.query,
    actor: input.actor,
    from: input.from,
    to: input.to,
    jobType: input.jobType,
    status: input.status,
  };
}

function activityBaseWhere(input: ActivityLogQueryInput): Prisma.employee_activity_logsWhereInput {
  const queryDate = dateSearchRange(input.query);
  const contains = (value: string) => ({ contains: value, mode: "insensitive" as const });
  const and: Prisma.employee_activity_logsWhereInput[] = [];
  if (input.actionType) and.push({ action_type: input.actionType });
  if (input.result) and.push({ result: input.result });
  if (input.targetType) and.push({ target_type: input.targetType });
  if (input.from || input.to) {
    and.push({
      created_at: {
        ...(input.from ? { gte: new Date(input.from) } : {}),
        ...(input.to ? { lte: new Date(input.to) } : {}),
      },
    });
  }
  if (input.actor) {
    and.push({
      users: {
        is: {
          OR: [
            { username: contains(input.actor) },
            { employee_profiles: { is: { display_name: contains(input.actor) } } },
          ],
        },
      },
    });
  }
  if (input.query) {
    const actionAliases = searchAliasCodes(input.query, ACTIVITY_ACTION_SEARCH_LABELS);
    const targetAliases = searchAliasCodes(input.query, ACTIVITY_TARGET_SEARCH_LABELS);
    const resultAliases = searchAliasCodes(input.query, ACTIVITY_RESULT_SEARCH_LABELS);
    and.push({
      OR: [
        { action_type: contains(input.query) },
        { target_type: contains(input.query) },
        { target_id: contains(input.query) },
        { result: contains(input.query) },
        { users: { is: { username: contains(input.query) } } },
        { users: { is: { employee_profiles: { is: { display_name: contains(input.query) } } } } },
        { changes: { some: { field_name: contains(input.query) } } },
        ...(actionAliases.length ? [{ action_type: { in: actionAliases } }] : []),
        ...(targetAliases.length ? [{ target_type: { in: targetAliases } }] : []),
        ...(resultAliases.length ? [{ result: { in: resultAliases } }] : []),
        ...(queryDate ? [{ created_at: queryDate }] : []),
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
}

function serverBaseWhere(input: ServerJobLogQueryInput): Prisma.server_job_logsWhereInput {
  const queryDate = dateSearchRange(input.query);
  const contains = (value: string) => ({ contains: value, mode: "insensitive" as const });
  const and: Prisma.server_job_logsWhereInput[] = [];
  if (input.jobType) and.push({ job_type: input.jobType });
  if (input.status) and.push({ status: input.status });
  if (input.from || input.to) {
    and.push({
      started_at: {
        ...(input.from ? { gte: new Date(input.from) } : {}),
        ...(input.to ? { lte: new Date(input.to) } : {}),
      },
    });
  }
  if (input.actor) {
    and.push({
      users: {
        is: {
          OR: [
            { username: contains(input.actor) },
            { employee_profiles: { is: { display_name: contains(input.actor) } } },
          ],
        },
      },
    });
  }
  if (input.query) {
    const jobAliases = searchAliasCodes(input.query, SERVER_JOB_SEARCH_LABELS);
    const statusAliases = searchAliasCodes(input.query, SERVER_STATUS_SEARCH_LABELS);
    const fieldAliases = searchAliasCodes(input.query, SERVER_FIELD_SEARCH_LABELS);
    and.push({
      OR: [
        { job_type: contains(input.query) },
        { job_name: contains(input.query) },
        { status: contains(input.query) },
        { error_code: contains(input.query) },
        { error_message: contains(input.query) },
        { summary_text: contains(input.query) },
        { users: { is: { username: contains(input.query) } } },
        { users: { is: { employee_profiles: { is: { display_name: contains(input.query) } } } } },
        { fields: { some: { field_name: contains(input.query) } } },
        ...(jobAliases.length ? [{ job_type: { in: jobAliases } }] : []),
        ...(statusAliases.length ? [{ status: { in: statusAliases } }] : []),
        ...(fieldAliases.length
          ? [{ fields: { some: { field_name: { in: fieldAliases } } } }]
          : []),
        ...(queryDate ? [{ started_at: queryDate }] : []),
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
}

function cursorWhere(timestampField: "created_at" | "started_at", position: CursorPosition) {
  return {
    OR: [
      { [timestampField]: { lt: new Date(position.timestamp) } },
      { [timestampField]: new Date(position.timestamp), id: { lt: position.id } },
    ],
  };
}

const userInclude = {
  select: {
    username: true,
    employee_profiles: { select: { display_name: true } },
  },
} as const;

type ActivityQueryRow = {
  id: number;
  user_id: number | null;
  action_type: string;
  target_type: string;
  target_id: string | null;
  before_summary_text: string | null;
  after_summary_text: string | null;
  result: string;
  created_at: Date;
  users: {
    username: string;
    employee_profiles: { display_name: string } | null;
  } | null;
  changes: Array<{
    field_name: string;
    before_value: string | null;
    after_value: string | null;
  }>;
};

type ServerJobQueryRow = {
  id: number;
  job_type: string;
  job_name: string | null;
  status: string;
  triggered_by_user_id: number | null;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  summary_text: string | null;
  summary_processed_count: number | null;
  summary_succeeded_count: number | null;
  summary_failed_count: number | null;
  summary_skipped_count: number | null;
  summary_created_count: number | null;
  summary_updated_count: number | null;
  summary_warning_count: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  users: {
    username: string;
    employee_profiles: { display_name: string } | null;
  } | null;
  fields: Array<{ field_name: string; field_value: string | null }>;
};

function activityDto(row: ActivityQueryRow): ActivityLogDto {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.users?.username ?? "",
    displayName: row.users?.employee_profiles?.display_name ?? row.users?.username ?? "",
    actionType: row.action_type,
    targetType: row.target_type,
    targetId: row.target_id ?? "",
    beforeSummaryText: row.before_summary_text ?? "",
    afterSummaryText: row.after_summary_text ?? "",
    changes: row.changes.map((change) => ({
      fieldName: change.field_name,
      beforeValue: change.before_value ?? "",
      afterValue: change.after_value ?? "",
    })),
    result: row.result,
    createdAt: requiredApiDateTime(row.created_at),
  };
}

function serverDto(row: ServerJobQueryRow): ServerJobLogDto {
  return {
    id: row.id,
    jobType: row.job_type,
    jobName: row.job_name ?? "",
    status: row.status,
    triggeredByUserId: row.triggered_by_user_id,
    username: row.users?.username ?? "",
    displayName: row.users?.employee_profiles?.display_name ?? row.users?.username ?? "",
    startedAt: requiredApiDateTime(row.started_at),
    finishedAt: apiDateTime(row.finished_at) ?? "",
    durationMs: row.duration_ms,
    summaryText: row.summary_text ?? "",
    summaryProcessedCount: row.summary_processed_count,
    summarySucceededCount: row.summary_succeeded_count,
    summaryFailedCount: row.summary_failed_count,
    summarySkippedCount: row.summary_skipped_count,
    summaryCreatedCount: row.summary_created_count,
    summaryUpdatedCount: row.summary_updated_count,
    summaryWarningCount: row.summary_warning_count,
    errorCode: row.error_code ?? "",
    errorMessage: row.error_message ?? "",
    fields: row.fields.map((field) => ({
      fieldName: field.field_name,
      fieldValue: field.field_value ?? "",
    })),
    createdAt: requiredApiDateTime(row.created_at),
  };
}

async function activitySummary(
  tx: Prisma.TransactionClient,
  where: Prisma.employee_activity_logsWhereInput
): Promise<ActivityLogSummary> {
  const [total, success, failure, workers] = await Promise.all([
    tx.employee_activity_logs.count({ where }),
    tx.employee_activity_logs.count({ where: { AND: [where, { result: "SUCCESS" }] } }),
    tx.employee_activity_logs.count({ where: { AND: [where, { result: { in: FAILURE_VALUES } }] } }),
    tx.employee_activity_logs.groupBy({
      by: ["user_id"],
      where: { AND: [where, { user_id: { not: null } }] },
    }),
  ]);
  return {
    total,
    success,
    failure,
    actorCount: workers.length,
    workers: workers.length,
  };
}

async function serverSummary(
  tx: Prisma.TransactionClient,
  where: Prisma.server_job_logsWhereInput
): Promise<ServerJobLogSummary> {
  const [total, running, success, failure] = await Promise.all([
    tx.server_job_logs.count({ where }),
    tx.server_job_logs.count({ where: { AND: [where, { status: { in: RUNNING_VALUES } }] } }),
    tx.server_job_logs.count({ where: { AND: [where, { status: "SUCCESS" }] } }),
    tx.server_job_logs.count({ where: { AND: [where, { status: { in: FAILURE_VALUES } }] } }),
  ]);
  return { total, running, success, failure };
}

export async function listActivityLogPage(
  client: PrismaClient,
  input: ActivityLogQueryInput,
  options: { includeSummary?: boolean } = {}
): Promise<AdminLogPageResponse<ActivityLogDto, ActivityLogSummary>> {
  const identity = activityIdentity(input);
  const decoded = input.cursor
    ? decodeKeysetCursor<CursorSnapshot, CursorPosition>({
        cursor: input.cursor,
        contract: ACTIVITY_CURSOR_CONTRACT,
        queryIdentity: identity,
      })
    : null;

  return client.$transaction(async (tx) => {
    const latest = decoded
      ? null
      : await tx.employee_activity_logs.findFirst({ orderBy: { id: "desc" }, select: { id: true } });
    const snapshot = decoded?.snapshot ?? { maxId: latest?.id ?? 0 };
    const baseWhere = activityBaseWhere(input);
    const snapshotWhere: Prisma.employee_activity_logsWhereInput = {
      AND: [baseWhere, { id: { lte: snapshot.maxId } }],
    };
    const pageWhere: Prisma.employee_activity_logsWhereInput = decoded
      ? { AND: [snapshotWhere, cursorWhere("created_at", decoded.position)] }
      : snapshotWhere;
    const [rows, summary] = await Promise.all([
      tx.employee_activity_logs.findMany({
        where: pageWhere,
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        include: {
          users: userInclude,
          changes: {
            select: { field_name: true, before_value: true, after_value: true },
            orderBy: [{ field_name: "asc" }],
          },
        },
      }),
      options.includeSummary === false
        ? Promise.resolve(null)
        : activitySummary(tx, snapshotWhere),
    ]);
    const visibleRows = rows.slice(0, input.limit);
    const sessionIds = visibleRows
      .filter((row) => row.target_type === "INVENTORY_AUDIT_SESSION")
      .map((row) => Number(row.target_id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    const inventoryChanges = sessionIds.length
      ? await tx.inventory_audit_location_changes.findMany({
          where: { inventory_audit_session_id: { in: sessionIds } },
          orderBy: [
            { inventory_audit_session_id: "asc" },
            { pg_no: "asc" },
          ],
        })
      : [];
    const inventoryBySession = new Map<number, typeof inventoryChanges>();
    for (const change of inventoryChanges) {
      const rowsForSession = inventoryBySession.get(change.inventory_audit_session_id) ?? [];
      rowsForSession.push(change);
      inventoryBySession.set(change.inventory_audit_session_id, rowsForSession);
    }
    for (const row of visibleRows) {
      if (row.target_type !== "INVENTORY_AUDIT_SESSION") continue;
      const details = inventoryBySession.get(Number(row.target_id)) ?? [];
      row.changes.push(
        ...details.map((change) => ({
          field_name: `items.${encodeURIComponent(change.pg_no)}.location`,
          before_value: change.previous_location,
          after_value: change.new_location,
        }))
      );
      row.changes.sort((left, right) => left.field_name.localeCompare(right.field_name));
    }
    const page = createKeysetPage({
      rows,
      limit: input.limit,
      coverage: "FILTERED" as const,
      totalCount: summary?.total,
      cursorFor: (last) =>
        encodeKeysetCursor({
          contract: ACTIVITY_CURSOR_CONTRACT,
          queryIdentity: identity,
          snapshot,
          position: { timestamp: last.created_at.toISOString(), id: last.id },
        }),
    });
    return {
      ok: true,
      ...page,
      totalCount: summary?.total ?? 0,
      items: visibleRows.map(activityDto),
      summary: summary ?? {
        total: 0,
        success: 0,
        failure: 0,
        actorCount: 0,
        workers: 0,
      },
    };
  }, { isolationLevel: "RepeatableRead" });
}

export async function listServerJobLogPage(
  client: PrismaClient,
  input: ServerJobLogQueryInput,
  options: { includeSummary?: boolean } = {}
): Promise<AdminLogPageResponse<ServerJobLogDto, ServerJobLogSummary>> {
  const identity = serverIdentity(input);
  const decoded = input.cursor
    ? decodeKeysetCursor<CursorSnapshot, CursorPosition>({
        cursor: input.cursor,
        contract: SERVER_CURSOR_CONTRACT,
        queryIdentity: identity,
      })
    : null;
  return client.$transaction(async (tx) => {
    const latest = decoded
      ? null
      : await tx.server_job_logs.findFirst({ orderBy: { id: "desc" }, select: { id: true } });
    const snapshot = decoded?.snapshot ?? { maxId: latest?.id ?? 0 };
    const baseWhere = serverBaseWhere(input);
    const snapshotWhere: Prisma.server_job_logsWhereInput = {
      AND: [baseWhere, { id: { lte: snapshot.maxId } }],
    };
    const pageWhere: Prisma.server_job_logsWhereInput = decoded
      ? { AND: [snapshotWhere, cursorWhere("started_at", decoded.position)] }
      : snapshotWhere;
    const [rows, summary] = await Promise.all([
      tx.server_job_logs.findMany({
        where: pageWhere,
        orderBy: [{ started_at: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        include: {
          users: userInclude,
          fields: {
            select: { field_name: true, field_value: true },
            orderBy: [{ field_name: "asc" }],
          },
        },
      }),
      options.includeSummary === false
        ? Promise.resolve(null)
        : serverSummary(tx, snapshotWhere),
    ]);
    const page = createKeysetPage({
      rows,
      limit: input.limit,
      coverage: "FILTERED" as const,
      totalCount: summary?.total,
      cursorFor: (last) =>
        encodeKeysetCursor({
          contract: SERVER_CURSOR_CONTRACT,
          queryIdentity: identity,
          snapshot,
          position: { timestamp: last.started_at.toISOString(), id: last.id },
        }),
    });
    return {
      ok: true,
      ...page,
      totalCount: summary?.total ?? 0,
      items: page.items.map(serverDto),
      summary: summary ?? { total: 0, running: 0, success: 0, failure: 0 },
    };
  }, { isolationLevel: "RepeatableRead" });
}

function csvStream<TInput extends { cursor: string | null; limit: number }, TItem>(input: {
  query: TInput;
  header: readonly unknown[];
  page: (query: TInput) => Promise<{ items: TItem[]; hasMore: boolean; nextCursor: string | null }>;
  row: (item: TItem) => readonly unknown[];
}) {
  const encoder = new TextEncoder();
  let cursor = input.query.cursor;
  let started = false;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      if (!started) {
        controller.enqueue(encoder.encode(`\ufeff${serializeCsvRow(input.header)}\r\n`));
        started = true;
      }
      const page = await input.page({ ...input.query, cursor, limit: ADMIN_LOG_MAX_LIMIT });
      if (page.items.length > 0) {
        controller.enqueue(
          encoder.encode(`${page.items.map((item) => serializeCsvRow(input.row(item))).join("\r\n")}\r\n`)
        );
      }
      cursor = page.nextCursor;
      if (!page.hasMore || !cursor) {
        done = true;
        controller.close();
      }
    },
  });
}

export function activityLogsCsvStream(client: PrismaClient, query: ActivityLogQueryInput) {
  return csvStream({
    query: { ...query, cursor: null },
    header: ["createdAt", "displayName", "username", "actionType", "targetType", "targetId", "result", "beforeSummary", "afterSummary", "changes"],
    page: (input) => listActivityLogPage(client, input, { includeSummary: false }),
    row: (item: ActivityLogDto) => [
      item.createdAt,
      item.displayName,
      item.username,
      item.actionType,
      item.targetType,
      item.targetId,
      item.result,
      item.beforeSummaryText,
      item.afterSummaryText,
      item.changes.map((change) => `${change.fieldName}: ${change.beforeValue} -> ${change.afterValue}`).join(" / "),
    ],
  });
}

export function serverJobLogsCsvStream(client: PrismaClient, query: ServerJobLogQueryInput) {
  return csvStream({
    query: { ...query, cursor: null },
    header: ["startedAt", "finishedAt", "jobType", "jobName", "status", "durationMs", "displayName", "username", "errorCode", "errorMessage", "summary", "fields"],
    page: (input) => listServerJobLogPage(client, input, { includeSummary: false }),
    row: (item: ServerJobLogDto) => [
      item.startedAt,
      item.finishedAt,
      item.jobType,
      item.jobName,
      item.status,
      item.durationMs,
      item.displayName,
      item.username,
      item.errorCode,
      item.errorMessage,
      item.summaryText,
      item.fields.map((field) => `${field.fieldName}=${field.fieldValue}`).join(" / "),
    ],
  });
}
