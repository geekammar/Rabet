#!/usr/bin/env node
import fs from "node:fs";

import postgres from "postgres";

const CANDIDATE_SHA = (process.env.CANDIDATE_SHA ?? "").trim().toLowerCase();
const SERVICE_ID = (process.env.RENDER_SERVICE_ID ?? "").trim();
const APP_URL = (process.env.APP_URL ?? "").trim().replace(/\/$/, "");
const RENDER_API_KEY = process.env.RENDER_API_KEY ?? "";
const SUMMARY_PATH = "/tmp/cod-staging-verify-head-summary.json";
const ORDER_REFERENCE = "ORD-RZNNAN";

function log(message) {
  process.stdout.write(`[cod-verify] ${String(message)}\n`);
}

function fail(message) {
  process.stderr.write(`[cod-verify:FAIL] ${String(message)}\n`);
  process.exitCode = 1;
  throw new Error(message);
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

async function waitForHealth() {
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${APP_URL}/api/healthz`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.status === "ok" && payload?.sha === CANDIDATE_SHA) {
        return payload;
      }
      log(`Health not ready: HTTP ${response.status} sha ${String(payload?.sha ?? "missing")}`);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  fail("Timed out waiting for deployed SHA in /api/healthz");
}

async function deployExactCommit() {
  const deploy = await renderApi("POST", `/services/${SERVICE_ID}/deploys`, {
    commitId: CANDIDATE_SHA,
  });
  if (!deploy?.id) fail("Render did not return a deploy id");
  log(`Render deploy ${deploy.id} started for ${CANDIDATE_SHA}`);
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const current = await renderApi(
      "GET",
      `/services/${SERVICE_ID}/deploys/${deploy.id}`,
    );
    const status = String(current?.status ?? "unknown");
    log(`Render deploy status: ${status}`);
    if (status === "live") return current;
    if (["build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"].includes(status)) {
      fail(`Render deploy failed with status ${status}`);
    }
  }
  fail("Timed out waiting for Render deploy");
}

async function main() {
  if (!/^[0-9a-f]{40}$/.test(CANDIDATE_SHA)) fail("Invalid CANDIDATE_SHA");
  if (!/^srv-[a-z0-9]+$/i.test(SERVICE_ID)) fail("Invalid RENDER_SERVICE_ID");
  if (!RENDER_API_KEY) fail("RENDER_API_KEY is missing");

  const envList = normalizeEnvList(
    await renderApi("GET", `/services/${SERVICE_ID}/env-vars`),
  );
  const envMap = new Map();
  for (const entry of envList) {
    if (entry.key && typeof entry.value === "string") envMap.set(entry.key, entry.value);
  }
  const databaseUrl = envMap.get("DATABASE_URL");
  const authSecret = envMap.get("AUTH_SECRET");
  if (!databaseUrl || !authSecret) fail("Expected isolated DATABASE_URL/AUTH_SECRET are missing");

  if (envMap.get("RABET_BUILD_SHA") !== CANDIDATE_SHA) {
    envMap.set("RABET_BUILD_SHA", CANDIDATE_SHA);
    await renderApi(
      "PUT",
      `/services/${SERVICE_ID}/env-vars`,
      [...envMap.entries()].map(([key, value]) => ({ key, value })),
    );
    log("Updated RABET_BUILD_SHA for the reviewed candidate");
  }

  await deployExactCommit();
  const health = await waitForHealth();
  log(`Health matched ${health.sha}`);

  const db = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 30,
    ssl: "require",
  });

  let dbEvidence;
  let cookie;
  try {
    const stores = await db`
      select id, slug, name from "store"
      where slug in ('cod-pr56-store-a', 'cod-pr56-store-b')
      order by slug
    `;
    const storeA = stores.find((row) => row.slug === "cod-pr56-store-a");
    const storeB = stores.find((row) => row.slug === "cod-pr56-store-b");
    if (!storeA || !storeB) fail("Expected synthetic stores are missing");

    const [product] = await db`
      select p.id, p.slug, p.price, p.is_active, c.is_active as category_active,
             pt.name
      from "product" p
      join "category" c on c.id = p.category_id
      join "product_translation" pt on pt.product_id = p.id
      join "language" l on l.id = pt.language_id
      where p.store_id = ${storeA.id} and l.code = 'en'
      limit 1
    `;
    const [connectionA] = await db`
      select bot_id, bot_username, status from "telegram_connection"
      where store_id = ${storeA.id} order by verified_at desc limit 1
    `;
    const [inventory] = await db`
      select on_hand, reserved from "product_inventory"
      where store_id = ${storeA.id} limit 1
    `;
    const [ordersA] = await db`
      select count(*)::int as count from "order" where store_id = ${storeA.id}
    `;
    const [reservationsA] = await db`
      select count(*)::int as count from "inventory_reservation" where store_id = ${storeA.id}
    `;
    const [targetOrder] = await db`
      select reference, subtotal, delivery_fee, total, currency, payment_status
      from "order" where reference = ${ORDER_REFERENCE}
    `;
    const [ordersB] = await db`
      select count(*)::int as count from "order" where store_id = ${storeB.id}
    `;
    const [merchantA] = await db`
      select u.id, u.session_version
      from "app_user" u join "store_membership" m on m.user_id = u.id
      where m.store_id = ${storeA.id} and m.status = 'active' limit 1
    `;
    if (!merchantA) fail("Merchant A fixture is missing");

    const { encode } = await import("next-auth/jwt");
    cookie = await encode({
      token: {
        merchantId: merchantA.id,
        role: "merchant",
        sessionVersion: merchantA.session_version,
        sub: merchantA.id,
      },
      secret: authSecret,
      salt: "rabet-merchant.session-token",
    });

    dbEvidence = {
      storeA: storeA.slug,
      storeB: storeB.slug,
      productA: product
        ? {
            slug: product.slug,
            name: product.name,
            price: product.price,
            productActive: product.is_active,
            categoryActive: product.category_active,
          }
        : null,
      connectionA: connectionA
        ? {
            botId: connectionA.bot_id,
            botUsername: connectionA.bot_username,
            status: connectionA.status,
          }
        : null,
      inventory: inventory
        ? { onHand: inventory.on_hand, reserved: inventory.reserved }
        : null,
      ordersA: ordersA.count,
      reservationsA: reservationsA.count,
      targetOrder: targetOrder
        ? {
            reference: targetOrder.reference,
            subtotal: targetOrder.subtotal,
            deliveryFee: targetOrder.delivery_fee,
            total: targetOrder.total,
            currency: targetOrder.currency,
            paymentStatus: targetOrder.payment_status,
          }
        : null,
      ordersB: ordersB.count,
    };

    if (!product || product.is_active !== true || product.category_active !== true) {
      fail("Store A catalog fixture is not active");
    }
    if (connectionA?.status !== "ready") fail("Store A managed connection is not ready");
    if (inventory?.on_hand !== 5 || inventory?.reserved !== 4) {
      fail("Order/inventory baseline changed");
    }
    if (ordersA.count !== 2 || reservationsA.count !== 2) {
      fail("Order/reservation baseline changed");
    }
    if (targetOrder?.reference !== ORDER_REFERENCE) fail("ORD-RZNNAN is missing");
    if (targetOrder.payment_status !== "awaiting_collection") {
      fail("ORD-RZNNAN is not awaiting collection");
    }
    if (ordersB.count !== 0) fail("Store B unexpectedly has orders");
  } finally {
    await db.end({ timeout: 5 }).catch(() => {});
  }

  async function merchantFetch(pathName) {
    return fetch(`${APP_URL}${pathName}`, {
      headers: {
        Cookie: `rabet-merchant.session-token=${cookie}`,
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(30_000),
    });
  }

  const productsResponse = await merchantFetch(`/app/products?verify=${Date.now()}`);
  const productsHtml = await productsResponse.text();
  if (productsResponse.status !== 200) {
    fail(`Merchant products page returned HTTP ${productsResponse.status}`);
  }
  if (!productsHtml.includes("COD Test Product A")) {
    fail("Store A catalog product is not served on the merchant catalog page");
  }

  const ordersResponse = await merchantFetch(`/app/orders?verify=${Date.now()}`);
  const ordersHtml = await ordersResponse.text();
  if (ordersResponse.status !== 200) fail(`Merchant orders page returned HTTP ${ordersResponse.status}`);
  if (!ordersHtml.includes(ORDER_REFERENCE)) fail("ORD-RZNNAN is not served on merchant A orders");
  if (!ordersHtml.includes("بانتظار التحصيل")) fail("ORD-RZNNAN is not awaiting collection in the UI");

  const summary = {
    serviceId: SERVICE_ID,
    appUrl: APP_URL,
    deployedSha: CANDIDATE_SHA,
    health,
    database: dbEvidence,
    liveChecks: {
      merchantCatalogServesProductA: true,
      merchantOrdersServesTargetOrder: true,
      targetOrderAwaitingCollection: true,
      storeAConnectionReady: true,
      storeBOrderCount: dbEvidence.ordersB,
    },
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o644 });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
