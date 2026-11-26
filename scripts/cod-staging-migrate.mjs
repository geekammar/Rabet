#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import postgres from "postgres";

const MODE = (process.argv[2] ?? "").trim();
const CANDIDATE_SHA = (process.env.CANDIDATE_SHA ?? "").trim().toLowerCase();
const SERVICE_ID = (process.env.RENDER_SERVICE_ID ?? "").trim();
const APP_URL = (process.env.APP_URL ?? "").trim().replace(/\/$/, "");
const RENDER_API_KEY = process.env.RENDER_API_KEY ?? "";
const CODE_ROOT = path.resolve(process.env.RABET_CODE_ROOT ?? "/tmp/rabet-candidate");
const WORK_DIR = "/tmp/cod-staging-recovery";
const DUMP_PATH = path.join(WORK_DIR, "recovery.dump");
const RECOVERY_SUMMARY = path.join(WORK_DIR, "recovery-summary.json");
const MIGRATE_SUMMARY = "/tmp/cod-staging-migrate-summary.json";

const EXPECTED_HOST = "ep-tiny-star-b4dpybus.c-6.us-east-2.aws.neon.tech";
const EXPECTED_DB = "rabet_cod_pr56";
const EXPECTED_ROLE = "rabet_cod_pr56";
const PRE_LEDGER_COUNT = 17;
const PRE_LEDGER_HASH = "0987aaa6cbfbf9d4ae83a35b0ddb8a9797742940beb5380f670a40dfe96a314e";
const POST_LEDGER_COUNT = 18;
const POST_LEDGER_HASH = "b870cde776593f11fceb72e3322e1a67a2fc9c2a3be69b982491929aabc26048";

const secrets = [RENDER_API_KEY];

function log(message) {
  process.stdout.write(`[cod-staging-migrate] ${String(message)}\n`);
}

function redact(value) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_DB_URL]");
}

function fail(message) {
  throw new Error(redact(message));
}

function requireSha(value) {
  if (!/^[0-9a-f]{40}$/.test(value)) fail("CANDIDATE_SHA must be a full 40-character SHA");
  return value;
}

