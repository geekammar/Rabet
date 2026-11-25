#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import postgres from "postgres";

const CANDIDATE_SHA = (process.env.CANDIDATE_SHA ?? "").trim().toLowerCase();
const RENDER_API_KEY = process.env.RENDER_API_KEY ?? "";
const OWNER_URL_RAW = process.env.NEON_DEV_DATABASE_URL ?? "";
const CODE_ROOT = path.resolve(process.env.RABET_CODE_ROOT ?? "/tmp/rabet-candidate");
const RESET_TARGET = String(process.env.RESET_TARGET ?? "").toLowerCase() === "true";

const OWNER_ID = "tea-db9st3gm7kps73ek9op0";
const ENVIRONMENT_ID = "evm-dc0uopt6e07s73bncdfg";
const BASELINE_SERVICE_ID = "srv-dc3e469ksfps739ru1ng";
const BASELINE_SERVICE_NAME = "nokmel-cod-qa-pr58";
const BASELINE_DB_NAME = "rabet_cod_qa_pr58";
const QA_SERVICE_NAME = "nokmel-buyer-lang-qa-pr59";
const QA_SERVICE_BRANCH = "feat/buyer-language-simple-checkout";
const QA_APP_URL = "https://nokmel-buyer-lang-qa-pr59.onrender.com";
const QA_DB_NAME = "rabet_buyer_lang_qa_pr59";
const QA_DB_ROLE = "rabet_buyer_lang_qa_pr59";

const PREFERRED_STORE_A = "cod-pr56-store-c";
const PREFERRED_STORE_B = "cod-pr56-store-a";
const PREFERRED_READONLY_STORE = "cod-pr57-store-d";

const WORK_DIR = "/tmp/cod-qa-pr59";
const DUMP_PATH = path.join(WORK_DIR, "baseline.dump");
const SUMMARY_PATH = "/tmp/cod-qa-pr59-summary.json";

const FIXTURE = {
  a: {
    slug: "buyer-lang-qa-pr59-a-product",
    nameEn: "PR59 Store A Product",
    nameAr: "منتج المتجر أ",
    fallbackSlug: "buyer-lang-qa-pr59-a-english-only",
    fallbackNameEn: "PR59 English Only Fallback",
    price: "12.00",
    fallbackPrice: "5.00",
    deliveryFee: "7.00",
    currency: "SAR",
    locale: "ar",
    quantity: 2,
    subtotal: "24.00",
    total: "31.00",
    fallbackQuantity: 1,
    fallbackSubtotal: "5.00",
    fallbackTotal: "12.00",
  },
  b: {
    slug: "buyer-lang-qa-pr59-b-product",
    nameEn: "PR59 Store B Product",
    price: "15.00",
    deliveryFee: "9.00",
    currency: "SAR",
    locale: "en",
    quantity: 1,
    subtotal: "15.00",
    total: "24.00",
  },
};

let stage = "validate";
const summary = {
  status: "blocked",
  verdict: "BLOCKED",
  candidateSha: CANDIDATE_SHA,
  qaAppUrl: QA_APP_URL,
  stage,
  generatedAt: new Date().toISOString(),
  liveTelegram: null,
  blockers: [],
};
const secrets = [RENDER_API_KEY, OWNER_URL_RAW];

function log(message) {
  process.stdout.write(`[cod-qa-pr59] ${String(message)}\n`);
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

function requireSha(value, label) {
  if (!/^[0-9a-f]{40}$/.test(value)) fail(`${label} must be a full 40-character SHA`);
  return value;
}

function requireServiceId(value, label) {
  if (!/^srv-[a-z0-9]+$/i.test(value)) fail(`${label} must look like srv-…`);
  return value;
}

function requireHttps(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("QA_APP_URL must be a valid URL");
  }
  if (parsed.protocol !== "https:") fail("QA_APP_URL must be https");
  if (parsed.username || parsed.password) fail("QA_APP_URL must not contain credentials");
  return parsed;
}

function safeIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) fail("Unsafe PostgreSQL identifier");
  return value;
}

function parseDbUrl(raw, label) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} is missing or invalid`);
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) fail(`${label} must be postgres`);
  if (!parsed.hostname.toLowerCase().endsWith(".neon.tech")) fail(`${label} must target Neon`);
  if (parsed.hostname.toLowerCase().includes("-pooler")) fail(`${label} must be an unpooled endpoint`);
  if (!parsed.username || !parsed.password) fail(`${label} must contain credentials`);
  if (!parsed.pathname || parsed.pathname === "/") fail(`${label} must name a database`);
  secrets.push(raw, parsed.password);
  return parsed;
}

function dbHostAndName(parsed) {
  return {
    host: parsed.hostname,
    database: parsed.pathname.replace(/^\//, ""),
    user: parsed.username,
    port: parsed.port || "5432",
  };
}

async function renderApi(method, apiPath, body) {
  let response;
  try {
    response = await fetch(`https://api.render.com/v1${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${RENDER_API_KEY}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`Render API network error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {}
  }
  if (!response.ok) {
    fail(
      `Render API ${method} ${apiPath} failed HTTP ${response.status}: ${
        payload?.message ?? text.slice(0, 300)
      }`,
    );
  }
  return payload;
}

