-- ===========================================================================
-- S1.2 legacy-store backfill plan.
--
-- NOT EXECUTED BY THE REPOSITORY. This is a separately approved operational
-- artifact for a legacy single-store database after migration 0006 is applied.
--
-- Execution contract:
--   * This file is exactly one PostgreSQL DO statement. The whole statement is
--     atomic: every write, the store creation and every validation either
--     commit together or roll back together.
--   * Supported execution:
--       psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f legacy-store-backfill.sql
--     `psql -1` is also safe because the file already runs as one statement.
--   * Do not split this file on semicolons, do not execute selected statements,
--     and do not run it from a migration runner, build, startup hook,
--     deployment or application code.
--   * Any client that executes the complete file as one SQL command is
--     supported. A client that autocommits individual statements or splits the
--     DO body is unsupported and must be rejected.
--
-- Safety properties:
--   * Schema/migration baseline and store identity are verified before writes.
--   * ACCESS EXCLUSIVE locks on every participating table make the backfill a
--     bounded write-blocking window; lock_timeout aborts instead of waiting
--     forever.
--   * Any pre-owned row, unrelated store, unexpected legacy identity, missing
--     schema object or failed postcondition aborts the whole transaction.
--   * The legacy store is reused on retries and is never created twice.
--   * Only store_id is written. Relationships, translations, inquiry/customer
--     identity, notification states, Telegram update identities and activation
--     flags are compared against a pre-write snapshot and must be unchanged.
--   * No Telegram API, HTTP call or notification is invoked.
--   * This is a point-in-time backfill. Legacy application writes that run
--     after commit can still insert NULL store_id until S1.3 enforces trusted
--     StoreContext writes.
-- ===========================================================================

