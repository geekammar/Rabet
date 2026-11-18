CREATE TABLE "admin_login_throttle" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_login_throttle_singleton_check" CHECK ("admin_login_throttle"."id" = 1),
	CONSTRAINT "admin_login_throttle_attempt_count_check" CHECK ("admin_login_throttle"."attempt_count" >= 0)
);
