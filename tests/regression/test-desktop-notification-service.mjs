import assert from "node:assert/strict";
import { publishDesktopNotification, markDesktopNotificationsRead, listDesktopNotifications } from "../../quickhack_server/notifications/desktop-notification-service.ts";
let userWhere;
let created = [];
const tx = {
  desktop_notification_events: { upsert: async ({ where }) => { assert.equal(where.dedupe_key, "RETURN_REQUEST:R-1"); return { notification_event_id: 9n }; } },
  users: { findMany: async ({ where }) => { userWhere = where; return [{ user_id: 2 }, { user_id: 3 }]; } },
  desktop_notification_recipients: {
    createMany: async ({ data, skipDuplicates }) => { assert.equal(skipDuplicates, true); created = data; return { count: data.length }; },
    count: async ({ where }) => where.user_id === 2 ? 2 : 0,
    updateMany: async () => ({ count: 2 }),
    findMany: async () => [1n, 2n].map((id, index) => ({ notification_recipient_id: id, read_at: null, event: { event_kind: "INSPECTION_COMPLETE", menu_id: "inbound-upload-pending", title: "검수", body: "완료", occurred_at: new Date(1_000 + index * 1_000), resolved_at: new Date(2_000) } })),
  },
  $transaction: async (callback) => callback(tx),
};
await publishDesktopNotification(tx, { kind: "RETURN_REQUEST", sourceType: "COUPANG_RETURN_RAW", sourceId: "1", dedupeKey: "RETURN_REQUEST:R-1", menuId: "return-after-shipment", title: "반품", body: "접수" });
assert.equal(userWhere.is_active, 1);
assert.deepEqual(userWhere.role.in, ["STAFF", "MANAGER", "LEADER"]);
assert.equal(userWhere.user_preferences.is.return_notification_enabled, 1);
assert.equal(userWhere.user_preferences.is.windows_notifications_enabled, 1);
assert.deepEqual(created.map((row) => row.user_id), [2, 3]);
assert.equal(await markDesktopNotificationsRead(tx, 2, [10n, 11n]), true);
assert.equal(await markDesktopNotificationsRead(tx, 3, [10n, 11n]), false);
const listed = await listDesktopNotifications(tx, 2, { limit: 10 });
assert.equal(listed.presentations.length, 1);
assert.equal(listed.presentations[0].count, 2);
assert.deepEqual(listed.presentations[0].recipientIds, ["1", "2"]);
console.log("Desktop notification recipient and exact-read contracts verified.");