DO $legacy_store_backfill$
DECLARE
  legacy_slug constant text := 'legacy-store';
  legacy_name constant text := 'Rabet Legacy Store';
  legacy_status constant text := 'active';

  direct_tables constant text[] := ARRAY[
    'bot_setting',
    'category',
    'customer',
    'message_template',
    'payment_method',
    'product',
    'seller_notification_setting',
    'telegram_update'
  ];

  touch_trigger_tables constant text[] := ARRAY[
    'bot_setting',
    'category',
    'customer',
    'message_template',
    'payment_method',
    'product',
    'seller_notification_setting'
  ];

  locked_tables constant text[] := ARRAY[
    'app_user',
    'bot_setting',
    'category',
    'category_translation',
    'customer',
    'inquiry',
    'inquiry_message',
    'language',
    'message_template',
    'message_translation',
    'payment_method',
    'payment_method_translation',
    'product',
    'product_action',
    'product_action_translation',
    'product_translation',
    'seller_notification_delivery',
    'seller_notification_setting',
    'store',
    'store_membership',
    'telegram_update'
  ];

  tbl text;
  legacy_store_id uuid;
  existing_name text;
  existing_status text;
  migration_count bigint;
  conflict_count bigint;
  bad_count bigint;
  baseline jsonb;
  postflight jsonb;
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);

  -- 1. Required schema and migration baseline.
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION
      'Backfill refused: required migration ledger drizzle.__drizzle_migrations is missing.';
  END IF;

  EXECUTE 'SELECT count(*) FROM drizzle.__drizzle_migrations' INTO migration_count;
  IF migration_count < 7 THEN
    RAISE EXCEPTION
      'Backfill refused: migration baseline is incomplete (% applied, at least 7 including 0006 required).',
      migration_count;
  END IF;

  FOREACH tbl IN ARRAY locked_tables LOOP
    IF to_regclass(format('public.%I', tbl)) IS NULL THEN
      RAISE EXCEPTION 'Backfill refused: required table public.% is missing.', tbl;
    END IF;
  END LOOP;

  FOREACH tbl IN ARRAY direct_tables LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND information_schema.columns.table_name = tbl
        AND column_name = 'store_id'
    ) THEN
      RAISE EXCEPTION
        'Backfill refused: required column public.%.store_id is missing; migration 0006 is not fully applied.',
        tbl;
    END IF;
  END LOOP;

  -- 2. Bounded write-blocking window. Lock every table participating in the
  -- snapshot, updates and postflight comparisons. lock_timeout above makes a
  -- busy database fail closed instead of hanging indefinitely.
  LOCK TABLE
    "app_user",
    "bot_setting",
    "category",
    "category_translation",
    "customer",
    "inquiry",
    "inquiry_message",
    "language",
    "message_template",
    "message_translation",
    "payment_method",
    "payment_method_translation",
    "product",
    "product_action",
    "product_action_translation",
    "product_translation",
    "seller_notification_delivery",
    "seller_notification_setting",
    "store",
    "store_membership",
    "telegram_update"
  IN ACCESS EXCLUSIVE MODE;

  -- 3. Preservation baseline, captured after the locks so no concurrent write
  -- can change it during the backfill.
  SELECT jsonb_build_object(
    'app_user_rows', (SELECT count(*) FROM "app_user"),
    'store_membership_rows', (SELECT count(*) FROM "store_membership"),
    'language_rows', (SELECT count(*) FROM "language"),
    'bot_setting_rows', (SELECT count(*) FROM "bot_setting"),
    'category_rows', (SELECT count(*) FROM "category"),
    'category_translation_rows', (SELECT count(*) FROM "category_translation"),
    'product_rows', (SELECT count(*) FROM "product"),
    'product_translation_rows', (SELECT count(*) FROM "product_translation"),
    'product_action_rows', (SELECT count(*) FROM "product_action"),
    'product_action_translation_rows', (SELECT count(*) FROM "product_action_translation"),
    'payment_method_rows', (SELECT count(*) FROM "payment_method"),
    'payment_method_translation_rows', (SELECT count(*) FROM "payment_method_translation"),
    'message_template_rows', (SELECT count(*) FROM "message_template"),
    'message_translation_rows', (SELECT count(*) FROM "message_translation"),
    'customer_rows', (SELECT count(*) FROM "customer"),
    'inquiry_rows', (SELECT count(*) FROM "inquiry"),
    'inquiry_message_rows', (SELECT count(*) FROM "inquiry_message"),
    'seller_notification_setting_rows', (SELECT count(*) FROM "seller_notification_setting"),
    'seller_notification_delivery_rows', (SELECT count(*) FROM "seller_notification_delivery"),
    'telegram_update_rows', (SELECT count(*) FROM "telegram_update"),
    'category_links', (
      SELECT coalesce(md5(string_agg("id"::text || ':' || coalesce("parent_id"::text, ''), ',' ORDER BY "id")), '')
      FROM "category"
    ),
    'product_links', (
      SELECT coalesce(md5(string_agg("id"::text || ':' || "category_id"::text, ',' ORDER BY "id")), '')
      FROM "product"
    ),
    'inquiry_links', (
      SELECT coalesce(md5(string_agg("id"::text || ':' || "customer_id"::text || ':' || coalesce("product_id"::text, ''), ',' ORDER BY "id")), '')
      FROM "inquiry"
    ),
    'inquiry_message_links', (
      SELECT coalesce(md5(string_agg("id"::text || ':' || "inquiry_id"::text || ':' || coalesce("telegram_message_id"::text, ''), ',' ORDER BY "id")), '')
      FROM "inquiry_message"
    ),
    'bot_setting_state', (
      SELECT coalesce(md5(string_agg(
        "id"::text || ':' || "default_language_id"::text || ':' || "currency"::text || ':' ||
        "display_name" || ':' || "ask_for_language"::text || ':' ||
        "support_category"::text || ':' || coalesce("support_reply_time", '') || ':' ||
        coalesce("storefront_menu"::text, ''), ',' ORDER BY "id")), '')
      FROM "bot_setting"
    ),
    'seller_notification_setting_state', (
      SELECT coalesce(md5(string_agg(
        "id"::text || ':' || "enabled"::text || ':' || coalesce("destination_chat_id", '') || ':' ||
        "language"::text || ':' || coalesce("verified_at"::text, '') || ':' ||
        coalesce("verified_bot_id"::text, '') || ':' || coalesce("verified_bot_username", '') || ':' ||
        coalesce("verified_chat_id", '') || ':' || "revision"::text || ':' ||
        coalesce("last_test_at"::text, ''), ',' ORDER BY "id")), '')
      FROM "seller_notification_setting"
    ),
    'delivery_state', (
      SELECT coalesce(md5(string_agg(
        "id"::text || ':' || "inquiry_id"::text || ':' || "reference" || ':' || "status" || ':' ||
        "revision"::text || ':' || "destination_chat_id" || ':' ||
        coalesce("telegram_message_id"::text, '') || ':' || coalesce("sent_at"::text, '') || ':' ||
        coalesce("failed_at"::text, '') || ':' || "attempt_count"::text, ',' ORDER BY "id")), '')
      FROM "seller_notification_delivery"
    ),
    'delivery_status_counts', (
      SELECT coalesce(jsonb_object_agg("status", "count"), '{}'::jsonb)
      FROM (
        SELECT "status", count(*)::int AS "count"
        FROM "seller_notification_delivery"
        GROUP BY "status"
      ) statuses
    ),
    'telegram_update_state', (
      SELECT coalesce(md5(string_agg(
        "id"::text || ':' || "update_id"::text || ':' || "update_type" || ':' ||
        coalesce("processed_at"::text, '') || ':' || coalesce("processing_error", ''), ',' ORDER BY "id")), '')
      FROM "telegram_update"
    ),
    'updated_at_state', (
      SELECT coalesce(md5(string_agg(
        "table_name" || ':' || "id"::text || ':' || "updated_at"::text,
        ',' ORDER BY "table_name", "id"
      )), '')
      FROM (
        SELECT 'bot_setting' AS "table_name", "id"::text AS "id", "updated_at" FROM "bot_setting"
        UNION ALL
        SELECT 'category', "id"::text, "updated_at" FROM "category"
        UNION ALL
        SELECT 'customer', "id"::text, "updated_at" FROM "customer"
        UNION ALL
        SELECT 'message_template', "id"::text, "updated_at" FROM "message_template"
        UNION ALL
        SELECT 'payment_method', "id"::text, "updated_at" FROM "payment_method"
        UNION ALL
        SELECT 'product', "id"::text, "updated_at" FROM "product"
        UNION ALL
        SELECT 'seller_notification_setting', "id"::text, "updated_at" FROM "seller_notification_setting"
      ) timestamps
    ),
    'telegram_duplicate_count', (
      SELECT count(*)::int
      FROM (
        SELECT "update_id"
        FROM "telegram_update"
        GROUP BY "update_id"
        HAVING count(*) > 1
      ) duplicates
    ),
    'category_activation', (
      SELECT jsonb_build_object(
        'active', count(*) FILTER (WHERE "is_active"),
        'inactive', count(*) FILTER (WHERE NOT "is_active")
      )
      FROM "category"
    ),
    'product_activation', (
      SELECT jsonb_build_object(
        'active', count(*) FILTER (WHERE "is_active"),
        'inactive', count(*) FILTER (WHERE NOT "is_active")
      )
      FROM "product"
    ),
    'payment_method_activation', (
      SELECT jsonb_build_object(
        'active', count(*) FILTER (WHERE "is_active"),
        'inactive', count(*) FILTER (WHERE NOT "is_active")
      )
      FROM "payment_method"
    )
  ) INTO baseline;

  -- 4. Legacy store identity. A retry reuses the same deterministic row. An
  -- existing slug with another name/status, or any unrelated store, is refused
  -- before any ownership data is changed.
  SELECT "id", "name", "status"
    INTO legacy_store_id, existing_name, existing_status
    FROM "store"
    WHERE "slug" = legacy_slug;

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM "store") THEN
      RAISE EXCEPTION
        'Backfill refused: store table is not empty but the deterministic legacy store slug "%" is absent.',
        legacy_slug;
    END IF;

    INSERT INTO "store" ("name", "slug", "status")
    VALUES (legacy_name, legacy_slug, legacy_status)
    RETURNING "id" INTO legacy_store_id;
  ELSE
    IF existing_name IS DISTINCT FROM legacy_name OR existing_status IS DISTINCT FROM legacy_status THEN
      RAISE EXCEPTION
        'Backfill refused: legacy store slug "%" has unexpected identity (name=%, status=%); expected name=% status=%.',
        legacy_slug, existing_name, existing_status, legacy_name, legacy_status;
    END IF;
  END IF;

  -- 5. Fail closed on any row already owned by another store. This runs before
  -- the unrelated-store check so an explicit conflict is reported precisely.
  FOREACH tbl IN ARRAY direct_tables LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE "store_id" IS NOT NULL AND "store_id" <> $1',
      tbl
    ) INTO conflict_count USING legacy_store_id;

    IF conflict_count > 0 THEN
      RAISE EXCEPTION
        'Backfill refused: table % contains % row(s) owned by another store. Nothing was reassigned.',
        tbl, conflict_count;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM "store" WHERE "id" <> legacy_store_id) THEN
    RAISE EXCEPTION
      'Backfill refused: another store exists besides the deterministic legacy store.';
  END IF;

  -- 6. Ownership writes only. Derived tables inherit ownership from these
  -- parents and are deliberately not updated. The shared updated_at triggers
  -- are temporarily disabled for these tables so a store_id backfill does not
  -- rewrite historical updated_at values; the ALTERs are transactional and are
  -- rolled back with the data if any later check fails.
  FOREACH tbl IN ARRAY touch_trigger_tables LOOP
    EXECUTE format(
      'ALTER TABLE %I DISABLE TRIGGER %I',
      tbl, tbl || '_touch_updated_at'
    );
  END LOOP;

  UPDATE "category" SET "store_id" = legacy_store_id WHERE "store_id" IS NULL;
  UPDATE "product" SET "store_id" = legacy_store_id WHERE "store_id" IS NULL;
  UPDATE "payment_method" SET "store_id" = legacy_store_id WHERE "store_id" IS NULL;
  UPDATE "message_template" SET "store_id" = legacy_store_id WHERE "store_id" IS NULL;
  UPDATE "customer" SET "store_id" = legacy_store_id WHERE "store_id" IS NULL;
  UPDATE "seller_notification_setting" SET "store_id" = legacy_store_id WHERE "store_id" IS NULL;
  UPDATE "bot_setting" SET "store_id" = legacy_store_id WHERE "store_id" IS NULL;
  UPDATE "telegram_update" SET "store_id" = legacy_store_id WHERE "store_id" IS NULL;

  FOREACH tbl IN ARRAY touch_trigger_tables LOOP
    EXECUTE format(
      'ALTER TABLE %I ENABLE TRIGGER %I',
      tbl, tbl || '_touch_updated_at'
    );
  END LOOP;

  -- 7. Postflight ownership and relationship verification.
  FOREACH tbl IN ARRAY direct_tables LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "store_id" IS NULL', tbl)
      INTO bad_count;
    IF bad_count > 0 THEN
      RAISE EXCEPTION
        'Backfill ownership verification failed: table % still has % unowned row(s).',
        tbl, bad_count;
    END IF;

    EXECUTE format('SELECT count(*) FROM %I WHERE "store_id" IS DISTINCT FROM $1', tbl)
      INTO bad_count USING legacy_store_id;
    IF bad_count > 0 THEN
      RAISE EXCEPTION
        'Backfill ownership verification failed: table % has % row(s) with the wrong store.',
        tbl, bad_count;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM "store") <> 1 THEN
    RAISE EXCEPTION 'Backfill store verification failed: expected exactly one store.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "store"
    WHERE "id" = legacy_store_id
      AND "slug" = legacy_slug
      AND "name" = legacy_name
      AND "status" = legacy_status
  ) THEN
    RAISE EXCEPTION 'Backfill store verification failed: legacy store identity changed.';
  END IF;

  SELECT count(*) INTO bad_count
    FROM "category" child
    JOIN "category" parent ON parent."id" = child."parent_id"
    WHERE child."store_id" IS DISTINCT FROM parent."store_id";
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Backfill relationship verification failed: % category parent/child store mismatch(es).',
      bad_count;
  END IF;

  SELECT count(*) INTO bad_count
    FROM "product" p
    JOIN "category" c ON c."id" = p."category_id"
    WHERE p."store_id" IS DISTINCT FROM c."store_id";
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Backfill relationship verification failed: % product/category store mismatch(es).',
      bad_count;
  END IF;

  SELECT count(*) INTO bad_count
    FROM "inquiry" i
    JOIN "customer" c ON c."id" = i."customer_id"
    WHERE c."store_id" IS DISTINCT FROM legacy_store_id;
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Backfill relationship verification failed: % inquiry/customer ownership mismatch(es).',
      bad_count;
  END IF;

  SELECT count(*) INTO bad_count
    FROM "inquiry" i
    JOIN "customer" c ON c."id" = i."customer_id"
    JOIN "product" p ON p."id" = i."product_id"
    WHERE c."store_id" IS DISTINCT FROM p."store_id"
       OR p."store_id" IS DISTINCT FROM legacy_store_id;
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Backfill relationship verification failed: % inquiry/product store mismatch(es).',
      bad_count;
  END IF;

  SELECT count(*) INTO bad_count
    FROM "inquiry_message" m
    JOIN "inquiry" i ON i."id" = m."inquiry_id"
    JOIN "customer" c ON c."id" = i."customer_id"
    WHERE c."store_id" IS DISTINCT FROM legacy_store_id;
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Backfill relationship verification failed: % inquiry message/thread ownership mismatch(es).',
      bad_count;
  END IF;

  SELECT count(*) INTO bad_count
    FROM "seller_notification_delivery" d
    JOIN "inquiry" i ON i."id" = d."inquiry_id"
    JOIN "customer" c ON c."id" = i."customer_id"
    WHERE c."store_id" IS DISTINCT FROM legacy_store_id;
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Backfill relationship verification failed: % notification delivery/thread ownership mismatch(es).',
      bad_count;
  END IF;

  -- 8. Preservation postflight. The snapshot excludes store_id by design, so
  -- any difference means an unrelated historical row, relationship, activation
  -- flag, translation count, notification state or Telegram identity changed.
  SELECT jsonb_build_object(
    'app_user_rows', (SELECT count(*) FROM "app_user"),
    'store_membership_rows', (SELECT count(*) FROM "store_membership"),
    'language_rows', (SELECT count(*) FROM "language"),
    'bot_setting_rows', (SELECT count(*) FROM "bot_setting"),
    'category_rows', (SELECT count(*) FROM "category"),
    'category_translation_rows', (SELECT count(*) FROM "category_translation"),
    'product_rows', (SELECT count(*) FROM "product"),
    'product_translation_rows', (SELECT count(*) FROM "product_translation"),
    'product_action_rows', (SELECT count(*) FROM "product_action"),
    'product_action_translation_rows', (SELECT count(*) FROM "product_action_translation"),
    'payment_method_rows', (SELECT count(*) FROM "payment_method"),
    'payment_method_translation_rows', (SELECT count(*) FROM "payment_method_translation"),
    'message_template_rows', (SELECT count(*) FROM "message_template"),
    'message_translation_rows', (SELECT count(*) FROM "message_translation"),
    'customer_rows', (SELECT count(*) FROM "customer"),
    'inquiry_rows', (SELECT count(*) FROM "inquiry"),
    'inquiry_message_rows', (SELECT count(*) FROM "inquiry_message"),
    'seller_notification_setting_rows', (SELECT count(*) FROM "seller_notification_setting"),
    'seller_notification_delivery_rows', (SELECT count(*) FROM "seller_notification_delivery"),
    'telegram_update_rows', (SELECT count(*) FROM "telegram_update"),
    'category_links', (
      SELECT coalesce(md5(string_agg("id"::text || ':' || coalesce("parent_id"::text, ''), ',' ORDER BY "id")), '')
      FROM "category"
    ),
    'product_links', (
      SELECT coalesce(md5(string_agg("id"::text || ':' || "category_id"::text, ',' ORDER BY "id")), '')
      FROM "product"
    ),
    'inquiry_links', (
      SELECT coalesce(md5(string_agg("id"::text || ':' || "customer_id"::text || ':' || coalesce("product_id"::text, ''), ',' ORDER BY "id")), '')
      FROM "inquiry"
    ),
    'inquiry_message_links', (
      SELECT coalesce(md5(string_agg("id"::text || ':' || "inquiry_id"::text || ':' || coalesce("telegram_message_id"::text, ''), ',' ORDER BY "id")), '')
      FROM "inquiry_message"
    ),
    'bot_setting_state', (
      SELECT coalesce(md5(string_agg(
        "id"::text || ':' || "default_language_id"::text || ':' || "currency"::text || ':' ||
        "display_name" || ':' || "ask_for_language"::text || ':' ||
        "support_category"::text || ':' || coalesce("support_reply_time", '') || ':' ||
        coalesce("storefront_menu"::text, ''), ',' ORDER BY "id")), '')
      FROM "bot_setting"
    ),
    'seller_notification_setting_state', (
      SELECT coalesce(md5(string_agg(
        "id"::text || ':' || "enabled"::text || ':' || coalesce("destination_chat_id", '') || ':' ||
        "language"::text || ':' || coalesce("verified_at"::text, '') || ':' ||
        coalesce("verified_bot_id"::text, '') || ':' || coalesce("verified_bot_username", '') || ':' ||
        coalesce("verified_chat_id", '') || ':' || "revision"::text || ':' ||
        coalesce("last_test_at"::text, ''), ',' ORDER BY "id")), '')
      FROM "seller_notification_setting"
    ),
    'delivery_state', (
      SELECT coalesce(md5(string_agg(
        "id"::text || ':' || "inquiry_id"::text || ':' || "reference" || ':' || "status" || ':' ||
        "revision"::text || ':' || "destination_chat_id" || ':' ||
        coalesce("telegram_message_id"::text, '') || ':' || coalesce("sent_at"::text, '') || ':' ||
        coalesce("failed_at"::text, '') || ':' || "attempt_count"::text, ',' ORDER BY "id")), '')
      FROM "seller_notification_delivery"
    ),
    'delivery_status_counts', (
      SELECT coalesce(jsonb_object_agg("status", "count"), '{}'::jsonb)
      FROM (
        SELECT "status", count(*)::int AS "count"
        FROM "seller_notification_delivery"
        GROUP BY "status"
      ) statuses
    ),
    'telegram_update_state', (
      SELECT coalesce(md5(string_agg(
        "id"::text || ':' || "update_id"::text || ':' || "update_type" || ':' ||
        coalesce("processed_at"::text, '') || ':' || coalesce("processing_error", ''), ',' ORDER BY "id")), '')
      FROM "telegram_update"
    ),
    'updated_at_state', (
      SELECT coalesce(md5(string_agg(
        "table_name" || ':' || "id"::text || ':' || "updated_at"::text,
        ',' ORDER BY "table_name", "id"
      )), '')
      FROM (
        SELECT 'bot_setting' AS "table_name", "id"::text AS "id", "updated_at" FROM "bot_setting"
        UNION ALL
        SELECT 'category', "id"::text, "updated_at" FROM "category"
        UNION ALL
        SELECT 'customer', "id"::text, "updated_at" FROM "customer"
        UNION ALL
        SELECT 'message_template', "id"::text, "updated_at" FROM "message_template"
        UNION ALL
        SELECT 'payment_method', "id"::text, "updated_at" FROM "payment_method"
        UNION ALL
        SELECT 'product', "id"::text, "updated_at" FROM "product"
        UNION ALL
        SELECT 'seller_notification_setting', "id"::text, "updated_at" FROM "seller_notification_setting"
      ) timestamps
    ),
    'telegram_duplicate_count', (
      SELECT count(*)::int
      FROM (
        SELECT "update_id"
        FROM "telegram_update"
        GROUP BY "update_id"
        HAVING count(*) > 1
      ) duplicates
    ),
    'category_activation', (
      SELECT jsonb_build_object(
        'active', count(*) FILTER (WHERE "is_active"),
        'inactive', count(*) FILTER (WHERE NOT "is_active")
      )
      FROM "category"
    ),
    'product_activation', (
      SELECT jsonb_build_object(
        'active', count(*) FILTER (WHERE "is_active"),
        'inactive', count(*) FILTER (WHERE NOT "is_active")
      )
      FROM "product"
    ),
    'payment_method_activation', (
      SELECT jsonb_build_object(
        'active', count(*) FILTER (WHERE "is_active"),
        'inactive', count(*) FILTER (WHERE NOT "is_active")
      )
      FROM "payment_method"
    )
  ) INTO postflight;

  IF postflight IS DISTINCT FROM baseline THEN
    RAISE EXCEPTION
      'Backfill preservation verification failed. Baseline: %. Postflight: %.',
      baseline, postflight;
  END IF;

  RAISE NOTICE 'Legacy-store backfill completed atomically for store %; all postflight checks passed.', legacy_store_id;
END;
$legacy_store_backfill$;
