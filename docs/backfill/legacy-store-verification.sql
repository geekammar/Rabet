-- ===========================================================================
-- S1.2 legacy-store backfill verification (read-only).
--
-- Run after `legacy-store-backfill.sql` in the same approved change window.
-- Every statement is a SELECT: this file writes nothing, calls no Telegram API
-- and sends no notification.
-- ===========================================================================

-- 1. Exactly one legacy store, active, with the deterministic slug.
SELECT "id", "name", "slug", "status", "created_at"
FROM "store"
WHERE "slug" = 'legacy-store';

SELECT count(*)::int AS store_count FROM "store";

-- 2. Ownership coverage: every legacy row has the legacy store and nothing else.
SELECT 'bot_setting' AS table_name, count(*)::int AS total,
       count("store_id")::int AS owned,
       count(*) FILTER (WHERE "store_id" IS NULL)::int AS unowned
FROM "bot_setting"
UNION ALL
SELECT 'category', count(*), count("store_id"), count(*) FILTER (WHERE "store_id" IS NULL) FROM "category"
UNION ALL
SELECT 'product', count(*), count("store_id"), count(*) FILTER (WHERE "store_id" IS NULL) FROM "product"
UNION ALL
SELECT 'payment_method', count(*), count("store_id"), count(*) FILTER (WHERE "store_id" IS NULL) FROM "payment_method"
UNION ALL
SELECT 'message_template', count(*), count("store_id"), count(*) FILTER (WHERE "store_id" IS NULL) FROM "message_template"
UNION ALL
SELECT 'customer', count(*), count("store_id"), count(*) FILTER (WHERE "store_id" IS NULL) FROM "customer"
UNION ALL
SELECT 'inquiry', count(*), count("store_id"), count(*) FILTER (WHERE "store_id" IS NULL) FROM "inquiry"
UNION ALL
SELECT 'seller_notification_setting', count(*), count("store_id"), count(*) FILTER (WHERE "store_id" IS NULL) FROM "seller_notification_setting"
UNION ALL
SELECT 'telegram_update', count(*), count("store_id"), count(*) FILTER (WHERE "store_id" IS NULL) FROM "telegram_update";

-- 3. Cross-ownership invariants. Each count must be zero.
SELECT count(*)::int AS category_parent_store_mismatch
FROM "category" child
JOIN "category" parent ON parent."id" = child."parent_id"
WHERE child."store_id" IS DISTINCT FROM parent."store_id";

SELECT count(*)::int AS product_category_store_mismatch
FROM "product" p
JOIN "category" c ON c."id" = p."category_id"
WHERE p."store_id" IS DISTINCT FROM c."store_id";

SELECT count(*)::int AS inquiry_customer_store_mismatch
FROM "inquiry" i
JOIN "customer" c ON c."id" = i."customer_id"
WHERE i."store_id" IS DISTINCT FROM c."store_id";

SELECT count(*)::int AS inquiry_product_store_mismatch
FROM "inquiry" i
JOIN "product" p ON p."id" = i."product_id"
WHERE i."store_id" IS DISTINCT FROM p."store_id";

SELECT count(*)::int AS inquiry_message_thread_mismatch
FROM "inquiry_message" m
JOIN "inquiry" i ON i."id" = m."inquiry_id"
WHERE i."store_id" IS NULL;

SELECT count(*)::int AS notification_delivery_thread_mismatch
FROM "seller_notification_delivery" d
JOIN "inquiry" i ON i."id" = d."inquiry_id"
WHERE i."store_id" IS NULL;

-- 4. Identity and delivery state preserved (counts, not mutations).
SELECT "status", count(*)::int AS delivery_count
FROM "seller_notification_delivery"
GROUP BY "status"
ORDER BY "status";

SELECT count(*)::int AS duplicate_telegram_update_ids
FROM (
  SELECT "update_id"
  FROM "telegram_update"
  GROUP BY "update_id"
  HAVING count(*) > 1
) duplicates;

SELECT "update_id", "update_type", "store_id"
FROM "telegram_update"
ORDER BY "update_id";

-- 5. Demo activation flags and translated content preserved.
SELECT "is_active", count(*)::int AS product_count
FROM "product"
GROUP BY "is_active"
ORDER BY "is_active";

SELECT count(*)::int AS category_translations FROM "category_translation";
SELECT count(*)::int AS product_translations FROM "product_translation";
SELECT count(*)::int AS action_translations FROM "product_action_translation";
SELECT count(*)::int AS message_translations FROM "message_translation";
SELECT count(*)::int AS payment_method_translations FROM "payment_method_translation";
