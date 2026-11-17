import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import {
  botSetting,
  category,
  categoryTranslation,
  customer,
  inquiry,
  inquiryMessage,
  language,
  messageTemplate,
  messageTranslation,
  paymentMethod,
  paymentMethodTranslation,
  product,
  productAction,
  productActionTranslation,
  productTranslation,
  sellerNotificationDelivery,
  sellerNotificationSetting,
  store,
  telegramUpdate,
} from "@/db/schema";
import { upsertCustomer } from "@/lib/data/customer";
import { claimTelegramUpdate } from "@/lib/data/telegram";
import {
  asAppDb,
  createTestDatabase,
  hasTestCluster,
  pgErrorCode,
  pgErrorMessage,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();
const migrationsFolder = path.resolve(import.meta.dirname, "../../drizzle");
const backfillFile = path.resolve(
  import.meta.dirname,
  "../../docs/backfill/legacy-store-backfill.sql",
);
const verificationFile = path.resolve(
  import.meta.dirname,
  "../../docs/backfill/legacy-store-verification.sql",
);
const backfillSql = readFileSync(backfillFile, "utf8");
const verificationSql = readFileSync(verificationFile, "utf8");

const OWNERSHIP_TABLES = [
  "bot_setting",
  "category",
  "product",
  "payment_method",
  "message_template",
  "customer",
  "seller_notification_setting",
  "telegram_update",
] as const;

const ALL_STORE_ID_TABLES = [...OWNERSHIP_TABLES, "store_membership"] as const;

const DERIVED_TABLES = [
  "inquiry",
  "category_translation",
  "product_translation",
  "product_action",
  "product_action_translation",
  "message_translation",
  "payment_method_translation",
  "inquiry_message",
  "seller_notification_delivery",
  "language",
] as const;

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;
  testDb = await createTestDatabase("tenant_ownership");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;

  await testDb.db.execute(sql`
    truncate table
      "seller_notification_delivery",
      "inquiry_message",
      "seller_notification_setting",
      "inquiry",
      "customer",
      "product_action_translation",
      "product_action",
      "product_translation",
      "product",
      "category_translation",
      "category",
      "payment_method_translation",
      "payment_method",
      "message_translation",
      "message_template",
      "telegram_update",
      "bot_setting",
      "language",
      "store_membership",
      "app_user",
      "store"
    restart identity cascade
  `);
});