function normalizeEnvList(payload) {
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

async function getEnvMap(serviceId) {
  const rows = normalizeEnvList(
    await renderApi("GET", `/services/${serviceId}/env-vars?limit=100`),
  );
  return new Map(rows.filter((row) => row.key).map((row) => [row.key, row.value]));
}

async function setEnvVars(serviceId, envVars) {
  await renderApi(
    "PUT",
    `/services/${serviceId}/env-vars`,
    envVars.map(({ key, value }) => ({ key, value })),
  );
  const keys = normalizeEnvList(
    await renderApi("GET", `/services/${serviceId}/env-vars?limit=100`),
  ).map((row) => row.key).sort();
  return keys;
}

async function getService(serviceId) {
  const payload = await renderApi("GET", `/services/${serviceId}`);
  return payload?.service ?? payload;
}

async function listServices() {
  const payload = await renderApi("GET", "/services?limit=100");
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.services)
      ? payload.services
      : [];
  return list.map((entry) => entry?.service ?? entry);
}

async function getDeploy(serviceId, deployId) {
  return renderApi("GET", `/services/${serviceId}/deploys/${deployId}`);
}

function buildTargetUrl(ownerUrl, role, password, database) {
  const url = new URL(ownerUrl.toString());
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  url.searchParams.set("sslmode", "require");
  return url.toString();
}

function runPostgresTool(tool, args, databaseUrl) {
  const url = new URL(databaseUrl);
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: url.pathname.replace(/^\//, ""),
    PGUSER: url.username,
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: "require",
    PGAPPNAME: "rabet-cod-qa-pr59",
  };
  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    "host",
    "-v",
    `${WORK_DIR}:/work`,
  ];
  for (const key of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE", "PGAPPNAME"]) {
    dockerArgs.push("-e", key);
  }
  dockerArgs.push("postgres:18", tool, ...args);
  const result = spawnSync("docker", dockerArgs, {
    env,
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
  });
  if (result.status !== 0) {
    fail(`${tool} failed: ${result.stderr || result.stdout || "no output"}`);
  }
}

function hashRows(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function snapshot(sql, label) {
  const stores = await sql`
    select id, name, slug, status, created_at, updated_at
    from store order by id
  `;
  const orders = await sql`
    select id, store_id, connection_id, telegram_user_id, telegram_chat_id,
      reference, checkout_key, status, payment_method, payment_status,
      fulfillment_status, currency, subtotal, delivery_fee, total,
      customer_name, customer_phone, delivery_address, placed_at, created_at, updated_at
    from "order" order by reference
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
      status, checkout_state, customer_name, customer_phone, delivery_address,
      quote_version, created_at, updated_at
    from cart order by id
  `;
  const cartItems = await sql`
    select id, cart_id, product_id, quantity, created_at, updated_at
    from cart_item order by id
  `;
  const connections = await sql`
    select store_id, bot_id::text as bot_id, bot_username, status, created_at, verified_at
    from telegram_connection order by store_id, bot_id
  `;
  const languages = await sql`
    select id, code, label, text_direction, is_enabled, created_at
    from language order by code
  `;
  const ordersByStatus = await sql`
    select status, count(*)::int as count from "order" group by status order by status
  `;
  const reservationsByStatus = await sql`
    select status, count(*)::int as count from inventory_reservation group by status order by status
  `;
  const [counts] = await sql`
    select
      (select count(*)::int from store) as stores,
      (select count(*)::int from "order") as orders,
      (select count(*)::int from order_item) as order_items,
      (select count(*)::int from inventory_reservation) as reservations,
      (select count(*)::int from product_inventory) as inventory_rows,
      (select count(*)::int from cart) as carts,
      (select count(*)::int from cart_item) as cart_items,
      (select count(*)::int from telegram_connection) as connections,
      (select count(*)::int from language) as languages,
      (select count(*)::int from drizzle.__drizzle_migrations) as migrations
  `;
  const ledger = await sql`
    select id, hash, created_at from drizzle.__drizzle_migrations order by id
  `;
  const [dbIdentity] = await sql`
    select current_database() as database, current_user as role,
      current_setting('neon.project_id', true) as project_id,
      current_setting('neon.branch_id', true) as branch_id
  `;

  return {
    label,
    dbIdentity,
    hashes: {
      stores: hashRows(stores),
      orders: hashRows(orders),
      orderItems: hashRows(orderItems),
      reservations: hashRows(reservations),
      inventory: hashRows(inventory),
      carts: hashRows(carts),
      cartItems: hashRows(cartItems),
      connections: hashRows(connections),
      languages: hashRows(languages),
    },
    data: {
      stores: stores.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
      })),
      connections: connections.map((row) => ({
        storeId: row.store_id,
        botId: row.bot_id,
        botUsername: row.bot_username,
        status: row.status,
      })),
      languages: languages.map((row) => ({
        code: row.code,
        label: row.label,
        textDirection: row.text_direction,
        isEnabled: row.is_enabled,
      })),
      counts,
      ordersByStatus,
      reservationsByStatus,
      ledgerCount: ledger.length,
      lastLedgerHash: ledger[ledger.length - 1]?.hash ?? null,
      lastLedgerId: ledger[ledger.length - 1]?.id ?? null,
    },
  };
}

function assertHashesEqual(before, after, label, keys) {
  const names = keys ?? Object.keys(before.hashes);
  for (const key of names) {
    if (before.hashes[key] !== after.hashes[key]) {
      fail(`${label} hash mismatch: ${key}`);
    }
  }
}

async function readLanguageRows(sql) {
  const rows = await sql`
    select id, code, label, text_direction, is_enabled, created_at
    from language order by code
  `;
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    label: row.label,
    textDirection: row.text_direction,
    isEnabled: row.is_enabled,
    createdAt: row.created_at,
  }));
}