async function renderApi(method, apiPath) {
  const response = await fetch(`https://api.render.com/v1${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${RENDER_API_KEY}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {}
  }
  if (!response.ok) fail(`Render API ${method} ${apiPath} failed HTTP ${response.status}`);
  return payload;
}

function envRows(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.envVars)
      ? payload.envVars
      : null;
  if (!list) fail("Unexpected Render env-vars response shape");
  return list.map((entry) => {
    const row = entry?.envVar ?? entry;
    return { key: String(row?.key ?? ""), value: row?.value };
  });
}

async function readStagingEnv() {
  if (!RENDER_API_KEY) fail("RENDER_API_KEY is missing");
  if (!/^srv-[a-z0-9]+$/i.test(SERVICE_ID)) fail("RENDER_SERVICE_ID is invalid");
  const rows = envRows(await renderApi("GET", `/services/${SERVICE_ID}/env-vars?limit=100`));
  const map = new Map();
  for (const row of rows) {
    if (row.key) map.set(row.key, row.value);
  }
  const databaseUrl = map.get("DATABASE_URL");
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") fail("Staging DATABASE_URL is missing");
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    fail("Staging DATABASE_URL is invalid");
  }
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\//, "");
  const role = parsed.username;
  if (host !== EXPECTED_HOST) fail(`Refusing target: host ${host} is not the approved staging host`);
  if (database !== EXPECTED_DB) fail(`Refusing target: database ${database} is not ${EXPECTED_DB}`);
  if (role !== EXPECTED_ROLE) fail(`Refusing target: role ${role} is not ${EXPECTED_ROLE}`);
  if (/-pooler/i.test(host)) fail("Refusing pooled Neon endpoint");
  if (parsed.searchParams.get("sslmode") !== "require") fail("Staging DATABASE_URL must use sslmode=require");
  secrets.push(databaseUrl, decodeURIComponent(parsed.password ?? ""));
  const appUrl = map.get("APP_URL");
  if (APP_URL && appUrl && APP_URL !== String(appUrl).replace(/\/$/, "")) {
    fail("APP_URL does not match the permanent staging URL");
  }
  return { databaseUrl, host, database, role };
}

function hashRows(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function readLedger(sql) {
  const rows = await sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`;
  const entries = JSON.parse(
    fs.readFileSync(path.join(CODE_ROOT, "drizzle", "meta", "_journal.json"), "utf8"),
  ).entries;
  return {
    count: rows.length,
    lastHash: rows[rows.length - 1]?.hash ?? null,
    lastId: rows[rows.length - 1]?.id ?? null,
    journalCount: entries.length,
    lastJournalTag: entries[entries.length - 1]?.tag ?? null,
    pending: Math.max(0, entries.length - rows.length),
  };
}

async function assertPreLedger(sql, label) {
  const ledger = await readLedger(sql);
  if (ledger.count !== PRE_LEDGER_COUNT) {
    fail(`${label}: expected ledger ${PRE_LEDGER_COUNT}, found ${ledger.count}`);
  }
  if (ledger.lastHash !== PRE_LEDGER_HASH) {
    fail(`${label}: last ledger hash does not match the 0016 baseline`);
  }
  if (ledger.journalCount !== POST_LEDGER_COUNT) {
    fail(`${label}: candidate journal does not contain 18 migrations`);
  }
  if (ledger.pending !== 1 || ledger.lastJournalTag !== "0017_store_telegram_support") {
    fail(`${label}: expected exactly 0017_store_telegram_support pending`);
  }
  return ledger;
}

async function snapshot(sql) {
  const stores = await sql`select id, name, slug, status, created_at, updated_at from store order by id`;
  const appUsers = await sql`select id, email, status, platform_role, session_version, created_at from app_user order by id`;
  const memberships = await sql`select id, store_id, user_id, role, status, created_at, updated_at from store_membership order by id`;
  const products = await sql`select id, store_id, category_id, slug, price, is_active, sort_order, created_at, updated_at from product order by id`;
  const categories = await sql`select id, store_id, parent_id, slug, sort_order, is_active, created_at, updated_at from category order by id`;
  const orders = await sql`
    select id, store_id, connection_id, telegram_user_id, telegram_chat_id,
      reference, checkout_key, status, payment_method, payment_status,
      fulfillment_status, currency, subtotal, delivery_fee, total,
      customer_name, customer_phone, delivery_address, placed_at, created_at, updated_at
    from "order" order by id
  `;
  const orderItems = await sql`
    select id, order_id, product_id, product_name, unit_price, quantity,
      line_total, product_snapshot, created_at
    from order_item order by id
  `;
  const reservations = await sql`
    select id, order_id, order_item_id, product_id, store_id, quantity, status,
      reserved_at, committed_at, released_at, release_reason, created_at, updated_at
    from inventory_reservation order by id
  `;
  const inventory = await sql`
    select product_id, store_id, on_hand, reserved, created_at, updated_at
    from product_inventory order by product_id
  `;
  const carts = await sql`
    select id, store_id, connection_id, telegram_user_id, telegram_chat_id,
      status, checkout_state, checkout_key, customer_name, customer_phone,
      delivery_address, quote_subtotal, quote_delivery_fee, quote_total,
      quote_currency, quote_version, created_at, updated_at
    from cart order by id
  `;
  const cartItems = await sql`select id, cart_id, product_id, quantity, created_at, updated_at from cart_item order by id`;
  const connections = await sql`
    select id, store_id, bot_id::text as bot_id, bot_username, status, created_at, verified_at
    from telegram_connection order by id
  `;
  const languages = await sql`select id, code, label, text_direction, is_enabled, created_at from language order by code`;
  const commerce = await sql`select store_id, currency, delivery_fee, cod_enabled, created_at, updated_at from store_commerce_setting order by store_id`;
  const [counts] = await sql`
    select
      (select count(*)::int from store) as stores,
      (select count(*)::int from app_user) as users,
      (select count(*)::int from store_membership) as memberships,
      (select count(*)::int from product) as products,
      (select count(*)::int from category) as categories,
      (select count(*)::int from "order") as orders,
      (select count(*)::int from order_item) as order_items,
      (select count(*)::int from inventory_reservation) as reservations,
      (select count(*)::int from product_inventory) as inventory_rows,
      (select count(*)::int from cart) as carts,
      (select count(*)::int from cart_item) as cart_items,
      (select count(*)::int from telegram_connection) as connections,
      (select count(*)::int from language) as languages
  `;
  return {
    counts,
    hashes: {
      stores: hashRows(stores),
      appUsers: hashRows(appUsers),
      memberships: hashRows(memberships),
      products: hashRows(products),
      categories: hashRows(categories),
      orders: hashRows(orders),
      orderItems: hashRows(orderItems),
      reservations: hashRows(reservations),
      inventory: hashRows(inventory),
      carts: hashRows(carts),
      cartItems: hashRows(cartItems),
      connections: hashRows(connections),
      languages: hashRows(languages),
      commerce: hashRows(commerce),
    },
    orderBaseline: orders.map((row) => ({
      reference: row.reference,
      storeId: row.store_id,
      status: row.status,
      paymentStatus: row.payment_status,
      fulfillmentStatus: row.fulfillment_status,
      total: row.total,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    connections: connections.map((row) => ({
      storeId: row.store_id,
      botId: row.bot_id,
      botUsername: row.bot_username,
      status: row.status,
    })),
    languages,
  };
}

function assertSnapshotEqual(before, after) {
  for (const key of Object.keys(before.hashes)) {
    if (before.hashes[key] !== after.hashes[key]) {
      fail(`Baseline hash mismatch after migration: ${key}`);
    }
  }
  if (JSON.stringify(before.counts) !== JSON.stringify(after.counts)) {
    fail("Baseline row counts changed during migration");
  }
  if (JSON.stringify(before.orderBaseline) !== JSON.stringify(after.orderBaseline)) {
    fail("Order baseline changed during migration");
  }
}

function runPgDump(databaseUrl) {
  fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
  const url = new URL(databaseUrl);
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: url.pathname.replace(/^\//, ""),
    PGUSER: url.username,
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: "require",
    PGAPPNAME: "rabet-cod-staging-recovery",
  };
  const args = [
    "run",
    "--rm",
    "--network",
    "host",
    "-v",
    `${WORK_DIR}:/work`,
  ];
  for (const key of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE", "PGAPPNAME"]) {
    args.push("-e", key);
  }
  args.push(
    "postgres:18",
    "pg_dump",
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--file=/work/recovery.dump",
  );
  const result = spawnSync("docker", args, {
    env,
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
  });
  if (result.status !== 0) {
    fail(`pg_dump failed: ${redact(result.stderr || result.stdout || "no output")}`);
  }
  if (!fs.existsSync(DUMP_PATH) || fs.statSync(DUMP_PATH).size === 0) {
    fail("pg_dump did not produce a recovery file");
  }
  const bytes = fs.readFileSync(DUMP_PATH);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return { path: DUMP_PATH, bytes: bytes.length, sha256 };
}

function assertSchema(sql) {
  return (async () => {
    const [tables] = await sql`
      select
        to_regclass('public.store_language_setting') is not null as store_language_setting,
        to_regclass('public.buyer_language_preference') is not null as buyer_language_preference
    `;
    if (!tables?.store_language_setting) fail("store_language_setting is missing after 0016");
    if (!tables?.buyer_language_preference) fail("buyer_language_preference is missing after 0016");

    const [support] = await sql`
      select
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'store'
            and column_name = 'telegram_support_username'
        ) as support_column,
        exists (
          select 1 from pg_constraint
          where conrelid = 'public.store'::regclass
            and conname = 'store_telegram_support_username_format_check'
        ) as support_constraint
    `;
    if (!support?.support_column) fail("store.telegram_support_username is missing after 0017");
    if (!support?.support_constraint) fail("store_telegram_support_username_format_check is missing after 0017");

    const columns = await sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'order'
        and column_name in (
          'accepted_at', 'preparing_at', 'cancelled_at', 'cancellation_reason',
          'handed_to_shipping_at', 'delivered_at', 'payment_collected_at'
        )
      order by column_name
    `;
    const present = new Set(columns.map((row) => row.column_name));
    for (const name of [
      "accepted_at",
      "preparing_at",
      "cancelled_at",
      "cancellation_reason",
      "handed_to_shipping_at",
      "delivered_at",
      "payment_collected_at",
    ]) {
      if (!present.has(name)) fail(`order.${name} is missing after migrations`);
    }
    runDbCheck();
  })();
}

function runDbCheck() {
  const result = spawnSync("npm", ["run", "db:check"], {
    cwd: CODE_ROOT,
    env: process.env,
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
  });
  if (result.status !== 0) {
    fail(`db:check failed: ${redact(result.stderr || result.stdout || "no output")}`);
  }
}

function runMigrations(databaseUrl) {
  const result = spawnSync("npm", ["run", "db:migrate"], {
    cwd: CODE_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
  });
  if (result.status !== 0) {
    fail(`db:migrate failed: ${redact(result.stderr || result.stdout || "no output")}`);
  }
  return redact((result.stdout || "").trim().split("\n").slice(-8).join("\n"));
}

async function recovery() {
  requireSha(CANDIDATE_SHA);
  const target = await readStagingEnv();
  const sql = postgres(target.databaseUrl, {
    max: 1,
    connect_timeout: 30,
    idle_timeout: 30,
    ssl: "require",
  });
  try {
    const ledgerBefore = await assertPreLedger(sql, "recovery");
    const baseline = await snapshot(sql);
    const dump = runPgDump(target.databaseUrl);
    const summary = {
      mode: "recovery",
      generatedAt: new Date().toISOString(),
      candidateSha: CANDIDATE_SHA,
      serviceId: SERVICE_ID,
      appUrl: APP_URL,
      target: { host: target.host, database: target.database, role: target.role },
      ledgerBefore,
      recovery: {
        artifactName: `cod-staging-recovery-${process.env.GITHUB_RUN_ID ?? "local"}`,
        bytes: dump.bytes,
        sha256: dump.sha256,
      },
      baseline,
    };
    fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(RECOVERY_SUMMARY, JSON.stringify(summary, null, 2), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function migrate() {
  requireSha(CANDIDATE_SHA);
  if (!fs.existsSync(RECOVERY_SUMMARY)) fail("Recovery summary is missing; refusing to migrate");
  if (!fs.existsSync(DUMP_PATH)) fail("Recovery dump is missing; refusing to migrate");
  const recoverySummary = JSON.parse(fs.readFileSync(RECOVERY_SUMMARY, "utf8"));
  const dumpBytes = fs.readFileSync(DUMP_PATH);
  const dumpSha = crypto.createHash("sha256").update(dumpBytes).digest("hex");
  if (dumpSha !== recoverySummary.recovery.sha256) fail("Recovery dump hash does not match its summary");

  const target = await readStagingEnv();
  const sql = postgres(target.databaseUrl, {
    max: 1,
    connect_timeout: 30,
    idle_timeout: 30,
    ssl: "require",
  });
  try {
    const ledgerBefore = await assertPreLedger(sql, "migrate");
    const before = await snapshot(sql);
    if (JSON.stringify(before.hashes) !== JSON.stringify(recoverySummary.baseline.hashes)) {
      fail("Baseline changed between recovery and migration; refusing to apply migrations");
    }

    const migrateOutput = runMigrations(target.databaseUrl);
    const ledgerAfter = await readLedger(sql);
    if (ledgerAfter.count !== POST_LEDGER_COUNT) {
      fail(`expected ledger ${POST_LEDGER_COUNT} after migration, found ${ledgerAfter.count}`);
    }
    if (ledgerAfter.lastHash !== POST_LEDGER_HASH) {
      fail("post-migration ledger hash does not match 0017_store_telegram_support");
    }
    if (ledgerAfter.pending !== 0) fail(`expected zero pending migrations, found ${ledgerAfter.pending}`);
    await assertSchema(sql);
    const after = await snapshot(sql);
    assertSnapshotEqual(before, after);

    const summary = {
      mode: "migrate",
      generatedAt: new Date().toISOString(),
      candidateSha: CANDIDATE_SHA,
      serviceId: SERVICE_ID,
      appUrl: APP_URL,
      target: { host: target.host, database: target.database, role: target.role },
      recovery: recoverySummary.recovery,
      ledgerBefore,
      ledgerAfter,
      migrationOutputTail: migrateOutput,
      countsBefore: before.counts,
      countsAfter: after.counts,
      baselineHashes: after.hashes,
      orderBaseline: after.orderBaseline,
      connections: after.connections,
      languages: after.languages,
      schemaVerified: {
        storeLanguageSetting: true,
        buyerLanguagePreference: true,
        telegramSupportUsernameColumn: true,
        telegramSupportUsernameConstraint: true,
        orderLifecycleAndShippingColumns: true,
        dbCheck: true,
      },
    };
    fs.writeFileSync(MIGRATE_SUMMARY, JSON.stringify(summary, null, 2), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`[cod-staging-migrate:FAIL] ${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exit(1);
});

async function main() {
  if (MODE === "recovery") return recovery();
  if (MODE === "migrate") return migrate();
  fail('Usage: node scripts/cod-staging-migrate.mjs <recovery|migrate>');
}
