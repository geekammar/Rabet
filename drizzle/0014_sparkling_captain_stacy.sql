ALTER TABLE "order" DROP CONSTRAINT "order_status_check";--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "preparing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "order" DISABLE TRIGGER "order_touch_updated_at";--> statement-breakpoint
UPDATE "order"
SET "cancellation_reason" = 'Legacy cancellation',
    "cancelled_at" = COALESCE("cancelled_at", "updated_at")
WHERE "status" = 'cancelled'
  AND ("cancellation_reason" IS NULL OR "cancelled_at" IS NULL);--> statement-breakpoint
ALTER TABLE "order" ENABLE TRIGGER "order_touch_updated_at";--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_merchant_progress_check" CHECK ((
        ("order"."status" = 'placed'
          AND "order"."accepted_at" IS NULL
          AND "order"."preparing_at" IS NULL)
        OR
        ("order"."status" = 'accepted'
          AND "order"."accepted_at" IS NOT NULL
          AND "order"."preparing_at" IS NULL)
        OR
        ("order"."status" = 'preparing'
          AND "order"."accepted_at" IS NOT NULL
          AND "order"."preparing_at" IS NOT NULL)
        OR
        ("order"."status" = 'cancelled')
      ));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_cancellation_state_check" CHECK ((
        ("order"."status" = 'cancelled'
          AND "order"."cancellation_reason" IS NOT NULL
          AND btrim("order"."cancellation_reason") <> ''
          AND "order"."cancelled_at" IS NOT NULL)
        OR
        ("order"."status" <> 'cancelled'
          AND "order"."cancellation_reason" IS NULL
          AND "order"."cancelled_at" IS NULL)
      ));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_cancellation_reason_length_check" CHECK ("order"."cancellation_reason" IS NULL
        OR char_length("order"."cancellation_reason") BETWEEN 3 AND 300);--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_status_check" CHECK ("order"."status" IN ('placed', 'accepted', 'preparing', 'cancelled'));