CREATE TABLE "merchant_auth_throttle" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_auth_throttle_scope_key_pk" PRIMARY KEY("scope","key"),
	CONSTRAINT "merchant_auth_throttle_scope_check" CHECK ("merchant_auth_throttle"."scope" IN ('invitation_global', 'invitation_preview', 'invitation_accept', 'sign_in', 'sign_in_global')),
	CONSTRAINT "merchant_auth_throttle_key_format_check" CHECK ("merchant_auth_throttle"."key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "merchant_auth_throttle_attempt_count_check" CHECK ("merchant_auth_throttle"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "merchant_auth_throttle_window_idx" ON "merchant_auth_throttle" USING btree ("window_started_at");