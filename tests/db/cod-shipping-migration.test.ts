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
 * Migration 0015 on a database that already has COD history.
 *
 * The 0014 baseline is reconstructed by applying the committed chain without
 * the 0015 file. Historical shipped, delivered and collected orders have no
 * order-level event timestamps (the earlier slice never recorded them), so the
 * migration must add nullable columns and relaxed consistency checks without
 * rewriting statuses, timestamps, totals, snapshots, reservations or stock.
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
  databaseName = `rabet_test_cod_migration_${process.pid}_${Date.now()}`;
  const admin = postgres(baseUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${databaseName}`);
  await admin.end();

  databaseUrl = baseUrl.replace(/\/[^/]*$/, `/${databaseName}`);
  pool = postgres(databaseUrl, { max: 2 });
  db = drizzle({ client: pool, schema });

  tempDir = mkdtempSync(path.join(os.tmpdir(), "rabet-cod-migration-"));
  const baselineFolder = path.join(tempDir, "drizzle");
  cpSync(path.join(repo, "drizzle"), baselineFolder, { recursive: true });

  const journalPath = path.join(baselineFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<Record<string, unknown>>;
  };
  const firstNewMigration = journal.entries.findIndex(
    (entry) => entry.tag === "0015_cod_shipping_delivery_collection",
  );
  if (firstNewMigration === -1) {
    throw new Error("Migration 0015 is missing from the journal");
  }
  journal.entries = journal.entries.slice(0, firstNewMigration);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  rmSync(
    path.join(baselineFolder, "0015_cod_shipping_delivery_collection.sql"),
  );

  await migrate(db, { migrationsFolder: baselineFolder });
  await seedHistoricalOrders();
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

type OrderSnapshot = {
  id: string;
  status: string;
  fulfillment_status: string;
  payment_status: string;
  accepted_at: string | null;
  preparing_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  placed_at: string;
  updated_at: string;
  subtotal: string;
  delivery_fee: string;
  total: string;
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  handed_to_shipping_at?: string | null;
  delivered_at?: string | null;
  payment_collected_at?: string | null;
};

type Snapshot = {
  orders: OrderSnapshot[];
  items: Array<Record<string, unknown>>;
  reservations: Array<Record<string, unknown>>;
  inventory: Array<Record<string, unknown>>;
};

async function readSnapshot(): Promise<Snapshot> {
  const orders = await pool.unsafe<OrderSnapshot>(`
    select id, status, fulfillment_status, payment_status,
           accepted_at, preparing_at, cancelled_at, cancellation_reason,
           placed_at, updated_at, subtotal, delivery_fee, total,
           customer_name, customer_phone, delivery_address
    from "order" order by id
  `);
  const items = await pool.unsafe<Record<string, unknown>>(`
    select id, order_id, product_id, product_name, unit_price, quantity,
           line_total, product_snapshot
    from order_item order by id
  `);
  const reservations = await pool.unsafe<Record<string, unknown>>(`
    select id, order_id, order_item_id, product_id, store_id, quantity,
           status, reserved_at, committed_at, released_at, release_reason
    from inventory_reservation order by id
  `);
  const inventory = await pool.unsafe<Record<string, unknown>>(`
    select product_id, store_id, on_hand, reserved
    from product_inventory order by product_id
  `);

  return {
    orders: [...orders],
    items: [...items],
    reservations: [...reservations],
    inventory: [...inventory],
  };
}

async function seedHistoricalOrders(): Promise<void> {
  await pool.unsafe(`
    insert into "store" ("id", "name", "slug", "status")
    values ('00000000-0000-4000-8000-000000000101', 'Historical Store',
            'historical-store', 'active');

    insert into "telegram_connection" (
      "id", "store_id", "bot_id", "bot_username", "token_ciphertext",
      "token_key_id", "webhook_secret_hash", "webhook_url", "status",
      "verified_at"
    ) values (
      '00000000-0000-4000-8000-000000000102',
      '00000000-0000-4000-8000-000000000101', 992001, 'HistoricalBot',
      'synthetic-ciphertext', 'v1', repeat('b', 64),
      'https://app.example.test/api/telegram/webhook/managed/historical',
      'ready', '2026-11-20T09:00:00Z'
    );

    insert into "category" ("id", "store_id", "slug", "sort_order", "is_active")
    values ('00000000-0000-4000-8000-000000000103',
            '00000000-0000-4000-8000-000000000101',
            'historical-root', 1, true);

    insert into "product" ("id", "store_id", "category_id", "slug", "price",
                           "is_active", "sort_order")
    values ('00000000-0000-4000-8000-000000000104',
            '00000000-0000-4000-8000-000000000101',
            '00000000-0000-4000-8000-000000000103',
            'historical-product', 11.00, true, 1);

    insert into "product_inventory" ("product_id", "store_id", "on_hand", "reserved")
    values ('00000000-0000-4000-8000-000000000104',
            '00000000-0000-4000-8000-000000000101', 5, 3);

    insert into "order" (
      "id", "store_id", "connection_id", "telegram_user_id", "telegram_chat_id",
      "reference", "checkout_key", "status", "payment_method", "payment_status",
      "fulfillment_status", "currency", "subtotal", "delivery_fee", "total",
      "customer_name", "customer_phone", "delivery_address",
      "placed_at", "accepted_at", "preparing_at", "created_at", "updated_at"
    ) values
    ('00000000-0000-4000-8000-000000000111',
     '00000000-0000-4000-8000-000000000101',
     '00000000-0000-4000-8000-000000000102', 94001, 94001, 'ORD-HJM234',
     '00000000-0000-4000-8000-000000000201', 'preparing', 'cod',
     'awaiting_collection', 'handed_to_shipping', 'SAR', 22.00, 15.00, 37.00,
     'Historical Handed', '+15550000101', 'Historical Street 1',
     '2026-11-20T10:00:00Z', '2026-11-20T10:05:00Z',
     '2026-11-20T10:10:00Z', '2026-11-20T10:00:00Z',
     '2026-11-20T10:20:00Z'),
    ('00000000-0000-4000-8000-000000000112',
     '00000000-0000-4000-8000-000000000101',
     '00000000-0000-4000-8000-000000000102', 94002, 94002, 'ORD-HJM345',
     '00000000-0000-4000-8000-000000000202', 'preparing', 'cod',
     'awaiting_collection', 'delivered', 'SAR', 11.00, 15.00, 26.00,
     'Historical Delivered', '+15550000102', 'Historical Street 2',
     '2026-11-20T11:00:00Z', '2026-11-20T11:05:00Z',
     '2026-11-20T11:10:00Z', '2026-11-20T11:00:00Z',
     '2026-11-20T12:20:00Z'),
    ('00000000-0000-4000-8000-000000000113',
     '00000000-0000-4000-8000-000000000101',
     '00000000-0000-4000-8000-000000000102', 94003, 94003, 'ORD-HJM456',
     '00000000-0000-4000-8000-000000000203', 'preparing', 'cod',
     'collected', 'delivered', 'SAR', 11.00, 15.00, 26.00,
     'Historical Collected', '+15550000103', 'Historical Street 3',
     '2026-11-20T13:00:00Z', '2026-11-20T13:05:00Z',
     '2026-11-20T13:10:00Z', '2026-11-20T13:00:00Z',
     '2026-11-20T14:20:00Z');

    insert into "order_item" (
      "id", "order_id", "product_id", "product_name", "unit_price",
      "quantity", "line_total", "product_snapshot"
    ) values
    ('00000000-0000-4000-8000-000000000121',
     '00000000-0000-4000-8000-000000000111',
     '00000000-0000-4000-8000-000000000104', 'Historical Product',
     11.00, 2, 22.00, '{"name":"Historical Product","unitPrice":"11.00"}'::jsonb),
    ('00000000-0000-4000-8000-000000000122',
     '00000000-0000-4000-8000-000000000112',
     '00000000-0000-4000-8000-000000000104', 'Historical Product',
     11.00, 1, 11.00, '{"name":"Historical Product","unitPrice":"11.00"}'::jsonb),
    ('00000000-0000-4000-8000-000000000123',
     '00000000-0000-4000-8000-000000000113',
     '00000000-0000-4000-8000-000000000104', 'Historical Product',
     11.00, 1, 11.00, '{"name":"Historical Product","unitPrice":"11.00"}'::jsonb);

    insert into "inventory_reservation" (
      "id", "order_id", "order_item_id", "product_id", "store_id", "quantity",
      "status", "reserved_at", "committed_at"
    ) values
    ('00000000-0000-4000-8000-000000000131',
     '00000000-0000-4000-8000-000000000111',
     '00000000-0000-4000-8000-000000000121',
     '00000000-0000-4000-8000-000000000104',
     '00000000-0000-4000-8000-000000000101', 2, 'committed',
     '2026-11-20T10:10:00Z', '2026-11-20T10:20:00Z'),
    ('00000000-0000-4000-8000-000000000132',
     '00000000-0000-4000-8000-000000000112',
     '00000000-0000-4000-8000-000000000122',
     '00000000-0000-4000-8000-000000000104',
     '00000000-0000-4000-8000-000000000101', 1, 'committed',
     '2026-11-20T11:10:00Z', '2026-11-20T11:20:00Z'),
    ('00000000-0000-4000-8000-000000000133',
     '00000000-0000-4000-8000-000000000113',
     '00000000-0000-4000-8000-000000000123',
     '00000000-0000-4000-8000-000000000104',
     '00000000-0000-4000-8000-000000000101', 1, 'committed',
     '2026-11-20T13:10:00Z', '2026-11-20T13:20:00Z');
  `);
}

describe.skipIf(!shouldRun)("0014 to 0015 COD shipping migration", () => {
  let before: Snapshot;
  let after: Snapshot;

  beforeAll(async () => {
    before = await readSnapshot();
    await migrate(db, {
      migrationsFolder: path.join(repo, "drizzle"),
    });
    after = await readSnapshot();
  });

  it("preserves historical statuses, timestamps, totals and customer data", () => {
    expect(after.orders.map((order) => ({ ...order }))).toEqual(before.orders);
    expect(
      after.orders.map((order) => [
        order.status,
        order.fulfillment_status,
        order.payment_status,
      ]),
    ).toEqual([
      ["preparing", "handed_to_shipping", "awaiting_collection"],
      ["preparing", "delivered", "awaiting_collection"],
      ["preparing", "delivered", "collected"],
    ]);
  });

  it("keeps item snapshots, reservations and inventory byte-for-byte equivalent", () => {
    expect(after.items).toEqual(before.items);
    expect(after.reservations).toEqual(before.reservations);
    expect(after.inventory).toEqual(before.inventory);
  });

  it("leaves unknown event times null instead of inferring them from updated_at", async () => {
    const rows = await pool.unsafe<{
      handed_to_shipping_at: string | null;
      delivered_at: string | null;
      payment_collected_at: string | null;
    }>(`
      select handed_to_shipping_at, delivered_at, payment_collected_at
      from "order" order by id
    `);

    expect(rows).toEqual([
      {
        handed_to_shipping_at: null,
        delivered_at: null,
        payment_collected_at: null,
      },
      {
        handed_to_shipping_at: null,
        delivered_at: null,
        payment_collected_at: null,
      },
      {
        handed_to_shipping_at: null,
        delivered_at: null,
        payment_collected_at: null,
      },
    ]);
  });

  it("allows a new action to record real timestamps and rejects inverted delivery times", async () => {
    await pool.unsafe(`
      update "order"
      set handed_to_shipping_at = '2026-11-25T10:00:00Z',
          delivered_at = '2026-11-25T11:00:00Z',
          payment_collected_at = '2026-11-25T12:00:00Z'
      where id = '00000000-0000-4000-8000-000000000113'
    `);

    const [row] = await pool.unsafe<{
      handed_to_shipping_at: string;
      delivered_at: string;
      payment_collected_at: string;
    }>(`
      select handed_to_shipping_at, delivered_at, payment_collected_at
      from "order"
      where id = '00000000-0000-4000-8000-000000000113'
    `);

    expect(new Date(row.handed_to_shipping_at).toISOString()).toBe(
      "2026-11-25T10:00:00.000Z",
    );
    expect(new Date(row.delivered_at).toISOString()).toBe(
      "2026-11-25T11:00:00.000Z",
    );
    expect(new Date(row.payment_collected_at).toISOString()).toBe(
      "2026-11-25T12:00:00.000Z",
    );

    await expect(
      pool.unsafe(`
        update "order"
        set delivered_at = '2026-11-25T09:00:00Z'
        where id = '00000000-0000-4000-8000-000000000113'
      `),
    ).rejects.toMatchObject({
      code: "23514",
    });
  });
});
