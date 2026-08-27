CREATE TABLE "desktop_notification_events" (
  "notification_event_id" BIGSERIAL PRIMARY KEY,
  "event_kind" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "menu_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "desktop_notification_recipients" (
  "notification_recipient_id" BIGSERIAL PRIMARY KEY,
  "notification_event_id" BIGINT NOT NULL,
  "user_id" INTEGER NOT NULL,
  "delivered_at" TIMESTAMPTZ(3),
  "read_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "desktop_notification_recipients_notification_event_id_fkey"
    FOREIGN KEY ("notification_event_id") REFERENCES "desktop_notification_events"("notification_event_id") ON DELETE CASCADE,
  CONSTRAINT "desktop_notification_recipients_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "uq_desktop_notification_events_dedupe_key" ON "desktop_notification_events"("dedupe_key");
CREATE INDEX "idx_desktop_notification_events_time" ON "desktop_notification_events"("occurred_at", "notification_event_id");
CREATE INDEX "idx_desktop_notification_events_source" ON "desktop_notification_events"("source_type", "source_id");
CREATE UNIQUE INDEX "uq_desktop_notification_recipients_event_user" ON "desktop_notification_recipients"("notification_event_id", "user_id");
CREATE INDEX "idx_desktop_notification_recipients_inbox" ON "desktop_notification_recipients"("user_id", "read_at", "notification_recipient_id");