async function seedLegacyData() {
  const db = testDb!.db;
  const [lang] = await db
    .insert(language)
    .values({ code: "en", label: "English", isEnabled: true })
    .returning();
  const [settings] = await db
    .insert(botSetting)
    .values({
      defaultLanguageId: lang.id,
      currency: "USD",
      displayName: "Legacy Store",
    })
    .returning();
  const [root] = await db
    .insert(category)
    .values({ slug: "root", sortOrder: 1, isActive: true })
    .returning();
  const [child] = await db
    .insert(category)
    .values({
      parentId: root.id,
      slug: "child",
      sortOrder: 1,
      isActive: true,
    })
    .returning();
  await db.insert(categoryTranslation).values({
    categoryId: child.id,
    languageId: lang.id,
    name: "Child",
  });
  const [activeProduct] = await db
    .insert(product)
    .values({
      categoryId: child.id,
      slug: "active-product",
      price: "10.00",
      isActive: true,
      sortOrder: 1,
    })
    .returning();
  const [inactiveProduct] = await db
    .insert(product)
    .values({
      categoryId: child.id,
      slug: "inactive-product",
      price: "20.00",
      isActive: false,
      sortOrder: 2,
    })
    .returning();
  await db.insert(productTranslation).values({
    productId: activeProduct.id,
    languageId: lang.id,
    name: "Active Product",
    description: "Visible",
  });
  const [action] = await db
    .insert(productAction)
    .values({
      productId: activeProduct.id,
      actionType: "OPEN_SUBMENU",
      sortOrder: 1,
    })
    .returning();
  await db.insert(productActionTranslation).values({
    actionId: action.id,
    languageId: lang.id,
    label: "Menu",
  });
  const [method] = await db
    .insert(paymentMethod)
    .values({ adminLabel: "Cash", isActive: false, sortOrder: 1 })
    .returning();
  await db.insert(paymentMethodTranslation).values({
    paymentMethodId: method.id,
    languageId: lang.id,
    title: "Cash",
    instructions: "Pay on delivery",
  });
  const [template] = await db
    .insert(messageTemplate)
    .values({ key: "bot_welcome", description: "Welcome" })
    .returning();
  await db.insert(messageTranslation).values({
    templateId: template.id,
    languageId: lang.id,
    body: "Welcome",
  });
  const [customerRow] = await db
    .insert(customer)
    .values({ telegramId: 123456789, firstName: "Legacy" })
    .returning();
  const [inquiryRow] = await db
    .insert(inquiry)
    .values({
      customerId: customerRow.id,
      productId: activeProduct.id,
      reference: "INQ-LEGACY",
      productSnapshot: {
        name: "Active Product",
        price: "10.00",
        currency: "USD",
      },
      selectedOptions: ["Menu"],
    })
    .returning();
  await db.insert(inquiryMessage).values({
    inquiryId: inquiryRow.id,
    author: "customer",
    body: "Hello",
    telegramMessageId: 9001,
    deliveryStatus: "sent",
    deliveredAt: new Date(),
  });
  await db.insert(sellerNotificationSetting).values({
    enabled: true,
    destinationChatId: "123456789",
    language: "en",
    verifiedAt: new Date(),
    verifiedBotId: 123,
    verifiedBotUsername: "legacy_bot",
    verifiedChatId: "123456789",
    revision: 4,
  });
  await db.insert(sellerNotificationDelivery).values({
    inquiryId: inquiryRow.id,
    reference: "SND-LEGACY",
    revision: 4,
    destinationChatId: "123456789",
    status: "sent",
    sentAt: new Date(),
  });
  await db.insert(telegramUpdate).values({
    updateId: 5001,
    updateType: "message",
    payload: { update: { message: { message_id: 9001 } } },
    processedAt: new Date(),
  });

  return {
    settings,
    root,
    child,
    activeProduct,
    inactiveProduct,
    action,
    method,
    template,
    customerRow,
    inquiryRow,
  };
}

async function runBackfillOn(db: TestDatabase["db"]) {
  await db.execute(sql.raw(backfillSql));
}

async function runBackfill() {
  await runBackfillOn(testDb!.db);
}

async function ownershipSnapshot() {
  const db = testDb!.db;

  const categories = await db.execute(sql`
    select "id", "parent_id", "slug", "sort_order", "is_active", "deleted_at"
    from "category" order by "id"
  `);
  const products = await db.execute(sql`
    select "id", "category_id", "slug", "price", "is_active", "sort_order", "deleted_at"
    from "product" order by "id"
  `);
  const inquiries = await db.execute(sql`
    select "id", "customer_id", "product_id", "reference", "status",
           "product_snapshot", "selected_options"
    from "inquiry" order by "id"
  `);
  const deliveries = await db.execute(sql`
    select "id", "inquiry_id", "reference", "status", "sent_at", "failed_at",
           "telegram_message_id", "attempt_count"
    from "seller_notification_delivery" order by "id"
  `);
  const updates = await db.execute(sql`
    select "id", "update_id", "update_type", "processed_at", "processing_error"
    from "telegram_update" order by "id"
  `);
  const translations = await db.execute(sql`
    select
      (select count(*)::int from "category_translation") as category_translation,
      (select count(*)::int from "product_translation") as product_translation,
      (select count(*)::int from "product_action_translation") as action_translation,
      (select count(*)::int from "message_translation") as message_translation,
      (select count(*)::int from "payment_method_translation") as payment_method_translation
  `);
  const timestamps = await db.execute<{ data: Record<string, unknown> }>(sql`
    select jsonb_build_object(
      'bot_setting', (select jsonb_agg(jsonb_build_object('id', "id", 'updated_at', "updated_at") order by "id") from "bot_setting"),
      'category', (select jsonb_agg(jsonb_build_object('id', "id", 'updated_at', "updated_at") order by "id") from "category"),
      'customer', (select jsonb_agg(jsonb_build_object('id', "id", 'updated_at', "updated_at") order by "id") from "customer"),
      'message_template', (select jsonb_agg(jsonb_build_object('id', "id", 'updated_at', "updated_at") order by "id") from "message_template"),
      'payment_method', (select jsonb_agg(jsonb_build_object('id', "id", 'updated_at', "updated_at") order by "id") from "payment_method"),
      'product', (select jsonb_agg(jsonb_build_object('id', "id", 'updated_at', "updated_at") order by "id") from "product"),
      'seller_notification_setting', (select jsonb_agg(jsonb_build_object('id', "id", 'updated_at', "updated_at") order by "id") from "seller_notification_setting")
    ) as data
  `);

  return {
    categories,
    products,
    inquiries,
    deliveries,
    updates,
    translations: translations[0],
    timestamps: timestamps[0].data,
  };
}

