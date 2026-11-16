CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"platform_role" text DEFAULT 'user' NOT NULL,
	"session_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_not_empty_check" CHECK (btrim("app_user"."email") <> ''),
	CONSTRAINT "app_user_email_trimmed_check" CHECK ("app_user"."email" = btrim("app_user"."email")),
	CONSTRAINT "app_user_status_check" CHECK ("app_user"."status" IN ('active', 'disabled')),
	CONSTRAINT "app_user_platform_role_check" CHECK ("app_user"."platform_role" IN ('user', 'super_admin')),
	CONSTRAINT "app_user_session_version_nonnegative_check" CHECK ("app_user"."session_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "store" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'onboarding' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_slug_unique" UNIQUE("slug"),
	CONSTRAINT "store_name_not_empty_check" CHECK (btrim("store"."name") <> ''),
	CONSTRAINT "store_slug_format_check" CHECK ("store"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "store_status_check" CHECK ("store"."status" IN ('onboarding', 'active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "store_membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_membership_role_check" CHECK ("store_membership"."role" IN ('owner')),
	CONSTRAINT "store_membership_status_check" CHECK ("store_membership"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "store_membership" ADD CONSTRAINT "store_membership_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_membership" ADD CONSTRAINT "store_membership_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_lower_unique" ON "app_user" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "store_membership_store_user_unique" ON "store_membership" USING btree ("store_id","user_id");--> statement-breakpoint
DROP TRIGGER IF EXISTS store_touch_updated_at ON store;--> statement-breakpoint
CREATE TRIGGER store_touch_updated_at
  BEFORE UPDATE ON store
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS app_user_touch_updated_at ON app_user;--> statement-breakpoint
CREATE TRIGGER app_user_touch_updated_at
  BEFORE UPDATE ON app_user
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS store_membership_touch_updated_at ON store_membership;--> statement-breakpoint
CREATE TRIGGER store_membership_touch_updated_at
  BEFORE UPDATE ON store_membership
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();