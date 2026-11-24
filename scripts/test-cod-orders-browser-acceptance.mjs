#!/usr/bin/env node
/**
 * Real-browser acceptance for the read-only /app/orders COD view.
 *
 * Starts the built Next.js application against a disposable loopback
 * PostgreSQL database, seeds one synthetic COD order, mints a merchant session,
 * and checks the page at a 360 px viewport: the order reference, customer,
 * quantities, totals, awaiting-collection payment state, and no horizontal
 * overflow.
 *
 * The seeded data is synthetic. No Telegram, Neon, Production or buyer data is
 * contacted.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encode as encodeAuthJwt } from "next-auth/jwt";
import postgres from "postgres";

import {
  detectConflictingFixture,
  readPgState,
  verifyAndStopOwnedFixture,
} from "./fixture-guard.mjs";

const APP_PORT = 3446;
const CDP_PORT = 9346;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const SESSION_SALT = "rabet-merchant.session-token";
const REVIEW_DIR =
  process.env.RABET_COD_SCREENSHOT_DIR ??
  path.resolve(process.cwd(), "docs/review/cod-order-operations");

let appServer = null;
let chromeProcess = null;
let pgClient = null;
let ownedTempDir = null;
let ownedPgFixture = null;
let createdDbName = null;
let isCleaningUp = false;

function log(message) {
  process.stdout.write(`[cod-orders-browser] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[cod-orders-browser:FAIL] ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanup() {
  if (isCleaningUp) return;
  isCleaningUp = true;

  if (chromeProcess) {
    try {
      chromeProcess.kill("SIGKILL");
    } catch {}
    chromeProcess = null;
  }

  if (appServer && appServer.pid) {
    try {
      process.kill(-appServer.pid, "SIGKILL");
    } catch {}
    appServer = null;
  }

  if (pgClient) {
    try {
      await pgClient.end();
    } catch {}
    pgClient = null;
  }

  if (createdDbName && process.env.RABET_TEST_PG_URL) {
    try {
      const cleanupSql = postgres(process.env.RABET_TEST_PG_URL, { max: 1 });
      await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${createdDbName}`);
      await cleanupSql.end();
    } catch {}
    createdDbName = null;
  }

  if (ownedTempDir) {
    try {
      rmSync(ownedTempDir, { recursive: true, force: true });
    } catch {}
    ownedTempDir = null;
  }

  if (ownedPgFixture) {
    const stateFilePath =
      process.env.RABET_PG_STATE_FILE ??
      path.join(tmpdir(), "rabet-test-pg.json");

    const result = verifyAndStopOwnedFixture({
      stateFilePath,
      ownedFixture: ownedPgFixture,
      stopFn: (fixture) => {
        try {
          spawnSync(
            "node",
            ["scripts/db-test-postgres.mjs", "stop", fixture.datadir],
            {
              stdio: "ignore",
              env: { ...process.env, RABET_PG_STATE_FILE: stateFilePath },
            },
          );
        } catch {}
      },
    });

    if (!result.stopped) {
      log(`Preserved database state (did not stop fixture: ${result.reason}).`);
    }
    ownedPgFixture = null;
  }
}

async function main() {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    fail(
      "Chromium executable not found. Set CHROME_BIN or CHROME_PATH environment variable.",
    );
  }

  let pgUrl = "";
  if (process.env.RABET_TEST_PG_URL) {
    createdDbName = `rabet_cod_browser_${Date.now()}`;
    const adminSql = postgres(process.env.RABET_TEST_PG_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE ${createdDbName}`);
    await adminSql.end();

    const parsed = new URL(process.env.RABET_TEST_PG_URL);
    parsed.pathname = `/${createdDbName}`;
    pgUrl = parsed.toString();
    log(`Using designated PostgreSQL service with database: ${createdDbName}`);
  } else {
    const stateFilePath =
      process.env.RABET_PG_STATE_FILE ??
      path.join(tmpdir(), "rabet-test-pg.json");

    const conflict = detectConflictingFixture(stateFilePath);
    if (conflict) {
      fail(
        `Pre-existing disposable PostgreSQL instance detected at ${stateFilePath} ` +
          `(port ${conflict.port}, datadir: ${conflict.datadir}). Stop it before running this suite.`,
      );
    }

    log("Starting disposable PostgreSQL...");
    const pgStart = spawnSync("node", ["scripts/db-test-postgres.mjs", "start"], {
      encoding: "utf8",
      env: { ...process.env, RABET_PG_STATE_FILE: stateFilePath },
    });
    if (pgStart.status !== 0) {
      fail(`Could not start disposable PostgreSQL: ${pgStart.stderr}`);
    }

    const pgUrlMatch = pgStart.stdout.match(/postgresql:\/\/[^\s]+/);
    if (!pgUrlMatch) fail("Could not find PostgreSQL URL in output");
    pgUrl = pgUrlMatch[0];

    const stateData = readPgState(stateFilePath);
    ownedPgFixture = {
      port: stateData?.port ?? new URL(pgUrl).port,
      datadir: stateData?.datadir ?? "",
      url: pgUrl,
    };
  }

  const parsedPgUrl = new URL(pgUrl);
  if (
    parsedPgUrl.hostname !== "127.0.0.1" &&
    parsedPgUrl.hostname !== "localhost" &&
    !process.env.RABET_TEST_PG_URL
  ) {
    fail(`Refusing to run against non-loopback database host: ${parsedPgUrl.hostname}`);
  }

  log("Applying database migrations...");
  const migrate = spawnSync("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: pgUrl },
    encoding: "utf8",
  });
  if (migrate.status !== 0) {
    fail(`Migration failed: ${migrate.stderr || migrate.stdout}`);
  }

  pgClient = postgres(pgUrl, { max: 5 });

  log("Seeding synthetic COD order...");
  const [language] = await pgClient`
    insert into "language" ("code", "label", "is_enabled")
    values ('en', 'English', true)
    returning id
  `;
  const [store] = await pgClient`
    insert into "store" ("name", "slug", "status")
    values ('Synthetic COD Store', 'synthetic-cod-store', 'active')
    returning id
  `;
  const [user] = await pgClient`
    insert into "app_user" ("email")
    values ('cod-browser-owner@example.test')
    returning id, session_version
  `;
  await pgClient`
    insert into "store_membership" ("store_id", "user_id", "role", "status")
    values (${store.id}, ${user.id}, 'owner', 'active')
  `;
  const [category] = await pgClient`
    insert into "category" ("store_id", "slug", "sort_order", "is_active")
    values (${store.id}, 'cod-browser-root', 1, true)
    returning id
  `;
  await pgClient`
    insert into "category_translation" ("category_id", "language_id", "name")
    values (${category.id}, ${language.id}, 'Root')
  `;
  const [product] = await pgClient`
    insert into "product" ("store_id", "category_id", "slug", "price", "is_active", "sort_order")
    values (${store.id}, ${category.id}, 'cod-browser-product', 11.00, true, 1)
    returning id
  `;
  await pgClient`
    insert into "product_translation" ("product_id", "language_id", "name", "description")
    values (${product.id}, ${language.id}, 'Synthetic COD Product', 'First slice fixture')
  `;
  const [connection] = await pgClient`
    insert into "telegram_connection" (
      "store_id", "bot_id", "bot_username", "token_ciphertext", "token_key_id",
      "webhook_secret_hash", "webhook_url", "status", "verified_at"
    )
    values (
      ${store.id}, 991001, 'SyntheticCodBot', 'synthetic-ciphertext', 'v1',
      repeat('a', 64), 'https://app.example.test/api/telegram/webhook/managed/x',
      'ready', now()
    )
    returning id
  `;
  await pgClient`
    insert into "store_commerce_setting" ("store_id", "currency", "delivery_fee", "cod_enabled")
    values (${store.id}, 'SAR', 15.00, true)
  `;
  await pgClient`
    insert into "product_inventory" ("product_id", "store_id", "on_hand", "reserved")
    values (${product.id}, ${store.id}, 5, 2)
  `;
  const [order] = await pgClient`
    insert into "order" (
      "store_id", "connection_id", "telegram_user_id", "telegram_chat_id",
      "reference", "checkout_key", "status", "payment_method", "payment_status",
      "fulfillment_status", "currency", "subtotal", "delivery_fee", "total",
      "customer_name", "customer_phone", "delivery_address"
    )
    values (
      ${store.id}, ${connection.id}, 93001, 93001,
      'ORD-ABC234', ${crypto.randomUUID()}, 'placed', 'cod', 'awaiting_collection',
      'unfulfilled', 'SAR', 22.00, 15.00, 37.00,
      'Synthetic Buyer', '+15550000000', '123 Synthetic Browser Street'
    )
    returning id
  `;
  const [orderItem] = await pgClient`
    insert into "order_item" (
      "order_id", "product_id", "product_name", "unit_price", "quantity",
      "line_total", "product_snapshot"
    )
    values (
      ${order.id}, ${product.id}, 'Synthetic COD Product', 11.00, 2, 22.00,
      ${JSON.stringify({
        name: "Synthetic COD Product",
        description: "First slice fixture",
        categoryId: category.id,
        unitPrice: "11.00",
        currency: "SAR",
      })}::jsonb
    )
    returning id
  `;
  await pgClient`
    insert into "inventory_reservation" (
      "order_id", "order_item_id", "product_id", "store_id", "quantity", "status"
    )
    values (${order.id}, ${orderItem.id}, ${product.id}, ${store.id}, 2, 'reserved')
  `;

  ownedTempDir = mkdtempSync(path.join(tmpdir(), "rabet-cod-browser-"));
  chmodSync(ownedTempDir, 0o700);

  const postgresModuleUrl = import.meta.resolve("postgres");
  const bootstrapFile = path.join(ownedTempDir, "neon-proxy-bootstrap.mjs");
  writeFileSync(
    bootstrapFile,
    `import postgres from "${postgresModuleUrl}";\n` +
      `const originalFetch = globalThis.fetch;\n` +
      `const formatVal = (v) => typeof v === "boolean" ? (v ? "t" : "f") : v;\n` +
      `let pg = null;\n` +
      `globalThis.fetch = async (input, init) => {\n` +
      `  const url = typeof input === "string" ? input : (input ? input.url : "");\n` +
      `  if (process.env.TEST_REAL_PG_URL && typeof url === "string" && url.endsWith("/sql")) {\n` +
      `    if (!pg) pg = postgres(process.env.TEST_REAL_PG_URL);\n` +
      `    const { query, params } = JSON.parse(init.body);\n` +
      `    const booleanColumns = new Set(["is_active", "enabled", "ask_for_language", "is_enabled", "is_blocked", "cod_enabled"]);\n` +
      `    const booleanIndexes = new Set();\n` +
      `    for (const match of query.matchAll(/"([a-z_]+)"\\s*=\\s*\\$(\\d+)/g)) {\n` +
      `      if (booleanColumns.has(match[1])) booleanIndexes.add(Number(match[2]));\n` +
      `    }\n` +
      `    const normalizedParams = (params || []).map((value, index) =>\n` +
      `      typeof value === "string" && booleanIndexes.has(index + 1)\n` +
      `        ? value === "true"\n` +
      `        : value,\n` +
      `    );\n` +
      `    try {\n` +
      `      const rows = await pg.unsafe(query, normalizedParams).values();\n` +
      `      const cols = rows.columns || [];\n` +
      `      const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));\n` +
      `      const rowArrays = rows.map((r) => r.map((value) => formatVal(value)));\n` +
      `      return new Response(JSON.stringify({ rows: rowArrays, fields }), {\n` +
      `        status: 200, headers: { "content-type": "application/json" },\n` +
      `      });\n` +
      `    } catch (err) {\n` +
      `      return new Response(JSON.stringify({ message: err.message }), {\n` +
      `        status: 500, headers: { "content-type": "application/json" },\n` +
      `      });\n` +
      `    }\n` +
      `  }\n` +
      `  return originalFetch(input, init);\n` +
      `};\n`,
    { mode: 0o600 },
  );

  const authSecret = crypto.randomBytes(32).toString("base64");
  const appDatabaseUrl = (() => {
    const parsed = new URL(pgUrl);
    if (parsed.hostname === "127.0.0.1") parsed.hostname = "localhost";
    return parsed.toString();
  })();

  const envFile = path.join(ownedTempDir, "test.env");
  writeFileSync(
    envFile,
    [
      `export DATABASE_URL='${appDatabaseUrl}'`,
      `export TEST_REAL_PG_URL='${pgUrl}'`,
      `export AUTH_SECRET='${authSecret}'`,
      `export AUTH_URL='${BASE_URL}'`,
      `export APP_URL='${BASE_URL}'`,
      `export AUTH_TRUST_HOST='true'`,
      `export RABET_MERCHANT_APP_ENABLED='true'`,
      `export RABET_COD_ORDERS_ENABLED='true'`,
      `export NODE_OPTIONS='--import ${bootstrapFile}'`,
    ].join("\n") + "\n",
    { mode: 0o600 },
  );

  appServer = spawn(
    "bash",
    [
      "-c",
      `source "${envFile}" && PORT=${APP_PORT} node node_modules/next/dist/bin/next start`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env },
    },
  );

  appServer.stderr.on("data", (data) => {
    const text = data.toString();
    if (!text.includes("ExperimentalWarning")) {
      process.stderr.write(`[next:stderr] ${text}`);
    }
  });

  let serverReady = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(500);
    try {
      const response = await fetch(`${BASE_URL}/app/login`);
      if (response.status === 200) {
        serverReady = true;
        break;
      }
    } catch {}
  }
  if (!serverReady) fail("Next.js server failed to start within 20s");

  const merchantCookie = await encodeAuthJwt({
    token: {
      merchantId: user.id,
      role: "merchant",
      sessionVersion: user.session_version,
      sub: user.id,
    },
    secret: authSecret,
    salt: SESSION_SALT,
  });

  chromeProcess = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${path.join(ownedTempDir, "chrome-data")}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let pageTarget = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(400);
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      ).json();
      pageTarget = targets.find((target) => target.type === "page") || targets[0];
      if (pageTarget?.webSocketDebuggerUrl) break;
    } catch {}
  }
  if (!pageTarget) fail("Could not connect to the Chromium page target");

  const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 800,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send("Network.setCookie", {
    name: "rabet-merchant.session-token",
    value: merchantCookie,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
  });

  const navigate = async (url, label) => {
    await cdp.send("Page.navigate", { url });
    await waitFor(
      cdp,
      "document.readyState === 'complete'",
      `${label} document ready`,
    );
  };

  log("Checking the merchant COD Orders entry and click-through...");
  await cdp.send("Network.setCookie", {
    name: "rabet-merchant-locale",
    value: "en",
    domain: "127.0.0.1",
    path: "/",
  });
  await navigate(`${BASE_URL}/app/setup`, "merchant setup");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-orders-link\"]'))",
    "COD Orders navigation entry",
  );
  const ordersLinkText = await cdp.evaluate(
    "document.querySelector('[data-testid=\"merchant-orders-link\"]')?.textContent?.trim()",
  );
  assert(
    ordersLinkText === "View orders",
    `Expected English Orders link, saw ${JSON.stringify(ordersLinkText)}`,
  );
  const clicked = await cdp.evaluate(`(() => {
    const link = document.querySelector('[data-testid="merchant-orders-link"]');
    if (!link) return false;
    link.click();
    return true;
  })()`);
  assert(clicked, "COD Orders link should be clickable");
  await waitFor(
    cdp,
    "window.location.pathname === '/app/orders'",
    "COD Orders click-through",
  );
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-orders-page\"]'))",
    "merchant orders page",
  );
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-card\"]'))",
    "merchant order card",
  );

  const body = await cdp.evaluate("document.body.innerText");
  for (const expected of [
    "ORD-ABC234",
    "Synthetic Buyer",
    "+15550000000",
    "123 Synthetic Browser Street",
    "Synthetic COD Product × 2",
    "37.00 SAR",
    "awaiting collection",
    "reserved",
  ]) {
    assert(
      body.includes(expected),
      `Orders page should include ${JSON.stringify(expected)}`,
    );
  }

  const overflow = await cdp.evaluate(
    "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)",
  );
  assert(
    overflow <= 361,
    `Expected no horizontal scroll at 360 px, saw ${overflow}`,
  );

  const capturePhoneScreenshot = async (filename) => {
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const contentSize = metrics.cssContentSize ?? metrics.contentSize;
    const height = Math.max(800, Math.ceil(contentSize?.height ?? 800));
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 360, height, scale: 1 },
    });

    mkdirSync(REVIEW_DIR, { recursive: true });
    const filePath = path.join(REVIEW_DIR, filename);
    writeFileSync(filePath, Buffer.from(screenshot.data, "base64"));
    log(`Saved phone-width screenshot: ${filePath}`);
  };

  const clickTestId = async (testId) => {
    const clicked = await cdp.evaluate(`(() => {
      const element = document.querySelector('[data-testid="${testId}"]');
      if (!element) return false;
      element.click();
      return true;
    })()`);
    assert(clicked, `Expected ${testId} to be clickable`);
  };

  log("Running the phone-first accept and prepare flow...");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-accept\"]'))",
    "Accept order action",
  );
  await capturePhoneScreenshot("01-order-placed-360.png");

  await clickTestId("merchant-order-action-accept");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-prepare\"]'))",
    "Start preparing action after acceptance",
  );
  await waitFor(
    cdp,
    "document.body.innerText.includes('Order accepted.')",
    "acceptance feedback",
  );
  await capturePhoneScreenshot("02-order-accepted-360.png");

  await clickTestId("merchant-order-action-prepare");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-cancel\"]'))",
    "cancellation action while preparing",
  );
  await waitFor(
    cdp,
    "document.body.innerText.includes('Order marked as preparing.')",
    "preparing feedback",
  );
  await capturePhoneScreenshot("03-order-preparing-360.png");

  log("Running the phone-first pre-shipment cancellation flow...");
  await clickTestId("merchant-order-action-cancel");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-cancel-reason\"]'))",
    "cancellation reason field",
  );

  const cancellationReason = "Customer requested cancellation";
  const typedReason = await cdp.evaluate(`(() => {
    const element = document.querySelector('[data-testid="merchant-order-cancel-reason"]');
    if (!element) return null;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set;
    setter.call(element, ${JSON.stringify(cancellationReason)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value;
  })()`);
  assert(
    typedReason === cancellationReason,
    `Expected cancellation reason to be entered, saw ${JSON.stringify(typedReason)}`,
  );
  await capturePhoneScreenshot("04-order-cancel-reason-360.png");

  await clickTestId("merchant-order-cancel-submit");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-feedback\"]'))",
    "cancellation feedback",
  );
  await waitFor(
    cdp,
    "document.body.innerText.includes('This order is cancelled and its stock reservation was released.')",
    "cancelled state",
  );
  await waitFor(
    cdp,
    `document.body.innerText.includes(${JSON.stringify(cancellationReason)})`,
    "saved cancellation reason",
  );

  const cancelledBody = await cdp.evaluate("document.body.innerText");
  for (const expected of [
    "cancelled",
    "released",
    "Order cancelled and the reservation released once.",
  ]) {
    assert(
      cancelledBody.includes(expected),
      `Cancelled Orders page should include ${JSON.stringify(expected)}`,
    );
  }

  await capturePhoneScreenshot("05-order-cancelled-360.png");

  const [cancelledInventory] = await pgClient`
    select on_hand, reserved
    from product_inventory
    where product_id = ${product.id}
  `;
  assert(
    cancelledInventory.on_hand === 5,
    `Cancellation must preserve on-hand stock, saw ${cancelledInventory.on_hand}`,
  );
  assert(
    cancelledInventory.reserved === 0,
    `Cancellation must release the full hold, saw ${cancelledInventory.reserved}`,
  );

  const cancelledReservations = await pgClient`
    select status, release_reason, released_at
    from inventory_reservation
    where order_id = ${order.id}
  `;
  assert(
    cancelledReservations.length === 1,
    `Expected one reservation, saw ${cancelledReservations.length}`,
  );
  assert(
    cancelledReservations[0].status === "released",
    `Expected released reservation, saw ${cancelledReservations[0].status}`,
  );
  assert(
    cancelledReservations[0].release_reason === cancellationReason,
    "Cancellation reason must be stored on the released reservation",
  );
  assert(
    Boolean(cancelledReservations[0].released_at),
    "Released reservation must record its release timestamp",
  );

  log("Checking Arabic RTL merchant Orders copy...");
  await cdp.send("Network.setCookie", {
    name: "rabet-merchant-locale",
    value: "ar",
    domain: "127.0.0.1",
    path: "/",
  });
  await navigate(`${BASE_URL}/app/orders`, "Arabic orders");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-orders-page\"]')?.getAttribute('dir') === 'rtl'",
    "Arabic RTL orders page",
  );
  const arabicBody = await cdp.evaluate("document.body.innerText");
  for (const expected of [
    "طلبات الدفع عند الاستلام",
    "بانتظار التحصيل",
    "ملغي",
    "محرر",
    "الدفع عند الاستلام",
  ]) {
    assert(
      arabicBody.includes(expected),
      `Arabic orders page should include ${JSON.stringify(expected)}`,
    );
  }
  const arabicOverflow = await cdp.evaluate(
    "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)",
  );
  assert(
    arabicOverflow <= 361,
    `Expected no horizontal scroll in Arabic at 360 px, saw ${arabicOverflow}`,
  );
  await capturePhoneScreenshot("06-order-cancelled-ar-360.png");

  log("Seeding a placed order and suspending the store for read-only coverage...");
  const [readOnlyOrder] = await pgClient`
    insert into "order" (
      "store_id", "connection_id", "telegram_user_id", "telegram_chat_id",
      "reference", "checkout_key", "status", "payment_method", "payment_status",
      "fulfillment_status", "currency", "subtotal", "delivery_fee", "total",
      "customer_name", "customer_phone", "delivery_address"
    )
    values (
      ${store.id}, ${connection.id}, 93002, 93002,
      'ORD-DEF567', ${crypto.randomUUID()}, 'placed', 'cod', 'awaiting_collection',
      'unfulfilled', 'SAR', 11.00, 15.00, 26.00,
      'Synthetic Buyer Two', '+15550000001', '456 Synthetic Read Only Street'
    )
    returning id
  `;
  const [readOnlyOrderItem] = await pgClient`
    insert into "order_item" (
      "order_id", "product_id", "product_name", "unit_price", "quantity",
      "line_total", "product_snapshot"
    )
    values (
      ${readOnlyOrder.id}, ${product.id}, 'Synthetic COD Product', 11.00, 1, 11.00,
      ${JSON.stringify({
        name: "Synthetic COD Product",
        description: "Read-only fixture",
        categoryId: category.id,
        unitPrice: "11.00",
        currency: "SAR",
      })}::jsonb
    )
    returning id
  `;
  await pgClient`
    insert into "inventory_reservation" (
      "order_id", "order_item_id", "product_id", "store_id", "quantity", "status"
    )
    values (${readOnlyOrder.id}, ${readOnlyOrderItem.id}, ${product.id}, ${store.id}, 1, 'reserved')
  `;
  await pgClient`
    update product_inventory
    set reserved = reserved + 1
    where product_id = ${product.id}
  `;
  await pgClient`
    update store
    set status = 'suspended'
    where id = ${store.id}
  `;

  await cdp.send("Network.setCookie", {
    name: "rabet-merchant-locale",
    value: "en",
    domain: "127.0.0.1",
    path: "/",
  });
  await navigate(`${BASE_URL}/app/orders`, "English read-only orders");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-orders-suspended-notice\"]'))",
    "English read-only suspended notice",
  );
  await waitFor(
    cdp,
    "document.body.innerText.includes('ORD-DEF567')",
    "read-only order card",
  );

  const englishReadOnly = await cdp.evaluate(`(() => ({
    accept: Boolean(document.querySelector('[data-testid="merchant-order-action-accept"]')),
    prepare: Boolean(document.querySelector('[data-testid="merchant-order-action-prepare"]')),
    cancel: Boolean(document.querySelector('[data-testid="merchant-order-action-cancel"]')),
    form: Boolean(document.querySelector('[data-testid="merchant-order-cancel-form"]')),
    readOnlyNotes: document.querySelectorAll('[data-testid="merchant-order-readonly-note"]').length,
    cards: document.querySelectorAll('[data-testid="merchant-order-card"]').length,
    text: document.body.innerText,
    overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }))()`);
  assert(!englishReadOnly.accept, "Read-only Orders must not render Accept");
  assert(!englishReadOnly.prepare, "Read-only Orders must not render Prepare");
  assert(!englishReadOnly.cancel, "Read-only Orders must not render Cancel");
  assert(!englishReadOnly.form, "Read-only Orders must not render the cancel form");
  assert(
    englishReadOnly.readOnlyNotes >= 2,
    `Expected read-only notes for both orders, saw ${englishReadOnly.readOnlyNotes}`,
  );
  assert(
    englishReadOnly.cards >= 2,
    `Expected both orders to remain readable, saw ${englishReadOnly.cards}`,
  );
  assert(
    englishReadOnly.text.includes("This store is suspended."),
    "English read-only notice should be visible",
  );
  assert(
    englishReadOnly.text.includes(
      "You can review this order only. Accept, prepare and cancel are unavailable",
    ),
    "English read-only per-order note should be visible",
  );
  assert(
    englishReadOnly.overflow <= 361,
    `Expected no horizontal scroll in English read-only mode, saw ${englishReadOnly.overflow}`,
  );
  await capturePhoneScreenshot("07-read-only-orders-en-360.png");

  await cdp.send("Network.setCookie", {
    name: "rabet-merchant-locale",
    value: "ar",
    domain: "127.0.0.1",
    path: "/",
  });
  await navigate(`${BASE_URL}/app/orders`, "Arabic read-only orders");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-orders-page\"]')?.getAttribute('dir') === 'rtl'",
    "Arabic read-only RTL page",
  );
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-orders-suspended-notice\"]'))",
    "Arabic read-only suspended notice",
  );

  const arabicReadOnly = await cdp.evaluate(`(() => ({
    accept: Boolean(document.querySelector('[data-testid="merchant-order-action-accept"]')),
    prepare: Boolean(document.querySelector('[data-testid="merchant-order-action-prepare"]')),
    cancel: Boolean(document.querySelector('[data-testid="merchant-order-action-cancel"]')),
    form: Boolean(document.querySelector('[data-testid="merchant-order-cancel-form"]')),
    text: document.body.innerText,
    overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }))()`);
  assert(!arabicReadOnly.accept, "Arabic read-only Orders must not render Accept");
  assert(!arabicReadOnly.prepare, "Arabic read-only Orders must not render Prepare");
  assert(!arabicReadOnly.cancel, "Arabic read-only Orders must not render Cancel");
  assert(!arabicReadOnly.form, "Arabic read-only Orders must not render the cancel form");
  for (const expected of [
    "المتجر موقوف مؤقتًا.",
    "يمكنك مراجعة الطلب فقط.",
    "ORD-DEF567",
  ]) {
    assert(
      arabicReadOnly.text.includes(expected),
      `Arabic read-only Orders should include ${JSON.stringify(expected)}`,
    );
  }
  assert(
    arabicReadOnly.overflow <= 361,
    `Expected no horizontal scroll in Arabic read-only mode, saw ${arabicReadOnly.overflow}`,
  );
  await capturePhoneScreenshot("08-read-only-orders-ar-360.png");

  log("Checking that the Orders entry is hidden when COD is off...");
  const probePort = 3447;
  const probeUrl = `http://127.0.0.1:${probePort}`;
  const probeServer = spawn(
    "bash",
    [
      "-c",
      `source "${envFile}" && export RABET_COD_ORDERS_ENABLED='false' && export AUTH_URL='${probeUrl}' && PORT=${probePort} node node_modules/next/dist/bin/next start`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env },
    },
  );

  try {
    let probeReady = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(500);
      try {
        const response = await fetch(`${probeUrl}/app/login`);
        if (response.status === 200) {
          probeReady = true;
          break;
        }
      } catch {}
    }
    assert(probeReady, "COD-off probe server failed to start within 20s");

    const setupResponse = await fetch(
      `${probeUrl}/app/setup?codProbe=${Date.now()}`,
      {
        headers: {
          Cookie: `rabet-merchant.session-token=${merchantCookie}`,
          "Cache-Control": "no-store",
        },
      },
    );
    assert(setupResponse.status === 200, "COD-off setup page should render");
    const setupBody = await setupResponse.text();
    assert(
      !setupBody.includes('data-testid="merchant-orders-link"'),
      "Orders entry must be hidden when the COD deployment gate is off",
    );
  } finally {
    if (probeServer.pid) {
      try {
        process.kill(-probeServer.pid, "SIGKILL");
      } catch {}
    }
  }

  log("ALL COD ORDERS BROWSER ACCEPTANCE CHECKS PASSED");
  await cleanup();
}

async function waitFor(cdp, expression, label, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch {}
    await sleep(150);
  }
  let context = "";
  try {
    context = await cdp.evaluate(
      "JSON.stringify({ path: window.location.pathname, text: document.body.innerText.slice(0, 500) })",
    );
  } catch {}
  fail(`Timed out waiting for ${label}${context ? ` — page: ${context}` : ""}`);
}

function resolveChromePath() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const playwrightDirs = [
    "/root/.cache/ms-playwright",
    path.join(process.env.HOME || "", ".cache/ms-playwright"),
  ];
  for (const directory of playwrightDirs) {
    if (!existsSync(directory)) continue;
    try {
      for (const entry of readdirSync(directory)) {
        if (!entry.startsWith("chromium-")) continue;
        for (const relative of [
          "chrome-linux64/chrome",
          "chrome-linux/chrome",
          "chrome-linux/headless_shell",
        ]) {
          const candidate = path.join(directory, entry, relative);
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {}
  }

  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.callbacks = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (error) => reject(error);
      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id && this.callbacks.has(data.id)) {
          const { resolve, reject } = this.callbacks.get(data.id);
          this.callbacks.delete(data.id);
          if (data.error) reject(new Error(JSON.stringify(data.error)));
          else resolve(data.result);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `CDP evaluate error: ${result.exceptionDetails.text} - ${
          result.exceptionDetails.exception?.description || ""
        }`,
      );
    }
    return result.result?.value;
  }
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

main().catch(async (error) => {
  process.stderr.write(
    `[cod-orders-browser:FAIL] ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  await cleanup();
  process.exit(1);
});
