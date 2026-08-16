import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const service = source("quickhack_server/admin/admin-log-query-service.ts");
const api = source("quickhack_server/api/admin/activity-logs.ts");
const view = source("quickhack_client/components/admin/employee-activity-log-view.tsx");
const proxy = source("quickhack_shared/core/server-proxy.ts");
const {
  ACTIVITY_ACTION_SEARCH_LABELS,
  ACTIVITY_RESULT_SEARCH_LABELS,
  searchAliasCodes,
} = await import("@/quickhack_shared/admin/admin-log-search-aliases");

assert.ok(searchAliasCodes("매입", ACTIVITY_ACTION_SEARCH_LABELS).includes("PURCHASE_CONFIRM"));
assert.deepEqual(
  searchAliasCodes("성공", ACTIVITY_RESULT_SEARCH_LABELS),
  ["SUCCESS"]
);

assert.match(service, /ACTIVITY_CURSOR_CONTRACT = "admin-activity-logs:v1"/);
assert.match(service, /orderBy:\s*\[\{ created_at: "desc" \}, \{ id: "desc" \}\]/);
assert.match(service, /id:\s*\{ lte: snapshot\.maxId \}/);
assert.match(service, /changes:\s*\{ some:\s*\{ field_name:/);
assert.match(service, /ACTIVITY_ACTION_SEARCH_LABELS/);
assert.doesNotMatch(
  service.slice(service.indexOf("function activityBaseWhere"), service.indexOf("function serverBaseWhere")),
  /before_value|after_value|before_summary_text|after_summary_text/
);
assert.match(service, /activitySummary\(tx, snapshotWhere\)/);
assert.match(service, /inventory_audit_location_changes\.findMany/);
assert.match(api, /canAccessRole\(user\.role, "LEADER"\)/);
assert.match(api, /activityLogsCsvStream/);
assert.match(view, /URLSearchParams\(\{ limit: "100" \}\)/);
assert.match(view, /search\.set\("query", requestedQuery\)/);
assert.match(view, /setSummary\(payload\.summary/);
assert.match(view, /append: true, cursor: nextCursor/);
assert.match(view, /requestRef\.current\?\.abort\(\)/);
assert.match(view, /rows=\{logs\}/);
assert.doesNotMatch(view, /downloadCsv\(filteredLogs\)/);
assert.match(proxy, /responseMode\?: "buffer" \| "stream"/);

console.log("CR-43 server-owned activity query, summary, paging, export, and UI contract verified.");
