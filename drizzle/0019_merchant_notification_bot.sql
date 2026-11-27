CREATE TABLE "merchant_notification_bot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"bot_id" bigint NOT NULL,
	"bot_username" text NOT NULL,
	"bot_name" text,
	"token_ciphertext" text NOT NULL,
	"token_key_id" text NOT NULL,
	"destination_chat_id" text,
	"destination_chat_title" text,
	"destination_chat_username" text,
	"pairing_code_hash" text,
	"pairing_expires_at" timestamp with time zone,
	"pairing_update_offset" bigint,
	"pairing_candidates" jsonb,
	"pairing_failure_code" text,
	"config_epoch" uuid DEFAULT gen_random_uuid() NOT NULL,
	"verified_at" timestamp with time zone,
	"last_test_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_notification_bot_bot_id_positive_check" CHECK ("merchant_notification_bot"."bot_id" > 0),
	CONSTRAINT "merchant_notification_bot_bot_username_format_check" CHECK ("merchant_notification_bot"."bot_username" ~ '^[A-Za-z][A-Za-z0-9_]{3,31}$'),
	CONSTRAINT "merchant_notification_bot_token_not_empty_check" CHECK (btrim("merchant_notification_bot"."token_ciphertext") <> ''),
	CONSTRAINT "merchant_notification_bot_token_key_id_format_check" CHECK ("merchant_notification_bot"."token_key_id" ~ '^[A-Za-z0-9._-]{1,32}$'),
	CONSTRAINT "merchant_notification_bot_destination_chat_id_format_check" CHECK ("merchant_notification_bot"."destination_chat_id" IS NULL OR "merchant_notification_bot"."destination_chat_id" ~ '^[1-9][0-9]{4,19}$'),
	CONSTRAINT "merchant_notification_bot_pairing_state_check" CHECK ((
        ("merchant_notification_bot"."pairing_code_hash" IS NULL
          AND "merchant_notification_bot"."pairing_expires_at" IS NULL)
        OR
        ("merchant_notification_bot"."pairing_code_hash" IS NOT NULL
          AND "merchant_notification_bot"."pairing_expires_at" IS NOT NULL)
      )),
	CONSTRAINT "merchant_notification_bot_pairing_hash_format_check" CHECK ("merchant_notification_bot"."pairing_code_hash" IS NULL OR "merchant_notification_bot"."pairing_code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "merchant_notification_bot_pairing_update_offset_check" CHECK ("merchant_notification_bot"."pairing_update_offset" IS NULL OR "merchant_notification_bot"."pairing_update_offset" >= 1),
	CONSTRAINT "merchant_notification_bot_pairing_candidates_array_check" CHECK ("merchant_notification_bot"."pairing_candidates" IS NULL OR jsonb_typeof("merchant_notification_bot"."pairing_candidates") = 'array'),
	CONSTRAINT "merchant_notification_bot_pairing_failure_code_check" CHECK ("merchant_notification_bot"."pairing_failure_code" IS NULL OR "merchant_notification_bot"."pairing_failure_code" = 'ambiguous'),
	CONSTRAINT "merchant_notification_bot_pairing_failure_state_check" CHECK ("merchant_notification_bot"."pairing_failure_code" IS NULL OR (
        "merchant_notification_bot"."pairing_code_hash" IS NULL
        AND "merchant_notification_bot"."pairing_expires_at" IS NULL
        AND "merchant_notification_bot"."pairing_candidates" IS NULL
        AND "merchant_notification_bot"."pairing_update_offset" IS NULL
      )),
	CONSTRAINT "merchant_notification_bot_verified_requires_destination_check" CHECK ("merchant_notification_bot"."verified_at" IS NULL OR "merchant_notification_bot"."destination_chat_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "merchant_notification_bot" ADD CONSTRAINT "merchant_notification_bot_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_notification_bot_store_unique" ON "merchant_notification_bot" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_notification_bot_bot_id_unique" ON "merchant_notification_bot" USING btree ("bot_id");

--> statement-breakpoint
DROP TRIGGER IF EXISTS merchant_notification_bot_touch_updated_at ON merchant_notification_bot;--> statement-breakpoint
CREATE TRIGGER merchant_notification_bot_touch_updated_at
  BEFORE UPDATE ON merchant_notification_bot
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();
