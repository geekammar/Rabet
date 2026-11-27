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
const EXPECTED_SERVICE_NAME = "nokmel-cod-staging";
const EXPECTED_CANDIDATE_SHA = "48be324524fd877aa995e9c0a045cb44c9eff0e3";
const EXPECTED_PREVIOUS_SHA = "ef3d7e98e84de1f70931291e4dd66187f9f70660";
const PRE_LEDGER_COUNT = 20;
const PRE_LEDGER_HASH = "06411c112521405aefde707bb11021cac11734ac031f2c66321dfe3b637cd67e";
const POST_LEDGER_COUNT = 21;
const POST_LEDGER_HASH = "f9d3b9f9d5cff43df49d008350e83ec07bd85d451f02cdc63c123e4c13550407";
const EXPECTED_PENDING_TAG = "0020_merchant_notification_bot_managed";
const PRESERVED_ORDER_REFERENCE = "ORD-FYJA23";

const secrets = [RENDER_API_KEY];

function log(message) {
  process.stdout.write(`[cod-staging-migrate-0020] ${String(message)}\n`);
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
  if (value !== EXPECTED_CANDIDATE_SHA) {
    fail(`CANDIDATE_SHA ${value} does not match reviewed head ${EXPECTED_CANDIDATE_SHA}`);
  }
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

function normalizeDeployList(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.deploys)
      ? payload.deploys
      : null;
  if (!list) fail("Unexpected Render deploy-list response shape");
  return list.map((entry) => entry?.deploy ?? entry).filter(Boolean);
}

function deployCommit(deploy) {
  return String(deploy?.commit?.id ?? deploy?.commitId ?? "").toLowerCase();
}

function deployDate(deploy) {
  return (
    Date.parse(
      deploy?.finishedAt ??
        deploy?.updatedAt ??
        deploy?.createdAt ??
        "1970-01-01T00:00:00Z",
    ) || 0
  );
}

async function readRenderBaseline() {
  if (!RENDER_API_KEY) fail("RENDER_API_KEY is missing");
  const servicePayload = await renderApi("GET", `/services/${SERVICE_ID}`);
  const service = servicePayload?.service ?? servicePayload;
  if (!service?.id) fail("Render did not return the service");
  if (String(service.name) !== EXPECTED_SERVICE_NAME) {
    fail(`Unexpected Render service name ${String(service.name)}`);
  }
  const suspendedState = String(service.suspended ?? "").trim().toLowerCase();
  if (
    suspendedState.length > 0 &&
    !["false", "no", "not_suspended"].includes(suspendedState)
  ) {
    fail(`Service is suspended: ${String(service.suspended)}`);
  }
  const deploys = normalizeDeployList(
    await renderApi("GET", `/services/${SERVICE_ID}/deploys?limit=20`),
  );
  const live = deploys
    .filter((deploy) => String(deploy?.status ?? "") === "live")
    .sort((left, right) => deployDate(right) - deployDate(left))[0];
  if (!live?.id) fail("Could not determine the current live Render deploy");
  const sha = deployCommit(live);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    fail("Current live Render deploy has no full commit SHA");
  }
  if (sha !== EXPECTED_PREVIOUS_SHA) {
    fail(`Current live Render deploy ${sha} does not match expected previous ${EXPECTED_PREVIOUS_SHA}`);
  }
  return {
    service: {
      id: String(service.id),
      name: String(service.name),
      suspended: service.suspended ?? null,
      autoDeploy: service.autoDeploy ?? null,
      branch: service.branch ?? null,
    },
    currentLiveDeploy: {
      id: String(live.id),
      sha,
      status: String(live.status ?? "unknown"),
      createdAt: live.createdAt ?? null,
      finishedAt: live.finishedAt ?? null,
      trigger: live.trigger ?? null,
    },
  };
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
    hashes: rows.map((row) => row.hash),
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
    fail(`${label}: last ledger hash does not match the final 0019 baseline`);
  }
  if (ledger.hashes.filter((hash) => hash === PRE_LEDGER_HASH).length !== 1) {
    fail(`${label}: expected exactly one 0019 migration in the ledger`);
  }
  if (
    ledger.hashes.filter(
      (hash) => hash === "868ba439a60f6a3870a5535e032ad55ab0d38c69aced7cf1532e465c632dc339",
    ).length !== 1
  ) {
    fail(`${label}: expected exactly one 0018 migration in the ledger`);
  }
  if (ledger.journalCount !== POST_LEDGER_COUNT) {
    fail(`${label}: candidate journal does not contain 21 migrations`);
  }
  if (ledger.pending !== 1 || ledger.lastJournalTag !== EXPECTED_PENDING_TAG) {
    fail(`${label}: expected exactly ${EXPECTED_PENDING_TAG} pending`);
  }
  return ledger;
}

