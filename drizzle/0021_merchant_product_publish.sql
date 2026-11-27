ALTER TABLE "product" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "store_commerce_setting" ADD COLUMN "delivery_fee_configured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_image_url_check" CHECK ("product"."image_url" IS NULL
        OR (char_length("product"."image_url") <= 2048
          AND "product"."image_url" ~* '^https?://'));--> statement-breakpoint
UPDATE "store_commerce_setting"
  SET "delivery_fee_configured" = true
  WHERE "delivery_fee" > 0;