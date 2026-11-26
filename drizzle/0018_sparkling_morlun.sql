CREATE TABLE "order_payment_claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"method" text DEFAULT 'vodafone_cash' NOT NULL,
	"reference" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_payment_claim_method_check" CHECK ("order_payment_claim"."method" = 'vodafone_cash'),
	CONSTRAINT "order_payment_claim_status_check" CHECK ("order_payment_claim"."status" IN ('pending', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "order_payment_claim_reference_length_check" CHECK (char_length("order_payment_claim"."reference") BETWEEN 3 AND 80),
	CONSTRAINT "order_payment_claim_decision_state_check" CHECK ((
        ("order_payment_claim"."status" = 'pending'
          AND "order_payment_claim"."decided_at" IS NULL
          AND "order_payment_claim"."decided_by" IS NULL)
        OR
        ("order_payment_claim"."status" IN ('approved', 'rejected')
          AND "order_payment_claim"."decided_at" IS NOT NULL
          AND "order_payment_claim"."decided_by" IS NOT NULL)
        OR
        ("order_payment_claim"."status" = 'cancelled'
          AND "order_payment_claim"."decided_at" IS NOT NULL
          AND "order_payment_claim"."decided_by" IS NULL)
      )),
	CONSTRAINT "order_payment_claim_decision_note_length_check" CHECK ("order_payment_claim"."decision_note" IS NULL
        OR char_length("order_payment_claim"."decision_note") <= 300)
);
--> statement-breakpoint
ALTER TABLE "order" DROP CONSTRAINT "order_payment_method_check";--> statement-breakpoint
ALTER TABLE "order" DROP CONSTRAINT "order_payment_status_check";--> statement-breakpoint
ALTER TABLE "cart" ADD COLUMN "payment_method" text DEFAULT 'cod' NOT NULL;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "transfer_reference_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "transfer_prompt_message_id" bigint;--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "transfer_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "store_commerce_setting" ADD COLUMN "vodafone_cash_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "store_commerce_setting" ADD COLUMN "vodafone_cash_number" text;--> statement-breakpoint
ALTER TABLE "store_commerce_setting" ADD COLUMN "vodafone_cash_account_name" text;--> statement-breakpoint
ALTER TABLE "store_commerce_setting" ADD COLUMN "vodafone_cash_instructions_ar" text;--> statement-breakpoint
ALTER TABLE "store_commerce_setting" ADD COLUMN "vodafone_cash_instructions_en" text;--> statement-breakpoint
ALTER TABLE "order_payment_claim" ADD CONSTRAINT "order_payment_claim_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payment_claim" ADD CONSTRAINT "order_payment_claim_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payment_claim" ADD CONSTRAINT "order_payment_claim_decided_by_app_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_payment_claim_order_unique" ON "order_payment_claim" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_payment_claim_store_reference_unique" ON "order_payment_claim" USING btree ("store_id","reference");--> statement-breakpoint
CREATE INDEX "order_payment_claim_store_status_idx" ON "order_payment_claim" USING btree ("store_id","status");--> statement-breakpoint
ALTER TABLE "cart" ADD CONSTRAINT "cart_payment_method_check" CHECK ("cart"."payment_method" IN ('cod', 'vodafone_cash'));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_payment_method_status_check" CHECK ((
        ("order"."payment_method" = 'cod'
          AND "order"."payment_status" IN ('awaiting_collection', 'collected', 'failed'))
        OR
        ("order"."payment_method" = 'vodafone_cash'
          AND "order"."payment_status" IN (
            'awaiting_transfer',
            'transfer_awaiting_review',
            'transfer_verified',
            'transfer_rejected'
          ))
      ));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_transfer_reference_request_state_check" CHECK ((
        ("order"."transfer_reference_requested_at" IS NULL
          OR "order"."payment_method" = 'vodafone_cash')
        AND
        ("order"."transfer_prompt_message_id" IS NULL
          OR ("order"."payment_method" = 'vodafone_cash'
            AND "order"."transfer_prompt_message_id" > 0))
      ));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_transfer_snapshot_state_check" CHECK ((
        ("order"."payment_method" = 'vodafone_cash'
          AND "order"."transfer_snapshot" IS NOT NULL)
        OR
        ("order"."payment_method" = 'cod'
          AND "order"."transfer_snapshot" IS NULL)
      ));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_payment_method_check" CHECK ("order"."payment_method" IN ('cod', 'vodafone_cash'));--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_payment_status_check" CHECK ("order"."payment_status" IN (
        'awaiting_collection',
        'collected',
        'failed',
        'awaiting_transfer',
        'transfer_awaiting_review',
        'transfer_verified',
        'transfer_rejected'
      ));--> statement-breakpoint
ALTER TABLE "store_commerce_setting" ADD CONSTRAINT "store_commerce_setting_vodafone_cash_config_check" CHECK ((
        "store_commerce_setting"."vodafone_cash_enabled" = false
        OR (
          "store_commerce_setting"."vodafone_cash_number" IS NOT NULL
          AND btrim("store_commerce_setting"."vodafone_cash_number") <> ''
          AND "store_commerce_setting"."vodafone_cash_account_name" IS NOT NULL
          AND btrim("store_commerce_setting"."vodafone_cash_account_name") <> ''
          AND (
            ("store_commerce_setting"."vodafone_cash_instructions_ar" IS NOT NULL
              AND btrim("store_commerce_setting"."vodafone_cash_instructions_ar") <> '')
            OR
            ("store_commerce_setting"."vodafone_cash_instructions_en" IS NOT NULL
              AND btrim("store_commerce_setting"."vodafone_cash_instructions_en") <> '')
          )
        )
      ));--> statement-breakpoint
ALTER TABLE "store_commerce_setting" ADD CONSTRAINT "store_commerce_setting_vodafone_cash_number_length_check" CHECK ("store_commerce_setting"."vodafone_cash_number" IS NULL
        OR char_length("store_commerce_setting"."vodafone_cash_number") <= 32);--> statement-breakpoint
ALTER TABLE "store_commerce_setting" ADD CONSTRAINT "store_commerce_setting_vodafone_cash_account_name_length_check" CHECK ("store_commerce_setting"."vodafone_cash_account_name" IS NULL
        OR char_length("store_commerce_setting"."vodafone_cash_account_name") <= 120);--> statement-breakpoint
ALTER TABLE "store_commerce_setting" ADD CONSTRAINT "store_commerce_setting_vodafone_cash_instructions_length_check" CHECK (("store_commerce_setting"."vodafone_cash_instructions_ar" IS NULL
          OR char_length("store_commerce_setting"."vodafone_cash_instructions_ar") <= 1000)
        AND ("store_commerce_setting"."vodafone_cash_instructions_en" IS NULL
          OR char_length("store_commerce_setting"."vodafone_cash_instructions_en") <= 1000));--> statement-breakpoint
DROP TRIGGER IF EXISTS order_payment_claim_touch_updated_at ON order_payment_claim;--> statement-breakpoint
CREATE TRIGGER order_payment_claim_touch_updated_at
  BEFORE UPDATE ON order_payment_claim
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();
