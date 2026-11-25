#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import postgres from "postgres";

const CANDIDATE_SHA = (process.env.CANDIDATE_SHA ?? "").trim().toLowerCase();
const BASELINE_SHA = (process.env.BASELINE_SHA ?? "").trim().toLowerCase();
const BASELINE_SERVICE_ID = (process.env.BASELINE_SERVICE_ID ?? "").trim();
const QA_APP_URL = (process.env.QA_APP_URL ?? "").trim().replace(/\/$/, "");
const RENDER_API_KEY = process.env.RENDER_API_KEY ?? "";
const OWNER_URL_RAW = process.env.NEON_DEV_DATABASE_URL ?? "";
const CODE_ROOT = path.resolve(process.env.RABET_CODE_ROOT ?? "/tmp/rabet-candidate");

const OWNER_ID = "tea-db9st3gm7kps73ek9op0";
const ENVIRONMENT_ID = "evm-dc0uopt6e07s73bncdfg";
const QA_SERVICE_NAME = "nokmel-cod-qa-pr58";
const QA_SERVICE_BRANCH = "feat/cod-shipping-delivery-collection";
const BASELINE_DB_NAME = "rabet_cod_qa_pr57";
const QA_DB_NAME = "rabet_cod_qa_pr58";
const QA_DB_ROLE = "rabet_cod_qa_pr58";
const BASELINE_STORE_SLUG = "cod-pr56-store-c";
const BASELINE_PRODUCT_SLUG = "cod-pr56-store-c-product";
const WORK_DIR = "/tmp/cod-qa-pr58";
const SUMMARY_PATH = "/tmp/cod-qa-pr58-summary.json";

const BASELINE_ORDER_REFS = [
  "ORD-QAA234",
  "ORD-QBB345",
  "ORD-QCC456",
  "ORD-RZNNAN",
  "ORD-X2EZD9",
  "ORD-ZRM8X6",
];

let stage = "validate";
const summary = {
  status: "blocked",
  candidateSha: CANDIDATE_SHA,
  baselineSha: BASELINE_SHA,
  baselineServiceId: BASELINE_SERVICE_ID,
  qaAppUrl: QA_APP_URL,
  stage,
  generatedAt: new Date().toISOString(),
};
const secrets = [RENDER_API_KEY, OWNER_URL_RAW];