async function snapshot(sql) {
  const stores = await sql`select * from store order by id`;
  const appUsers = await sql`select * from app_user order by id`;
  const memberships = await sql`select * from store_membership order by id`;
  const products = await sql`select * from product order by id`;
  const categories = await sql`select * from category order by id`;
  const orders = await sql`select * from "order" order by id`;
  const orderItems = await sql`select * from order_item order by id`;
  const reservations = await sql`select * from inventory_reservation order by id`;
  const inventory = await sql`select * from product_inventory order by product_id`;
  const carts = await sql`select * from cart order by id`;
  const cartItems = await sql`select * from cart_item order by id`;
  const claims = await sql`select * from order_payment_claim order by id`;
  const connections = await sql`select * from telegram_connection order by id`;
  const notificationBots = await sql`select * from merchant_notification_bot order by id`;
  const linkAttempts = await sql`
    select id, store_id, merchant_user_id, manager_bot_username, nonce_digest,
      nonce_ciphertext, nonce_key_id, status, telegram_user_id, telegram_bot_id,
      telegram_bot_username, telegram_bot_name, connection_id, failure_code,
      expires_at, bound_at, verified_at, completed_at, created_at, updated_at
    from telegram_link_attempt order by id
  `;
  const managedUpdates = await sql`select * from telegram_managed_update order by id`;
  const languages = await sql`select * from language order by code`;
  const commerce = await sql`select * from store_commerce_setting order by store_id`;
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
      (select count(*)::int from order_payment_claim) as claims,
      (select count(*)::int from telegram_connection) as connections,
      (select count(*)::int from merchant_notification_bot) as notification_bots,
      (select count(*)::int from telegram_link_attempt) as link_attempts,
      (select count(*)::int from telegram_managed_update) as managed_updates,
      (select count(*)::int from language) as languages
  `;
  const orderById = new Map(orders.map((row) => [row.id, row]));
  const commerceByStore = new Map(commerce.map((row) => [row.store_id, row]));
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
      claims: hashRows(claims),
      connections: hashRows(connections),
      notificationBots: hashRows(notificationBots),
      linkAttempts: hashRows(linkAttempts),
      managedUpdates: hashRows(managedUpdates),
      languages: hashRows(languages),
      commerce: hashRows(commerce),
    },
    orderBaseline: orders.map((row) => ({
      reference: row.reference,
      storeId: row.store_id,
      status: row.status,
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      fulfillmentStatus: row.fulfillment_status,
      total: row.total,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    claimsBaseline: claims.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      orderReference: orderById.get(row.order_id)?.reference ?? null,
      storeId: row.store_id,
      method: row.method,
      reference: row.reference,
      status: row.status,
      submittedAt: row.submitted_at,
      decidedAt: row.decided_at,
    })),
    reservationsBaseline: reservations.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      orderReference: orderById.get(row.order_id)?.reference ?? null,
      orderItemId: row.order_item_id,
      productId: row.product_id,
      storeId: row.store_id,
      quantity: row.quantity,
      status: row.status,
      reservedAt: row.reserved_at,
      committedAt: row.committed_at,
      releasedAt: row.released_at,
    })),
    connections: connections.map((row) => ({
      id: row.id,
      storeId: row.store_id,
      botId: String(row.bot_id),
      botUsername: row.bot_username,
      status: row.status,
      webhookUrl: row.webhook_url,
      verifiedAt: row.verified_at,
    })),
    notificationBots: notificationBots.map((row) => ({
      id: row.id,
      storeId: row.store_id,
      botId: String(row.bot_id),
      botUsername: row.bot_username,
      destinationChatId: row.destination_chat_id,
      destinationChatTitle: row.destination_chat_title,
      verifiedAt: row.verified_at,
      lastTestAt: row.last_test_at,
      configEpoch: row.config_epoch,
    })),
    linkAttempts: linkAttempts.map((row) => ({
      id: row.id,
      storeId: row.store_id,
      merchantUserId: row.merchant_user_id,
      status: row.status,
      telegramUserId: row.telegram_user_id === null ? null : String(row.telegram_user_id),
      connectionId: row.connection_id,
      failureCode: row.failure_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    storeFlags: stores.map((row) => {
      const setting = commerceByStore.get(row.id);
      return {
        storeId: row.id,
        slug: row.slug,
        status: row.status,
        codEnabled: setting?.cod_enabled ?? null,
        vodafoneCashEnabled: setting?.vodafone_cash_enabled ?? null,
        vodafoneCashConfigured: Boolean(setting?.vodafone_cash_number),
      };
    }),
    languages,
  };
}

async function readPreservedOrder(sql) {
  const [order] = await sql`
    select id, reference, store_id, status, payment_method, payment_status,
      fulfillment_status, total, currency, placed_at, created_at, updated_at
    from "order"
    where reference = ${PRESERVED_ORDER_REFERENCE}
    limit 1
  `;
  if (!order) fail(`${PRESERVED_ORDER_REFERENCE} is missing`);
  const claims = await sql`
    select id, order_id, store_id, method, reference, status, submitted_at,
      decided_at, decided_by, decision_note, created_at, updated_at
    from order_payment_claim
    where order_id = ${order.id}
    order by id
  `;
  const pendingClaims = claims.filter((claim) => claim.status === "pending");
  if (pendingClaims.length < 1) {
    fail(`${PRESERVED_ORDER_REFERENCE} has no pending payment claim`);
  }
  return { order, claims, pendingClaimCount: pendingClaims.length };
}

function assertPreservedOrderEqual(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    fail(`Preserved order/claim changed: ${PRESERVED_ORDER_REFERENCE}`);
  }
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
  for (const key of [
    "orderBaseline",
    "claimsBaseline",
    "reservationsBaseline",
    "connections",
    "notificationBots",
    "linkAttempts",
    "storeFlags",
  ]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      fail(`Baseline evidence changed during migration: ${key}`);
    }
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

    const [vodafone] = await sql`
      select
        to_regclass('public.order_payment_claim') is not null as claim_table,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'order'
            and column_name = 'transfer_snapshot'
        ) as transfer_snapshot,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'order'
            and column_name = 'transfer_prompt_message_id'
        ) as transfer_prompt_message_id,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'order'
            and column_name = 'transfer_prompt_token'
        ) as transfer_prompt_token,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'order'
            and column_name = 'transfer_reference_requested_at'
        ) as transfer_reference_requested_at,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'cart'
            and column_name = 'payment_method'
        ) as cart_payment_method,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'store_commerce_setting'
            and column_name = 'vodafone_cash_enabled'
        ) as vodafone_cash_enabled,
        exists (
          select 1 from pg_constraint
          where conrelid = 'public.order'::regclass
            and conname = 'order_transfer_snapshot_state_check'
        ) as transfer_snapshot_check,
        exists (
          select 1 from pg_constraint
          where conrelid = 'public.order_payment_claim'::regclass
            and conname = 'order_payment_claim_decision_state_check'
        ) as claim_decision_check,
        exists (
          select 1 from pg_indexes
          where schemaname = 'public'
            and indexname = 'order_payment_claim_order_unique'
        ) as claim_order_unique
    `;
    for (const [key, value] of Object.entries(vodafone ?? {})) {
      if (!value) fail(`Vodafone Cash schema object missing after 0018: ${key}`);
    }

    const [notificationBot] = await sql`
      select
        to_regclass('public.merchant_notification_bot') is not null as bot_table,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'merchant_notification_bot'
            and column_name = 'token_ciphertext'
        ) as token_ciphertext,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'merchant_notification_bot'
            and column_name = 'token_key_id'
        ) as token_key_id,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'merchant_notification_bot'
            and column_name = 'pairing_update_offset'
        ) as pairing_update_offset,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'merchant_notification_bot'
            and column_name = 'pairing_candidates'
        ) as pairing_candidates,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'merchant_notification_bot'
            and column_name = 'pairing_failure_code'
        ) as pairing_failure_code,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'merchant_notification_bot'
            and column_name = 'config_epoch'
        ) as config_epoch,
        exists (
          select 1 from pg_indexes
          where schemaname = 'public'
            and indexname = 'merchant_notification_bot_store_unique'
        ) as store_unique,
        exists (
          select 1 from pg_indexes
          where schemaname = 'public'
            and indexname = 'merchant_notification_bot_bot_id_unique'
        ) as bot_id_unique,
        exists (
          select 1 from pg_constraint
          where conrelid = 'public.merchant_notification_bot'::regclass
            and conname = 'merchant_notification_bot_store_id_store_id_fk'
        ) as store_fk,
        exists (
          select 1 from pg_constraint
          where conrelid = 'public.merchant_notification_bot'::regclass
            and conname = 'merchant_notification_bot_pairing_failure_state_check'
        ) as pairing_failure_state_check,
        exists (
          select 1 from pg_constraint
          where conrelid = 'public.merchant_notification_bot'::regclass
            and conname = 'merchant_notification_bot_verified_requires_destination_check'
        ) as verified_requires_destination_check,
        exists (
          select 1 from information_schema.triggers
          where trigger_schema = 'public'
            and event_object_table = 'merchant_notification_bot'
            and trigger_name = 'merchant_notification_bot_touch_updated_at'
        ) as touch_trigger
    `;
    for (const [key, value] of Object.entries(notificationBot ?? {})) {
      if (!value) fail(`Merchant notification bot schema object missing after 0019: ${key}`);
    }

    const [linkAttemptPurpose] = await sql`
      select
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'telegram_link_attempt'
            and column_name = 'purpose' and data_type = 'text' and is_nullable = 'NO'
        ) as purpose_column_not_null,
        (
          select column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'telegram_link_attempt'
            and column_name = 'purpose'
        ) as purpose_default,
        exists (
          select 1 from pg_constraint
          where conrelid = 'public.telegram_link_attempt'::regclass
            and conname = 'telegram_link_attempt_purpose_check'
            and pg_get_constraintdef(oid) like '%store_bot%'
            and pg_get_constraintdef(oid) like '%notification_bot%'
        ) as purpose_check,
        to_regclass('public.telegram_link_attempt_one_active_per_store_idx') is null as old_store_index_dropped,
        to_regclass('public.telegram_link_attempt_one_active_per_user_idx') is null as old_user_index_dropped,
        exists (
          select 1 from pg_indexes
          where schemaname = 'public'
            and indexname = 'telegram_link_attempt_one_active_per_store_purpose_idx'
            and indexdef like '%purpose%'
        ) as new_store_purpose_index,
        exists (
          select 1 from pg_indexes
          where schemaname = 'public'
            and indexname = 'telegram_link_attempt_one_active_per_user_purpose_idx'
            and indexdef like '%purpose%'
        ) as new_user_purpose_index,
        exists (
          select 1 from pg_indexes
          where schemaname = 'public'
            and indexname = 'telegram_link_attempt_nonce_digest_unique'
        ) as nonce_unique_preserved
    `;
    if (!String(linkAttemptPurpose?.purpose_default ?? "").includes("store_bot")) {
      fail("telegram_link_attempt.purpose does not default to store_bot after 0020");
    }
    for (const [key, value] of Object.entries(linkAttemptPurpose ?? {})) {
      if (key === "purpose_default") continue;
      if (!value) fail(`Managed notification bot schema object missing after 0020: ${key}`);
    }

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
    const renderBefore = await readRenderBaseline();
    const baseline = await snapshot(sql);
    const preservedOrder = await readPreservedOrder(sql);
    const dump = runPgDump(target.databaseUrl);
    const summary = {
      mode: "recovery-0020",
      generatedAt: new Date().toISOString(),
      candidateSha: CANDIDATE_SHA,
      serviceId: SERVICE_ID,
      appUrl: APP_URL,
      target: { host: target.host, database: target.database, role: target.role },
      renderBefore,
      ledgerBefore,
      preservedOrder,
      recovery: {
        artifactName: `cod-staging-pr63-0020-recovery-${process.env.GITHUB_RUN_ID ?? "local"}`,
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
    const renderBefore = await readRenderBaseline();
    if (
      JSON.stringify(renderBefore) !== JSON.stringify(recoverySummary.renderBefore)
    ) {
      fail("Render live deploy changed between recovery and migration");
    }
    const before = await snapshot(sql);
    if (JSON.stringify(before) !== JSON.stringify(recoverySummary.baseline)) {
      fail("Baseline changed between recovery and migration; refusing to apply migrations");
    }
    const preservedBefore = await readPreservedOrder(sql);
    assertPreservedOrderEqual(recoverySummary.preservedOrder, preservedBefore);

    const migrateOutput = runMigrations(target.databaseUrl);
    const ledgerAfter = await readLedger(sql);
    if (ledgerAfter.count !== POST_LEDGER_COUNT) {
      fail(`expected ledger ${POST_LEDGER_COUNT} after migration, found ${ledgerAfter.count}`);
    }
    if (ledgerAfter.lastHash !== POST_LEDGER_HASH) {
      fail("post-migration ledger hash does not match 0020_merchant_notification_bot_managed");
    }
    if (ledgerAfter.hashes.filter((hash) => hash === POST_LEDGER_HASH).length !== 1) {
      fail("expected exactly one 0020 migration in the ledger");
    }
    if (ledgerAfter.hashes.filter((hash) => hash === PRE_LEDGER_HASH).length !== 1) {
      fail("expected exactly one 0019 migration in the ledger after 0020");
    }
    if (
      ledgerAfter.hashes.filter(
        (hash) => hash === "868ba439a60f6a3870a5535e032ad55ab0d38c69aced7cf1532e465c632dc339",
      ).length !== 1
    ) {
      fail("expected exactly one 0018 migration in the ledger after 0020");
    }
    if (ledgerAfter.pending !== 0) fail(`expected zero pending migrations, found ${ledgerAfter.pending}`);
    await assertSchema(sql);
    const linkAttemptPurposes = await sql`
      select purpose, count(*)::int as count
      from telegram_link_attempt
      group by purpose
      order by purpose
    `;
    const unexpectedPurpose = linkAttemptPurposes.find(
      (row) => row.purpose !== "store_bot",
    );
    if (unexpectedPurpose) {
      fail(`unexpected telegram_link_attempt purpose after 0020: ${unexpectedPurpose.purpose}`);
    }
    const preservedAfter = await readPreservedOrder(sql);
    assertPreservedOrderEqual(preservedBefore, preservedAfter);
    const after = await snapshot(sql);
    assertSnapshotEqual(before, after);

    const summary = {
      mode: "migrate",
      generatedAt: new Date().toISOString(),
      candidateSha: CANDIDATE_SHA,
      serviceId: SERVICE_ID,
      appUrl: APP_URL,
      target: { host: target.host, database: target.database, role: target.role },
      renderBefore,
      recovery: recoverySummary.recovery,
      ledgerBefore,
      ledgerAfter,
      migrationOutputTail: migrateOutput,
      countsBefore: before.counts,
      countsAfter: after.counts,
      baselineHashes: after.hashes,
      orderBaseline: after.orderBaseline,
      claimsBaseline: after.claimsBaseline,
      reservationsBaseline: after.reservationsBaseline,
      preservedOrder: preservedAfter,
      connections: after.connections,
      notificationBots: after.notificationBots,
      linkAttempts: after.linkAttempts,
      linkAttemptPurposes,
      storeFlags: after.storeFlags,
      languages: after.languages,
      schemaVerified: {
        storeLanguageSetting: true,
        buyerLanguagePreference: true,
        telegramSupportUsernameColumn: true,
        telegramSupportUsernameConstraint: true,
        orderLifecycleAndShippingColumns: true,
        vodafoneCashTransferSchema: true,
        merchantNotificationBotTable: true,
        managedNotificationBotPurposeColumn: true,
        managedNotificationBotPurposeCheck: true,
        managedNotificationBotPurposeIndexes: true,
        existingBotsPreserved: true,
        preservedOrderPendingClaim: true,
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
  process.stderr.write(`[cod-staging-migrate-0020:FAIL] ${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exit(1);
});

async function main() {
  if (MODE === "recovery") return recovery();
  if (MODE === "migrate") return migrate();
  fail('Usage: node scripts/cod-staging-migrate-pr63-0020.mjs <recovery|migrate>');
}