async function requireStore(sql, preferredSlug, label, excludeIds = []) {
  const rows = await sql`
    select id, name, slug, status
    from store where slug = ${preferredSlug} limit 1
  `;
  if (rows[0] && !excludeIds.includes(rows[0].id)) return rows[0];
  const fallback = await sql`
    select s.id, s.name, s.slug, s.status
    from store s
    where s.status = 'active'
      and not (s.id = any(${excludeIds}::uuid[]))
      and exists (
        select 1 from telegram_connection c
        where c.store_id = s.id and c.status = 'ready'
      )
      and exists (
        select 1 from product p
        where p.store_id = s.id and p.is_active and p.deleted_at is null
      )
    order by s.slug
    limit 1
  `;
  if (!fallback[0]) fail(`No usable ${label} store found (preferred ${preferredSlug})`);
  log(`Preferred ${label} store ${preferredSlug} missing; using ${fallback[0].slug}`);
  return fallback[0];
}

async function readyConnection(sql, storeId) {
  const rows = await sql`
    select id, bot_id::text as bot_id, bot_username
    from telegram_connection
    where store_id = ${storeId} and status = 'ready'
    order by verified_at desc nulls last limit 1
  `;
  return rows[0] ?? null;
}

async function createBaselineCartFixture(sql, store) {
  const connection = await readyConnection(sql, store.id);
  if (!connection) fail(`Baseline cart store ${store.slug} has no ready connection`);
  const [product] = await sql`
    select p.id, p.slug, p.price, i.on_hand, i.reserved
    from product p
    join product_inventory i on i.product_id = p.id
    where p.store_id = ${store.id}
      and p.is_active = true
      and p.deleted_at is null
      and i.on_hand - i.reserved >= 2
    order by p.sort_order, p.slug
    limit 1
  `;
  if (!product) fail(`Baseline cart store ${store.slug} has no stockable product`);

  const telegramUserId = 959001;
  const [cart] = await sql`
    insert into cart (
      store_id, connection_id, telegram_user_id, telegram_chat_id,
      status, checkout_state, customer_name, customer_phone, delivery_address,
      quote_version
    ) values (
      ${store.id}, ${connection.id}, ${telegramUserId}, ${telegramUserId},
      'checkout', 'awaiting_phone', 'PR59 Baseline Cart', '+15550009590',
      null, 1
    )
    returning id
  `;
  const [item] = await sql`
    insert into cart_item (cart_id, product_id, quantity)
    values (${cart.id}, ${product.id}, 2)
    returning id
  `;
  const [row] = await sql`
    select c.id, c.store_id, c.status, c.checkout_state, c.customer_name,
      c.customer_phone, c.quote_version, ci.product_id, ci.quantity
    from cart c join cart_item ci on ci.cart_id = c.id
    where c.id = ${cart.id}
  `;
  return {
    cartId: cart.id,
    itemId: item.id,
    storeSlug: store.slug,
    productSlug: product.slug,
    telegramUserId,
    quantity: 2,
    hash: hashRows([row]),
    row,
  };
}

async function ensureCategoryTranslation(sql, categoryId, languageId, name) {
  if (!languageId) return;
  await sql`
    insert into category_translation (category_id, language_id, name)
    values (${categoryId}, ${languageId}, ${name})
    on conflict (category_id, language_id)
    do update set name = excluded.name, updated_at = now()
  `;
}

async function ensureProductTranslation(sql, productId, languageId, name, description) {
  if (!languageId) return;
  await sql`
    insert into product_translation (product_id, language_id, name, description)
    values (${productId}, ${languageId}, ${name}, ${description})
    on conflict (product_id, language_id)
    do update set name = excluded.name, description = excluded.description,
      updated_at = now()
  `;
}

async function ensureFixtureProduct(sql, store, spec, languageIds) {
  const [category] = await sql`
    select id from category
    where store_id = ${store.id} and parent_id is null and deleted_at is null
    order by is_active desc, sort_order, id limit 1
  `;
  let categoryId = category?.id;
  if (!categoryId) {
    const [max] = await sql`
      select coalesce(max(sort_order), 0) + 1 as next
      from category where store_id = ${store.id} and parent_id is null
    `;
    const [created] = await sql`
      insert into category (store_id, slug, sort_order, is_active)
      values (${store.id}, ${`buyer-lang-qa-pr59-${store.slug}-root`}, ${max.next}, true)
      returning id
    `;
    categoryId = created.id;
  }
  await sql`
    update category set is_active = true, deleted_at = null, updated_at = now()
    where id = ${categoryId}
  `;
  await ensureCategoryTranslation(sql, categoryId, languageIds.en, "PR59 QA Catalog");
  await ensureCategoryTranslation(sql, categoryId, languageIds.ar, "كتالوج اختبار اللغة");

  const [existing] = await sql`
    select id from product
    where store_id = ${store.id} and slug = ${spec.slug}
    limit 1
  `;
  let productId = existing?.id;
  if (productId) {
    await sql`
      update product
      set category_id = ${categoryId}, price = ${spec.price}, is_active = true,
        deleted_at = null, updated_at = now()
      where id = ${productId}
    `;
  } else {
    const [max] = await sql`
      select coalesce(max(sort_order), 0) + 1 as next
      from product where store_id = ${store.id}
    `;
    const [created] = await sql`
      insert into product (
        store_id, category_id, slug, price, is_active, sort_order
      ) values (
        ${store.id}, ${categoryId}, ${spec.slug}, ${spec.price}, true, ${max.next}
      ) returning id
    `;
    productId = created.id;
  }
  await sql`
    insert into product_inventory (product_id, store_id, on_hand, reserved)
    values (${productId}, ${store.id}, 20, 0)
    on conflict (product_id)
    do update set on_hand = 20, reserved = 0, updated_at = now()
  `;
  await ensureProductTranslation(
    sql,
    productId,
    languageIds.en,
    spec.nameEn,
    "PR59 buyer-language QA fixture",
  );
  if (spec.nameAr) {
    await ensureProductTranslation(
      sql,
      productId,
      languageIds.ar,
      spec.nameAr,
      "منتج اختبار لغة المشتري",
    );
  }
  return { id: productId, categoryId };
}

