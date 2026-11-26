#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";

import postgres from "postgres";

const CANDIDATE_SHA = (process.env.CANDIDATE_SHA ?? "").trim().toLowerCase();
const SERVICE_ID = (process.env.RENDER_SERVICE_ID ?? "").trim();
const APP_URL = (process.env.APP_URL ?? "").trim().replace(/\/$/, "");
const RENDER_API_KEY = process.env.RENDER_API_KEY ?? "";
const CONFIRM = process.env.DEPLOY_CONFIRM ?? "";
const EXPECTED_CONFIRM = "DEPLOY_PR62_COD_STAGING";
const EXPECTED_SERVICE_NAME = "nokmel-cod-staging";
const QA_STORE_SLUG = "cod-pr56-store-a";
const QA_WALLET_NUMBER = "+201000000062";
const QA_ACCOUNT_NAME = "Synthetic Vodafone QA — Store A";
const QA_INSTRUCTIONS_AR =
  "اختبار اصطناعي: حوّل المبلغ إلى محفظة الاختبار ثم أرسل المرجع.";
const QA_INSTRUCTIONS_EN =
  "Synthetic QA only: transfer the exact amount to the test wallet, then submit the reference.";
const TARGET_ORDER_REFERENCE = "ORD-X2EZD9";
const EXPECTED_LEDGER_COUNT = 19;
const EXPECTED_LEDGER_HASH =
  "868ba439a60f6a3870a5535e032ad55ab0d38c69aced7cf1532e465c632dc339";
const EXPECTED_MIGRATION_TAG = "0018_sparkling_morlun";
const SUMMARY_PATH = "/tmp/cod-staging-pr62-summary.json";

function log(message) {
  process.stdout.write(`[cod-staging-pr62] ${String(message)}\n`);
}

