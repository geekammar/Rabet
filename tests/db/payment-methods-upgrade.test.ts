/**
 * tests/db/payment-methods-upgrade.test.ts
 *
 * Verifies the production upgrade path from Phase 10B (0000+0001 applied)
 * to Phase 11 (0002_payment_methods applied):
 *
 * 1. Healthy prior release state (2 migrations applied, 14 tables, 17 indexes)
 *    is distinguished from damaged partial states.
 * 2. Pre-upgrade baseline:
 *    - `checkPaymentMethodsCapability` returns `{ supported: false }` without swallowing DB errors.
 *    - The fixture seeds prior-release data with raw SQL; the current application
 *      data layer targets the 0006 schema and is not claimed to run on a
 *      pre-0006 database.
 * 3. Runner upgrade execution:
 *    - Inspect mode validates prior release schema and reports pending `0002_payment_methods`.
 *    - Damaged prior release is refused before any writes.
 *    - Migrate mode applies 0002, verifies 16 tables, 18 indexes, and preserves existing data.
 *    - Repeated migrate is an honest no-op.
 * 4. Post-upgrade capability activation:
 *    - `checkPaymentMethodsCapability` returns `{ supported: true }`.
 *    - Payment methods and product button binding become fully functional.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";

import { asAppDb, hasTestCluster, testClusterUrl } from "./helpers";
import * as wizard from "../../scripts/setup-neon-dev.mjs";
import * as actions from "../../scripts/neon-prod-actions.mjs";
import * as schema from "@/db/schema";
import {
  checkPaymentMethodsCapability,
  createPaymentMethod,
  createProductAction,
  editPaymentMethod,
  ensureLanguage,
  readProductAction,
} from "@/lib/data";

const shouldRun = hasTestCluster();
const clusterUrl = testClusterUrl() ?? "";
const repo = process.cwd();

type Throwaway = {
  url: string;
  name: string;
  sql: ReturnType<typeof postgres>;
  close(): Promise<void>;
};

async function createThrowawayDb(label: string): Promise<Throwaway> {
  const safe = label.replace(/[^a-z0-9]/gi, "_");
  const name = `rabet_upgrade_${safe}_${process.pid}_${globalThis.crypto
    .getRandomValues(new Uint8Array(6))
    .reduce((acc, b) => acc + b.toString(36).padStart(2, "0"), "")}`.toLowerCase();

  const admin = postgres(clusterUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = clusterUrl.replace(/\/[^/]*$/, `/${name}`);
  const sqlClient = postgres(url, { max: 2 });

  return {
    url,
    name,
    sql: sqlClient,
    async close() {
      await sqlClient.end();
      const dropper = postgres(clusterUrl, { max: 1 });
      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await dropper.end();
      }
    },
  };
}

function pinnedTo(url: string) {
  const parsed = wizard.parsePgUrl(url);
  return {
    expectedHost: parsed.host,
    expectedDbName: parsed.dbname,
  };
}

function cleanEnv(url: string, pin: { expectedHost: string; expectedDbName: string }) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (k === "DATABASE_URL" || k === "RABET_TEST_PG_URL" || k.startsWith("GITHUB_")) continue;
    env[k] = v;
  }
  env[actions.PROD_URL_ENV] = url;
  env[actions.EXPECTED_HOST_ENV] = pin.expectedHost;
  env[actions.EXPECTED_DB_NAME_ENV] = pin.expectedDbName;
  return env;
}

async function runProdActionsRunner({
  url,
  mode = "inspect",
  confirm = "",
}: {
  url: string;
  mode?: string;
  confirm?: string;
}) {
  const output: string[] = [];
  const targetPin = pinnedTo(url);

  const io = {
    line(text = "") {
      output.push(`${String(text)}\n`);
    },
    note(text = "") {
      output.push(`  ${String(text)}\n`);
    },
    header(text = "") {
      output.push(`\n${String(text)}\n`);
    },
  };

  const result = await actions.runProdActions({
    io,
    connect: (connectUrl) => actions.createProdPostgresSql(connectUrl),
    runCommand: (opts) => wizard.runCommandReal({ ...opts, onOutput: () => {} }),
    mode,
    confirm,
    env: cleanEnv(url, targetPin),
    root: repo,
    expectedHost: targetPin.expectedHost,
    expectedDbName: targetPin.expectedDbName,
    allowTestTarget: true,
  });

  return { result, output: output.join("") };
}

/**
 * Initializes a throwaway database with the exact prior release schema
 * (migrations 0000_init and 0001_inquiries) matching Phase 10B Production baseline.
 */
