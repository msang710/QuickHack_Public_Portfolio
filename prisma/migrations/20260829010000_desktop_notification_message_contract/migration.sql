ALTER TABLE "desktop_notification_events"
  ADD COLUMN "message_key" TEXT,
  ADD COLUMN "message_arguments" JSONB;