describe("S1.2 migration static safety", () => {
  it("adds only the eight nullable ownership columns", () => {
    const migration = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../drizzle/0006_tenant_ownership_expansion.sql",
      ),
      "utf8",
    );

    const columns = [
      ...migration.matchAll(/ALTER TABLE "([^"]+)" ADD COLUMN "store_id" uuid;/g),
    ].map((match) => match[1]);

    expect(columns.sort()).toEqual([...OWNERSHIP_TABLES].sort());
    expect(migration).not.toMatch(/\bNOT NULL\b/);
    expect(migration).not.toMatch(/\bCREATE TABLE\b/i);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migration).not.toMatch(/\bUPDATE\s+"[a-z_]+"\s+SET\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|INDEX|CONSTRAINT)\b/i);
    expect(migration).not.toMatch(/\bALTER COLUMN\b/i);
    expect(migration).not.toMatch(/\bADD CONSTRAINT "[^"]+" UNIQUE\b/i);
    expect(migration).not.toMatch(/\bNOTIFY\b/i);
  });

  it("keeps the backfill and verification artifacts non-automatic and non-networked", () => {
    const backfill = readFileSync(backfillFile, "utf8");
    const verification = readFileSync(verificationFile, "utf8");

    expect(backfill).toContain("NOT EXECUTED BY THE REPOSITORY");
    expect(backfill).toContain("DO $legacy_store_backfill$");
    expect(backfill).not.toContain("--> statement-breakpoint");
    expect(backfill).not.toMatch(/https?:\/\//i);
    expect(backfill).not.toMatch(/\b(sendMessage|pg_notify|NOTIFY)\b/i);
    expect(verification).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(verification).not.toMatch(/https?:\/\//i);
  });
});

