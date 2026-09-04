ALTER TABLE "user_preferences"
ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'ko';

ALTER TABLE "user_preferences"
ADD CONSTRAINT "ck_user_preferences_locale"
CHECK ("locale" IN ('ko', 'en'));
