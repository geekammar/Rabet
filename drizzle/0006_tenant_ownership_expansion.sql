ALTER TABLE "category" ADD COLUMN "store_id" uuid;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "store_id" uuid;--> statement-breakpoint
ALTER TABLE "message_template" ADD COLUMN "store_id" uuid;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "store_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_method" ADD COLUMN "store_id" uuid;--> statement-breakpoint
ALTER TABLE "seller_notification_setting" ADD COLUMN "store_id" uuid;--> statement-breakpoint
ALTER TABLE "bot_setting" ADD COLUMN "store_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_update" ADD COLUMN "store_id" uuid;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template" ADD CONSTRAINT "message_template_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_method" ADD CONSTRAINT "payment_method_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_notification_setting" ADD CONSTRAINT "seller_notification_setting_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_setting" ADD CONSTRAINT "bot_setting_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_update" ADD CONSTRAINT "telegram_update_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "category_store_idx" ON "category" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "product_store_idx" ON "product" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "message_template_store_idx" ON "message_template" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "customer_store_idx" ON "customer" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "payment_method_store_idx" ON "payment_method" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "seller_notification_setting_store_idx" ON "seller_notification_setting" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "bot_setting_store_idx" ON "bot_setting" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "telegram_update_store_idx" ON "telegram_update" USING btree ("store_id");