async function populateV1PriorRelease(db: Throwaway) {
  const drizzleDir = path.resolve(repo, "drizzle");
  const sql0000 = readFileSync(path.join(drizzleDir, "0000_initial_schema.sql"), "utf8");
  const sql0001 = readFileSync(path.join(drizzleDir, "0001_tree_and_snapshot_integrity.sql"), "utf8");
  const hashes = wizard.computeMigrationHashes(repo);

  await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS drizzle;`);
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    );
  `);

  // Execute migration 0000
  await db.sql.unsafe(sql0000);
  await db.sql.unsafe(`
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    VALUES ('${hashes[0].hash}', ${hashes[0].when});
  `);

  // Execute migration 0001
  await db.sql.unsafe(sql0001);
  await db.sql.unsafe(`
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    VALUES ('${hashes[1].hash}', ${hashes[1].when});
  `);
}

describe.skipIf(!shouldRun)("Production Release Upgrade Path (Phase 10B -> Phase 11)", () => {
  let v1Db: Throwaway | null = null;

  beforeAll(async () => {
    v1Db = await createThrowawayDb("phase10b_baseline");
    await populateV1PriorRelease(v1Db);
  });

  afterAll(async () => {
    await v1Db?.close();
    v1Db = null;
  });

  it("A. Healthy prior release state: capability gate and upgrade baseline", async () => {
    const appDb = asAppDb(drizzle(v1Db!.sql, { schema }));

    // 1. Capability check accurately reports unsupported on 0000+0001 schema
    const capability = await checkPaymentMethodsCapability(appDb);
    expect(capability.supported).toBe(false);
    expect(capability.reason).toContain("0002_payment_methods");

    // 2. Seed the prior release through raw SQL. The current application data
    // layer targets the 0006 schema, so this fixture deliberately proves the
    // runner upgrade path and preserves data for the post-upgrade checks
    // without claiming that new application code runs on a pre-0006 database.
    const [en] = await v1Db!.sql`
      INSERT INTO "language" ("code", "label", "text_direction", "is_enabled")
      VALUES ('en', 'English', 'ltr', true)
      RETURNING "id"
    `;
    await v1Db!.sql`
      INSERT INTO "bot_setting" ("id", "default_language_id", "currency", "display_name")
      VALUES (1, ${en.id}, 'USD', 'Pre-Upgrade Digital Store')
    `;
    const [cat] = await v1Db!.sql`
      INSERT INTO "category" ("slug", "sort_order", "is_active")
      VALUES ('licenses', 0, true)
      RETURNING "id"
    `;
    const [prod] = await v1Db!.sql`
      INSERT INTO "product" ("category_id", "slug", "price", "is_active")
      VALUES (${cat.id}, 'starter-kit', '29.00', true)
      RETURNING "id"
    `;
    await v1Db!.sql`
      INSERT INTO "product_action" ("product_id", "action_type", "is_active")
      VALUES (${prod.id}, 'SHOW_DETAILS', true)
    `;

    const [baseline] = await v1Db!.sql`
      SELECT
        (SELECT count(*)::int FROM "language" WHERE "code" = 'en') AS languages,
        (SELECT count(*)::int FROM "bot_setting") AS settings,
        (SELECT count(*)::int FROM "category" WHERE "slug" = 'licenses') AS categories,
        (SELECT count(*)::int FROM "product" WHERE "slug" = 'starter-kit') AS products,
        (SELECT count(*)::int FROM "product_action") AS actions
    `;
    expect(baseline).toMatchObject({
      languages: 1,
      settings: 1,
      categories: 1,
      products: 1,
      actions: 1,
    });
  });

  it("B. Runner inspect mode: validates prior release schema and reports pending 0002", async () => {
    const { result, output } = await runProdActionsRunner({
      url: v1Db!.url,
      mode: "inspect",
    });

    expect(result.ok).toBe(true);
    expect(output).toContain("Validating prior release schema on target");
    expect(output).toContain("0002_payment_methods");
  });

  it("C. Runner refusal: damaged prior release is refused before any writes", async () => {
    const damagedDb = await createThrowawayDb("damaged_prior");
    try {
      await populateV1PriorRelease(damagedDb);

      // Artificially damage prior release schema: drop table inquiry
      await damagedDb.sql.unsafe("DROP TABLE inquiry CASCADE;");

      const { result, output } = await runProdActionsRunner({
        url: damagedDb.url,
        mode: "migrate",
        confirm: actions.MIGRATE_CONFIRMATION,
      });

      // Refusal before writes!
      expect(result.ok).toBe(false);
      expect(output).toMatch(/Prior release schema validation failed|Missing table/i);

      // Verify migration 0002 was NOT applied
      const [reg] = await damagedDb.sql`SELECT to_regclass('public.payment_method') AS reg`;
      expect(reg?.reg).toBeNull();
    } finally {
      await damagedDb.close();
    }
  });

  it("C1. Runner refusal: altered last timestamp with correct hashes is refused before writes", async () => {
    const alteredDb = await createThrowawayDb("altered_timestamp");
    try {
      await populateV1PriorRelease(alteredDb);

      // Keep correct hashes, but alter created_at timestamp of 0001
      await alteredDb.sql.unsafe("UPDATE drizzle.__drizzle_migrations SET created_at = 1799999999999 WHERE id = 2;");

      const { result, output } = await runProdActionsRunner({
        url: alteredDb.url,
        mode: "migrate",
        confirm: actions.MIGRATE_CONFIRMATION,
      });

      expect(result.ok).toBe(false);
      expect(output).toMatch(/applied migration history does not match the committed chain|timestamp mismatch|does not match the verified prior release schema/i);

      // Verify migration 0002 was NOT applied
      const [reg] = await alteredDb.sql`SELECT to_regclass('public.payment_method') AS reg`;
      expect(reg?.reg).toBeNull();
    } finally {
      await alteredDb.close();
    }
  });

  it("C2. Runner refusal: duplicate or invalid timestamp metadata is refused before writes", async () => {
    const dupDb = await createThrowawayDb("duplicate_timestamp");
    try {
      await populateV1PriorRelease(dupDb);

      // Set duplicate timestamp on 0001 to match 0000
      await dupDb.sql.unsafe(
        "UPDATE drizzle.__drizzle_migrations SET created_at = (SELECT created_at FROM drizzle.__drizzle_migrations WHERE id = 1) WHERE id = 2;",
      );

      const { result, output } = await runProdActionsRunner({
        url: dupDb.url,
        mode: "migrate",
        confirm: actions.MIGRATE_CONFIRMATION,
      });

      expect(result.ok).toBe(false);
      expect(output).toMatch(/applied migration history does not match the committed chain|duplicate timestamp|does not match the verified prior release schema/i);

      // Verify migration 0002 was NOT applied
      const [reg] = await dupDb.sql`SELECT to_regclass('public.payment_method') AS reg`;
      expect(reg?.reg).toBeNull();
    } finally {
      await dupDb.close();
    }
  });

  it("D. Runner migrate mode: applies 0002, verifies complete schema & preserves data", async () => {
    const { result, output } = await runProdActionsRunner({
      url: v1Db!.url,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(true);
    expect(output).toContain("Production migration complete");
    expect(output).toContain("Applied      0002_payment_methods");
    expect(output).toContain("Migrations were successfully applied and verified live on the target");

    // Verify ledger has at least 3 migrations applied
    const ledger = await v1Db!.sql`SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id ASC`;
    expect(ledger.length).toBeGreaterThanOrEqual(3);
    const hashes = wizard.computeMigrationHashes(repo);
    expect(ledger[2].hash).toBe(hashes[2].hash);
  });

  it("E. Runner repeat migrate: honest no-op when already up-to-date", async () => {
    const { result, output } = await runProdActionsRunner({
      url: v1Db!.url,
      mode: "migrate",
      confirm: actions.MIGRATE_CONFIRMATION,
    });

    expect(result.ok).toBe(true);
    expect(output).toContain("No migrations are pending");
    expect(output).toContain("Database was already up to date; no writes were executed");
  });

  it("F. Post-upgrade capability activation: payment methods & button binding become functional", async () => {
    const appDb = asAppDb(drizzle(v1Db!.sql, { schema }));

    // 1. Capability check now returns supported = true
    const capability = await checkPaymentMethodsCapability(appDb);
    expect(capability.supported).toBe(true);

    // 2. Pre-existing product and category are preserved
    const [existingProd] = await appDb
      .select()
      .from(schema.product)
      .where(eq(schema.product.slug, "starter-kit"));
    expect(existingProd).toBeDefined();

    // 3. Create payment method now succeeds
    const [enLang] = await appDb.select().from(schema.language).where(eq(schema.language.code, "en"));
    const createdMethod = await createPaymentMethod(appDb, {
      adminLabel: "Post-Upgrade Wire",
      translations: [
        {
          languageId: enLang.id,
          languageCode: "en",
          title: "Bank Wire Transfer",
          instructions: "Wire instructions for customer.",
        },
      ],
    });
    expect(createdMethod.methodId).toBeDefined();

    // 4. Bind PAYMENT_METHOD action to existing product
    const boundAction = await createProductAction(appDb, {
      productId: existingProd.id,
      actionType: "PAYMENT_METHOD",
      isActive: false,
      paymentMethodId: createdMethod.methodId,
      translations: [{ languageId: enLang.id, label: "Pay with Wire" }],
    });
    expect(boundAction.actionId).toBeDefined();

    const storedAction = await readProductAction(appDb, boundAction.actionId);
    expect(storedAction!.actionType).toBe("PAYMENT_METHOD");
    expect(storedAction!.paymentMethodId).toBe(createdMethod.methodId);

    // 5. Atomic multilingual save works on upgraded DB
    const updated = await editPaymentMethod(appDb, {
      id: createdMethod.methodId,
      adminLabel: "Post-Upgrade Wire (Corporate)",
      translations: [
        {
          languageCode: "en",
          title: "Corporate Wire",
          instructions: "Include invoice reference.",
        },
      ],
    });
    expect(updated.method.adminLabel).toBe("Post-Upgrade Wire (Corporate)");
    expect(updated.method.translations["en"]?.title).toBe("Corporate Wire");

    // Register Arabic as second language
    await ensureLanguage(appDb, {
      code: "ar",
      label: "Arabic",
      textDirection: "rtl",
      isEnabled: true,
    });

    // 6. Untouched optional translations do not block save and preserve existing titles
    const updatedUntouched = await editPaymentMethod(appDb, {
      id: createdMethod.methodId,
      adminLabel: "Post-Upgrade Wire (Enterprise)",
      translations: [
        {
          languageCode: "en",
          instructions: "Direct bank wire to corporate account.",
        },
        {
          languageCode: "ar",
          title: "",
          instructions: "",
        },
      ],
    });
    expect(updatedUntouched.method.adminLabel).toBe("Post-Upgrade Wire (Enterprise)");
    expect(updatedUntouched.method.translations["en"]?.title).toBe("Corporate Wire");
    expect(updatedUntouched.method.translations["en"]?.instructions).toBe("Direct bank wire to corporate account.");
    expect(updatedUntouched.method.translations["ar"]).toBeUndefined();
  });
});
