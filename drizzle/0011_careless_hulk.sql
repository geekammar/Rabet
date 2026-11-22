CREATE TABLE "telegram_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"bot_id" bigint NOT NULL,
	"bot_username" text NOT NULL,
	"bot_name" text,
	"token_ciphertext" text NOT NULL,
	"token_key_id" text NOT NULL,
	"webhook_secret_hash" text NOT NULL,
	"webhook_url" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_connection_bot_id_unique" UNIQUE("bot_id"),
	CONSTRAINT "telegram_connection_status_check" CHECK ("telegram_connection"."status" IN ('provisioning', 'awaiting_confirmation', 'ready', 'revoked', 'disconnected', 'needs_review')),
	CONSTRAINT "telegram_connection_bot_id_positive_check" CHECK ("telegram_connection"."bot_id" > 0),
	CONSTRAINT "telegram_connection_webhook_secret_hash_format_check" CHECK ("telegram_connection"."webhook_secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "telegram_connection_webhook_url_https_check" CHECK ("telegram_connection"."webhook_url" ~ '^https://')
);
--> statement-breakpoint
CREATE TABLE "telegram_link_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"merchant_user_id" uuid NOT NULL,
	"manager_bot_username" text NOT NULL,
	"nonce_digest" text NOT NULL,
	"nonce_ciphertext" text NOT NULL,
	"nonce_key_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"telegram_user_id" bigint,
	"telegram_bot_id" bigint,
	"telegram_bot_username" text,
	"telegram_bot_name" text,
	"connection_id" uuid,
	"failure_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"bound_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_link_attempt_nonce_digest_format_check" CHECK ("telegram_link_attempt"."nonce_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "telegram_link_attempt_status_check" CHECK ("telegram_link_attempt"."status" IN ('pending', 'provisioning', 'awaiting_confirmation', 'completed', 'expired', 'cancelled', 'failed')),
	CONSTRAINT "telegram_link_attempt_expiry_after_creation_check" CHECK ("telegram_link_attempt"."expires_at" > "telegram_link_attempt"."created_at"),
	CONSTRAINT "telegram_link_attempt_telegram_user_positive_check" CHECK ("telegram_link_attempt"."telegram_user_id" IS NULL OR "telegram_link_attempt"."telegram_user_id" > 0),
	CONSTRAINT "telegram_link_attempt_telegram_bot_positive_check" CHECK ("telegram_link_attempt"."telegram_bot_id" IS NULL OR "telegram_link_attempt"."telegram_bot_id" > 0)
);
--> statement-breakpoint
CREATE TABLE "telegram_managed_update" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" bigint NOT NULL,
	"update_id" bigint NOT NULL,
	"update_type" text NOT NULL,
	"connection_id" uuid,
	"attempt_id" uuid,
	"status" text DEFAULT 'processing' NOT NULL,
	"attempt_token" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_managed_update_status_check" CHECK ("telegram_managed_update"."status" IN ('processing', 'processed', 'failed')),
	CONSTRAINT "telegram_managed_update_update_id_positive_check" CHECK ("telegram_managed_update"."update_id" > 0),
	CONSTRAINT "telegram_managed_update_bot_id_positive_check" CHECK ("telegram_managed_update"."bot_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "telegram_connection" ADD CONSTRAINT "telegram_connection_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_attempt" ADD CONSTRAINT "telegram_link_attempt_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_attempt" ADD CONSTRAINT "telegram_link_attempt_merchant_user_id_app_user_id_fk" FOREIGN KEY ("merchant_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_attempt" ADD CONSTRAINT "telegram_link_attempt_connection_id_telegram_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."telegram_connection"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_managed_update" ADD CONSTRAINT "telegram_managed_update_connection_id_telegram_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."telegram_connection"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_managed_update" ADD CONSTRAINT "telegram_managed_update_attempt_id_telegram_link_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."telegram_link_attempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_connection_store_idx" ON "telegram_connection" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_connection_one_active_per_store_idx" ON "telegram_connection" USING btree ("store_id") WHERE "telegram_connection"."status" IN ('provisioning', 'awaiting_confirmation', 'ready');--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_link_attempt_nonce_digest_unique" ON "telegram_link_attempt" USING btree ("nonce_digest");--> statement-breakpoint
CREATE INDEX "telegram_link_attempt_store_idx" ON "telegram_link_attempt" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "telegram_link_attempt_telegram_user_idx" ON "telegram_link_attempt" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_link_attempt_one_active_per_store_idx" ON "telegram_link_attempt" USING btree ("store_id") WHERE "telegram_link_attempt"."status" IN ('pending', 'provisioning', 'awaiting_confirmation');--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_link_attempt_one_active_per_user_idx" ON "telegram_link_attempt" USING btree ("telegram_user_id") WHERE "telegram_link_attempt"."telegram_user_id" IS NOT NULL AND "telegram_link_attempt"."status" IN ('pending', 'provisioning', 'awaiting_confirmation');--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_managed_update_bot_update_unique" ON "telegram_managed_update" USING btree ("bot_id","update_id");--> statement-breakpoint
CREATE INDEX "telegram_managed_update_status_idx" ON "telegram_managed_update" USING btree ("status","claimed_at");--> statement-breakpoint
DROP TRIGGER IF EXISTS telegram_connection_touch_updated_at ON telegram_connection;--> statement-breakpoint
CREATE TRIGGER telegram_connection_touch_updated_at
  BEFORE UPDATE ON telegram_connection
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS telegram_link_attempt_touch_updated_at ON telegram_link_attempt;--> statement-breakpoint
CREATE TRIGGER telegram_link_attempt_touch_updated_at
  BEFORE UPDATE ON telegram_link_attempt
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();
