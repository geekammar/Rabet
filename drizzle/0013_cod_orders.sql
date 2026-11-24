CREATE TABLE "cart" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"checkout_state" text DEFAULT 'cart' NOT NULL,
	"checkout_key" uuid,
	"customer_name" text,
	"customer_phone" text,
	"delivery_address" text,
	"quote_subtotal" numeric(18, 2),
	"quote_delivery_fee" numeric(18, 2),
	"quote_total" numeric(18, 2),
	"quote_currency" char(3),
	"quote_snapshot" jsonb,
	"quote_version" integer DEFAULT 0 NOT NULL,
	"quoted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_status_check" CHECK ("cart"."status" IN ('open', 'checkout', 'converted', 'abandoned')),
	CONSTRAINT "cart_checkout_state_check" CHECK ("cart"."checkout_state" IN ('cart', 'awaiting_phone', 'awaiting_address', 'review')),
	CONSTRAINT "cart_telegram_user_positive_check" CHECK ("cart"."telegram_user_id" > 0),
	CONSTRAINT "cart_telegram_chat_positive_check" CHECK ("cart"."telegram_chat_id" > 0),
	CONSTRAINT "cart_quote_version_nonnegative_check" CHECK ("cart"."quote_version" >= 0),
	CONSTRAINT "cart_quote_currency_allowlist_check" CHECK ("cart"."quote_currency" IS NULL OR "cart"."quote_currency" IN ('SAR', 'USD', 'AED', 'EGP')),
	CONSTRAINT "cart_quote_consistency_check" CHECK ((
        ("cart"."quote_subtotal" IS NULL
          AND "cart"."quote_delivery_fee" IS NULL
          AND "cart"."quote_total" IS NULL
          AND "cart"."quote_currency" IS NULL
          AND "cart"."quote_snapshot" IS NULL
          AND "cart"."quoted_at" IS NULL)
        OR
        ("cart"."quote_subtotal" IS NOT NULL
          AND "cart"."quote_delivery_fee" IS NOT NULL
          AND "cart"."quote_total" IS NOT NULL
          AND "cart"."quote_currency" IS NOT NULL
          AND "cart"."quote_snapshot" IS NOT NULL
          AND "cart"."quoted_at" IS NOT NULL
          AND "cart"."quote_subtotal" >= 0
          AND "cart"."quote_delivery_fee" >= 0
          AND "cart"."quote_total" = "cart"."quote_subtotal" + "cart"."quote_delivery_fee")
      ))
);
--> statement-breakpoint
CREATE TABLE "cart_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_item_quantity_check" CHECK ("cart_item"."quantity" > 0 AND "cart_item"."quantity" <= 99)
);
--> statement-breakpoint
CREATE TABLE "inventory_reservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservation_quantity_check" CHECK ("inventory_reservation"."quantity" > 0),
	CONSTRAINT "inventory_reservation_status_check" CHECK ("inventory_reservation"."status" IN ('reserved', 'committed', 'released'))
);
--> statement-breakpoint
CREATE TABLE "order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"reference" text NOT NULL,
	"checkout_key" uuid NOT NULL,
	"status" text DEFAULT 'placed' NOT NULL,
	"payment_method" text DEFAULT 'cod' NOT NULL,
	"payment_status" text DEFAULT 'awaiting_collection' NOT NULL,
	"fulfillment_status" text DEFAULT 'unfulfilled' NOT NULL,
	"currency" char(3) NOT NULL,
	"subtotal" numeric(18, 2) NOT NULL,
	"delivery_fee" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone" text NOT NULL,
	"delivery_address" text NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_reference_unique" UNIQUE("reference"),
	CONSTRAINT "order_reference_format_check" CHECK (reference ~ '^ORD-[A-HJ-NP-Z2-9]{6}$'),
	CONSTRAINT "order_status_check" CHECK ("order"."status" IN ('placed', 'cancelled')),
	CONSTRAINT "order_payment_method_check" CHECK ("order"."payment_method" = 'cod'),
	CONSTRAINT "order_payment_status_check" CHECK ("order"."payment_status" IN ('awaiting_collection', 'collected', 'failed')),
	CONSTRAINT "order_fulfillment_status_check" CHECK ("order"."fulfillment_status" IN ('unfulfilled', 'handed_to_shipping', 'delivered', 'cancelled')),
	CONSTRAINT "order_currency_allowlist_check" CHECK (currency IN ('SAR', 'USD', 'AED', 'EGP')),
	CONSTRAINT "order_totals_nonnegative_check" CHECK ("order"."subtotal" >= 0 AND "order"."delivery_fee" >= 0 AND "order"."total" >= 0),
	CONSTRAINT "order_total_matches_parts_check" CHECK ("order"."total" = "order"."subtotal" + "order"."delivery_fee"),
	CONSTRAINT "order_telegram_user_positive_check" CHECK ("order"."telegram_user_id" > 0),
	CONSTRAINT "order_telegram_chat_positive_check" CHECK ("order"."telegram_chat_id" > 0),
	CONSTRAINT "order_customer_name_not_empty_check" CHECK (btrim("order"."customer_name") <> ''),
	CONSTRAINT "order_customer_phone_not_empty_check" CHECK (btrim("order"."customer_phone") <> ''),
	CONSTRAINT "order_delivery_address_not_empty_check" CHECK (btrim("order"."delivery_address") <> '')
);
--> statement-breakpoint
CREATE TABLE "order_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"quantity" integer NOT NULL,
	"line_total" numeric(18, 2) NOT NULL,
	"product_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_quantity_check" CHECK ("order_item"."quantity" > 0),
	CONSTRAINT "order_item_totals_nonnegative_check" CHECK ("order_item"."unit_price" >= 0 AND "order_item"."line_total" >= 0),
	CONSTRAINT "order_item_line_total_check" CHECK ("order_item"."line_total" = "order_item"."unit_price" * "order_item"."quantity"),
	CONSTRAINT "order_item_product_name_not_empty_check" CHECK (btrim("order_item"."product_name") <> '')
);
--> statement-breakpoint
CREATE TABLE "product_inventory" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_inventory_on_hand_nonnegative_check" CHECK ("product_inventory"."on_hand" >= 0),
	CONSTRAINT "product_inventory_reserved_nonnegative_check" CHECK ("product_inventory"."reserved" >= 0),
	CONSTRAINT "product_inventory_reserved_within_on_hand_check" CHECK ("product_inventory"."reserved" <= "product_inventory"."on_hand")
);
--> statement-breakpoint
CREATE TABLE "store_commerce_setting" (
	"store_id" uuid PRIMARY KEY NOT NULL,
	"currency" char(3) NOT NULL,
	"delivery_fee" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"cod_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_commerce_setting_currency_allowlist_check" CHECK (currency IN ('SAR', 'USD', 'AED', 'EGP')),
	CONSTRAINT "store_commerce_setting_delivery_fee_nonnegative_check" CHECK ("store_commerce_setting"."delivery_fee" >= 0)
);
--> statement-breakpoint
ALTER TABLE "cart" ADD CONSTRAINT "cart_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart" ADD CONSTRAINT "cart_connection_id_telegram_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."telegram_connection"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_item" ADD CONSTRAINT "cart_item_cart_id_cart_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."cart"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_item" ADD CONSTRAINT "cart_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservation" ADD CONSTRAINT "inventory_reservation_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservation" ADD CONSTRAINT "inventory_reservation_order_item_id_order_item_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservation" ADD CONSTRAINT "inventory_reservation_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservation" ADD CONSTRAINT "inventory_reservation_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_connection_id_telegram_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."telegram_connection"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_id_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory" ADD CONSTRAINT "product_inventory_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_inventory" ADD CONSTRAINT "product_inventory_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_commerce_setting" ADD CONSTRAINT "store_commerce_setting_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cart_one_active_per_store_buyer_idx" ON "cart" USING btree ("store_id","telegram_user_id") WHERE "cart"."status" IN ('open', 'checkout');--> statement-breakpoint
CREATE INDEX "cart_store_idx" ON "cart" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "cart_connection_idx" ON "cart" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "cart_telegram_user_idx" ON "cart" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_item_cart_product_unique" ON "cart_item" USING btree ("cart_id","product_id");--> statement-breakpoint
CREATE INDEX "cart_item_cart_idx" ON "cart_item" USING btree ("cart_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_order_item_unique" ON "inventory_reservation" USING btree ("order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_order_product_unique" ON "inventory_reservation" USING btree ("order_id","product_id");--> statement-breakpoint
CREATE INDEX "inventory_reservation_order_idx" ON "inventory_reservation" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "inventory_reservation_store_idx" ON "inventory_reservation" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "inventory_reservation_product_idx" ON "inventory_reservation" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_store_checkout_key_unique" ON "order" USING btree ("store_id","checkout_key");--> statement-breakpoint
CREATE INDEX "order_store_placed_idx" ON "order" USING btree ("store_id","placed_at");--> statement-breakpoint
CREATE INDEX "order_telegram_user_idx" ON "order" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_item_order_product_unique" ON "order_item" USING btree ("order_id","product_id");--> statement-breakpoint
CREATE INDEX "order_item_order_idx" ON "order_item" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "product_inventory_store_idx" ON "product_inventory" USING btree ("store_id");--> statement-breakpoint
DROP TRIGGER IF EXISTS store_commerce_setting_touch_updated_at ON store_commerce_setting;--> statement-breakpoint
CREATE TRIGGER store_commerce_setting_touch_updated_at
  BEFORE UPDATE ON store_commerce_setting
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS product_inventory_touch_updated_at ON product_inventory;--> statement-breakpoint
CREATE TRIGGER product_inventory_touch_updated_at
  BEFORE UPDATE ON product_inventory
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS cart_touch_updated_at ON cart;--> statement-breakpoint
CREATE TRIGGER cart_touch_updated_at
  BEFORE UPDATE ON cart
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS cart_item_touch_updated_at ON cart_item;--> statement-breakpoint
CREATE TRIGGER cart_item_touch_updated_at
  BEFORE UPDATE ON cart_item
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS order_touch_updated_at ON "order";--> statement-breakpoint
CREATE TRIGGER order_touch_updated_at
  BEFORE UPDATE ON "order"
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
DROP TRIGGER IF EXISTS inventory_reservation_touch_updated_at ON inventory_reservation;--> statement-breakpoint
CREATE TRIGGER inventory_reservation_touch_updated_at
  BEFORE UPDATE ON inventory_reservation
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_order_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.store_id IS DISTINCT FROM OLD.store_id
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.telegram_user_id IS DISTINCT FROM OLD.telegram_user_id
    OR NEW.telegram_chat_id IS DISTINCT FROM OLD.telegram_chat_id
    OR NEW.reference IS DISTINCT FROM OLD.reference
    OR NEW.checkout_key IS DISTINCT FROM OLD.checkout_key
    OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
    OR NEW.delivery_fee IS DISTINCT FROM OLD.delivery_fee
    OR NEW.total IS DISTINCT FROM OLD.total
    OR NEW.customer_name IS DISTINCT FROM OLD.customer_name
    OR NEW.customer_phone IS DISTINCT FROM OLD.customer_phone
    OR NEW.delivery_address IS DISTINCT FROM OLD.delivery_address
    OR NEW.placed_at IS DISTINCT FROM OLD.placed_at
  THEN
    RAISE EXCEPTION 'order snapshot columns are immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS order_guard_snapshot ON "order";--> statement-breakpoint
CREATE TRIGGER order_guard_snapshot
  BEFORE UPDATE ON "order"
  FOR EACH ROW
  EXECUTE FUNCTION guard_order_snapshot();--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_order_item_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order_item rows are immutable';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS order_item_guard_snapshot ON order_item;--> statement-breakpoint
CREATE TRIGGER order_item_guard_snapshot
  BEFORE UPDATE ON order_item
  FOR EACH ROW
  EXECUTE FUNCTION guard_order_item_snapshot();
