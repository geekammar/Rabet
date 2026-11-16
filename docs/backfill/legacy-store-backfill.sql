-- ===========================================================================
-- S1.2 legacy-store backfill plan.
--
-- NOT EXECUTED BY THE REPOSITORY. This file is an operational artifact for a
-- separately approved change window after migration 0006 has been applied.
-- Run it inside one explicit transaction, against the legacy single-store
-- database only, and keep the verification queries in
-- `legacy-store-verification.sql` alongside the change record.
--
-- Properties:
--   * The legacy store is identified by the fixed slug `legacy-store`, so a
--     retry reuses the same row and never creates a second store.
--   * Only `store_id` is written. Category/product relationships, translations,
--     inquiry and customer identity, notification delivery states, Telegram
--     update ids and demo activation flags are untouched.
--   * Every write is guarded by `store_id IS NULL`, so the plan is idempotent.
--   * No Telegram API, HTTP call or notification is invoked.
--   * Nothing is seeded until this file is deliberately run by an operator.
-- ===========================================================================

INSERT INTO "store" ("name", "slug", "status")
VALUES ('Rabet Legacy Store', 'legacy-store', 'active')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint

DO $$
DECLARE
  legacy_store_id uuid;
BEGIN
  SELECT "id" INTO legacy_store_id
    FROM "store"
    WHERE "slug" = 'legacy-store';

  IF legacy_store_id IS NULL THEN
    RAISE EXCEPTION 'Legacy store was not created or found.';
  END IF;

  IF EXISTS (SELECT 1 FROM "store" WHERE "id" <> legacy_store_id) THEN
    RAISE EXCEPTION
      'Backfill requires the legacy single-store database; another store exists.';
  END IF;
END;
$$;
--> statement-breakpoint

UPDATE "category" AS target
SET "store_id" = legacy."id"
FROM "store" AS legacy
WHERE legacy."slug" = 'legacy-store' AND target."store_id" IS NULL;
--> statement-breakpoint

UPDATE "product" AS target
SET "store_id" = legacy."id"
FROM "store" AS legacy
WHERE legacy."slug" = 'legacy-store' AND target."store_id" IS NULL;
--> statement-breakpoint

UPDATE "payment_method" AS target
SET "store_id" = legacy."id"
FROM "store" AS legacy
WHERE legacy."slug" = 'legacy-store' AND target."store_id" IS NULL;
--> statement-breakpoint

UPDATE "message_template" AS target
SET "store_id" = legacy."id"
FROM "store" AS legacy
WHERE legacy."slug" = 'legacy-store' AND target."store_id" IS NULL;
--> statement-breakpoint

UPDATE "customer" AS target
SET "store_id" = legacy."id"
FROM "store" AS legacy
WHERE legacy."slug" = 'legacy-store' AND target."store_id" IS NULL;
--> statement-breakpoint

UPDATE "seller_notification_setting" AS target
SET "store_id" = legacy."id"
FROM "store" AS legacy
WHERE legacy."slug" = 'legacy-store' AND target."store_id" IS NULL;
--> statement-breakpoint

UPDATE "bot_setting" AS target
SET "store_id" = legacy."id"
FROM "store" AS legacy
WHERE legacy."slug" = 'legacy-store' AND target."store_id" IS NULL;
--> statement-breakpoint

UPDATE "telegram_update" AS target
SET "store_id" = legacy."id"
FROM "store" AS legacy
WHERE legacy."slug" = 'legacy-store' AND target."store_id" IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "bot_setting" WHERE "store_id" IS NULL
    UNION ALL
    SELECT 1 FROM "category" WHERE "store_id" IS NULL
    UNION ALL
    SELECT 1 FROM "product" WHERE "store_id" IS NULL
    UNION ALL
    SELECT 1 FROM "payment_method" WHERE "store_id" IS NULL
    UNION ALL
    SELECT 1 FROM "message_template" WHERE "store_id" IS NULL
    UNION ALL
    SELECT 1 FROM "customer" WHERE "store_id" IS NULL
    UNION ALL
    SELECT 1 FROM "seller_notification_setting" WHERE "store_id" IS NULL
    UNION ALL
    SELECT 1 FROM "telegram_update" WHERE "store_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Backfill left at least one legacy row without store_id.';
  END IF;
END;
$$;
