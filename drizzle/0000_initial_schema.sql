CREATE TYPE "public"."action_type" AS ENUM('OPEN_SUBMENU', 'START_INQUIRY', 'SHOW_DETAILS', 'SEND_TEMPLATE_MESSAGE', 'OPEN_URL', 'OPEN_SUPPORT', 'NAVIGATE_CATALOG');--> statement-breakpoint
CREATE TYPE "public"."inquiry_status" AS ENUM('open', 'waiting_on_customer', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."message_author" AS ENUM('customer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."message_delivery" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "product_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"parent_action_id" uuid,
	"action_type" "action_type" NOT NULL,
	"url" text,
	"navigate_category_id" uuid,
	"navigate_product_id" uuid,
	"action_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_action_no_self_parent_check" CHECK ("product_action"."parent_action_id" <> "product_action"."id"),
	CONSTRAINT "product_action_url_https_check" CHECK ("product_action"."url" IS NULL OR "product_action"."url" ~ '^https://'),
	CONSTRAINT "product_action_navigation_target_exclusive_check" CHECK (NOT ("product_action"."navigate_category_id" IS NOT NULL AND "product_action"."navigate_product_id" IS NOT NULL)),
	CONSTRAINT "product_action_navigation_target_type_check" CHECK ("product_action"."action_type" = 'NAVIGATE_CATALOG' OR ("product_action"."navigate_category_id" IS NULL AND "product_action"."navigate_product_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "product_action_translation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"language_id" uuid NOT NULL,
	"label" text NOT NULL,
	"menu_text" text,
	"template_body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_action_translation_label_length_check" CHECK (length("product_action_translation"."label") <= 64)
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_slug_unique" UNIQUE("slug"),
	CONSTRAINT "category_no_self_parent_check" CHECK ("category"."parent_id" <> "category"."id")
);
--> statement-breakpoint
CREATE TABLE "category_translation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"language_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"price" numeric(18, 2) NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_slug_unique" UNIQUE("slug"),
	CONSTRAINT "product_price_nonnegative_check" CHECK ("product"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_translation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"language_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_template_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "message_translation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"language_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_translation_body_length_check" CHECK (length("message_translation"."body") <= 4096)
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" bigint NOT NULL,
	"telegram_username" text,
	"first_name" text,
	"last_name" text,
	"language_code" text,
	"selected_language_id" uuid,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_telegram_id_unique" UNIQUE("telegram_id")
);
--> statement-breakpoint
CREATE TABLE "inquiry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid,
	"reference" text NOT NULL,
	"status" "inquiry_status" DEFAULT 'open' NOT NULL,
	"category" text,
	"product_snapshot" jsonb NOT NULL,
	"selected_options" jsonb,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reply_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inquiry_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "inquiry_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inquiry_id" uuid NOT NULL,
	"author" "message_author" NOT NULL,
	"body" text NOT NULL,
	"telegram_message_id" bigint,
	"delivery_status" "message_delivery" DEFAULT 'pending' NOT NULL,
	"delivery_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inquiry_message_body_length_check" CHECK (length("inquiry_message"."body") <= 4096)
);
--> statement-breakpoint
CREATE TABLE "bot_setting" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"default_language_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"display_name" text NOT NULL,
	"ask_for_language" boolean DEFAULT true NOT NULL,
	"support_category" text[] DEFAULT '{}'::text[] NOT NULL,
	"support_reply_time" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_setting_singleton_check" CHECK ("bot_setting"."id" = 1),
	CONSTRAINT "bot_setting_currency_allowlist_check" CHECK ("bot_setting"."currency" IN ('SAR', 'USD', 'AED', 'EGP'))
);
--> statement-breakpoint
CREATE TABLE "language" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" char(2) NOT NULL,
	"label" text NOT NULL,
	"text_direction" text DEFAULT 'ltr' NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "language_code_unique" UNIQUE("code"),
	CONSTRAINT "language_text_direction_check" CHECK ("language"."text_direction" IN ('ltr', 'rtl'))
);
--> statement-breakpoint
CREATE TABLE "telegram_update" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"update_id" bigint NOT NULL,
	"update_type" text NOT NULL,
	"payload" jsonb,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_update_update_id_unique" UNIQUE("update_id")
);
--> statement-breakpoint
ALTER TABLE "product_action" ADD CONSTRAINT "product_action_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_action" ADD CONSTRAINT "product_action_parent_action_id_product_action_id_fk" FOREIGN KEY ("parent_action_id") REFERENCES "public"."product_action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_action" ADD CONSTRAINT "product_action_navigate_category_id_category_id_fk" FOREIGN KEY ("navigate_category_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_action" ADD CONSTRAINT "product_action_navigate_product_id_product_id_fk" FOREIGN KEY ("navigate_product_id") REFERENCES "public"."product"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_action_translation" ADD CONSTRAINT "product_action_translation_action_id_product_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."product_action"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_action_translation" ADD CONSTRAINT "product_action_translation_language_id_language_id_fk" FOREIGN KEY ("language_id") REFERENCES "public"."language"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_parent_id_category_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_translation" ADD CONSTRAINT "category_translation_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_translation" ADD CONSTRAINT "category_translation_language_id_language_id_fk" FOREIGN KEY ("language_id") REFERENCES "public"."language"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_translation" ADD CONSTRAINT "product_translation_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_translation" ADD CONSTRAINT "product_translation_language_id_language_id_fk" FOREIGN KEY ("language_id") REFERENCES "public"."language"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translation" ADD CONSTRAINT "message_translation_template_id_message_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."message_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_translation" ADD CONSTRAINT "message_translation_language_id_language_id_fk" FOREIGN KEY ("language_id") REFERENCES "public"."language"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_selected_language_id_language_id_fk" FOREIGN KEY ("selected_language_id") REFERENCES "public"."language"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_message" ADD CONSTRAINT "inquiry_message_inquiry_id_inquiry_id_fk" FOREIGN KEY ("inquiry_id") REFERENCES "public"."inquiry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_setting" ADD CONSTRAINT "bot_setting_default_language_id_language_id_fk" FOREIGN KEY ("default_language_id") REFERENCES "public"."language"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_action_tree_idx" ON "product_action" USING btree ("product_id","parent_action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_action_sibling_sort_order_idx" ON "product_action" USING btree ("parent_action_id","sort_order") WHERE parent_action_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_action_root_sort_order_idx" ON "product_action" USING btree ("product_id","sort_order") WHERE parent_action_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_action_translation_action_language_idx" ON "product_action_translation" USING btree ("action_id","language_id");--> statement-breakpoint
CREATE INDEX "category_parent_idx" ON "category" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "category_active_idx" ON "category" USING btree ("is_active") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "category_sibling_sort_order_idx" ON "category" USING btree ("parent_id","sort_order") WHERE parent_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "category_root_sort_order_idx" ON "category" USING btree ("sort_order") WHERE parent_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "category_translation_category_language_idx" ON "category_translation" USING btree ("category_id","language_id");--> statement-breakpoint
CREATE INDEX "product_category_order_idx" ON "product" USING btree ("category_id","sort_order") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_translation_product_language_idx" ON "product_translation" USING btree ("product_id","language_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_translation_template_language_idx" ON "message_translation" USING btree ("template_id","language_id");--> statement-breakpoint
CREATE INDEX "inquiry_customer_status_idx" ON "inquiry" USING btree ("customer_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "inquiry_active_per_customer_product_idx" ON "inquiry" USING btree ("customer_id","product_id") WHERE status IN ('open', 'waiting_on_customer');--> statement-breakpoint
CREATE UNIQUE INDEX "inquiry_message_telegram_message_idx" ON "inquiry_message" USING btree ("inquiry_id","telegram_message_id");--> statement-breakpoint
CREATE INDEX "inquiry_message_thread_order_idx" ON "inquiry_message" USING btree ("inquiry_id","created_at");