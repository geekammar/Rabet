import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { neon, neonConfig } from "@neondatabase/serverless";
import postgres from "postgres";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import { category, categoryTranslation } from "@/db/schema";
import { executeAtomicBatch } from "@/lib/data/catalog";
import {
  createTestDatabase,
  hasTestCluster,
  type TestDatabase,
} from "./helpers";

const shouldRun = hasTestCluster();

describe.skipIf(!shouldRun)("neon-http batch protocol bridge & atomic rollback", () => {
  let testDb: TestDatabase | null = null;
  let pgPool: postgres.Sql | null = null;
  const originalFetchFunction = neonConfig.fetchFunction;

  beforeAll(async () => {
    if (!shouldRun) return;
    testDb = await createTestDatabase("neon_driver_batch");
    pgPool = postgres(testDb.url);
  });

  afterAll(async () => {
    neonConfig.fetchFunction = originalFetchFunction;
    if (pgPool) {
      await pgPool.end();
      pgPool = null;
    }
    if (testDb) {
      await testDb.close();
      testDb = null;
    }
  });

  it("proves real neon-http batch reaches bridge, writes in transaction, rolls back on error, and leaves zero rows", async () => {
    let bridgeReached = false;
    let payloadReceived: { query: string; params: unknown[] }[] | null = null;
    let firstWriteVerifiedInTransaction = false;

    neonConfig.fetchFunction = async (_input, init) => {
      bridgeReached = true;
      const body = JSON.parse(init?.body as string);
      payloadReceived = body.queries;

      if (body.queries) {
        try {
          const results: unknown[] = [];
          await pgPool!.begin(async (sql) => {
            for (let i = 0; i < body.queries.length; i++) {
              const q = body.queries[i];
              const rows = await sql.unsafe(q.query, q.params || []);
              const cols = rows.columns || [];
              const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));
              const rowArrays = rows.map((r: Record<string, unknown>) =>
                cols.map((c) => r[c.name]),
              );
              results.push({ rows: rowArrays, fields });

              // Proof: After executing the first write (inserting the category),
              // verify directly that the category row DOES exist inside this uncommitted transaction
              if (i === 0) {
                const inTx = await sql`SELECT id FROM category WHERE id = ${q.params[0]}`;
                if (inTx.length === 1 && inTx[0].id === q.params[0]) {
                  firstWriteVerifiedInTransaction = true;
                }
              }
            }
          });
          return new Response(JSON.stringify({ results }), { status: 200 });
        } catch (err: unknown) {
          return new Response(
            JSON.stringify({ message: (err as Error).message }),
            { status: 400 },
          );
        }
      }
      return new Response("Not found", { status: 404 });
    };

    // Instantiate real neon-http Drizzle client
    const neonClient = neon("postgresql://test:test@ep-example.neon.tech/rabet");
    const neonDb = drizzleNeon(neonClient, { schema });

    const doomedCatId = globalThis.crypto.randomUUID();
    const doomedTransId = globalThis.crypto.randomUUID();
    const invalidLangId = globalThis.crypto.randomUUID(); // Foreign key violation!

    // Statement 1: Valid category insert
    const q1 = neonDb.insert(category).values({
      id: doomedCatId,
      parentId: null,
      slug: "neon-batch-doomed-cat",
      sortOrder: 1,
      isActive: false,
    });

    // Statement 2: Intentionally failing translation insert (non-existent language_id triggers FK error)
    const q2 = neonDb.insert(categoryTranslation).values({
      id: doomedTransId,
      categoryId: doomedCatId,
      languageId: invalidLangId,
      name: "Doomed Translation",
    });

    // Execute atomic batch; this must serialize through neon-http, hit the protocol bridge,
    // trigger transaction rollback on PostgreSQL, and reject
    let batchThrew = false;
    try {
      await executeAtomicBatch(neonDb as unknown as import("@/db/client").Database, [q1, q2]);
    } catch {
      batchThrew = true;
    }

    expect(batchThrew).toBe(true);

    // Proof 1: The real neon-http client reached the test-only HTTP bridge
    expect(bridgeReached).toBe(true);

    // Proof 2: The expected multi-statement payload was received
    expect(payloadReceived).not.toBeNull();
    expect(payloadReceived!.length).toBe(2);
    expect(payloadReceived![0].query).toContain('insert into "category"');
    expect(payloadReceived![1].query).toContain('insert into "category_translation"');

    // Proof 3: The first database write executed inside the transaction
    expect(firstWriteVerifiedInTransaction).toBe(true);

    // Proof 4 & 5: The failing translation statement caused complete rollback;
    // zero category or translation rows remain committed in PostgreSQL
    const baseRows = await testDb!.db
      .select()
      .from(category)
      .where(eq(category.id, doomedCatId));
    expect(baseRows).toHaveLength(0);

    const transRows = await testDb!.db
      .select()
      .from(categoryTranslation)
      .where(eq(categoryTranslation.id, doomedTransId));
    expect(transRows).toHaveLength(0);
  });
});
