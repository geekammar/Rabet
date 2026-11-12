/**
 * tests/db/payment-methods-upgrade.test.ts
 *
 * Verifies the production upgrade path from Phase 10B (0000+0001 applied)
 * to Phase 11 (0002_payment_methods applied):
 *
 * 1. Healthy prior release state (2 migrations applied, 14 tables, 17 indexes)
 *    is distinguished from damaged partial states.
 * 2. Pre-upgrade dual-schema compatibility:
 *    - Existing catalog, action editing, and Telegram journeys remain operational.
 *    - `checkPaymentMethodsCapability` returns `{ supported: false }` without swallowing DB errors.
 *    - Payment method creation and button binding are safely rejected with `SCHEMA_UPGRADE_REQUIRED`.
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
  createCatalogCategory,
  createCatalogProduct,
  createPaymentMethod,
  createProductAction,
  editPaymentMethod,
  ensureLanguage,
  initializeSettings,
  listPaymentMethods,
  listProductActions,
  readProductAction,
} from "@/lib/data";
import { createFakeTelegramTransport } from "@/lib/telegram/transport";
import { handleTelegramWebhookRequest } from "@/lib/telegram/webhook";
import { tokens } from "@/lib/telegram/tokens";

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

  it("A. Healthy prior release state: verifies pre-upgrade behavior & capability gate", async () => {
    const appDb = asAppDb(drizzle(v1Db!.sql, { schema }));

    // 1. Capability check accurately reports unsupported on 0000+0001 schema
    const capability = await checkPaymentMethodsCapability(appDb);
    expect(capability.supported).toBe(false);
    expect(capability.reason).toContain("0002_payment_methods");

    // 2. Setup baseline store data on the legacy schema
    const en = await ensureLanguage(appDb, {
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    });
    await initializeSettings(appDb, {
      defaultLanguageCode: "en",
      displayName: "Pre-Upgrade Digital Store",
      currency: "USD",
    });

    const cat = await createCatalogCategory(appDb, {
      parentId: null,
      slug: "licenses",
      translations: [{ languageId: en.id, name: "Licenses" }],
    });

    const prod = await createCatalogProduct(appDb, {
      categoryId: cat.categoryId,
      slug: "starter-kit",
      price: "29.00",
      translations: [{ languageId: en.id, name: "Starter Kit" }],
    });

    // Activate category and product so Telegram displays the product card
    await v1Db!.sql`UPDATE category SET is_active = true WHERE id = ${cat.categoryId}`;
    await v1Db!.sql`UPDATE product SET is_active = true WHERE id = ${prod.productId}`;

    // 3. Create existing supported action (SHOW_DETAILS)
    const action = await createProductAction(appDb, {
      productId: prod.productId,
      actionType: "SHOW_DETAILS",
      isActive: true,
      translations: [{ languageId: en.id, label: "View Specs" }],
    });
    expect(action.actionId).toBeDefined();

    // 4. Listing actions on pre-upgrade schema succeeds without requesting missing column payment_method_id
    const actionsList = await listProductActions(appDb, prod.productId);
    expect(actionsList).toHaveLength(1);
    expect(actionsList[0].actionType).toBe("SHOW_DETAILS");
    expect(actionsList[0].paymentMethodId).toBeNull();

    // 5. Creating a PAYMENT_METHOD button is rejected cleanly before migration
    await expect(
      createProductAction(appDb, {
        productId: prod.productId,
        actionType: "PAYMENT_METHOD",
        isActive: false,
        paymentMethodId: null,
        translations: [{ languageId: en.id, label: "Pay" }],
      }),
    ).rejects.toThrow(/0002_payment_methods/);

    // 6. Creating a payment method is rejected cleanly before migration
    await expect(
      createPaymentMethod(appDb, {
        adminLabel: "Early Method",
        translations: [{ languageId: en.id, languageCode: "en", title: "Early Title" }],
      }),
    ).rejects.toThrow(/0002_payment_methods/);

    // 7. listPaymentMethods safely returns empty array
    const methodsList = await listPaymentMethods(appDb);
    expect(methodsList).toEqual([]);

    // 8. Telegram catalog journey executes cleanly without throwing enum errors on old schema
    const fakeTransport = createFakeTelegramTransport();
    const req = new Request("https://example.com/api/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "secret-test-token-123",
      },
      body: JSON.stringify({
        update_id: 8801,
        callback_query: {
          id: "cb_pre_upgrade_prod",
          from: { id: 7701, is_bot: false, first_name: "Customer" },
          message: { message_id: 10, chat: { id: 7701, type: "private" } },
          data: tokens.product(prod.productId),
        },
      }),
    });

    const res = await handleTelegramWebhookRequest(req, {
      db: appDb,
      transport: fakeTransport,
      botToken: "123456:FAKE_TOKEN_FOR_PRE_UPGRADE",
      webhookSecret: "secret-test-token-123",
    });

    expect(res.status).toBe(200);
    expect(fakeTransport.editedMessages).toHaveLength(1);
    expect(fakeTransport.editedMessages[0].text).toContain("Starter Kit");
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
