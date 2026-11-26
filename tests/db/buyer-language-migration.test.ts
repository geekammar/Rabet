import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import * as schema from "@/db/schema";
import { hasTestCluster, testClusterUrl } from "./helpers";

/**
 * Migration 0016 against a database that already has a live store and an
 * in-progress cart.
 *
 * The slice is additive: two new tables and no rewrite of existing rows. This
 * test applies the committed chain through 0015, writes representative live
 * data, then applies 0016 and proves the cart, quantities, totals and store are
 * untouched while the new language tables exist and are empty.
 */

const shouldRun = hasTestCluster();
const repo = process.cwd();

let baseUrl: string;
let databaseName: string;
let databaseUrl: string;
let pool: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let tempDir: string;

beforeAll(async () => {
  if (!shouldRun) return;

  baseUrl = testClusterUrl()!;
  databaseName = `rabet_test_language_migration_${process.pid}_${Date.now()}`;
  const admin = postgres(baseUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${databaseName}`);
  await admin.end();

  databaseUrl = baseUrl.replace(/\/[^/]*$/, `/${databaseName}`);
  pool = postgres(databaseUrl, { max: 2 });
  db = drizzle({ client: pool, schema });

  tempDir = mkdtempSync(path.join(os.tmpdir(), "rabet-language-migration-"));
  const baselineFolder = path.join(tempDir, "drizzle");
  cpSync(path.join(repo, "drizzle"), baselineFolder, { recursive: true });

  const journalPath = path.join(baselineFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<Record<string, unknown>>;
  };
  const firstNewMigration = journal.entries.findIndex(
    (entry) => entry.tag === "0016_buyer_language_support",
  );
  if (firstNewMigration === -1) {
    throw new Error("Migration 0016 is missing from the journal");
  }
  journal.entries = journal.entries.slice(0, firstNewMigration);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  rmSync(path.join(baselineFolder, "0016_buyer_language_support.sql"));

  await migrate(db, { migrationsFolder: baselineFolder });
  await seedLiveData();
});

afterAll(async () => {
  if (!shouldRun) return;

  await pool.end();
  const admin = postgres(baseUrl, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
  } finally {
    await admin.end();
  }

  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

type CartSnapshot = {
  status: string;
  checkout_state: string;
  customer_phone: string | null;
  delivery_address: string | null;
  quote_version: number;
  quote_total: string | null;
};

async function readCart(): Promise<CartSnapshot> {
  const rows = await pool.unsafe<CartSnapshot>(`
    select status, checkout_state, customer_phone, delivery_address,
           quote_version, quote_total
    from cart
  `);
  return rows[0];
}

async function seedLiveData(): Promise<void> {
  await pool.unsafe(`
    insert into "language" ("id", "code", "label", "is_enabled")
    values ('00000000-0000-4000-8000-000000000301', 'en', 'English', true);

    insert into "store" ("id", "name", "slug", "status")
    values ('00000000-0000-4000-8000-000000000302', 'Live Store',
            'live-store', 'active');

    insert into "telegram_connection" (
      "id", "store_id", "bot_id", "bot_username", "token_ciphertext",
      "token_key_id", "webhook_secret_hash", "webhook_url", "status",
      "verified_at"
    ) values (
      '00000000-0000-4000-8000-000000000303',
      '00000000-0000-4000-8000-000000000302', 993001, 'LiveStoreBot',
      'synthetic-ciphertext', 'v1', repeat('c', 64),
      'https://app.example.test/api/telegram/webhook/managed/live',
      'ready', '2026-11-20T09:00:00Z'
    );

    insert into "category" ("id", "store_id", "slug", "sort_order", "is_active")
    values ('00000000-0000-4000-8000-000000000304',
            '00000000-0000-4000-8000-000000000302',
            'live-root', 1, true);

    insert into "product" ("id", "store_id", "category_id", "slug", "price",
                           "is_active", "sort_order")
    values ('00000000-0000-4000-8000-000000000305',
            '00000000-0000-4000-8000-000000000302',
            '00000000-0000-4000-8000-000000000304',
            'live-product', 11.00, true, 1);

    insert into "product_translation" ("product_id", "language_id", "name")
    values ('00000000-0000-4000-8000-000000000305',
            '00000000-0000-4000-8000-000000000301', 'Live Product');

    insert into "product_inventory" ("product_id", "store_id", "on_hand", "reserved")
    values ('00000000-0000-4000-8000-000000000305',
            '00000000-0000-4000-8000-000000000302', 5, 0);

    insert into "store_commerce_setting" ("store_id", "currency", "delivery_fee", "cod_enabled")
    values ('00000000-0000-4000-8000-000000000302', 'SAR', 15.00, true);

    insert into "cart" (
      "id", "store_id", "connection_id", "telegram_user_id", "telegram_chat_id",
      "status", "checkout_state", "customer_name", "customer_phone",
      "delivery_address", "quote_version"
    ) values (
      '00000000-0000-4000-8000-000000000306',
      '00000000-0000-4000-8000-000000000302',
      '00000000-0000-4000-8000-000000000303', 95001, 95001,
      'checkout', 'awaiting_address', 'Live Buyer', '+15550000950',
      'Live Street 1', 3
    );

    insert into "cart_item" ("cart_id", "product_id", "quantity")
    values ('00000000-0000-4000-8000-000000000306',
            '00000000-0000-4000-8000-000000000305', 2);
  `);
}

describe.skipIf(!shouldRun)("buyer language migration 0016", () => {
  it("keeps an existing store and in-progress cart usable", async () => {
    const before = await readCart();
    expect(before).toMatchObject({
      status: "checkout",
      checkout_state: "awaiting_address",
      customer_phone: "+15550000950",
      delivery_address: "Live Street 1",
      quote_version: 3,
    });

    await migrate(db, {
      migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle"),
    });

    expect(await readCart()).toEqual(before);

    const items = await pool.unsafe<{ quantity: number }>(`
      select quantity from cart_item
    `);
    expect(Number(items[0].quantity)).toBe(2);

    const tables = await pool.unsafe<{ name: string | null }>(`
      select to_regclass('public.buyer_language_preference')::text as name
      union all
      select to_regclass('public.store_language_setting')::text as name
    `);
    expect(tables.map((row) => row.name).sort()).toEqual([
      "buyer_language_preference",
      "store_language_setting",
    ]);

    const columns = await pool.unsafe<{ table_name: string; column_name: string }>(`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('buyer_language_preference', 'store_language_setting')
        and column_name in ('locale', 'language_id', 'default_language_id')
      order by table_name, column_name
    `);
    expect(columns).toEqual([
      { table_name: "buyer_language_preference", column_name: "locale" },
      { table_name: "store_language_setting", column_name: "locale" },
    ]);

    const preferences = await pool.unsafe<{ count: number }>(`
      select count(*)::int as count from buyer_language_preference
    `);
    const defaults = await pool.unsafe<{ count: number }>(`
      select count(*)::int as count from store_language_setting
    `);
    expect(Number(preferences[0].count)).toBe(0);
    expect(Number(defaults[0].count)).toBe(0);

    const store = await pool.unsafe<{ status: string }>(`
      select status from store where id = '00000000-0000-4000-8000-000000000302'
    `);
    expect(store[0].status).toBe("active");

    const ledger = await pool.unsafe<{ count: number }>(`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `);
    expect(Number(ledger[0].count)).toBe(18);
  });
});
