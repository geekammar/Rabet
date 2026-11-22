ALTER TABLE "telegram_connection" ADD COLUMN "activation_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_connection" ADD COLUMN "webhook_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_connection" ADD COLUMN "webhook_operation_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_connection" ADD COLUMN "webhook_operation_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telegram_connection" ADD CONSTRAINT "telegram_connection_webhook_operation_consistency_check" CHECK ((
        ("telegram_connection"."webhook_operation_id" IS NULL
          AND "telegram_connection"."webhook_operation_attempt_id" IS NULL
          AND "telegram_connection"."webhook_operation_expires_at" IS NULL)
        OR
        ("telegram_connection"."webhook_operation_id" IS NOT NULL
          AND "telegram_connection"."webhook_operation_attempt_id" IS NOT NULL
          AND "telegram_connection"."webhook_operation_expires_at" IS NOT NULL)
      ));