function fail(message) {
  process.stderr.write(`[cod-staging-pr62:FAIL] ${String(message)}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function deployCommit(deploy) {
  return String(deploy?.commit?.id ?? deploy?.commitId ?? "").toLowerCase();
}

function deployStatus(deploy) {
  return String(deploy?.status ?? "unknown");
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

function normalizeDeployList(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.deploys)
      ? payload.deploys
      : null;
  if (!list) fail("Unexpected Render deploy-list response shape");
  return list.map((entry) => entry?.deploy ?? entry).filter(Boolean);
}

async function renderApi(method, apiPath, body) {
  const response = await fetch(`https://api.render.com/v1${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${RENDER_API_KEY}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {}
  }
  if (!response.ok) {
    fail(`Render API ${method} ${apiPath} failed HTTP ${response.status}`);
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

async function readEnvMap() {
  const envList = normalizeEnvList(
    await renderApi("GET", `/services/${SERVICE_ID}/env-vars`),
  );
  const map = new Map();
  for (const entry of envList) {
    if (entry.key && typeof entry.value === "string") {
      map.set(entry.key, entry.value);
    }
  }
  return map;
}

function fingerprintEnv(map, excludedKeys = new Set()) {
  const lines = [...map.entries()]
    .filter(([key]) => !excludedKeys.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\u0000${value}\n`);
  return crypto.createHash("sha256").update(lines.join("")).digest("hex");
}

function hashRows(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function readLedger(db) {
  const rows = await db`
    select id, hash, created_at
    from drizzle.__drizzle_migrations
    order by id
  `;
  return {
    count: rows.length,
    lastHash: rows[rows.length - 1]?.hash ?? null,
  };
}

async function readSnapshot(db, storeId) {
  const stores = await db`
    select id, name, slug, status, created_at, updated_at
    from store
    order by id
  `;
  const orders = await db`
    select id, store_id, connection_id, telegram_user_id, telegram_chat_id,
      reference, checkout_key, status, payment_method, payment_status,
      fulfillment_status, currency, subtotal, delivery_fee, total,
      placed_at, accepted_at, preparing_at, handed_to_shipping_at,
      delivered_at, payment_collected_at, cancelled_at, cancellation_reason,
      created_at, updated_at
    from "order"
    order by id
  `;
  const orderItems = await db`
    select id, order_id, product_id, product_name, unit_price, quantity,
      line_total, created_at
    from order_item
    order by id
  `;
  const reservations = await db`
    select id, order_id, order_item_id, product_id, store_id, quantity, status,
      reserved_at, committed_at, released_at, release_reason, created_at, updated_at
    from inventory_reservation
    order by id
  `;
  const inventory = await db`
    select product_id, store_id, on_hand, reserved, created_at, updated_at
    from product_inventory
    order by product_id
  `;
  const carts = await db`
    select id, store_id, connection_id, telegram_user_id, telegram_chat_id,
      status, checkout_state, checkout_key, quote_total, quote_currency,
      quote_version, created_at, updated_at
    from cart
    order by id
  `;
  const cartItems = await db`
    select id, cart_id, product_id, quantity, created_at, updated_at
    from cart_item
    order by id
  `;
  const connections = await db`
    select id, store_id, bot_id::text as bot_id, bot_username, status,
      webhook_url, created_at, verified_at
    from telegram_connection
    order by id
  `;
  const commerce = await db`
    select store_id, currency, delivery_fee, cod_enabled, created_at, updated_at
    from store_commerce_setting
    order by store_id
  `;
  const [counts] = await db`
    select
      (select count(*)::int from store) as stores,
      (select count(*)::int from "order") as orders,
      (select count(*)::int from order_item) as order_items,
      (select count(*)::int from inventory_reservation) as reservations,
      (select count(*)::int from product_inventory) as inventory_rows,
      (select count(*)::int from cart) as carts,
      (select count(*)::int from cart_item) as cart_items,
      (select count(*)::int from telegram_connection) as connections
  `;
  const [selectedStoreCommerce] = storeId
    ? await db`
        select currency, delivery_fee, cod_enabled
        from store_commerce_setting
        where store_id = ${storeId}
        limit 1
      `
    : [];
  const [pendingForStore] = storeId
    ? await db`
        select count(*)::int as count
        from "order"
        where store_id = ${storeId}
          and payment_method = 'cod'
          and status = 'placed'
          and fulfillment_status = 'unfulfilled'
      `
    : [{ count: 0 }];

  return {
    ledger: await readLedger(db),
    counts,
    selectedStoreCommerce: selectedStoreCommerce ?? null,
    pendingForStore: pendingForStore?.count ?? 0,
    hashes: {
      stores: hashRows(stores),
      orders: hashRows(orders),
      orderItems: hashRows(orderItems),
      reservations: hashRows(reservations),
      inventory: hashRows(inventory),
      carts: hashRows(carts),
      cartItems: hashRows(cartItems),
      connections: hashRows(connections),
      commerce: hashRows(commerce),
    },
  };
}

async function readOrderCandidates(db) {
  return db`
    select o.id, o.reference, o.store_id, s.slug as store_slug, s.name as store_name,
      o.status, o.payment_status, o.fulfillment_status, o.total, o.currency,
      o.placed_at
    from "order" o
    join store s on s.id = o.store_id
    order by o.placed_at desc, o.id desc
  `;
}

async function readMerchantForStore(db, storeId) {
  const rows = await db`
    select u.id, u.session_version
    from app_user u
    join store_membership m on m.user_id = u.id
    where m.store_id = ${storeId}
      and m.status = 'active'
      and m.role = 'owner'
      and u.status = 'active'
    order by u.created_at
    limit 1
  `;
  return rows[0] ?? null;
}

async function assertApplied0018(db, label) {
  const [rows] = await db`
    select count(*)::int as count
    from drizzle.__drizzle_migrations
  `;
  const [last] = await db`
    select hash
    from drizzle.__drizzle_migrations
    order by id desc
    limit 1
  `;
  const count = Number(rows?.count ?? -1);
  const lastHash = String(last?.hash ?? "");
  if (count !== EXPECTED_LEDGER_COUNT) {
    fail(`${label}: expected ledger ${EXPECTED_LEDGER_COUNT}, found ${count}`);
  }
  if (lastHash !== EXPECTED_LEDGER_HASH) {
    fail(`${label}: applied migration hash is not ${EXPECTED_MIGRATION_TAG}`);
  }
  return { count, lastHash, tag: EXPECTED_MIGRATION_TAG };
}

async function applyVodafoneQaFixture(db) {
  const [store] = await db`
    select id, name, slug, status
    from store
    where slug = ${QA_STORE_SLUG}
    limit 1
  `;
  if (!store) fail(`Approved QA store ${QA_STORE_SLUG} is missing`);
  if (store.status !== "active") {
    fail(`Approved QA store ${QA_STORE_SLUG} is not active`);
  }

  const [setting] = await db`
    update store_commerce_setting
    set vodafone_cash_enabled = true,
        vodafone_cash_number = ${QA_WALLET_NUMBER},
        vodafone_cash_account_name = ${QA_ACCOUNT_NAME},
        vodafone_cash_instructions_ar = ${QA_INSTRUCTIONS_AR},
        vodafone_cash_instructions_en = ${QA_INSTRUCTIONS_EN},
        updated_at = now()
    where store_id = ${store.id}
    returning store_id, currency, cod_enabled, vodafone_cash_enabled,
      vodafone_cash_number, vodafone_cash_account_name,
      vodafone_cash_instructions_ar, vodafone_cash_instructions_en
  `;
  if (!setting) {
    fail(`Store commerce setting for ${QA_STORE_SLUG} is missing; fixture not applied`);
  }

  await db`
    update store_commerce_setting
    set vodafone_cash_enabled = false,
        updated_at = now()
    where store_id <> ${store.id}
      and vodafone_cash_enabled = true
  `;

  const stores = await db`
    select s.id, s.name, s.slug, s.status,
      coalesce(c.vodafone_cash_enabled, false) as vodafone_cash_enabled
    from store s
    left join store_commerce_setting c on c.store_id = s.id
    order by s.slug
  `;
  const enabledElsewhere = stores.filter(
    (row) => row.id !== store.id && row.vodafone_cash_enabled === true,
  );
  if (enabledElsewhere.length > 0) {
    fail("Vodafone Cash must stay disabled for every other store");
  }

  const [bot] = await db`
    select bot_id::text as bot_id, bot_username, status, webhook_url
    from telegram_connection
    where store_id = ${store.id}
      and status = 'ready'
    order by created_at desc
    limit 1
  `;
  if (!bot) fail(`No ready Telegram bot for approved QA store ${QA_STORE_SLUG}`);
  if (!String(bot.webhook_url).startsWith(APP_URL)) {
    fail("Approved QA store Telegram webhook does not point at permanent Staging");
  }

  return {
    store: {
      id: store.id,
      name: store.name,
      slug: store.slug,
      status: store.status,
    },
    setting: {
      currency: setting.currency,
      codEnabled: setting.cod_enabled,
      vodafoneCashEnabled: setting.vodafone_cash_enabled,
      number: setting.vodafone_cash_number,
      accountName: setting.vodafone_cash_account_name,
      instructionsAr: setting.vodafone_cash_instructions_ar,
      instructionsEn: setting.vodafone_cash_instructions_en,
    },
    bot: {
      botId: bot.bot_id,
      botUsername: bot.bot_username,
      status: bot.status,
      webhookUrl: bot.webhook_url,
    },
    stores: stores.map((row) => ({
      slug: row.slug,
      status: row.status,
      vodafoneCashEnabled: row.vodafone_cash_enabled,
    })),
  };
}

async function waitForHealth() {
  const deadline = Date.now() + 8 * 60 * 1000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${APP_URL}/api/healthz`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => null);
      last = { status: response.status, payload };
      if (
        response.ok &&
        payload?.status === "ok" &&
        String(payload?.sha ?? "").toLowerCase() === CANDIDATE_SHA
      ) {
        return {
          httpStatus: response.status,
          body: payload,
          cacheControl: response.headers.get("cache-control"),
        };
      }
      log(
        `Health not ready: HTTP ${response.status} sha ${String(payload?.sha ?? "missing")}`,
      );
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  fail(
    `Timed out waiting for health SHA ${CANDIDATE_SHA}; last ${JSON.stringify(last)}`,
  );
}

async function deployExactCommit() {
  const deploy = await renderApi(
    "POST",
    `/services/${SERVICE_ID}/deploys`,
    { commitId: CANDIDATE_SHA },
  );
  if (!deploy?.id) fail("Render did not return a deploy id");
  log(`Render deploy ${deploy.id} started for ${CANDIDATE_SHA}`);

  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const current = await renderApi(
      "GET",
      `/services/${SERVICE_ID}/deploys/${deploy.id}`,
    );
    const status = deployStatus(current);
    log(`Render deploy status: ${status}`);
    if (status === "live") return current;
    if (
      [
        "build_failed",
        "update_failed",
        "canceled",
        "deactivated",
        "pre_deploy_failed",
      ].includes(status)
    ) {
      fail(`Render deploy failed with status ${status}`);
    }
  }
  fail("Timed out waiting for Render deploy to become live");
}

async function main() {
  if (!/^[0-9a-f]{40}$/.test(CANDIDATE_SHA)) fail("Invalid CANDIDATE_SHA");
  if (!/^srv-[a-z0-9]+$/i.test(SERVICE_ID)) fail("Invalid RENDER_SERVICE_ID");
  if (!RENDER_API_KEY) fail("RENDER_API_KEY is missing");
  if (!APP_URL.startsWith("https://")) fail("APP_URL must use https://");
  if (CONFIRM !== EXPECTED_CONFIRM) {
    fail(`DEPLOY_CONFIRM must equal ${EXPECTED_CONFIRM}`);
  }

  const servicePayload = await renderApi("GET", `/services/${SERVICE_ID}`);
  const service = servicePayload?.service ?? servicePayload;
  if (!service?.id) fail("Render did not return the service");
  if (String(service.id) !== SERVICE_ID) fail("Render service id mismatch");
  if (String(service.name) !== EXPECTED_SERVICE_NAME) {
    fail(`Unexpected service name ${String(service.name)}`);
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
  const liveDeploys = deploys
    .filter((deploy) => deployStatus(deploy) === "live")
    .sort((left, right) => deployDate(right) - deployDate(left));
  const currentLive = liveDeploys[0] ?? null;
  if (!currentLive?.id) fail("Could not determine the current live deploy");
  const currentLiveSha = deployCommit(currentLive);
  if (!/^[0-9a-f]{40}$/.test(currentLiveSha)) {
    fail("Current live deploy has no full commit SHA");
  }

  const envBefore = await readEnvMap();
  const databaseUrl = envBefore.get("DATABASE_URL");
  const authSecret = envBefore.get("AUTH_SECRET");
  if (!databaseUrl || !authSecret) {
    fail("Expected DATABASE_URL/AUTH_SECRET are missing on Staging");
  }
  const envFingerprintBefore = fingerprintEnv(
    envBefore,
    new Set(["RABET_BUILD_SHA", "RABET_MANUAL_TRANSFER_ENABLED"]),
  );

  const db = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 30,
    ssl: "require",
  });

  let orderCandidates;
  let merchant;
  let selectedStore;
  let smokeOrder;
  let museOrder;
  let dbBefore;
  let dbAfter;

  try {
    const migrationBeforeDeploy = await assertApplied0018(
      db,
      "pre-deploy",
    );

    await db.begin(async (tx) => {
      await tx`set transaction read only`;
      orderCandidates = await readOrderCandidates(tx);
    });

    const stores = await db`
      select id, name, slug, status from store order by slug
    `;
    const pendingOrders = orderCandidates.filter(
      (order) =>
        order.status === "placed" && order.fulfillment_status === "unfulfilled",
    );
    const preferredPending =
      pendingOrders.find((order) => order.store_slug === "cod-pr56-store-a") ??
      pendingOrders[0] ??
      null;
    const storeACandidate = stores.find(
      (store) => store.slug === QA_STORE_SLUG,
    );
    const preferredStoreId =
      storeACandidate?.id ?? preferredPending?.store_id;
    selectedStore =
      stores.find((store) => store.id === preferredStoreId) ?? stores[0] ?? null;
    if (!selectedStore) fail("No Staging store is available for smoke checks");

    merchant = await readMerchantForStore(db, selectedStore.id);
    if (!merchant) {
      for (const store of stores) {
        const candidate = await readMerchantForStore(db, store.id);
        if (candidate) {
          selectedStore = store;
          merchant = candidate;
          break;
        }
      }
    }
    if (!merchant) fail("No active merchant fixture is available for smoke checks");

    const selectedStoreOrders = orderCandidates.filter(
      (order) => order.store_id === selectedStore.id,
    );
    const selectedStorePending = selectedStoreOrders.filter(
      (order) =>
        order.status === "placed" && order.fulfillment_status === "unfulfilled",
    );
    smokeOrder =
      selectedStorePending[0] ?? selectedStoreOrders[0] ?? orderCandidates[0] ?? null;
    museOrder =
      preferredPending ??
      pendingOrders[0] ??
      smokeOrder ??
      orderCandidates[0] ??
      null;

    await db.begin(async (tx) => {
      await tx`set transaction read only`;
      dbBefore = await readSnapshot(tx, selectedStore.id);
    });

    const { encode } = await import("next-auth/jwt");
    const cookie = await encode({
      token: {
        merchantId: merchant.id,
        role: "merchant",
        sessionVersion: merchant.session_version,
        sub: merchant.id,
      },
      secret: authSecret,
      salt: "rabet-merchant.session-token",
    });

    if (
      envBefore.get("RABET_BUILD_SHA") !== CANDIDATE_SHA ||
      envBefore.get("RABET_MANUAL_TRANSFER_ENABLED") !== "true"
    ) {
      const nextEnvMap = new Map(envBefore);
      nextEnvMap.set("RABET_BUILD_SHA", CANDIDATE_SHA);
      nextEnvMap.set("RABET_MANUAL_TRANSFER_ENABLED", "true");
      const nextPayload = [...nextEnvMap.entries()].map(([key, value]) => ({
        key,
        value,
      }));
      await renderApi("PUT", `/services/${SERVICE_ID}/env-vars`, nextPayload);
      log(
        "Updated the non-secret RABET_BUILD_SHA and manual-transfer staging flags",
      );
    }

    const envAfterBuildSha = await readEnvMap();
    if (envAfterBuildSha.get("RABET_BUILD_SHA") !== CANDIDATE_SHA) {
      fail("RABET_BUILD_SHA was not persisted");
    }
    if (envAfterBuildSha.get("RABET_MANUAL_TRANSFER_ENABLED") !== "true") {
      fail("RABET_MANUAL_TRANSFER_ENABLED was not persisted");
    }
    const envFingerprintAfter = fingerprintEnv(
      envAfterBuildSha,
      new Set(["RABET_BUILD_SHA", "RABET_MANUAL_TRANSFER_ENABLED"]),
    );
    if (envFingerprintAfter !== envFingerprintBefore) {
      fail("Staging environment changed beyond the approved staging flags");
    }

    const deploy = await deployExactCommit();
    const finalCommit = deployCommit(deploy);
    if (finalCommit !== CANDIDATE_SHA) {
      fail(`Deploy commit ${finalCommit} does not match ${CANDIDATE_SHA}`);
    }
    if (deployStatus(deploy) !== "live") {
      fail(`Deploy final status is ${deployStatus(deploy)}`);
    }

    const health = await waitForHealth();

    const qaFixture = await applyVodafoneQaFixture(db);
    log(
      `Vodafone QA fixture enabled only for ${qaFixture.store.slug} (${qaFixture.bot.botUsername})`,
    );

    const loginResponse = await fetch(`${APP_URL}/app/login`, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(30_000),
    });
    const loginHtml = await loginResponse.text();
    if (loginResponse.status !== 200) {
      fail(`Merchant login page returned HTTP ${loginResponse.status}`);
    }
    if (!loginHtml.includes('data-testid="merchant-login-page"')) {
      fail("Merchant login page did not render the login form");
    }

    const merchantFetch = (pathName) =>
      fetch(`${APP_URL}${pathName}`, {
        headers: {
          Cookie: `rabet-merchant.session-token=${cookie}`,
          "Cache-Control": "no-cache",
        },
        signal: AbortSignal.timeout(30_000),
      });

    const setupResponse = await merchantFetch(
      `/app/setup?verify=${Date.now()}`,
    );
    const setupHtml = await setupResponse.text();
    if (setupResponse.status !== 200) {
      fail(`Merchant setup page returned HTTP ${setupResponse.status}`);
    }
    if (!setupHtml.includes('data-testid="merchant-setup-page"')) {
      fail("Merchant setup page did not render");
    }
    const setupPendingMatch = setupHtml.match(
      /data-testid="merchant-needs-attention"[^>]*data-pending-count="(\d+)"/,
    );
    const setupHasAttention = setupHtml.includes(
      'data-testid="merchant-needs-attention"',
    );
    if (
      (dbBefore.selectedStoreCommerce?.cod_enabled === true ||
        dbBefore.pendingForStore > 0) &&
      !setupHasAttention
    ) {
      fail("Merchant setup page did not render the Needs Attention section");
    }

    const vodafoneInputTag =
      setupHtml.match(
        /<input[^>]*data-testid="merchant-vodafone-enabled"[^>]*>/,
      )?.[0] ?? "";
    const setupVodafoneEnabled =
      vodafoneInputTag.includes("checked") &&
      setupHtml.includes(QA_WALLET_NUMBER);
    if (!setupVodafoneEnabled) {
      fail("Merchant setup page did not render the enabled Vodafone Cash fixture");
    }

    const ordersResponse = await merchantFetch(
      `/app/orders?verify=${Date.now()}`,
    );
    const ordersHtml = await ordersResponse.text();
    if (ordersResponse.status !== 200) {
      fail(`Merchant orders page returned HTTP ${ordersResponse.status}`);
    }
    if (!ordersHtml.includes('data-testid="merchant-orders-page"')) {
      fail("Merchant orders page did not render");
    }
    if (smokeOrder && !ordersHtml.includes(smokeOrder.reference)) {
      fail(`Merchant orders page did not serve ${smokeOrder.reference}`);
    }
    if (!ordersHtml.includes(TARGET_ORDER_REFERENCE)) {
      fail(`Merchant orders page did not serve ${TARGET_ORDER_REFERENCE}`);
    }

    let selectedOrderCheck = null;
    if (smokeOrder) {
      const selectedResponse = await merchantFetch(
        `/app/orders?order=${smokeOrder.id}&verify=${Date.now()}#merchant-order-${smokeOrder.id}`,
      );
      const selectedHtml = await selectedResponse.text();
      if (selectedResponse.status !== 200) {
        fail(`Selected order page returned HTTP ${selectedResponse.status}`);
      }
      if (!selectedHtml.includes(`id="merchant-order-${smokeOrder.id}"`)) {
        fail(`Selected order card ${smokeOrder.reference} did not render`);
      }
      selectedOrderCheck = {
        reference: smokeOrder.reference,
        cardRendered: true,
      };
    }

    await db.begin(async (tx) => {
      await tx`set transaction read only`;
      dbAfter = await readSnapshot(tx, selectedStore.id);
      const [afterOrder] = smokeOrder
        ? await tx`
            select status, payment_status, fulfillment_status, total, updated_at
            from "order"
            where id = ${smokeOrder.id}
            limit 1
          `
        : [];
      if (smokeOrder && !afterOrder) {
        fail(`Smoke order ${smokeOrder.reference} disappeared`);
      }
      if (
        smokeOrder &&
        (afterOrder.status !== smokeOrder.status ||
          afterOrder.payment_status !== smokeOrder.payment_status ||
          afterOrder.fulfillment_status !== smokeOrder.fulfillment_status ||
          afterOrder.total !== smokeOrder.total)
      ) {
        fail(`Smoke order ${smokeOrder.reference} changed state`);
      }
    });

    const [targetOrder] = await db`
      select reference, status, payment_status, fulfillment_status,
        payment_method, total
      from "order"
      where reference = ${TARGET_ORDER_REFERENCE}
      limit 1
    `;
    if (!targetOrder) fail(`${TARGET_ORDER_REFERENCE} is missing`);
    if (targetOrder.status !== "accepted") {
      fail(`${TARGET_ORDER_REFERENCE} is ${targetOrder.status}, expected accepted`);
    }
    if (targetOrder.payment_method !== "cod") {
      fail(`${TARGET_ORDER_REFERENCE} is not a COD order`);
    }

    const stableHashes = (hashes) => {
      const copy = { ...hashes };
      delete copy.commerce;
      return JSON.stringify(copy);
    };
    if (stableHashes(dbBefore.hashes) !== stableHashes(dbAfter.hashes)) {
      fail("Database fixture hashes changed during the deploy/smoke window");
    }
    if (
      dbBefore.ledger.count !== dbAfter.ledger.count ||
      dbBefore.ledger.lastHash !== dbAfter.ledger.lastHash
    ) {
      fail("Migration ledger changed during the deploy/smoke window");
    }
    const migrationAfterDeploy = await assertApplied0018(
      db,
      "post-deploy",
    );
    if (
      dbBefore.counts.orders !== dbAfter.counts.orders ||
      dbBefore.counts.carts !== dbAfter.counts.carts ||
      dbBefore.counts.connections !== dbAfter.counts.connections
    ) {
      fail("Database fixture counts changed during the deploy/smoke window");
    }

    const summary = {
      service: {
        id: service.id,
        name: service.name,
        type: service.type ?? null,
        suspended: service.suspended ?? null,
        autoDeploy: service.autoDeploy ?? null,
        branch: service.branch ?? null,
      },
      appUrl: APP_URL,
      reviewedSha: CANDIDATE_SHA,
      rollback: {
        deployId: String(currentLive.id),
        sha: currentLiveSha,
        status: deployStatus(currentLive),
        createdAt: currentLive.createdAt ?? null,
        finishedAt: currentLive.finishedAt ?? null,
        imageRef: currentLive.image?.ref ?? null,
      },
      deploy: {
        id: String(deploy.id),
        status: deployStatus(deploy),
        sha: finalCommit,
        createdAt: deploy.createdAt ?? null,
        finishedAt: deploy.finishedAt ?? null,
        trigger: deploy.trigger ?? null,
        imageRef: deploy.image?.ref ?? null,
      },
      health,
      environment: {
        buildShaLabelUpdated: true,
        manualTransferFlagEnabled:
          envAfterBuildSha.get("RABET_MANUAL_TRANSFER_ENABLED") === "true",
        nonLabelFingerprintStable: true,
      },
      database: {
        migration: {
          expectedTag: EXPECTED_MIGRATION_TAG,
          expectedCount: EXPECTED_LEDGER_COUNT,
          expectedHash: EXPECTED_LEDGER_HASH,
          beforeDeploy: migrationBeforeDeploy,
          afterDeploy: migrationAfterDeploy,
          noNewMigrationApplied: true,
        },
        ledgerBefore: dbBefore.ledger,
        ledgerAfter: dbAfter.ledger,
        countsBefore: dbBefore.counts,
        countsAfter: dbAfter.counts,
        hashesStable: true,
        selectedStore: {
          id: selectedStore.id,
          slug: selectedStore.slug,
          name: selectedStore.name,
          status: selectedStore.status,
        },
        pendingForStore: dbBefore.pendingForStore,
        commerce: dbBefore.selectedStoreCommerce,
        commerceChangedOnlyByQaFixture: true,
        targetOrder: targetOrder
          ? {
              reference: targetOrder.reference,
              status: targetOrder.status,
              paymentStatus: targetOrder.payment_status,
              fulfillmentStatus: targetOrder.fulfillment_status,
              paymentMethod: targetOrder.payment_method,
              total: targetOrder.total,
            }
          : null,
        qaFixture,
      },
      museOrder: museOrder
        ? {
            id: museOrder.id,
            reference: museOrder.reference,
            storeSlug: museOrder.store_slug,
            status: museOrder.status,
            paymentStatus: museOrder.payment_status,
            fulfillmentStatus: museOrder.fulfillment_status,
            total: museOrder.total,
            currency: museOrder.currency,
            placedAt: museOrder.placed_at,
            eligibleForAcceptance:
              museOrder.status === "placed" &&
              museOrder.fulfillment_status === "unfulfilled",
            stateUnchanged: true,
          }
        : null,
      smoke: {
        merchantLoginPage: true,
        merchantSetupPage: true,
        merchantSetupNeedsAttentionSection: setupHasAttention,
        merchantSetupPendingCount: setupPendingMatch
          ? Number(setupPendingMatch[1])
          : null,
        merchantSetupVodafoneFixtureVisible: setupVodafoneEnabled,
        merchantOrdersPage: true,
        merchantOrdersServedSmokeOrder:
          smokeOrder !== null && ordersHtml.includes(smokeOrder.reference),
        merchantOrdersServedTargetOrder: true,
        targetOrderAccepted: true,
        selectedOrderCheck,
      },
      generatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), {
      mode: 0o644,
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await db.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
