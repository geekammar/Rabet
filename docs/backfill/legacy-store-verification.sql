-- ===========================================================================
-- S1.2 legacy-store backfill verification (read-only).
--
-- Run after `legacy-store-backfill.sql` in the same approved change window.
-- This file is exactly one SELECT statement: it writes nothing, takes no
-- application lock beyond normal reads, calls no Telegram API and sends no
-- notification.
--
-- Result contract:
--   * kind = 'assertion' rows are pass/fail invariants; every `ok` must be true.
--   * kind = 'metric' rows are audit values to record with the change evidence.
-- A backfill is not accepted merely because psql returned exit code 0; the
-- assertion rows must be reviewed and all must pass.
-- ===========================================================================

WITH legacy_store AS (
  SELECT "id"
  FROM "store"
  WHERE "slug" = 'legacy-store'
    AND "name" = 'Rabet Legacy Store'
    AND "status" = 'active'
),
checks AS (
  SELECT
    'assertion'::text AS kind,
    'store_count'::text AS check_name,
    (SELECT count(*)::text FROM "store") AS actual,
    '1'::text AS expected,
    (SELECT count(*) = 1 FROM "store") AS ok

  UNION ALL
  SELECT
    'assertion',
    'legacy_store_identity',
    (SELECT count(*)::text FROM "store" s JOIN legacy_store l ON l."id" = s."id" WHERE s."slug" = 'legacy-store'),
    '1',
    (SELECT count(*) = 1 FROM "store" s JOIN legacy_store l ON l."id" = s."id" WHERE s."slug" = 'legacy-store')

  UNION ALL
  SELECT 'assertion', 'bot_setting_unowned', (SELECT count(*)::text FROM "bot_setting" WHERE "store_id" IS NULL), '0', (SELECT count(*) = 0 FROM "bot_setting" WHERE "store_id" IS NULL)
  UNION ALL
  SELECT 'assertion', 'category_unowned', (SELECT count(*)::text FROM "category" WHERE "store_id" IS NULL), '0', (SELECT count(*) = 0 FROM "category" WHERE "store_id" IS NULL)
  UNION ALL
  SELECT 'assertion', 'customer_unowned', (SELECT count(*)::text FROM "customer" WHERE "store_id" IS NULL), '0', (SELECT count(*) = 0 FROM "customer" WHERE "store_id" IS NULL)
  UNION ALL
  SELECT 'assertion', 'message_template_unowned', (SELECT count(*)::text FROM "message_template" WHERE "store_id" IS NULL), '0', (SELECT count(*) = 0 FROM "message_template" WHERE "store_id" IS NULL)
  UNION ALL
  SELECT 'assertion', 'payment_method_unowned', (SELECT count(*)::text FROM "payment_method" WHERE "store_id" IS NULL), '0', (SELECT count(*) = 0 FROM "payment_method" WHERE "store_id" IS NULL)
  UNION ALL
  SELECT 'assertion', 'product_unowned', (SELECT count(*)::text FROM "product" WHERE "store_id" IS NULL), '0', (SELECT count(*) = 0 FROM "product" WHERE "store_id" IS NULL)
  UNION ALL
  SELECT 'assertion', 'seller_notification_setting_unowned', (SELECT count(*)::text FROM "seller_notification_setting" WHERE "store_id" IS NULL), '0', (SELECT count(*) = 0 FROM "seller_notification_setting" WHERE "store_id" IS NULL)
  UNION ALL
  SELECT 'assertion', 'telegram_update_unowned', (SELECT count(*)::text FROM "telegram_update" WHERE "store_id" IS NULL), '0', (SELECT count(*) = 0 FROM "telegram_update" WHERE "store_id" IS NULL)

  UNION ALL
  SELECT 'assertion', 'bot_setting_wrong_store', (SELECT count(*)::text FROM "bot_setting" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store)), '0', (SELECT count(*) = 0 FROM "bot_setting" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store))
  UNION ALL
  SELECT 'assertion', 'category_wrong_store', (SELECT count(*)::text FROM "category" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store)), '0', (SELECT count(*) = 0 FROM "category" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store))
  UNION ALL
  SELECT 'assertion', 'customer_wrong_store', (SELECT count(*)::text FROM "customer" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store)), '0', (SELECT count(*) = 0 FROM "customer" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store))
  UNION ALL
  SELECT 'assertion', 'message_template_wrong_store', (SELECT count(*)::text FROM "message_template" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store)), '0', (SELECT count(*) = 0 FROM "message_template" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store))
  UNION ALL
  SELECT 'assertion', 'payment_method_wrong_store', (SELECT count(*)::text FROM "payment_method" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store)), '0', (SELECT count(*) = 0 FROM "payment_method" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store))
  UNION ALL
  SELECT 'assertion', 'product_wrong_store', (SELECT count(*)::text FROM "product" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store)), '0', (SELECT count(*) = 0 FROM "product" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store))
  UNION ALL
  SELECT 'assertion', 'seller_notification_setting_wrong_store', (SELECT count(*)::text FROM "seller_notification_setting" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store)), '0', (SELECT count(*) = 0 FROM "seller_notification_setting" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store))
  UNION ALL
  SELECT 'assertion', 'telegram_update_wrong_store', (SELECT count(*)::text FROM "telegram_update" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store)), '0', (SELECT count(*) = 0 FROM "telegram_update" WHERE "store_id" IS NOT NULL AND "store_id" <> (SELECT "id" FROM legacy_store))

  UNION ALL
  SELECT
    'assertion',
    'category_parent_store_mismatch',
    (SELECT count(*)::text FROM "category" child JOIN "category" parent ON parent."id" = child."parent_id" WHERE child."store_id" IS DISTINCT FROM parent."store_id"),
    '0',
    (SELECT count(*) = 0 FROM "category" child JOIN "category" parent ON parent."id" = child."parent_id" WHERE child."store_id" IS DISTINCT FROM parent."store_id")

  UNION ALL
  SELECT
    'assertion',
    'product_category_store_mismatch',
    (SELECT count(*)::text FROM "product" p JOIN "category" c ON c."id" = p."category_id" WHERE p."store_id" IS DISTINCT FROM c."store_id"),
    '0',
    (SELECT count(*) = 0 FROM "product" p JOIN "category" c ON c."id" = p."category_id" WHERE p."store_id" IS DISTINCT FROM c."store_id")

  UNION ALL
  SELECT
    'assertion',
    'inquiry_customer_ownership_mismatch',
    (SELECT count(*)::text FROM "inquiry" i JOIN "customer" c ON c."id" = i."customer_id" WHERE c."store_id" IS DISTINCT FROM (SELECT "id" FROM legacy_store)),
    '0',
    (SELECT count(*) = 0 FROM "inquiry" i JOIN "customer" c ON c."id" = i."customer_id" WHERE c."store_id" IS DISTINCT FROM (SELECT "id" FROM legacy_store))

  UNION ALL
  SELECT
    'assertion',
    'inquiry_product_ownership_mismatch',
    (SELECT count(*)::text FROM "inquiry" i JOIN "customer" c ON c."id" = i."customer_id" JOIN "product" p ON p."id" = i."product_id" WHERE c."store_id" IS DISTINCT FROM p."store_id" OR p."store_id" IS DISTINCT FROM (SELECT "id" FROM legacy_store)),
    '0',
    (SELECT count(*) = 0 FROM "inquiry" i JOIN "customer" c ON c."id" = i."customer_id" JOIN "product" p ON p."id" = i."product_id" WHERE c."store_id" IS DISTINCT FROM p."store_id" OR p."store_id" IS DISTINCT FROM (SELECT "id" FROM legacy_store))

  UNION ALL
  SELECT
    'assertion',
    'inquiry_message_thread_ownership_mismatch',
    (SELECT count(*)::text FROM "inquiry_message" m JOIN "inquiry" i ON i."id" = m."inquiry_id" JOIN "customer" c ON c."id" = i."customer_id" WHERE c."store_id" IS DISTINCT FROM (SELECT "id" FROM legacy_store)),
    '0',
    (SELECT count(*) = 0 FROM "inquiry_message" m JOIN "inquiry" i ON i."id" = m."inquiry_id" JOIN "customer" c ON c."id" = i."customer_id" WHERE c."store_id" IS DISTINCT FROM (SELECT "id" FROM legacy_store))

  UNION ALL
  SELECT
    'assertion',
    'notification_delivery_thread_ownership_mismatch',
    (SELECT count(*)::text FROM "seller_notification_delivery" d JOIN "inquiry" i ON i."id" = d."inquiry_id" JOIN "customer" c ON c."id" = i."customer_id" WHERE c."store_id" IS DISTINCT FROM (SELECT "id" FROM legacy_store)),
    '0',
    (SELECT count(*) = 0 FROM "seller_notification_delivery" d JOIN "inquiry" i ON i."id" = d."inquiry_id" JOIN "customer" c ON c."id" = i."customer_id" WHERE c."store_id" IS DISTINCT FROM (SELECT "id" FROM legacy_store))

  UNION ALL
  SELECT
    'assertion',
    'duplicate_telegram_update_ids',
    (SELECT count(*)::text FROM (SELECT "update_id" FROM "telegram_update" GROUP BY "update_id" HAVING count(*) > 1) d),
    '0',
    (SELECT count(*) = 0 FROM (SELECT "update_id" FROM "telegram_update" GROUP BY "update_id" HAVING count(*) > 1) d)

  UNION ALL
  SELECT 'metric', 'row_counts', (SELECT jsonb_build_object(
    'app_user', (SELECT count(*) FROM "app_user"),
    'store_membership', (SELECT count(*) FROM "store_membership"),
    'store', (SELECT count(*) FROM "store"),
    'language', (SELECT count(*) FROM "language"),
    'bot_setting', (SELECT count(*) FROM "bot_setting"),
    'category', (SELECT count(*) FROM "category"),
    'category_translation', (SELECT count(*) FROM "category_translation"),
    'product', (SELECT count(*) FROM "product"),
    'product_translation', (SELECT count(*) FROM "product_translation"),
    'product_action', (SELECT count(*) FROM "product_action"),
    'product_action_translation', (SELECT count(*) FROM "product_action_translation"),
    'payment_method', (SELECT count(*) FROM "payment_method"),
    'payment_method_translation', (SELECT count(*) FROM "payment_method_translation"),
    'message_template', (SELECT count(*) FROM "message_template"),
    'message_translation', (SELECT count(*) FROM "message_translation"),
    'customer', (SELECT count(*) FROM "customer"),
    'inquiry', (SELECT count(*) FROM "inquiry"),
    'inquiry_message', (SELECT count(*) FROM "inquiry_message"),
    'seller_notification_setting', (SELECT count(*) FROM "seller_notification_setting"),
    'seller_notification_delivery', (SELECT count(*) FROM "seller_notification_delivery"),
    'telegram_update', (SELECT count(*) FROM "telegram_update")
  )::text), NULL, NULL

  UNION ALL
  SELECT 'metric', 'category_parent_links', (SELECT count(*)::text FROM "category" WHERE "parent_id" IS NOT NULL), NULL, NULL
  UNION ALL
  SELECT 'metric', 'product_category_links', (SELECT count(*)::text FROM "product"), NULL, NULL
  UNION ALL
  SELECT 'metric', 'inquiry_customer_links', (SELECT count(*)::text FROM "inquiry"), NULL, NULL
  UNION ALL
  SELECT 'metric', 'inquiry_message_links', (SELECT count(*)::text FROM "inquiry_message"), NULL, NULL

  UNION ALL
  SELECT 'metric', 'translation_counts', (SELECT jsonb_build_object(
    'category', (SELECT count(*) FROM "category_translation"),
    'product', (SELECT count(*) FROM "product_translation"),
    'action', (SELECT count(*) FROM "product_action_translation"),
    'message', (SELECT count(*) FROM "message_translation"),
    'payment_method', (SELECT count(*) FROM "payment_method_translation")
  )::text), NULL, NULL

  UNION ALL
  SELECT 'metric', 'notification_delivery_states', (SELECT coalesce(jsonb_object_agg("status", "count"), '{}'::jsonb)::text FROM (
    SELECT "status", count(*)::int AS "count" FROM "seller_notification_delivery" GROUP BY "status"
  ) states), NULL, NULL

  UNION ALL
  SELECT 'metric', 'activation_flags', (SELECT jsonb_build_object(
    'category', (SELECT jsonb_build_object('active', count(*) FILTER (WHERE "is_active"), 'inactive', count(*) FILTER (WHERE NOT "is_active")) FROM "category"),
    'product', (SELECT jsonb_build_object('active', count(*) FILTER (WHERE "is_active"), 'inactive', count(*) FILTER (WHERE NOT "is_active")) FROM "product"),
    'payment_method', (SELECT jsonb_build_object('active', count(*) FILTER (WHERE "is_active"), 'inactive', count(*) FILTER (WHERE NOT "is_active")) FROM "payment_method")
  )::text), NULL, NULL

  UNION ALL
  SELECT 'metric', 'telegram_update_identities', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'update_id', "update_id",
    'update_type', "update_type",
    'store_id', "store_id"
  ) ORDER BY "update_id"), '[]'::jsonb)::text FROM "telegram_update"), NULL, NULL
)
SELECT kind, check_name, actual, expected, ok
FROM checks
ORDER BY CASE kind WHEN 'assertion' THEN 0 ELSE 1 END, ok NULLS LAST, check_name;
