import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";

import { appUser, store, storeMembership } from "@/db/schema";
import {
  createTestDatabase,
  hasTestCluster,
  pgErrorCode,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();

let testDb: TestDatabase | null = null;

beforeAll(async () => {
  if (!shouldRun) return;

  testDb = await createTestDatabase("tenant_identity");
});

afterAll(async () => {
  await testDb?.close();
  testDb = null;
});

beforeEach(async () => {
  if (!testDb) return;

  await testDb.db.execute(sql`delete from store_membership`);
  await testDb.db.execute(sql`delete from app_user`);
  await testDb.db.execute(sql`delete from store`);
});

async function insertStore(
  overrides: Partial<typeof store.$inferInsert> = {},
) {
  const [row] = await testDb!.db
    .insert(store)
    .values({
      name: "Test Store",
      slug: `store-${randomUUID()}`,
      ...overrides,
    })
    .returning();

  return row;
}

async function insertUser(
  overrides: Partial<typeof appUser.$inferInsert> = {},
) {
  const [row] = await testDb!.db
    .insert(appUser)
    .values({
      email: `owner-${randomUUID()}@example.test`,
      ...overrides,
    })
    .returning();

  return row;
}

async function expectDbError(
  operation: () => Promise<unknown>,
  code: string,
) {
  let caught: unknown;

  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeDefined();
  expect(pgErrorCode(caught)).toBe(code);
}

describe.skipIf(!shouldRun)("S1.1 tenant identity schema", () => {
  it("applies the additive migration to the isolated test database", async () => {
    const rows = await testDb!.db.execute<{ name: string }>(sql`
      select table_name as name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('app_user', 'store', 'store_membership')
      order by table_name
    `);

    expect(rows.map((row) => row.name)).toEqual([
      "app_user",
      "store",
      "store_membership",
    ]);

    const journal = await testDb!.db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from drizzle.__drizzle_migrations
    `);

    expect(journal[0].count).toBe(17);
  });

  it("leaves every pre-existing domain table in place", async () => {
    const expected = [
      "bot_setting",
      "category",
      "category_translation",
      "customer",
      "inquiry",
      "inquiry_message",
      "language",
      "message_template",
      "message_translation",
      "payment_method",
      "payment_method_translation",
      "product",
      "product_action",
      "product_action_translation",
      "product_translation",
      "seller_notification_delivery",
      "seller_notification_setting",
      "telegram_update",
    ];

    const rows = await testDb!.db.execute<{ name: string }>(sql`
      select table_name as name
      from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `);
    const present = new Set(rows.map((row) => row.name));

    for (const table of expected) {
      expect(present.has(table)).toBe(true);
    }
  });

  it("accepts canonical lowercase ASCII store slugs", async () => {
    const slugs = ["my-store", "store1", "digital-products-2"];

    for (const slug of slugs) {
      const row = await insertStore({ slug });

      expect(row.slug).toBe(slug);
    }
  });

  it("rejects non-canonical store slugs and still enforces uniqueness", async () => {
    const rejected = [
      "",
      "   ",
      "MyStore",
      "my store",
      "-store",
      "store-",
      "store--name",
      "store!",
    ];

    for (const slug of rejected) {
      await expectDbError(
        () => insertStore({ slug }),
        "23514",
      );
    }

    await expectDbError(
      () => insertStore({ name: "   " }),
      "23514",
    );
    await expectDbError(
      () => insertStore({ status: "draft" }),
      "23514",
    );

    const first = await insertStore({ slug: `slug-${randomUUID()}` });

    await expectDbError(
      () => insertStore({ slug: first.slug }),
      "23505",
    );
  });

  it("enforces case-insensitive email uniqueness and rejects surrounding whitespace", async () => {
    await insertUser({ email: "Owner@Example.com" });

    await expectDbError(
      () => insertUser({ email: "owner@example.com" }),
      "23505",
    );
    await expectDbError(
      () => insertUser({ email: "owner@example.com " }),
      "23514",
    );
    await expectDbError(
      () => insertUser({ email: " owner@example.com" }),
      "23514",
    );

    const accepted = await insertUser({ email: "other@example.com" });

    expect(accepted.email).toBe("other@example.com");
  });

  it("rejects invalid app_user status, platform role and session version", async () => {
    await expectDbError(
      () => insertUser({ status: "invited" }),
      "23514",
    );
    await expectDbError(
      () => insertUser({ platformRole: "admin" }),
      "23514",
    );
    await expectDbError(
      () => insertUser({ sessionVersion: -1 }),
      "23514",
    );

    const user = await insertUser();

    expect(user.status).toBe("active");
    expect(user.platformRole).toBe("user");
    expect(user.sessionVersion).toBe(0);
  });

  it("rejects duplicate memberships and missing store/user references", async () => {
    const memberStore = await insertStore();
    const user = await insertUser();

    await testDb!.db.insert(storeMembership).values({
      storeId: memberStore.id,
      userId: user.id,
    });

    await expectDbError(
      () =>
        testDb!.db.insert(storeMembership).values({
          storeId: memberStore.id,
          userId: user.id,
        }),
      "23505",
    );

    await expectDbError(
      () =>
        testDb!.db.insert(storeMembership).values({
          storeId: randomUUID(),
          userId: user.id,
        }),
      "23503",
    );

    await expectDbError(
      () =>
        testDb!.db.insert(storeMembership).values({
          storeId: memberStore.id,
          userId: randomUUID(),
        }),
      "23503",
    );
  });

  it("rejects invalid membership role and status values", async () => {
    const memberStore = await insertStore();
    const user = await insertUser();

    await expectDbError(
      () =>
        testDb!.db.insert(storeMembership).values({
          storeId: memberStore.id,
          userId: user.id,
          role: "staff",
        }),
      "23514",
    );

    await expectDbError(
      () =>
        testDb!.db.insert(storeMembership).values({
          storeId: memberStore.id,
          userId: user.id,
          status: "pending",
        }),
      "23514",
    );
  });

  it("allows one user to belong to two stores and two users to share a store", async () => {
    const firstStore = await insertStore();
    const secondStore = await insertStore();
    const firstUser = await insertUser();
    const secondUser = await insertUser();

    const memberships = await testDb!.db
      .insert(storeMembership)
      .values([
        { storeId: firstStore.id, userId: firstUser.id },
        { storeId: secondStore.id, userId: firstUser.id },
        { storeId: firstStore.id, userId: secondUser.id },
      ])
      .returning();

    expect(memberships).toHaveLength(3);
  });
});

describe("S1.1 scope and migration safety", () => {
  it("creates only the three authorized tables and no seed or backfill statements", () => {
    const migration = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../drizzle/0005_tenant_identity_foundation.sql",
      ),
      "utf8",
    );

    const createdTables = [...migration.matchAll(/CREATE TABLE "([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(createdTables.sort()).toEqual([
      "app_user",
      "store",
      "store_membership",
    ]);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migration).not.toMatch(/\bUPDATE\s+["a-z_][a-z0-9_"]*\s+SET\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);

    const alteredTables = [...migration.matchAll(/ALTER TABLE "([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(new Set(alteredTables)).toEqual(
      new Set(["store_membership"]),
    );
  });

  it("does not activate merchant authentication on top of app_user", () => {
    const credentials = readFileSync(
      path.resolve(import.meta.dirname, "../../src/lib/auth/credentials.ts"),
      "utf8",
    );
    const session = readFileSync(
      path.resolve(import.meta.dirname, "../../src/lib/auth/session.ts"),
      "utf8",
    );

    expect(credentials).toContain("getAdminConfig");
    expect(session).toContain('session?.user?.role !== "admin"');

    for (const source of [credentials, session]) {
      expect(source).not.toMatch(/appUser|app_user|storeMembership|store_membership/);
    }
  });
});
