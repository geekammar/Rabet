ALTER TABLE "order" ADD COLUMN "handed_to_shipping_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "payment_collected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" DISABLE TRIGGER "order_touch_updated_at";--> statement-breakpoint
UPDATE "order"
SET "handed_to_shipping_at" = COALESCE("handed_to_shipping_at", "updated_at"),
    "delivered_at" = CASE
      WHEN "fulfillment_status" = 'delivered'
        THEN COALESCE("delivered_at", "updated_at")
      ELSE "delivered_at"
    END
WHERE "fulfillment_status" IN ('handed_to_shipping', 'delivered')
  AND ("handed_to_shipping_at" IS NULL
    OR ("fulfillment_status" = 'delivered' AND "delivered_at" IS NULL));--> statement-breakpoint
UPDATE "order"
SET "payment_collected_at" = COALESCE("payment_collected_at", "updated_at")
WHERE "payment_status" = 'collected'
  AND "payment_collected_at" IS NULL;--> statement-breakpoint
ALTER TABLE "order" ENABLE TRIGGER "order_touch_updated_at";--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_shipping_state_check" CHECK ((
        ("order"."fulfillment_status" = 'unfulfilled'
          AND "order"."handed_to_shipping_at" IS NULL
          AND "order"."delivered_at" IS NULL)
        OR
        ("order"."fulfillment_status" = 'handed_to_shipping'
          AND "order"."handed_to_shipping_at" IS NOT NULL
          AND "order"."delivered_at" IS NULL)
        OR
        ("order"."fulfillment_status" = 'delivered'
          AND "order"."handed_to_shipping_at" IS NOT NULL
          AND "order"."delivered_at" IS NOT NULL)
        OR
        ("order"."fulfillment_status" = 'cancelled'
          AND "order"."handed_to_shipping_at" IS NULL
          AND "order"."delivered_at" IS NULL)
      ));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_payment_collection_state_check" CHECK ((
        ("order"."payment_status" = 'collected'
          AND "order"."payment_collected_at" IS NOT NULL)
        OR
        ("order"."payment_status" <> 'collected'
          AND "order"."payment_collected_at" IS NULL)
      ));