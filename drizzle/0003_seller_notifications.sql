CREATE TABLE "seller_notification_setting" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"destination_chat_id" text,
	"language" char(2) DEFAULT 'ar' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_bot_id" bigint,
	"verified_bot_username" text,
	"verified_chat_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"last_test_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_notification_setting_singleton_check" CHECK ("id" = 1),
	CONSTRAINT "seller_notification_setting_language_check" CHECK ("language" IN ('ar', 'en')),
	CONSTRAINT "seller_notification_setting_destination_check" CHECK ("destination_chat_id" IS NULL OR "destination_chat_id" ~ '^[1-9][0-9]{4,19}$')
);
--> statement-breakpoint
CREATE TABLE "seller_notification_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text DEFAULT 'new_inquiry' NOT NULL,
	"inquiry_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"revision" integer NOT NULL,
	"destination_chat_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_attempt_id" text,
	"claim_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"telegram_message_id" bigint,
	"error_category" text,
	"retry_after_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_notification_delivery_status_check" CHECK ("status" IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "seller_notification_delivery" ADD CONSTRAINT "seller_notification_delivery_inquiry_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."inquiry"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "seller_notification_delivery_event_inquiry_idx" ON "seller_notification_delivery" USING btree ("event_type", "inquiry_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "seller_notification_delivery_reference_unique" ON "seller_notification_delivery" USING btree ("reference");
--> statement-breakpoint
CREATE INDEX "seller_notification_delivery_status_idx" ON "seller_notification_delivery" USING btree ("status", "claim_expires_at");
--> statement-breakpoint
CREATE INDEX "seller_notification_delivery_created_at_idx" ON "seller_notification_delivery" USING btree ("created_at");
--> statement-breakpoint
DROP TRIGGER IF EXISTS seller_notification_setting_touch_updated_at ON seller_notification_setting;
--> statement-breakpoint
CREATE TRIGGER seller_notification_setting_touch_updated_at
  BEFORE UPDATE ON seller_notification_setting
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS seller_notification_delivery_touch_updated_at ON seller_notification_delivery;
--> statement-breakpoint
CREATE TRIGGER seller_notification_delivery_touch_updated_at
  BEFORE UPDATE ON seller_notification_delivery
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();