function log(message) {
  process.stdout.write(`[cod-qa-pr58] ${String(message)}\n`);
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
    PGAPPNAME: "rabet-cod-qa-pr58",
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
  const connections = await sql`
    select store_id, bot_id::text as bot_id, bot_username, status, created_at, verified_at
    from telegram_connection order by store_id, bot_id
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
      (select count(*)::int from telegram_connection) as connections,
      (select count(*)::int from drizzle.__drizzle_migrations) as migrations
  `;
  const [targetOrder] = await sql`
    select reference, status, payment_status, fulfillment_status, subtotal,
      delivery_fee, total, currency
    from "order" where reference = 'ORD-X2EZD9'
  `;
  const cancelled = await sql`
    select reference, status, updated_at
    from "order" where status = 'cancelled' order by reference
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
      connections: hashRows(connections),
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
      counts,
      ordersByStatus,
      reservationsByStatus,
      targetOrder: targetOrder
        ? {
            reference: targetOrder.reference,
            status: targetOrder.status,
            paymentStatus: targetOrder.payment_status,
            fulfillmentStatus: targetOrder.fulfillment_status,
            subtotal: targetOrder.subtotal,
            deliveryFee: targetOrder.delivery_fee,
            total: targetOrder.total,
            currency: targetOrder.currency,
          }
        : null,
      cancelled,
    },
  };
}

function assertHashesEqual(before, after, label) {
  for (const key of Object.keys(before.hashes)) {
    if (before.hashes[key] !== after.hashes[key]) {
      fail(`${label} hash mismatch: ${key}`);
    }
  }
}

async function baselineRefHashes(sql) {
  const orders = await sql`
    select reference, status, payment_status, fulfillment_status, subtotal,
      delivery_fee, total, currency, updated_at
    from "order" where reference = any(${BASELINE_ORDER_REFS}) order by reference
  `;
  const items = await sql`
    select oi.reference, oi.product_name, oi.unit_price, oi.quantity, oi.line_total,
      oi.product_snapshot
    from (
      select oi.*, o.reference
      from order_item oi join "order" o on o.id = oi.order_id
      where o.reference = any(${BASELINE_ORDER_REFS})
    ) oi order by oi.reference, oi.product_name
  `;
  const reservations = await sql`
    select o.reference, r.status, r.quantity, r.reserved_at, r.committed_at,
      r.released_at, r.release_reason
    from inventory_reservation r join "order" o on o.id = r.order_id
    where o.reference = any(${BASELINE_ORDER_REFS})
    order by o.reference, r.id
  `;
  return {
    orders: hashRows(orders),
    items: hashRows(items),
    reservations: hashRows(reservations),
  };
}

async function readAccountSummary(sql) {
  const rows = await sql`
    select s.slug, s.name, s.status, u.email
    from store s
    join store_membership m on m.store_id = s.id and m.status = 'active'
    join app_user u on u.id = m.user_id
    order by s.slug
  `;
  return rows.map((row) => ({
    storeSlug: row.slug,
    storeName: row.name,
    storeStatus: row.status,
    email: row.email,
  }));
}

async function createFixtures(sql) {
  const refs = {
    shipping: "ORD-Q2A234",
    cancel: "ORD-QCB345",
    legacy: "ORD-QHL456",
  };
  const result = await sql.begin(async (tx) => {
    const [store] = await tx`
      select id, name, slug, status from store where slug = ${BASELINE_STORE_SLUG}
    `;
    if (!store || store.status !== "active") fail("Store C is missing or not active");

    const [product] = await tx`
      select p.id, p.slug, i.on_hand, i.reserved
      from product p join product_inventory i on i.product_id = p.id
      where p.store_id = ${store.id} and p.slug = ${BASELINE_PRODUCT_SLUG}
    `;
    if (!product) fail("Store C fixture product is missing");
    if (Number(product.on_hand) !== 5 || Number(product.reserved) !== 1) {
      fail(
        `Store C product baseline is ${product.on_hand}/${product.reserved}, expected 5/1`,
      );
    }

    const [connection] = await tx`
      select id from telegram_connection
      where store_id = ${store.id} and status = 'ready'
      order by verified_at desc nulls last limit 1
    `;
    if (!connection) fail("Store C has no ready connection for fixture orders");

    const [category] = await tx`
      select id from category
      where store_id = ${store.id} and parent_id is null
      order by sort_order, id limit 1
    `;
    if (!category) fail("Store C has no root category for fixture products");

    const [setting] = await tx`
      select currency, delivery_fee from store_commerce_setting
      where store_id = ${store.id}
    `;
    if (!setting) fail("Store C has no commerce setting");
    const currency = setting.currency;
    const deliveryFee = String(setting.delivery_fee);

    async function ensureProduct(slug, onHand, reserved) {
      const [existing] = await tx`
        select id from product where store_id = ${store.id} and slug = ${slug}
      `;
      if (existing) return existing.id;
      const [max] = await tx`
        select coalesce(max(sort_order), 0) + 1 as next
        from product where store_id = ${store.id}
      `;
      const [created] = await tx`
        insert into product (store_id, category_id, slug, price, is_active, sort_order)
        values (${store.id}, ${category.id}, ${slug}, 11.00, true, ${max.next})
        returning id
      `;
      await tx`
        insert into product_inventory (product_id, store_id, on_hand, reserved)
        values (${created.id}, ${store.id}, ${onHand}, ${reserved})
      `;
      return created.id;
    }

    async function ensureOrder(input) {
      const [existing] = await tx`
        select id from "order" where reference = ${input.reference}
      `;
      if (existing) return { id: existing.id, skipped: true };

      const [order] = await tx`
        insert into "order" (
          store_id, connection_id, telegram_user_id, telegram_chat_id,
          reference, checkout_key, status, payment_method, payment_status,
          fulfillment_status, currency, subtotal, delivery_fee, total,
          customer_name, customer_phone, delivery_address,
          placed_at, accepted_at, preparing_at, updated_at
        ) values (
          ${store.id}, ${connection.id}, ${input.telegramUserId},
          ${input.telegramUserId}, ${input.reference}, ${crypto.randomUUID()},
          ${input.status}, 'cod', 'awaiting_collection',
          ${input.fulfillmentStatus}, ${currency}, ${input.subtotal},
          ${deliveryFee}, ${input.total}, ${input.customerName},
          ${input.customerPhone}, ${input.customerAddress},
          now() - interval '1 hour', now() - interval '1 hour',
          now() - interval '1 hour', now() - interval '1 hour'
        ) returning id
      `;
      const [item] = await tx`
        insert into order_item (
          order_id, product_id, product_name, unit_price, quantity, line_total,
          product_snapshot
        ) values (
          ${order.id}, ${input.productId}, ${input.productName}, 11.00,
          ${input.quantity}, ${input.lineTotal},
          ${JSON.stringify({
            name: input.productName,
            description: "COD QA PR58 synthetic fixture",
            categoryId: category.id,
            unitPrice: "11.00",
            currency,
          })}::jsonb
        ) returning id
      `;
      const committedAt =
        input.reservationStatus === "committed"
          ? new Date(Date.now() - 30 * 60 * 1000)
          : null;
      await tx`
        insert into inventory_reservation (
          order_id, order_item_id, product_id, store_id, quantity, status,
          reserved_at, committed_at
        ) values (
          ${order.id}, ${item.id}, ${input.productId}, ${store.id},
          ${input.quantity}, ${input.reservationStatus},
          now() - interval '1 hour', ${committedAt}
        )
      `;
      if (input.adjustInventory) {
        await tx`
          update product_inventory
          set reserved = reserved + ${input.quantity}, updated_at = now()
          where product_id = ${input.productId} and store_id = ${store.id}
        `;
      }
      return { id: order.id, itemId: item.id, skipped: false };
    }

    const shipping = await ensureOrder({
      reference: refs.shipping,
      telegramUserId: 95001,
      status: "preparing",
      fulfillmentStatus: "unfulfilled",
      productId: product.id,
      productName: "COD QA58 Shipping Product",
      quantity: 2,
      subtotal: "22.00",
      total: "31.00",
      lineTotal: "22.00",
      reservationStatus: "reserved",
      adjustInventory: true,
      customerName: "QA58 Shipping Buyer",
      customerPhone: "+15550000801",
      customerAddress: "801 QA58 Shipping Street",
    });

    const cancelProductId = await ensureProduct("cod-qa58-cancel-product", 5, 0);
    const cancel = await ensureOrder({
      reference: refs.cancel,
      telegramUserId: 95002,
      status: "preparing",
      fulfillmentStatus: "unfulfilled",
      productId: cancelProductId,
      productName: "COD QA58 Cancel Product",
      quantity: 2,
      subtotal: "22.00",
      total: "31.00",
      lineTotal: "22.00",
      reservationStatus: "reserved",
      adjustInventory: true,
      customerName: "QA58 Cancel Buyer",
      customerPhone: "+15550000802",
      customerAddress: "802 QA58 Cancel Street",
    });

    const legacyProductId = await ensureProduct("cod-qa58-legacy-product", 4, 0);
    const legacy = await ensureOrder({
      reference: refs.legacy,
      telegramUserId: 95003,
      status: "preparing",
      fulfillmentStatus: "handed_to_shipping",
      productId: legacyProductId,
      productName: "COD QA58 Legacy Product",
      quantity: 1,
      subtotal: "11.00",
      total: "20.00",
      lineTotal: "11.00",
      reservationStatus: "committed",
      adjustInventory: false,
      customerName: "QA58 Legacy Buyer",
      customerPhone: "+15550000803",
      customerAddress: "803 QA58 Legacy Street",
    });

    const inventoryRows = await tx`
      select p.slug, i.on_hand, i.reserved
      from product_inventory i join product p on p.id = i.product_id
      where p.slug in (
        ${BASELINE_PRODUCT_SLUG}, 'cod-qa58-cancel-product',
        'cod-qa58-legacy-product'
      )
      order by p.slug
    `;
    const fixtureOrders = await tx`
      select reference, status, payment_status, fulfillment_status,
        handed_to_shipping_at, delivered_at, payment_collected_at
      from "order" where reference in (${refs.shipping}, ${refs.cancel}, ${refs.legacy})
      order by reference
    `;
    const fixtureReservations = await tx`
      select o.reference, r.status, r.quantity, r.committed_at
      from inventory_reservation r join "order" o on o.id = r.order_id
      where o.reference in (${refs.shipping}, ${refs.cancel}, ${refs.legacy})
      order by o.reference
    `;

    return {
      store: { slug: store.slug, name: store.name, id: store.id },
      refs,
      orders: { shipping, cancel, legacy },
      fixtureOrders,
      fixtureReservations,
      inventory: inventoryRows,
    };
  });

  const shippingInventory = result.inventory.find(
    (row) => row.slug === BASELINE_PRODUCT_SLUG,
  );
  if (
    Number(shippingInventory?.on_hand) !== 5 ||
    Number(shippingInventory?.reserved) !== 3
  ) {
    fail(
      `Shipping fixture stock is ${shippingInventory?.on_hand}/${shippingInventory?.reserved}, expected 5/3`,
    );
  }
  const cancelInventory = result.inventory.find(
    (row) => row.slug === "cod-qa58-cancel-product",
  );
  if (
    Number(cancelInventory?.on_hand) !== 5 ||
    Number(cancelInventory?.reserved) !== 2
  ) {
    fail(
      `Cancel fixture stock is ${cancelInventory?.on_hand}/${cancelInventory?.reserved}, expected 5/2`,
    );
  }
  const legacyInventory = result.inventory.find(
    (row) => row.slug === "cod-qa58-legacy-product",
  );
  if (
    Number(legacyInventory?.on_hand) !== 4 ||
    Number(legacyInventory?.reserved) !== 0
  ) {
    fail(
      `Legacy fixture stock is ${legacyInventory?.on_hand}/${legacyInventory?.reserved}, expected 4/0`,
    );
  }
  return result;
}

async function main() {
  stage = "validate";
  requireSha(CANDIDATE_SHA, "CANDIDATE_SHA");
  requireSha(BASELINE_SHA, "BASELINE_SHA");
  requireServiceId(BASELINE_SERVICE_ID, "BASELINE_SERVICE_ID");
  const appUrl = requireHttps(QA_APP_URL);
  if (!RENDER_API_KEY) fail("RENDER_API_KEY is missing");
  if (!OWNER_URL_RAW) fail("NEON_DEV_DATABASE_URL is missing");
  if (!fs.existsSync(path.join(CODE_ROOT, "drizzle", "meta", "_journal.json"))) {
    fail("Candidate worktree has no Drizzle journal");
  }
  fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });

  const baselineService = await getService(BASELINE_SERVICE_ID);
  const baselineServiceUrl = String(
    baselineService?.serviceDetails?.url ?? "",
  ).replace(/\/$/, "");
  const baselineEnv = await getEnvMap(BASELINE_SERVICE_ID);
  const baselineBuildSha = String(baselineEnv.get("RABET_BUILD_SHA") ?? "").toLowerCase();
  if (baselineBuildSha !== BASELINE_SHA) {
    fail(`Baseline RABET_BUILD_SHA is ${baselineBuildSha || "missing"}, expected ${BASELINE_SHA}`);
  }
  const baselineUrlRaw = baselineEnv.get("DATABASE_URL");
  if (!baselineUrlRaw) fail("Baseline DATABASE_URL is missing");
  const baselineUrl = parseDbUrl(baselineUrlRaw, "Baseline DATABASE_URL");
  const baselineDb = dbHostAndName(baselineUrl);
  if (baselineDb.database !== BASELINE_DB_NAME) {
    fail(`Baseline database is ${baselineDb.database}, expected ${BASELINE_DB_NAME}`);
  }
  const ownerUrl = parseDbUrl(OWNER_URL_RAW, "NEON_DEV_DATABASE_URL");

  summary.baseline = {
    serviceId: BASELINE_SERVICE_ID,
    serviceName: baselineService?.name,
    serviceUrl: baselineServiceUrl,
    buildSha: baselineBuildSha,
    database: { host: baselineDb.host, name: baselineDb.database, role: baselineDb.user },
  };
  log(`Baseline #57 QA ${BASELINE_SERVICE_ID} at ${baselineBuildSha}; DB ${baselineDb.host}/${baselineDb.database}`);

  stage = "create-isolated-db";
  safeIdentifier(QA_DB_NAME);
  safeIdentifier(QA_DB_ROLE);
  const rolePassword = crypto.randomBytes(24).toString("hex");
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
      const ownerTargetUrl = buildTargetUrl(ownerUrl, ownerRole, decodeURIComponent(ownerUrl.password), QA_DB_NAME);
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
      if (probeTables !== 0) {
        fail(`Database ${QA_DB_NAME} already exists with tables; refusing to overwrite it`);
      }
      log(`Removing empty failed-attempt database ${QA_DB_NAME}`);
      await owner.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${QA_DB_NAME}' and pid <> pg_backend_pid()`).catch(() => {});
      await owner.unsafe(`drop database "${QA_DB_NAME}" with (force)`);
    }
    if (existingRole.length > 0) {
      if (existingDb.length === 0) fail(`Role ${QA_DB_ROLE} already exists without the QA database; refusing to overwrite it`);
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
  secrets.push(targetUrlRaw, rolePassword);
  const targetUrl = new URL(targetUrlRaw);
  const targetDb = dbHostAndName(targetUrl);
  summary.isolatedDatabase = {
    host: targetDb.host,
    name: targetDb.database,
    role: targetDb.user,
    recovery: "new isolated database; #57 QA baseline is untouched and can be re-copied",
  };
  log(`Created isolated database ${targetDb.host}/${targetDb.database}`);

  stage = "baseline-snapshot";
  const baselineSql = postgres(baselineUrl.toString(), { max: 1, connect_timeout: 30, ssl: "require" });
  let baselineSnapshot;
  let baselineRefs;
  let accounts;
  try {
    baselineSnapshot = await snapshot(baselineSql, "baseline");
    baselineRefs = await baselineRefHashes(baselineSql);
    accounts = await readAccountSummary(baselineSql);
    if (baselineSnapshot.data.counts.migrations !== 15) {
      fail(`Baseline ledger has ${baselineSnapshot.data.counts.migrations} migrations, expected 15`);
    }
    if (!baselineSnapshot.data.targetOrder || baselineSnapshot.data.targetOrder.reference !== "ORD-X2EZD9") {
      fail("Baseline ORD-X2EZD9 is missing");
    }
    const refs = new Set(
      (await baselineSql`select reference from "order" order by reference`).map((row) => row.reference),
    );
    for (const ref of BASELINE_ORDER_REFS) {
      if (!refs.has(ref)) fail(`Baseline order ${ref} is missing`);
    }
    if (baselineSnapshot.data.stores.length !== 4) {
      fail(`Baseline store count is ${baselineSnapshot.data.stores.length}, expected 4`);
    }
    if (baselineSnapshot.data.counts.orders !== 6) {
      fail(`Baseline order count is ${baselineSnapshot.data.counts.orders}, expected 6`);
    }
    summary.baseline.snapshot = {
      counts: baselineSnapshot.data.counts,
      stores: baselineSnapshot.data.stores,
      ordersByStatus: baselineSnapshot.data.ordersByStatus,
      reservationsByStatus: baselineSnapshot.data.reservationsByStatus,
      targetOrder: baselineSnapshot.data.targetOrder,
      connections: baselineSnapshot.data.connections,
      hashes: baselineSnapshot.hashes,
      refHashes: baselineRefs,
      accounts,
    };
    log("Captured #57 QA baseline snapshot");
  } finally {
    await baselineSql.end({ timeout: 5 }).catch(() => {});
  }

  stage = "copy-baseline";
  log("Dumping #57 QA and restoring into the isolated database");
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
  try {
    copiedSnapshot = await snapshot(targetSql, "copied");
    if (copiedSnapshot.data.counts.migrations !== 15) {
      fail(`Copied ledger has ${copiedSnapshot.data.counts.migrations} migrations, expected 15`);
    }
    assertHashesEqual(baselineSnapshot, copiedSnapshot, "Copied baseline");
    summary.isolatedDatabase.snapshotBeforeMigration = {
      counts: copiedSnapshot.data.counts,
      hashes: copiedSnapshot.hashes,
      dbIdentity: copiedSnapshot.dbIdentity,
    };
    log("Isolated copy matches #57 QA immediately before migration");
  } finally {
    await targetSql.end({ timeout: 5 }).catch(() => {});
  }

  stage = "apply-0015";
  const migrate = spawnSync("npm", ["run", "db:migrate"], {
    cwd: CODE_ROOT,
    env: { ...process.env, DATABASE_URL: targetUrl.toString() },
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
  });
  if (migrate.status !== 0) {
    fail(`Migration failed: ${migrate.stderr || migrate.stdout}`);
  }
  const journalPath = path.join(CODE_ROOT, "drizzle", "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (!Array.isArray(journal.entries) || journal.entries.length !== 16) {
    fail(`Candidate journal has ${journal.entries?.length ?? "no"} entries, expected 16`);
  }
  const lastTag = journal.entries[journal.entries.length - 1]?.tag;
  if (lastTag !== "0015_cod_shipping_delivery_collection") {
    fail(`Candidate journal last tag is ${lastTag}, expected 0015_cod_shipping_delivery_collection`);
  }

  stage = "verify-migration";
  const promotedSql = postgres(targetUrl.toString(), { max: 2, connect_timeout: 30, ssl: "require" });
  let promotedSnapshot;
  try {
    promotedSnapshot = await snapshot(promotedSql, "promoted");
    const postRefs = await baselineRefHashes(promotedSql);
    if (promotedSnapshot.data.counts.migrations !== 16) {
      fail(`Promoted ledger has ${promotedSnapshot.data.counts.migrations} migrations, expected 16`);
    }
    assertHashesEqual(copiedSnapshot, promotedSnapshot, "Post-migration");
    if (JSON.stringify(postRefs) !== JSON.stringify(baselineRefs)) {
      fail("Existing evidence orders changed during migration");
    }
    const constraints = await promotedSql`
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname in (
        'order_shipping_state_check',
        'order_payment_collection_state_check'
      ) order by conname
    `;
    if (constraints.length !== 2) fail("Expected both new order constraints after migration");
    const newColumns = await promotedSql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'order'
        and column_name in (
          'handed_to_shipping_at', 'delivered_at', 'payment_collected_at'
        )
      order by column_name
    `;
    if (newColumns.length !== 3) fail("Expected three new order timestamp columns");
    const [filled] = await promotedSql`
      select count(*)::int as count from "order"
      where handed_to_shipping_at is not null
         or delivered_at is not null
         or payment_collected_at is not null
    `;
    if (filled.count !== 0) fail("0015 filled historical event timestamps");
    const ledger = await promotedSql`
      select id, hash, created_at from drizzle.__drizzle_migrations order by id
    `;
    const migrationFile = path.join(
      CODE_ROOT,
      "drizzle",
      "0015_cod_shipping_delivery_collection.sql",
    );
    const expectedHash = crypto.createHash("sha256").update(fs.readFileSync(migrationFile)).digest("hex");
    if (String(ledger[ledger.length - 1]?.hash) !== expectedHash) {
      fail("Ledger last hash does not match candidate migration 0015");
    }
    summary.isolatedDatabase.migration = {
      ledgerBefore: copiedSnapshot.data.counts.migrations,
      ledgerAfter: promotedSnapshot.data.counts.migrations,
      pending: journal.entries.length - promotedSnapshot.data.counts.migrations,
      lastTag,
      lastHash: expectedHash,
      constraints: constraints.map((row) => ({
        name: row.conname,
        definition: row.definition,
      })),
      newColumns: newColumns.map((row) => row.column_name),
      historicalTimestampsFilled: filled.count,
    };
    summary.isolatedDatabase.snapshotAfterMigration = {
      counts: promotedSnapshot.data.counts,
      hashes: promotedSnapshot.hashes,
      targetOrder: promotedSnapshot.data.targetOrder,
      dbIdentity: promotedSnapshot.dbIdentity,
      baselineRefs: postRefs,
    };
    log("Migration 0015 verified: 16/16 ledger, constraints present, historical data preserved");
  } finally {
    await promotedSql.end({ timeout: 5 }).catch(() => {});
  }

  stage = "create-fixtures";
  const fixtureSql = postgres(targetUrl.toString(), { max: 2, connect_timeout: 30, ssl: "require" });
  let fixtures;
  try {
    fixtures = await createFixtures(fixtureSql);
    summary.fixtures = {
      store: fixtures.store,
      references: fixtures.refs,
      orders: fixtures.fixtureOrders,
      reservations: fixtures.fixtureReservations,
      inventory: fixtures.inventory,
      accounts: accounts.filter((row) =>
        ["cod-pr56-store-b", "cod-pr56-store-c", "cod-pr57-store-d"].includes(
          row.storeSlug,
        ),
      ),
      expected: {
        shippingStock: "5/3 -> 3/1",
        cancelStock: "5/2 -> 5/0",
        legacyStock: "4/0",
        deliveryPayment: "awaiting_collection",
        collectionPayment: "collected",
      },
    };
    const postFixtureRefs = await baselineRefHashes(fixtureSql);
    if (JSON.stringify(postFixtureRefs) !== JSON.stringify(baselineRefs)) {
      fail("Existing evidence orders changed while creating fixtures");
    }
    log(`Created fixtures ${fixtures.refs.shipping}, ${fixtures.refs.cancel}, ${fixtures.refs.legacy}`);
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
      fail("QA service unexpectedly still has Telegram credentials");
    }
    log(`Reused empty QA service ${qaService.id} and replaced its environment`);
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
  if (qaEnv.has("TELEGRAM_BOT_TOKEN")) fail("QA service must not have Telegram credentials");
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
  log(`QA service ${qaService.id} points only to ${qaDb.host}/${qaDb.database}`);

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
      } else if (status === "live") {
        fail(`QA service is live at ${commit}, not the candidate`);
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

  summary.qaService.deployStatus = "live";
  summary.qaService.deployCommit = liveCommit ?? CANDIDATE_SHA;
  summary.qaService.health = health;
  summary.status = "ready";
  summary.stage = "complete";
  summary.generatedAt = new Date().toISOString();
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o644 });
  log(`QA candidate is live at ${QA_APP_URL} with SHA ${health.sha}`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  summary.status = "blocked";
  summary.stage = stage;
  summary.error = redact(error instanceof Error ? error.message : String(error));
  summary.generatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o644 });
  } catch {}
  process.stderr.write(`[cod-qa-pr58:FAIL] ${summary.error}\n`);
  process.exitCode = 1;
});