describe.skipIf(!shouldRun)("S1.2 tenant ownership schema", () => {
  it("applies after 0005 and keeps every legacy object", async () => {
    const journal = await testDb!.db.execute<{ count: number }>(sql`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `);
    expect(journal[0].count).toBe(7);

    const tables = await testDb!.db.execute<{ count: number }>(sql`
      select count(*)::int as count from information_schema.tables
      where table_schema = 'public'
    `);
    expect(tables[0].count).toBe(21);

    const columns = await testDb!.db.execute<{
      table_name: string;
      data_type: string;
      is_nullable: string;
    }>(sql`
      select table_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public' and column_name = 'store_id'
      order by table_name
    `);

    expect(columns.map((column) => column.table_name)).toEqual(
      [...ALL_STORE_ID_TABLES].sort(),
    );
    for (const column of columns) {
      expect(column.data_type).toBe("uuid");
      expect(column.is_nullable).toBe(
        column.table_name === "store_membership" ? "NO" : "YES",
      );
    }

    for (const table of DERIVED_TABLES) {
      const derived = await testDb!.db.execute<{ count: number }>(sql`
        select count(*)::int as count
        from information_schema.columns
        where table_schema = 'public'
          and table_name = ${table}
          and column_name = 'store_id'
      `);
      expect(derived[0].count).toBe(0);
    }

    const indexes = await testDb!.db.execute<{ name: string }>(sql`
      select indexname as name from pg_indexes where schemaname = 'public'
    `);
    const indexNames = new Set(indexes.map((row) => row.name));

    for (const index of [
      "category_slug_unique",
      "product_slug_unique",
      "customer_telegram_id_unique",
      "message_template_key_unique",
      "telegram_update_update_id_unique",
      "inquiry_reference_unique",
      "category_translation_category_language_idx",
      "product_translation_product_language_idx",
      "product_action_translation_action_language_idx",
      "message_translation_template_language_idx",
      "payment_method_translation_method_language_idx",
      "seller_notification_delivery_event_inquiry_idx",
      "seller_notification_delivery_reference_unique",
      "app_user_email_lower_unique",
      "store_slug_unique",
      "store_membership_store_user_unique",
    ]) {
      expect(indexNames.has(index)).toBe(true);
    }

    for (const index of [
      "bot_setting_store_idx",
      "category_store_idx",
      "product_store_idx",
      "message_template_store_idx",
      "customer_store_idx",
      "payment_method_store_idx",
      "seller_notification_setting_store_idx",
      "telegram_update_store_idx",
    ]) {
      expect(indexNames.has(index)).toBe(true);
    }

    const constraints = await testDb!.db.execute<{ name: string }>(sql`
      select conname as name from pg_constraint
      where connamespace = 'public'::regnamespace
    `);
    const constraintNames = new Set(constraints.map((row) => row.name));

    for (const constraint of [
      "category_parent_id_category_id_fk",
      "product_category_id_category_id_fk",
      "inquiry_customer_id_customer_id_fk",
      "inquiry_product_id_product_id_fk",
      "inquiry_message_inquiry_id_inquiry_id_fk",
      "seller_notification_delivery_inquiry_id_fk",
      "bot_setting_default_language_id_language_id_fk",
      "bot_setting_singleton_check",
      "seller_notification_setting_singleton_check",
    ]) {
      expect(constraintNames.has(constraint)).toBe(true);
    }

    for (const table of OWNERSHIP_TABLES) {
      const expected = `${table}_store_id_store_id_fk`;
      expect(constraintNames.has(expected)).toBe(true);
    }
  });

  it("seeds no store, app_user or membership", async () => {
    const rows = await testDb!.db.execute<{
      store_count: number;
      user_count: number;
      membership_count: number;
    }>(sql`
      select
        (select count(*)::int from "store") as store_count,
        (select count(*)::int from "app_user") as user_count,
        (select count(*)::int from "store_membership") as membership_count
    `);

    expect(rows[0]).toEqual({
      store_count: 0,
      user_count: 0,
      membership_count: 0,
    });
  });

  it("keeps existing single-store inserts working with NULL ownership", async () => {
    const seeded = await seedLegacyData();

    expect(seeded.settings.storeId).toBeNull();
    expect(seeded.root.storeId).toBeNull();
    expect(seeded.child.storeId).toBeNull();
    expect(seeded.activeProduct.storeId).toBeNull();
    expect(seeded.inactiveProduct.storeId).toBeNull();
    expect(seeded.activeProduct.isActive).toBe(true);
    expect(seeded.inactiveProduct.isActive).toBe(false);

    const upserted = await upsertCustomer(asAppDb(testDb!.db), {
      telegramId: 987654321,
      firstName: "Runtime",
    });
    expect(upserted.storeId).toBeNull();

    const claimed = await claimTelegramUpdate(asAppDb(testDb!.db), {
      updateId: 7001,
      updateType: "message",
      payload: { message: { message_id: 1 } },
    });
    expect(claimed.status).toBe("claimed");
    expect(claimed.row.storeId).toBeNull();
  });

  it("validates the store foreign key without requiring a store", async () => {
    const db = testDb!.db;
    const [legacyStore] = await db
      .insert(store)
      .values({ name: "Legacy", slug: `legacy-${randomUUID()}` })
      .returning();
    const [ownedCategory] = await db
      .insert(category)
      .values({
        storeId: legacyStore.id,
        slug: "owned",
        sortOrder: 1,
      })
      .returning();

    expect(ownedCategory.storeId).toBe(legacyStore.id);

    let caught: unknown;
    try {
      await db.insert(category).values({
        storeId: randomUUID(),
        slug: "unknown-store",
        sortOrder: 2,
      });
    } catch (error) {
      caught = error;
    }
    expect(pgErrorCode(caught)).toBe("23503");

    caught = undefined;
    try {
      await db.delete(store).where(sql`"id" = ${legacyStore.id}`);
    } catch (error) {
      caught = error;
    }
    expect(pgErrorCode(caught)).toBe("23001");
  });

  it("still rejects duplicate legacy business keys after ownership expansion", async () => {
    const db = testDb!.db;
    const seeded = await seedLegacyData();

    const expectDuplicate = async (operation: () => Promise<unknown>) => {
      let caught: unknown;
      try {
        await operation();
      } catch (error) {
        caught = error;
      }
      expect(pgErrorCode(caught)).toBe("23505");
    };

    await expectDuplicate(() =>
      db.insert(category).values({ slug: seeded.root.slug, sortOrder: 99 }),
    );
    await expectDuplicate(() =>
      db.insert(product).values({
        categoryId: seeded.child.id,
        slug: seeded.activeProduct.slug,
        price: "1.00",
        sortOrder: 99,
      }),
    );
    await expectDuplicate(() =>
      db.insert(customer).values({ telegramId: seeded.customerRow.telegramId }),
    );
    await expectDuplicate(() =>
      db.insert(messageTemplate).values({ key: seeded.template.key }),
    );
    await expectDuplicate(() =>
      db.insert(telegramUpdate).values({ updateId: 5001, updateType: "message" }),
    );
    await expectDuplicate(() =>
      db.insert(botSetting).values({
        id: 1,
        defaultLanguageId: seeded.settings.defaultLanguageId,
        currency: "USD",
        displayName: "Second",
      }),
    );
    await expectDuplicate(() =>
      db.insert(sellerNotificationSetting).values({ id: 1 }),
    );
    await expectDuplicate(() =>
      db.insert(inquiry).values({
        customerId: seeded.customerRow.id,
        productId: seeded.activeProduct.id,
        reference: "INQ-LEGACY",
        productSnapshot: {},
      }),
    );
  });

  it("backfills the legacy store idempotently without changing business state", async () => {
    const seeded = await seedLegacyData();
    const before = await ownershipSnapshot();

    await runBackfill();

    const firstStore = await testDb!.db.execute<{ id: string; slug: string; status: string }>(sql`
      select "id", "slug", "status" from "store" where "slug" = 'legacy-store'
    `);
    expect(firstStore).toHaveLength(1);
    expect(firstStore[0].status).toBe("active");

    const coverage = await testDb!.db.execute<{
      total: number;
      owned: number;
      unowned: number;
    }>(sql`
      select
        (select count(*)::int from "bot_setting") as total,
        (select count(*)::int from "bot_setting" where "store_id" is not null) as owned,
        (select count(*)::int from "bot_setting" where "store_id" is null) as unowned
    `);
    expect(coverage[0]).toEqual({
      total: 1,
      owned: 1,
      unowned: 0,
    });

    for (const table of OWNERSHIP_TABLES) {
      const rows = await testDb!.db.execute<{ unowned: number; other: number }>(sql`
        select
          count(*) filter (where "store_id" is null)::int as unowned,
          count(*) filter (where "store_id" is not null and "store_id" <> ${firstStore[0].id})::int as other
        from ${sql.raw(`"${table}"`)}
      `);
      expect(rows[0].unowned).toBe(0);
      expect(rows[0].other).toBe(0);
    }

    const afterFirst = await ownershipSnapshot();
    expect(afterFirst.categories).toEqual(before.categories);
    expect(afterFirst.products).toEqual(before.products);
    expect(afterFirst.inquiries).toEqual(before.inquiries);
    expect(afterFirst.deliveries).toEqual(before.deliveries);
    expect(afterFirst.updates).toEqual(before.updates);
    expect(afterFirst.translations).toEqual(before.translations);
    expect(afterFirst.timestamps).toEqual(before.timestamps);

    const firstDelivery = await testDb!.db.execute<{ status: string }>(sql`
      select "status" from "seller_notification_delivery" where "reference" = 'SND-LEGACY'
    `);
    expect(firstDelivery[0].status).toBe("sent");

    const firstUpdate = await testDb!.db.execute<{ update_id: string }>(sql`
      select "update_id"::text from "telegram_update" where "update_id" = 5001
    `);
    expect(firstUpdate[0].update_id).toBe("5001");

    await runBackfill();

    const secondStore = await testDb!.db.execute<{ id: string }>(sql`
      select "id" from "store" where "slug" = 'legacy-store'
    `);
    const storeCount = await testDb!.db.execute<{ count: number }>(sql`
      select count(*)::int as count from "store"
    `);
    expect(storeCount[0].count).toBe(1);
    expect(secondStore[0].id).toBe(firstStore[0].id);

    const afterSecond = await ownershipSnapshot();
    expect(afterSecond).toEqual(afterFirst);

    const verification = await testDb!.db.execute<{
      kind: string;
      check_name: string;
      actual: string;
      expected: string | null;
      ok: boolean | null;
    }>(sql.raw(verificationSql));
    const assertions = verification.filter((row) => row.kind === "assertion");
    expect(assertions.length).toBeGreaterThan(0);
    expect(assertions.every((row) => row.ok === true)).toBe(true);
    expect(
      verification.some(
        (row) => row.kind === "metric" && row.check_name === "translation_counts",
      ),
    ).toBe(true);

    const deliveryCount = await testDb!.db.execute<{ count: number }>(sql`
      select count(*)::int as count from "seller_notification_delivery"
    `);
    expect(deliveryCount[0].count).toBe(1);

    const duplicateUpdates = await testDb!.db.execute<{ count: number }>(sql`
      select count(*)::int as count from (
        select "update_id" from "telegram_update" group by "update_id" having count(*) > 1
      ) duplicates
    `);
    expect(duplicateUpdates[0].count).toBe(0);

    const relationships = await testDb!.db.execute<{ product_id: string; category_id: string }>(sql`
      select p."id" as product_id, p."category_id"
      from "product" p where p."id" = ${seeded.activeProduct.id}
    `);
    expect(relationships[0].category_id).toBe(seeded.child.id);
  });

  it("rolls back store creation and every ownership write when a late step fails", async () => {
    const seeded = await seedLegacyData();
    const before = await ownershipSnapshot();
    const db = testDb!.db;

    await db.execute(sql`drop trigger if exists backfill_force_failure_trigger on "telegram_update"`);
    await db.execute(sql`drop function if exists public.backfill_force_failure()`);
    await db.execute(sql`
      create function public.backfill_force_failure()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'simulated late backfill failure';
      end;
      $$
    `);
    await db.execute(sql`
      create trigger backfill_force_failure_trigger
      before update on "telegram_update"
      for each row execute function public.backfill_force_failure()
    `);

    let caught: unknown;
    try {
      await runBackfill();
    } catch (error) {
      caught = error;
    } finally {
      await db.execute(sql`drop trigger if exists backfill_force_failure_trigger on "telegram_update"`);
      await db.execute(sql`drop function if exists public.backfill_force_failure()`);
    }

    expect(pgErrorMessage(caught)).toMatch(/simulated late backfill failure/);

    const [stores] = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from "store"`,
    );
    expect(stores.count).toBe(0);

    for (const table of OWNERSHIP_TABLES) {
      const [row] = await db.execute<{ owned: number }>(sql`
        select count(*) filter (where "store_id" is not null)::int as owned
        from ${sql.raw(`"${table}"`)}
      `);
      expect(row.owned).toBe(0);
    }

    const after = await ownershipSnapshot();
    expect(after).toEqual(before);
    expect(after.timestamps).toEqual(before.timestamps);
    expect(seeded.activeProduct.storeId).toBeNull();
  });

  it("fails closed when another unrelated store exists", async () => {
    await seedLegacyData();
    const db = testDb!.db;
    await db.insert(store).values({
      name: "Other Store",
      slug: "other-store",
      status: "active",
    });
    const before = await ownershipSnapshot();

    let caught: unknown;
    try {
      await runBackfill();
    } catch (error) {
      caught = error;
    }

    expect(pgErrorMessage(caught)).toMatch(
      /not empty but the deterministic legacy store slug|another store exists/i,
    );
    const [stores] = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from "store"`,
    );
    expect(stores.count).toBe(1);
    const [legacy] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from "store" where "slug" = 'legacy-store'
    `);
    expect(legacy.count).toBe(0);

    for (const table of OWNERSHIP_TABLES) {
      const [row] = await db.execute<{ owned: number }>(sql`
        select count(*) filter (where "store_id" is not null)::int as owned
        from ${sql.raw(`"${table}"`)}
      `);
      expect(row.owned).toBe(0);
    }
    expect(await ownershipSnapshot()).toEqual(before);
  });

  it("fails closed when the legacy slug has an unexpected identity", async () => {
    await seedLegacyData();
    const db = testDb!.db;
    await db.insert(store).values({
      name: "Unexpected Store",
      slug: "legacy-store",
      status: "onboarding",
    });
    const before = await ownershipSnapshot();

    let caught: unknown;
    try {
      await runBackfill();
    } catch (error) {
      caught = error;
    }

    expect(pgErrorMessage(caught)).toMatch(/unexpected identity/i);
    const [stores] = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from "store"`,
    );
    expect(stores.count).toBe(1);

    for (const table of OWNERSHIP_TABLES) {
      const [row] = await db.execute<{ owned: number }>(sql`
        select count(*) filter (where "store_id" is not null)::int as owned
        from ${sql.raw(`"${table}"`)}
      `);
      expect(row.owned).toBe(0);
    }
    expect(await ownershipSnapshot()).toEqual(before);
  });

  it("fails closed when a row is already owned by another store", async () => {
    const seeded = await seedLegacyData();
    const db = testDb!.db;
    await db.insert(store).values({
      name: "Rabet Legacy Store",
      slug: "legacy-store",
      status: "active",
    });
    const [other] = await db
      .insert(store)
      .values({ name: "Other Store", slug: "other-store", status: "active" })
      .returning();
    await db.execute(sql`
      update "category" set "store_id" = ${other.id} where "id" = ${seeded.root.id}
    `);

    let caught: unknown;
    try {
      await runBackfill();
    } catch (error) {
      caught = error;
    }

    expect(pgErrorMessage(caught)).toMatch(/owned by another store/i);
    const [root] = await db.execute<{ store_id: string | null }>(sql`
      select "store_id" from "category" where "id" = ${seeded.root.id}
    `);
    expect(root.store_id).toBe(other.id);
    const [child] = await db.execute<{ store_id: string | null }>(sql`
      select "store_id" from "category" where "id" = ${seeded.child.id}
    `);
    expect(child.store_id).toBeNull();
    const [stores] = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from "store"`,
    );
    expect(stores.count).toBe(2);
  });

  it("fails closed when the 0006 schema baseline is missing", async () => {
    const missingDb = await createTestDatabase("backfill_missing_baseline");

    try {
      await missingDb.db.execute(sql`alter table "customer" drop column "store_id" cascade`);

      let caught: unknown;
      try {
        await runBackfillOn(missingDb.db);
      } catch (error) {
        caught = error;
      }

      expect(pgErrorMessage(caught)).toMatch(
        /required column public.customer.store_id is missing/i,
      );
      const [stores] = await missingDb.db.execute<{ count: number }>(
        sql`select count(*)::int as count from "store"`,
      );
      expect(stores.count).toBe(0);
    } finally {
      await missingDb.close();
    }
  });

  it("stamps runtime writes after the legacy store exists (S1.3-A)", async () => {
    await seedLegacyData();
    await runBackfill();

    const db = testDb!.db;
    const [legacy] = await db.execute<{ id: string }>(sql`
      select "id" from "store" where "slug" = 'legacy-store'
    `);

    const upserted = await upsertCustomer(asAppDb(db), {
      telegramId: 987654322,
      firstName: "Post-backfill write",
    });
    expect(upserted.storeId).toBe(legacy.id);

    const claimed = await claimTelegramUpdate(asAppDb(db), {
      updateId: 7002,
      updateType: "message",
      payload: { message: { message_id: 2 } },
    });
    expect(claimed.status).toBe("claimed");
    expect(claimed.row.storeId).toBe(legacy.id);

    // Direct schema inserts bypass the write services and remain NULL; this is
    // the historical compatibility path the application no longer uses.
    const [created] = await db
      .insert(category)
      .values({ slug: "post-backfill-null-owner", sortOrder: 100 })
      .returning();
    expect(created.storeId).toBeNull();
  });

  it("re-applying the migration chain is a no-op", async () => {
    const before = await testDb!.db.execute<{ count: number }>(sql`
      select count(*)::int as count from information_schema.columns
      where table_schema = 'public' and column_name = 'store_id'
    `);

    await migrate(testDb!.db, { migrationsFolder });

    const after = await testDb!.db.execute<{ count: number }>(sql`
      select count(*)::int as count from information_schema.columns
      where table_schema = 'public' and column_name = 'store_id'
    `);

    expect(after[0].count).toBe(before[0].count);
    expect(after[0].count).toBe(ALL_STORE_ID_TABLES.length);
  });
});
