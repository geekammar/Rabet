CREATE TABLE "buyer_language_preference" (
	"store_id" uuid NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"locale" char(2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyer_language_preference_pk" PRIMARY KEY("store_id","telegram_user_id"),
	CONSTRAINT "buyer_language_preference_telegram_user_positive_check" CHECK ("buyer_language_preference"."telegram_user_id" > 0),
	CONSTRAINT "buyer_language_preference_locale_check" CHECK ("buyer_language_preference"."locale" IN ('ar', 'en'))
);
--> statement-breakpoint
CREATE TABLE "store_language_setting" (
	"store_id" uuid PRIMARY KEY NOT NULL,
	"locale" char(2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_language_setting_locale_check" CHECK ("store_language_setting"."locale" IN ('ar', 'en'))
);
--> statement-breakpoint
ALTER TABLE "buyer_language_preference" ADD CONSTRAINT "buyer_language_preference_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_language_setting" ADD CONSTRAINT "store_language_setting_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;