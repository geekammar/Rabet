CREATE TABLE "merchant_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_credential_password_hash_not_empty_check" CHECK (btrim("merchant_credential"."password_hash") <> ''),
	CONSTRAINT "merchant_credential_password_hash_argon2id_check" CHECK ("merchant_credential"."password_hash" LIKE '$argon2id$%')
);
--> statement-breakpoint
CREATE TABLE "merchant_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"invited_email" text NOT NULL,
	"token_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_invitation_email_not_empty_check" CHECK (btrim("merchant_invitation"."invited_email") <> ''),
	CONSTRAINT "merchant_invitation_email_normalized_check" CHECK ("merchant_invitation"."invited_email" = lower(btrim("merchant_invitation"."invited_email"))),
	CONSTRAINT "merchant_invitation_token_digest_format_check" CHECK ("merchant_invitation"."token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "merchant_invitation_expiry_after_creation_check" CHECK ("merchant_invitation"."expires_at" > "merchant_invitation"."created_at"),
	CONSTRAINT "merchant_invitation_terminal_state_check" CHECK (NOT ("merchant_invitation"."accepted_at" IS NOT NULL AND "merchant_invitation"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "merchant_credential" ADD CONSTRAINT "merchant_credential_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_invitation" ADD CONSTRAINT "merchant_invitation_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_invitation" ADD CONSTRAINT "merchant_invitation_invited_by_user_id_app_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_credential_user_id_unique" ON "merchant_credential" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_invitation_token_digest_unique" ON "merchant_invitation" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "merchant_invitation_store_idx" ON "merchant_invitation" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "merchant_invitation_invited_email_idx" ON "merchant_invitation" USING btree ("invited_email");--> statement-breakpoint
DROP TRIGGER IF EXISTS merchant_credential_touch_updated_at ON merchant_credential;--> statement-breakpoint
CREATE TRIGGER merchant_credential_touch_updated_at
  BEFORE UPDATE ON merchant_credential
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS merchant_invitation_touch_updated_at ON merchant_invitation;--> statement-breakpoint
CREATE TRIGGER merchant_invitation_touch_updated_at
  BEFORE UPDATE ON merchant_invitation
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();