async function configureFixtureStore(sql, store, spec, languageIds) {
  await sql`
    insert into store_commerce_setting (store_id, currency, delivery_fee, cod_enabled)
    values (${store.id}, ${spec.currency}, ${spec.deliveryFee}, true)
    on conflict (store_id)
    do update set currency = excluded.currency,
      delivery_fee = excluded.delivery_fee,
      cod_enabled = true, updated_at = now()
  `;
  const product = await ensureFixtureProduct(sql, store, spec, languageIds);
  let fallback = null;
  if (spec.fallbackSlug) {
    fallback = await ensureFixtureProduct(
      sql,
      store,
      {
        slug: spec.fallbackSlug,
        nameEn: spec.fallbackNameEn,
        price: spec.fallbackPrice,
      },
      languageIds,
    );
  }
  await sql`
    insert into store_language_setting (store_id, locale)
    values (${store.id}, ${spec.locale})
    on conflict (store_id)
    do update set locale = excluded.locale, updated_at = now()
  `;
  return { product, fallback };
}

async function main() {
  stage = "validate";
  requireSha(CANDIDATE_SHA, "CANDIDATE_SHA");
  requireServiceId(BASELINE_SERVICE_ID, "BASELINE_SERVICE_ID");
  const appUrl = requireHttps(QA_APP_URL);
  if (!RENDER_API_KEY) fail("RENDER_API_KEY is missing");
  if (!OWNER_URL_RAW) fail("NEON_DEV_DATABASE_URL is missing");
  if (!fs.existsSync(path.join(CODE_ROOT, "drizzle", "meta", "_journal.json"))) {
    fail("Candidate worktree has no Drizzle journal");
  }
  fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });

  const baselineService = await getService(BASELINE_SERVICE_ID);
  if (baselineService?.name !== BASELINE_SERVICE_NAME) {
    fail(`Baseline service is ${baselineService?.name}, expected ${BASELINE_SERVICE_NAME}`);
  }
  const baselineEnv = await getEnvMap(BASELINE_SERVICE_ID);
  const baselineUrlRaw = baselineEnv.get("DATABASE_URL");
  if (!baselineUrlRaw) fail("Baseline DATABASE_URL is missing");
  const baselineUrl = parseDbUrl(baselineUrlRaw, "Baseline DATABASE_URL");
  const baselineDb = dbHostAndName(baselineUrl);
  if (baselineDb.database !== BASELINE_DB_NAME) {
    fail(`Baseline database is ${baselineDb.database}, expected ${BASELINE_DB_NAME}`);
  }
  const ownerUrl = parseDbUrl(OWNER_URL_RAW, "NEON_DEV_DATABASE_URL");

  const journalPath = path.join(CODE_ROOT, "drizzle", "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (!Array.isArray(journal.entries) || journal.entries.length !== 17) {
    fail(`Candidate journal has ${journal.entries?.length ?? "no"} entries, expected 17`);
  }
  const lastTag = journal.entries[journal.entries.length - 1]?.tag;
  if (lastTag !== "0016_buyer_language_support") {
    fail(`Candidate journal last tag is ${lastTag}, expected 0016_buyer_language_support`);
  }
  const migrationFile = path.join(CODE_ROOT, "drizzle", "0016_buyer_language_support.sql");
  const expectedLastHash = crypto.createHash("sha256").update(fs.readFileSync(migrationFile)).digest("hex");

  stage = "baseline-inspect";
  const baselineSql = postgres(baselineUrl.toString(), { max: 1, connect_timeout: 30, ssl: "require" });
  let baselineSnapshot;
  try {
    baselineSnapshot = await snapshot(baselineSql, "baseline");
    if (baselineSnapshot.data.counts.migrations !== 16) {
      fail(`Baseline ledger has ${baselineSnapshot.data.counts.migrations} migrations, expected 16`);
    }
    const [tables] = await baselineSql`
      select to_regclass('public.store_language_setting')::text as store_language,
             to_regclass('public.buyer_language_preference')::text as buyer_language
    `;
    if (tables.store_language || tables.buyer_language) {
      fail("Baseline already has 0016 tables; refusing to treat it as a 0015 baseline");
    }
    summary.baseline = {
      serviceId: BASELINE_SERVICE_ID,
      serviceName: baselineService.name,
      database: { host: baselineDb.host, name: baselineDb.database, role: baselineDb.user },
      counts: baselineSnapshot.data.counts,
      hashes: baselineSnapshot.hashes,
      lastLedgerHash: baselineSnapshot.data.lastLedgerHash,
      stores: baselineSnapshot.data.stores,
      connections: baselineSnapshot.data.connections,
      languages: baselineSnapshot.data.languages,
    };
    log("Baseline #58 QA is at ledger 16 / 0015 and 0016 is pending");
  } finally {
    await baselineSql.end({ timeout: 5 }).catch(() => {});
  }

  stage = "create-isolated-db";
  safeIdentifier(QA_DB_NAME);
  safeIdentifier(QA_DB_ROLE);
  const rolePassword = crypto.randomBytes(24).toString("hex");
  secrets.push(rolePassword);
  const owner = postgres(ownerUrl.toString(), {
    max: 1,
    connect_timeout: 30,
    ssl: "require",
  });
  let ownerRole;
  try {
    const [identity] = await owner`
      select current_user as role,
        (select rolcreatedb from pg_roles where rolname = current_user) as can_create_db
    `;
    ownerRole = identity?.role;
    if (!ownerRole) fail("Neon owner role could not be identified");
    if (!identity?.can_create_db) fail("NEON_DEV_DATABASE_URL role cannot create a dedicated test database");
    const existingDb = await owner`select datname from pg_database where datname = ${QA_DB_NAME}`;
    const existingRole = await owner`select rolname from pg_roles where rolname = ${QA_DB_ROLE}`;
    if (existingDb.length > 0) {
      const ownerTargetUrl = buildTargetUrl(
        ownerUrl,
        ownerRole,
        decodeURIComponent(ownerUrl.password),
        QA_DB_NAME,
      );
      const probe = postgres(ownerTargetUrl, { max: 1, connect_timeout: 30, ssl: "require" });
      let probeTables = null;
      try {
        const rows = await probe`
          select count(*)::int as count from information_schema.tables
          where table_schema in ('public', 'drizzle')
        `;
        probeTables = rows[0]?.count ?? null;
      } catch {
        probeTables = null;
      } finally {
        await probe.end({ timeout: 5 }).catch(() => {});
      }
      if (probeTables === 0 || RESET_TARGET) {
        log(`Replacing disposable PR59 target ${QA_DB_NAME}`);
        await owner.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${QA_DB_NAME}' and pid <> pg_backend_pid()`).catch(() => {});
        await owner.unsafe(`drop database "${QA_DB_NAME}" with (force)`);
      } else {
        fail(`Database ${QA_DB_NAME} already exists with tables; set reset_target=true to recreate it`);
      }
    }
    if (existingRole.length > 0) {
      await owner.unsafe(`drop role if exists "${QA_DB_ROLE}"`);
    }
    await owner.unsafe(
      `create role "${QA_DB_ROLE}" with login password '${rolePassword.replace(/'/g, "''")}' nosuperuser nocreatedb nocreaterole noreplication`,
    );
    await owner.unsafe(`grant "${QA_DB_ROLE}" to "${ownerRole}"`);
    await owner.unsafe(`create database "${QA_DB_NAME}" owner "${QA_DB_ROLE}"`);
  } finally {
    await owner.end({ timeout: 5 }).catch(() => {});
  }

  const targetUrlRaw = buildTargetUrl(ownerUrl, QA_DB_ROLE, rolePassword, QA_DB_NAME);
  secrets.push(targetUrlRaw);
  const targetUrl = new URL(targetUrlRaw);
  const targetDb = dbHostAndName(targetUrl);
  summary.isolatedDatabase = {
    host: targetDb.host,
    name: targetDb.database,
    role: targetDb.user,
    recovery: "dedicated PR59 database copied from #58 QA; #57/#58 databases are untouched",
  };
  log(`Created isolated database ${targetDb.host}/${targetDb.database}`);

  stage = "copy-baseline";
  runPostgresTool(
    "pg_dump",
    ["--format=custom", "--no-owner", "--no-privileges", "--file", "/work/baseline.dump"],
    baselineUrl.toString(),
  );
  runPostgresTool(
    "pg_restore",
    [
      "--no-owner",
      "--no-privileges",
      "--no-comments",
      "--dbname",
      targetDb.database,
      "/work/baseline.dump",
    ],
    targetUrl.toString(),
  );

  stage = "verify-copy";
  const targetSql = postgres(targetUrl.toString(), { max: 2, connect_timeout: 30, ssl: "require" });
  let copiedSnapshot;
  let cartFixture;
  try {
    copiedSnapshot = await snapshot(targetSql, "copied");
    if (copiedSnapshot.data.counts.migrations !== 16) {
      fail(`Copied ledger has ${copiedSnapshot.data.counts.migrations} migrations, expected 16`);
    }
    if (copiedSnapshot.data.lastLedgerHash !== baselineSnapshot.data.lastLedgerHash) {
      fail("Copied ledger last hash does not match the 0015 baseline");
    }
    assertHashesEqual(baselineSnapshot, copiedSnapshot, "Copied baseline");
    summary.isolatedDatabase.snapshotBeforeMigration = {
      counts: copiedSnapshot.data.counts,
      hashes: copiedSnapshot.hashes,
      dbIdentity: copiedSnapshot.dbIdentity,
      lastLedgerHash: copiedSnapshot.data.lastLedgerHash,
    };
    log("Isolated copy matches #58 QA before migration");

    stage = "create-baseline-cart";
    const cartStore = await requireStore(targetSql, PREFERRED_STORE_A, "cart fixture");
    cartFixture = await createBaselineCartFixture(targetSql, cartStore);
    summary.isolatedDatabase.inProgressCart = {
      cartId: cartFixture.cartId,
      storeSlug: cartFixture.storeSlug,
      productSlug: cartFixture.productSlug,
      quantity: cartFixture.quantity,
      hash: cartFixture.hash,
      row: cartFixture.row,
    };
    log(`Created in-progress cart fixture ${cartFixture.cartId} at 0015`);
  } finally {
    await targetSql.end({ timeout: 5 }).catch(() => {});
  }

  stage = "apply-0016";
  const migrate = spawnSync("npm", ["run", "db:migrate"], {
    cwd: CODE_ROOT,
    env: { ...process.env, DATABASE_URL: targetUrl.toString() },
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
  });
  if (migrate.status !== 0) {
    fail(`Migration failed: ${migrate.stderr || migrate.stdout}`);
  }

  stage = "verify-migration";
  const promotedSql = postgres(targetUrl.toString(), { max: 2, connect_timeout: 30, ssl: "require" });
  let promotedSnapshot;
  try {
    promotedSnapshot = await snapshot(promotedSql, "promoted");
    if (promotedSnapshot.data.counts.migrations !== 17) {
      fail(`Promoted ledger has ${promotedSnapshot.data.counts.migrations} migrations, expected 17`);
    }
    if (promotedSnapshot.data.lastLedgerHash !== expectedLastHash) {
      fail("Ledger last hash does not match candidate migration 0016");
    }
    assertHashesEqual(copiedSnapshot, promotedSnapshot, "Post-0016", [
      "stores",
      "orders",
      "orderItems",
      "reservations",
      "inventory",
      "connections",
      "languages",
    ]);
    const [cartRow] = await promotedSql`
      select c.id, c.store_id, c.status, c.checkout_state, c.customer_name,
        c.customer_phone, c.quote_version, ci.product_id, ci.quantity
      from cart c join cart_item ci on ci.cart_id = c.id
      where c.id = ${cartFixture.cartId}
    `;
    const cartHashAfter = hashRows([cartRow]);
    if (cartHashAfter !== cartFixture.hash) fail("In-progress cart changed during 0016");
    const tables = await promotedSql`
      select to_regclass('public.store_language_setting')::text as store_language,
             to_regclass('public.buyer_language_preference')::text as buyer_language
    `;
    if (!tables[0]?.store_language || !tables[0]?.buyer_language) {
      fail("0016 tables are missing after migration");
    }
    const columns = await promotedSql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('store_language_setting', 'buyer_language_preference')
        and column_name in ('locale', 'language_id', 'default_language_id')
      order by table_name, column_name
    `;
    if (columns.length !== 2 || columns.some((row) => row.column_name !== "locale")) {
      fail("0016 locale columns do not match the candidate");
    }
    const constraints = await promotedSql`
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname in (
        'store_language_setting_locale_check',
        'buyer_language_preference_locale_check',
        'store_language_setting_store_id_store_id_fk',
        'buyer_language_preference_store_id_store_id_fk'
      )
      order by conname
    `;
    if (constraints.length !== 4) fail("0016 locale constraints are incomplete");
    const languageFks = await promotedSql`
      select conname from pg_constraint
      where conrelid in (
        'public.store_language_setting'::regclass,
        'public.buyer_language_preference'::regclass
      )
      and contype = 'f'
      and conname like '%language_id_language_id_fk'
    `;
    if (languageFks.length !== 0) fail("0016 still references global language rows");
    summary.isolatedDatabase.migration = {
      ledgerBefore: copiedSnapshot.data.counts.migrations,
      ledgerAfter: promotedSnapshot.data.counts.migrations,
      pending: journal.entries.length - promotedSnapshot.data.counts.migrations,
      lastTag,
      lastHash: expectedLastHash,
      localeColumns: columns,
      constraints: constraints.map((row) => ({
        name: row.conname,
        definition: row.definition,
      })),
      languageFks: languageFks.length,
      cartPreserved: true,
      cartHash: cartHashAfter,
    };
    log("0016 verified: 17/17 ledger, locale tables/checks present, baseline and cart preserved");
  } finally {
    await promotedSql.end({ timeout: 5 }).catch(() => {});
  }

  stage = "configure-fixtures";
  const fixtureSql = postgres(targetUrl.toString(), { max: 2, connect_timeout: 30, ssl: "require" });
  let fixtureSummary;
  let languageRowsBeforeDisable;
  let languageRowsAfterDisable;
  let languageRowsAfterLocaleSave;
  try {
    const storeA = await requireStore(fixtureSql, PREFERRED_STORE_A, "Store A");
    const storeB = await requireStore(fixtureSql, PREFERRED_STORE_B, "Store B", [
      storeA.id,
    ]);
    const readonlyStore = await requireStore(
      fixtureSql,
      PREFERRED_READONLY_STORE,
      "read-only Store D",
      [storeA.id, storeB.id],
    );
    if (storeA.id === storeB.id) fail("Store A and Store B resolved to the same store");

    languageRowsBeforeDisable = await readLanguageRows(fixtureSql);
    const arabic = languageRowsBeforeDisable.find((row) => row.code === "ar");
    if (arabic) {
      await fixtureSql`
        update language set is_enabled = false where id = ${arabic.id}
      `;
    }
    languageRowsAfterDisable = await readLanguageRows(fixtureSql);
    const languageIds = {
      en: languageRowsAfterDisable.find((row) => row.code === "en")?.id ?? null,
      ar: languageRowsAfterDisable.find((row) => row.code === "ar")?.id ?? null,
    };
    if (!languageIds.en) fail("English catalog language row is missing");

    await fixtureSql`
      update store set status = 'suspended', updated_at = now()
      where id = ${readonlyStore.id}
    `;

    const a = await configureFixtureStore(fixtureSql, storeA, FIXTURE.a, languageIds);
    const b = await configureFixtureStore(fixtureSql, storeB, FIXTURE.b, languageIds);
    languageRowsAfterLocaleSave = await readLanguageRows(fixtureSql);
    if (JSON.stringify(languageRowsAfterLocaleSave) !== JSON.stringify(languageRowsAfterDisable)) {
      fail("Configuring store locales changed global language rows");
    }

    const connectionA = await readyConnection(fixtureSql, storeA.id);
    const connectionB = await readyConnection(fixtureSql, storeB.id);
    const accounts = await fixtureSql`
      select s.slug, s.name, s.status, u.email, m.role, m.status as membership_status
      from store s
      join store_membership m on m.store_id = s.id
      join app_user u on u.id = m.user_id
      where s.id in (${storeA.id}, ${storeB.id}, ${readonlyStore.id})
      order by s.slug, u.email
    `;
    const defaults = await fixtureSql`
      select store_id, locale from store_language_setting
      where store_id in (${storeA.id}, ${storeB.id})
      order by store_id
    `;
    fixtureSummary = {
      storeA: {
        id: storeA.id,
        slug: storeA.slug,
        name: storeA.name,
        status: storeA.status,
        locale: FIXTURE.a.locale,
        connection: connectionA,
        product: {
          id: a.product.id,
          slug: FIXTURE.a.slug,
          nameEn: FIXTURE.a.nameEn,
          nameAr: FIXTURE.a.nameAr,
          price: FIXTURE.a.price,
          quantity: FIXTURE.a.quantity,
          subtotal: FIXTURE.a.subtotal,
          deliveryFee: FIXTURE.a.deliveryFee,
          total: FIXTURE.a.total,
        },
        fallback: {
          id: a.fallback?.id ?? null,
          slug: FIXTURE.a.fallbackSlug,
          nameEn: FIXTURE.a.fallbackNameEn,
          price: FIXTURE.a.fallbackPrice,
          quantity: FIXTURE.a.fallbackQuantity,
          subtotal: FIXTURE.a.fallbackSubtotal,
          deliveryFee: FIXTURE.a.deliveryFee,
          total: FIXTURE.a.fallbackTotal,
        },
      },
      storeB: {
        id: storeB.id,
        slug: storeB.slug,
        name: storeB.name,
        status: storeB.status,
        locale: FIXTURE.b.locale,
        connection: connectionB,
        product: {
          id: b.product.id,
          slug: FIXTURE.b.slug,
          nameEn: FIXTURE.b.nameEn,
          price: FIXTURE.b.price,
          quantity: FIXTURE.b.quantity,
          subtotal: FIXTURE.b.subtotal,
          deliveryFee: FIXTURE.b.deliveryFee,
          total: FIXTURE.b.total,
        },
      },
      readOnlyStore: {
        id: readonlyStore.id,
        slug: readonlyStore.slug,
        name: readonlyStore.name,
        status: "suspended",
      },
      accounts,
      defaults,
      globalLanguagesBeforeDisable: languageRowsBeforeDisable,
      globalLanguagesAfterDisable: languageRowsAfterDisable,
      globalLanguagesAfterLocaleSave: languageRowsAfterLocaleSave,
      arabicCatalogMetadata: languageIds.ar ? "present-disabled" : "missing",
    };
    summary.fixtures = fixtureSummary;
    log("Configured two store locales, commerce/products, read-only store and global-language isolation");
  } finally {
    await fixtureSql.end({ timeout: 5 }).catch(() => {});
  }

  stage = "configure-qa-service";
  const authSecret = crypto.randomBytes(32).toString("base64");
  secrets.push(authSecret);
  const envVars = [
    { key: "DATABASE_URL", value: targetUrl.toString() },
    { key: "AUTH_SECRET", value: authSecret },
    { key: "AUTH_URL", value: QA_APP_URL },
    { key: "APP_URL", value: QA_APP_URL },
    { key: "AUTH_TRUST_HOST", value: "true" },
    { key: "RABET_MERCHANT_APP_ENABLED", value: "true" },
    { key: "RABET_COD_ORDERS_ENABLED", value: "true" },
    { key: "RABET_BUILD_SHA", value: CANDIDATE_SHA },
  ];

  const services = await listServices();
  const existing = services.find((service) => service?.name === QA_SERVICE_NAME);
  let qaService;
  let createdDeployId = null;
  if (existing) {
    qaService = existing;
    const envKeys = await setEnvVars(qaService.id, envVars);
    if (envKeys.some((key) => key.startsWith("TELEGRAM_"))) {
      fail("QA service unexpectedly has Telegram credentials");
    }
    log(`Reused QA service ${qaService.id} and replaced its environment`);
  } else {
    const created = await renderApi("POST", "/services", {
      type: "web_service",
      name: QA_SERVICE_NAME,
      ownerId: OWNER_ID,
      repo: "https://github.com/geekammar/nokmel",
      branch: QA_SERVICE_BRANCH,
      autoDeployTrigger: "off",
      environmentId: ENVIRONMENT_ID,
      envVars,
      serviceDetails: {
        env: "docker",
        runtime: "docker",
        envSpecificDetails: {
          dockerCommand: "",
          dockerContext: ".",
          dockerfilePath: "./Dockerfile",
        },
        healthCheckPath: "/api/healthz",
        plan: "free",
        region: "ohio",
        numInstances: 1,
      },
    });
    qaService = created?.service;
    createdDeployId = created?.deployId ?? null;
    if (!qaService?.id) fail("Render did not return the created QA service");
    log(`Created QA service ${qaService.id} with isolated DB environment`);
  }

  const qaServiceUrl = String(qaService?.serviceDetails?.url ?? "").replace(/\/$/, "");
  if (new URL(qaServiceUrl).hostname !== appUrl.hostname) {
    fail(`QA service URL ${qaServiceUrl} does not match ${QA_APP_URL}`);
  }
  const qaEnv = await getEnvMap(qaService.id);
  if (qaEnv.has("TELEGRAM_BOT_TOKEN")) fail("QA service must not have Telegram bot credentials");
  const qaDbUrl = parseDbUrl(String(qaEnv.get("DATABASE_URL") ?? ""), "QA DATABASE_URL");
  const qaDb = dbHostAndName(qaDbUrl);
  if (qaDb.database !== QA_DB_NAME || qaDb.host !== targetDb.host) {
    fail("QA service DATABASE_URL does not point only to the isolated copy");
  }
  summary.qaService = {
    id: qaService.id,
    name: qaService.name,
    appUrl: qaServiceUrl,
    database: { host: qaDb.host, name: qaDb.database, role: qaDb.user },
    envKeys: [...qaEnv.keys()].sort(),
  };

  stage = "deploy-candidate";
  let deployId = null;
  if (createdDeployId) {
    const deploy = await getDeploy(qaService.id, createdDeployId);
    const commit = deploy?.commit?.id ?? deploy?.commitId ?? null;
    if (commit === CANDIDATE_SHA) {
      deployId = createdDeployId;
      log(`Using Render-created deploy ${deployId} for exact candidate`);
    } else {
      const status = String(deploy?.status ?? "");
      if (!["live", "build_failed", "update_failed", "canceled", "deactivated"].includes(status)) {
        await renderApi("POST", `/services/${qaService.id}/deploys/${createdDeployId}/cancel`, {});
      }
    }
  }
  if (!deployId) {
    const deploy = await renderApi("POST", `/services/${qaService.id}/deploys`, {
      commitId: CANDIDATE_SHA,
    });
    if (!deploy?.id) fail("Render did not return a deploy id");
    deployId = deploy.id;
  }
  summary.qaService.deployId = deployId;
  log(`Render QA deploy ${deployId} started for ${CANDIDATE_SHA}`);

  const deployDeadline = Date.now() + 25 * 60 * 1000;
  let liveDeploy = null;
  while (Date.now() < deployDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const current = await getDeploy(qaService.id, deployId);
    const status = String(current?.status ?? "unknown");
    log(`Render QA deploy status: ${status}`);
    if (status === "live") {
      liveDeploy = current;
      break;
    }
    if (["build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"].includes(status)) {
      fail(`Render QA deploy failed with status ${status}`);
    }
  }
  if (!liveDeploy) fail("Timed out waiting for Render QA deploy");
  const liveCommit = liveDeploy.commit?.id ?? liveDeploy.commitId ?? null;
  if (liveCommit && liveCommit !== CANDIDATE_SHA) {
    fail(`Render deploy commit is ${liveCommit}, expected ${CANDIDATE_SHA}`);
  }

  stage = "verify-health";
  const healthDeadline = Date.now() + 8 * 60 * 1000;
  let health = null;
  while (Date.now() < healthDeadline) {
    try {
      const response = await fetch(`${QA_APP_URL}/api/healthz`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.status === "ok" && payload?.sha === CANDIDATE_SHA) {
        health = payload;
        break;
      }
      log(`Health not ready: HTTP ${response.status} sha ${String(payload?.sha ?? "missing")}`);
    } catch (error) {
      log(`Health request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (!health) fail("Timed out waiting for candidate SHA in QA /api/healthz");

  stage = "dashboard-smoke";
  const smoke = {};
  for (const route of ["/api/healthz", "/app/login", "/app/setup"]) {
    try {
      const response = await fetch(`${QA_APP_URL}${route}`, {
        redirect: "manual",
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(20_000),
      });
      smoke[route] = { status: response.status, location: response.headers.get("location") };
    } catch (error) {
      smoke[route] = { status: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  summary.qaService.deployStatus = "live";
  summary.qaService.deployCommit = liveCommit ?? CANDIDATE_SHA;
  summary.qaService.health = health;
  summary.qaService.dashboardSmoke = smoke;

  summary.liveTelegram = {
    status: "blocked",
    reason:
      "A dedicated PR59 Render service and database were prepared, but no dedicated bot credentials or webhook routing were authorized for this new service. No existing bot webhook was changed.",
    requiredApproval:
      "Approve two dedicated sandbox bots, or explicitly authorize retargeting the named existing test bots, and authorize setting TELEGRAM_CONNECTION_TOKEN_KEY/_ID plus each bot webhook to the new PR59 service. Do not recover Store B by username.",
    discoveredReadyConnections: baselineSnapshot.data.connections.filter(
      (row) => row.status === "ready",
    ),
    qaServiceHasTelegramCredentials: false,
  };
  summary.blockers = [
    "Live Telegram buyer acceptance is blocked until dedicated bot credential and webhook routing approval is provided.",
  ];
  summary.status = "prepared";
  summary.verdict = "BLOCKED";
  summary.stage = "complete";
  summary.generatedAt = new Date().toISOString();
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o644 });
  log(`QA candidate is live at ${QA_APP_URL} with SHA ${health.sha}; live Telegram routing is BLOCKED`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  summary.status = "blocked";
  summary.verdict = "BLOCKED";
  summary.stage = stage;
  summary.error = redact(error instanceof Error ? error.message : String(error));
  summary.generatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o644 });
  } catch {}
  process.stderr.write(`[cod-qa-pr59:FAIL] ${summary.error}\n`);
  process.exitCode = 1;
});
