import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const service = source("quickhack_server/admin/admin-log-query-service.ts");
const api = source("quickhack_server/api/admin/server-logs.ts");
const view = source("quickhack_client/components/admin/server-job-log-view.tsx");
const {
  SERVER_FIELD_SEARCH_LABELS,
  SERVER_JOB_SEARCH_LABELS,
  searchAliasCodes,
} = await import("@/quickhack_shared/admin/admin-log-search-aliases");

assert.ok(searchAliasCodes("쿠팡 주문", SERVER_JOB_SEARCH_LABELS).includes("COUPANG_ORDER_SYNC"));
assert.deepEqual(searchAliasCodes("Trace ID", SERVER_FIELD_SEARCH_LABELS), ["trace_id"]);

assert.match(service, /SERVER_CURSOR_CONTRACT = "admin-server-job-logs:v1"/);
assert.match(service, /orderBy:\s*\[\{ started_at: "desc" \}, \{ id: "desc" \}\]/);
assert.match(service, /cursorWhere\("started_at", decoded\.position\)/);
assert.match(service, /fields:\s*\{ some:\s*\{ field_name:/);
assert.match(service, /SERVER_FIELD_SEARCH_LABELS/);
const serverWhere = service.slice(service.indexOf("function serverBaseWhere"), service.indexOf("function cursorWhere"));
assert.doesNotMatch(serverWhere, /field_value/);
assert.match(serverWhere, /summary_text/);
assert.match(service, /serverSummary\(tx, snapshotWhere\)/);
assert.match(service, /serverJobLogsCsvStream/);
assert.match(api, /canAccessRole\(user\.role, "LEADER"\)/);
assert.match(api, /responseMode:[\s\S]*?"stream"/);
assert.match(view, /URLSearchParams\(\{ limit: "100" \}\)/);
assert.match(view, /setSummary\(payload\.summary/);
assert.match(view, /append: true, cursor: nextCursor/);
assert.match(view, /requestRef\.current\?\.abort\(\)/);
assert.match(view, /rows=\{logs\}/);
assert.doesNotMatch(view, /downloadCsv\(filteredLogs\)/);

console.log("CR-46 server-owned job-log query, summary, paging, export, and UI contract verified.");
