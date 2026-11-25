ALTER TABLE "order" ADD COLUMN "handed_to_shipping_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "payment_collected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_shipping_state_check" CHECK ((
        ("order"."fulfillment_status" = 'unfulfilled'
          AND "order"."handed_to_shipping_at" IS NULL
          AND "order"."delivered_at" IS NULL)
        OR
        ("order"."fulfillment_status" = 'handed_to_shipping'
          AND "order"."delivered_at" IS NULL)
        OR
        ("order"."fulfillment_status" = 'delivered'
          AND (
            ("order"."handed_to_shipping_at" IS NULL
              AND "order"."delivered_at" IS NULL)
            OR
            ("order"."handed_to_shipping_at" IS NOT NULL
              AND "order"."delivered_at" IS NOT NULL
              AND "order"."delivered_at" >= "order"."handed_to_shipping_at")
          ))
        OR
        ("order"."fulfillment_status" = 'cancelled'
          AND "order"."handed_to_shipping_at" IS NULL
          AND "order"."delivered_at" IS NULL)
      ));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_payment_collection_state_check" CHECK ((
        "order"."payment_status" = 'collected'
        OR "order"."payment_collected_at" IS NULL
      ));