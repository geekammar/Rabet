#!/usr/bin/env node
import fs from "node:fs";

import postgres from "postgres";

const CANDIDATE_SHA = (process.env.CANDIDATE_SHA ?? "").trim().toLowerCase();
const SERVICE_ID = (process.env.RENDER_SERVICE_ID ?? "").trim();
const APP_URL = (process.env.APP_URL ?? "").trim().replace(/\/$/, "");
const RENDER_API_KEY = process.env.RENDER_API_KEY ?? "";
const SUMMARY_PATH = "/tmp/cod-staging-reconcile-summary.json";
const MANAGER_BOT_ID = 9028444116;
const ORDER_REFERENCE = "ORD-RZNNAN";
const STORE_B_BOT = "rabet_cod_pr56_store_b_bot";
const TTL_MS = 15 * 60 * 1000;

function log(message) {
  process.stdout.write(`[cod-reconcile] ${String(message)}\n`);
}

function fail(message) {
  process.stderr.write(`[cod-reconcile:FAIL] ${String(message)}\n`);
  process.exitCode = 1;
  throw new Error(message);
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

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function main() {
  if (!/^[0-9a-f]{40}$/.test(CANDIDATE_SHA)) fail("Invalid CANDIDATE_SHA");
  if (!/^srv-[a-z0-9]+$/i.test(SERVICE_ID)) fail("Invalid RENDER_SERVICE_ID");
  if (!RENDER_API_KEY) fail("RENDER_API_KEY is missing");

  const healthResponse = await fetch(`${APP_URL}/api/healthz`, {
    headers: { "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(30_000),
  });
  const health = await healthResponse.json().catch(() => null);

  const envList = normalizeEnvList(
    await renderApi("GET", `/services/${SERVICE_ID}/env-vars`),
  );
  const envMap = new Map();
  for (const entry of envList) {
    if (entry.key && typeof entry.value === "string") envMap.set(entry.key, entry.value);
  }
  const databaseUrl = envMap.get("DATABASE_URL");
  if (!databaseUrl) fail("DATABASE_URL is absent from the isolated service");

  const db = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 30,
    ssl: "require",
  });

  try {
    const stores = await db`
      select id, slug, name from "store"
      where slug in ('cod-pr56-store-a', 'cod-pr56-store-b')
      order by slug
    `;
    const storeA = stores.find((row) => row.slug === "cod-pr56-store-a");
    const storeB = stores.find((row) => row.slug === "cod-pr56-store-b");
    if (!storeA || !storeB) fail("Expected synthetic stores are missing");

    const orders = await db`
      select o.id, o.reference, s.slug as store_slug, o.subtotal, o.delivery_fee,
             o.total, o.currency, o.status, o.payment_status, o.fulfillment_status,
             o.placed_at
      from "order" o join "store" s on s.id = o.store_id
      order by o.placed_at
    `;
    const targetOrder = orders.find((row) => row.reference === ORDER_REFERENCE) ?? null;
    const orderItems = targetOrder
      ? await db`
          select product_name, quantity, unit_price, line_total
          from "order_item" where order_id = ${targetOrder.id}
          order by product_name
        `
      : [];
    const orderReservations = targetOrder
      ? await db`
          select status, quantity from "inventory_reservation"
          where order_id = ${targetOrder.id}
          order by status
        `
      : [];
    const orderReservationCount = orderReservations.reduce(
      (sum, row) => sum + Number(row.quantity),
      0,
    );

    const inventory = await db`
      select pi.on_hand, pi.reserved, p.slug as product_slug
      from "product_inventory" pi join "product" p on p.id = pi.product_id
      where pi.store_id = ${storeA.id}
      order by p.slug
    `;
    const storeAProductInventory = inventory[0] ?? null;

    const storeBOrders = await db`
      select count(*)::int as count from "order" where store_id = ${storeB.id}
    `;
    const storeBReservations = await db`
      select count(*)::int as count from "inventory_reservation" where store_id = ${storeB.id}
    `;
    const allOrdersByStore = await db`
      select s.slug as store_slug, count(*)::int as count,
             min(o.placed_at) as first_order, max(o.placed_at) as last_order
      from "order" o join "store" s on s.id = o.store_id
      group by s.slug order by s.slug
    `;
    const reservationsByStore = await db`
      select s.slug as store_slug, count(*)::int as count,
             coalesce(sum(r.quantity), 0)::int as quantity
      from "inventory_reservation" r join "store" s on s.id = r.store_id
      group by s.slug order by s.slug
    `;

    const attemptFields = db`
      select a.id, a.store_id, a.status, a.telegram_user_id, a.telegram_bot_id,
             a.telegram_bot_username, a.connection_id, a.failure_code,
             a.created_at, a.updated_at, a.expires_at, a.bound_at,
             a.verified_at, a.completed_at
      from "telegram_link_attempt" a
      where a.store_id in (${storeA.id}, ${storeB.id})
      order by a.created_at
    `;
    const attempts = await attemptFields;
    const attemptsA = attempts.filter((row) => row.store_id === storeA.id);
    const attemptsB = attempts.filter((row) => row.store_id === storeB.id);
    const completedA = attemptsA.find(
      (row) => row.status === "completed" && row.telegram_bot_id !== null,
    ) ?? null;
    const lastB = attemptsB.at(-1) ?? null;

    const connections = await db`
      select id, store_id, bot_id, bot_username, status, verified_at, created_at
      from "telegram_connection"
      where store_id in (${storeA.id}, ${storeB.id})
         or bot_username = ${STORE_B_BOT}
      order by created_at
    `;
    const storeBBotConnection =
      connections.find((row) => row.bot_username === STORE_B_BOT) ?? null;
    const connectionsA = connections.filter((row) => row.store_id === storeA.id);
    const connectionsB = connections.filter((row) => row.store_id === storeB.id);

    const managerUpdates = await db`
      select update_id, update_type, status, processing_error, claimed_at,
             processed_at, created_at
      from "telegram_managed_update"
      where bot_id = ${MANAGER_BOT_ID}
      order by created_at desc
      limit 40
    `;
    const managerUpdatesAfterB = lastB
      ? managerUpdates.filter(
          (row) => new Date(row.created_at).getTime() >= new Date(lastB.created_at).getTime(),
        )
      : managerUpdates;
    const managedBotUpdates = managerUpdates.filter(
      (row) => row.update_type === "managed_bot",
    );

    const sameCreatorAsA =
      lastB?.telegram_user_id != null &&
      completedA?.telegram_user_id != null &&
      String(lastB.telegram_user_id) === String(completedA.telegram_user_id);

    const firstManagedBotAfterB = managerUpdatesAfterB.find(
      (row) => row.update_type === "managed_bot" && row.status === "processed",
    );
    const managedBotDelivered = Boolean(firstManagedBotAfterB);
    const ambiguousWindow =
      sameCreatorAsA &&
      completedA?.completed_at != null &&
      firstManagedBotAfterB?.created_at != null &&
      new Date(firstManagedBotAfterB.created_at).getTime() -
        new Date(completedA.completed_at).getTime() <= TTL_MS &&
      new Date(firstManagedBotAfterB.created_at).getTime() >=
        new Date(completedA.completed_at).getTime();

    const bHasBotEvidence = attemptsB.some(
      (row) => row.telegram_bot_id !== null && row.telegram_bot_username !== null,
    );
    const recoverableByExistingRules =
      Boolean(storeBBotConnection) ||
      attemptsB.some(
        (row) =>
          ["expired", "cancelled", "failed"].includes(row.status) &&
          row.connection_id === null &&
          row.telegram_user_id !== null &&
          row.telegram_bot_id !== null &&
          row.telegram_bot_username !== null,
      );

    const summary = {
      appUrl: APP_URL,
      deployedSha: health?.sha ?? null,
      expectedSha: CANDIDATE_SHA,
      healthStatus: health?.status ?? null,
      order: targetOrder
        ? {
            reference: targetOrder.reference,
            storeSlug: targetOrder.store_slug,
            subtotal: targetOrder.subtotal,
            deliveryFee: targetOrder.delivery_fee,
            total: targetOrder.total,
            currency: targetOrder.currency,
            status: targetOrder.status,
            paymentStatus: targetOrder.payment_status,
            fulfillmentStatus: targetOrder.fulfillment_status,
            placedAt: iso(targetOrder.placed_at),
            items: orderItems.map((row) => ({
              name: row.product_name,
              quantity: row.quantity,
              unitPrice: row.unit_price,
              lineTotal: row.line_total,
            })),
            reservationCount: orderReservations.length,
            reservationQuantity: orderReservationCount,
            reservations: orderReservations.map((row) => ({
              status: row.status,
              quantity: row.quantity,
            })),
          }
        : null,
      inventory: storeAProductInventory
        ? {
            productSlug: storeAProductInventory.product_slug,
            onHand: storeAProductInventory.on_hand,
            reserved: storeAProductInventory.reserved,
          }
        : null,
      baseline: { expectedOrders: 2, expectedReserved: 4, expectedOnHand: 5 },
      ordersByStore: allOrdersByStore.map((row) => ({
        storeSlug: row.store_slug,
        count: row.count,
        firstOrder: iso(row.first_order),
        lastOrder: iso(row.last_order),
      })),
      reservationsByStore: reservationsByStore.map((row) => ({
        storeSlug: row.store_slug,
        count: row.count,
        quantity: row.quantity,
      })),
      storeBIsolation: {
        orderCount: storeBOrders[0]?.count ?? null,
        reservationCount: storeBReservations[0]?.count ?? null,
        hasTargetReference: false,
      },
      storeBBotDiagnosis: {
        username: STORE_B_BOT,
        attempts: attemptsB.map((row) => ({
          status: row.status,
          hasTelegramUser: row.telegram_user_id !== null,
          telegramBotId: row.telegram_bot_id,
          telegramBotUsername: row.telegram_bot_username,
          hasConnection: row.connection_id !== null,
          failureCode: row.failure_code,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
          expiresAt: iso(row.expires_at),
          boundAt: iso(row.bound_at),
          verifiedAt: iso(row.verified_at),
          completedAt: iso(row.completed_at),
        })),
        connections: connectionsB.map((row) => ({
          botId: row.bot_id,
          botUsername: row.bot_username,
          status: row.status,
          verifiedAt: iso(row.verified_at),
        })),
        botConnectionByUsername: storeBBotConnection
          ? {
              storeSlug:
                storeBBotConnection.store_id === storeA.id
                  ? "cod-pr56-store-a"
                  : storeBBotConnection.store_id === storeB.id
                    ? "cod-pr56-store-b"
                    : "other",
              botId: storeBBotConnection.bot_id,
              status: storeBBotConnection.status,
            }
          : null,
        sameCreatorAsA,
        completedAExists: Boolean(completedA),
        completedAStatus: completedA?.status ?? null,
        completedABotId: completedA?.telegram_bot_id ?? null,
        bHasBotEvidence,
        managerUpdatesAfterBCreated: managerUpdatesAfterB.map((row) => ({
          updateType: row.update_type,
          status: row.status,
          processingError: row.processing_error,
          claimedAt: iso(row.claimed_at),
          processedAt: iso(row.processed_at),
          createdAt: iso(row.created_at),
        })),
        managerManagedBotUpdates: managedBotUpdates.map((row) => ({
          status: row.status,
          processingError: row.processing_error,
          claimedAt: iso(row.claimed_at),
          processedAt: iso(row.processed_at),
          createdAt: iso(row.created_at),
        })),
        managedBotDelivered,
        otherStoreAmbiguityInferred: ambiguousWindow && managedBotDelivered && !bHasBotEvidence,
        recoverableByExistingRules,
        safeRecoveryAvailable: recoverableByExistingRules,
        lastBExpiresAt: iso(lastB?.expires_at),
        now: new Date().toISOString(),
      },
      generatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o644 });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await db.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
