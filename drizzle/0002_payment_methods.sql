ALTER TYPE "public"."action_type" ADD VALUE 'PAYMENT_METHOD';--> statement-breakpoint
CREATE TABLE "payment_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_label" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_method_translation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_method_id" uuid NOT NULL,
	"language_id" uuid NOT NULL,
	"title" text NOT NULL,
	"instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_action" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_method_translation" ADD CONSTRAINT "payment_method_translation_method_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_method"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_method_translation" ADD CONSTRAINT "payment_method_translation_language_id_language_id_fk" FOREIGN KEY ("language_id") REFERENCES "public"."language"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_method_translation_method_language_idx" ON "payment_method_translation" USING btree ("payment_method_id","language_id");--> statement-breakpoint
ALTER TABLE "product_action" ADD CONSTRAINT "product_action_payment_method_id_payment_method_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_method"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_action" ADD CONSTRAINT "product_action_payment_method_type_check" CHECK ("product_action"."action_type"::text = 'PAYMENT_METHOD' OR "product_action"."payment_method_id" IS NULL);--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_method_touch_updated_at ON payment_method;--> statement-breakpoint
CREATE TRIGGER payment_method_touch_updated_at
  BEFORE UPDATE ON payment_method
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS payment_method_translation_touch_updated_at ON payment_method_translation;--> statement-breakpoint
CREATE TRIGGER payment_method_translation_touch_updated_at
  BEFORE UPDATE ON payment_method_translation
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();
