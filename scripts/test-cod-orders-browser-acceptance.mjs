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
import { hash as hashPassword } from "@node-rs/argon2";
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
const TEST_REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

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

function testOrderReference(prefix, index) {
  let remaining = index;
  let suffix = "";

  for (let position = 0; position < 4; position += 1) {
    suffix =
      TEST_REFERENCE_ALPHABET[remaining % TEST_REFERENCE_ALPHABET.length] +
      suffix;
    remaining = Math.floor(remaining / TEST_REFERENCE_ALPHABET.length);
  }

  return `ORD-${prefix}${suffix}`;
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
  const merchantEmail = "cod-browser-owner@example.test";
  const merchantPassword = crypto.randomUUID();
  const passwordHash = await hashPassword(merchantPassword);
  const [user] = await pgClient`
    insert into "app_user" ("email")
    values (${merchantEmail})
    returning id, session_version
  `;
  await pgClient`
    insert into "merchant_credential" ("user_id", "password_hash")
    values (${user.id}, ${passwordHash})
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
    values (${product.id}, ${store.id}, 5, 3)
  `;
  const [cancelProduct] = await pgClient`
    insert into "product" ("store_id", "category_id", "slug", "price", "is_active", "sort_order")
    values (${store.id}, ${category.id}, 'cod-browser-cancel-product', 11.00, true, 2)
    returning id
  `;
  await pgClient`
    insert into "product_inventory" ("product_id", "store_id", "on_hand", "reserved")
    values (${cancelProduct.id}, ${store.id}, 5, 0)
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
  const navigate = async (url, label) => {
    await cdp.send("Page.navigate", { url });
    await waitFor(
      cdp,
      "document.readyState === 'complete'",
      `${label} document ready`,
    );
  };

  log("Checking that a signed-out order link resumes after merchant sign-in...");
  const orderPath = `/app/orders?order=${order.id}#merchant-order-${order.id}`;
  await navigate(`${BASE_URL}${orderPath}`, "signed-out order link");
  await waitFor(
    cdp,
    `location.pathname === '/app/login' &&
      new URLSearchParams(location.search).get('order') === ${JSON.stringify(order.id)} &&
      Boolean(document.querySelector('[data-testid="merchant-login-email"]'))`,
    "merchant login with the order selector preserved",
  );
  assert(
    !(await cdp.evaluate("document.body.innerText.includes('ORD-ABC234')")),
    "The signed-out page must not expose the order",
  );
  for (const [field, value] of [["email", merchantEmail], ["password", merchantPassword]]) {
    await cdp.evaluate(`document.querySelector('[data-testid="merchant-login-${field}"]').focus()`);
    await cdp.send("Input.insertText", { text: value });
  }
  await cdp.evaluate("document.querySelector('[data-testid=\"merchant-login-submit\"]').click()");
  await waitFor(
    cdp,
    `location.pathname === '/app/orders' &&
      new URLSearchParams(location.search).get('order') === ${JSON.stringify(order.id)} &&
      Boolean(document.getElementById(${JSON.stringify(`merchant-order-${order.id}`)}))`,
    "authorized order after merchant login",
  );
  await waitFor(
    cdp,
    `location.hash === ${JSON.stringify(`#merchant-order-${order.id}`)}`,
    "selected order card anchor after merchant login",
  );

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
  const attentionBefore = await cdp.evaluate(`(() => {
    const section = document.querySelector('[data-testid="merchant-needs-attention"]');
    const link = section?.querySelector('[data-testid="merchant-needs-attention-link"]');
    return {
      count: section?.getAttribute('data-pending-count') ?? null,
      previewCount: section?.getAttribute('data-preview-count') ?? null,
      previewNote: Boolean(section?.querySelector('[data-testid="merchant-needs-attention-preview-note"]')),
      text: section?.innerText ?? '',
      href: link?.getAttribute('href') ?? null,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    };
  })()`);
  assert(
    attentionBefore.count === "1" && attentionBefore.previewCount === "1",
    `Expected one order awaiting acceptance with a one-row preview, saw ${JSON.stringify(attentionBefore)}`,
  );
  assert(
    !attentionBefore.previewNote,
    `A bounded-preview note must not appear when every pending order fits, saw ${JSON.stringify(attentionBefore)}`,
  );
  assert(
    attentionBefore.text.includes("ORD-ABC234") &&
      attentionBefore.text.includes("37.00 SAR"),
    `Needs Attention must show the pending order reference and total, saw ${JSON.stringify(attentionBefore)}`,
  );
  assert(
    attentionBefore.href ===
      `/app/orders?order=${order.id}#merchant-order-${order.id}`,
    `Needs Attention must use a validated order selector plus the existing card anchor, saw ${JSON.stringify(attentionBefore.href)}`,
  );
  assert(
    attentionBefore.overflow <= 361,
    `Expected no horizontal scroll on the merchant entry point at 360 px, saw ${attentionBefore.overflow}`,
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

  const findOrderCardExpression = (reference) =>
    `[...document.querySelectorAll('[data-testid="merchant-order-card"]')].find((candidate) => candidate.innerText.includes(${JSON.stringify(reference)}))`;

  const scrollToOrder = async (reference) => {
    const scrolled = await cdp.evaluate(`(() => {
      const card = ${findOrderCardExpression(reference)};
      if (!card) return false;
      card.scrollIntoView({ block: "start", behavior: "instant" });
      return true;
    })()`);
    assert(scrolled, `Expected ${reference} card to exist for scrolling`);
  };

  const clickOrderTestId = async (reference, testId) => {
    const clicked = await cdp.evaluate(`(() => {
      const card = ${findOrderCardExpression(reference)};
      const element = card?.querySelector('[data-testid="${testId}"]');
      if (!element) return false;
      element.click();
      return true;
    })()`);
    assert(clicked, `Expected ${testId} inside ${reference} to be clickable`);
  };

  const readUxSequence = async () =>
    cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="merchant-order-card"]')];
      const details = cards.map((card, index) => {
        const match = card.innerText.match(/ORD-[A-Z2-9]{6}/);
        return {
          index,
          reference: match?.[0] ?? null,
          status: card.getAttribute('data-current-status'),
          payment: card.getAttribute('data-payment-status'),
          top: card.getBoundingClientRect().top,
          bottom: card.getBoundingClientRect().bottom,
        };
      });
      const a = details.find((entry) => entry.reference === "ORD-UXA234");
      const b = details.find((entry) => entry.reference === "ORD-UXB345");
      return {
        order: details.map((entry) => entry.reference),
        a,
        b,
        viewportHeight: window.innerHeight,
        scrollY: window.scrollY,
      };
    })()`);

  const readOrderCard = async (reference = null) =>
    cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="merchant-order-card"]')];
      const card = ${
        reference
          ? `cards.find((candidate) => candidate.textContent.includes(${JSON.stringify(reference)}))`
          : "cards[0]"
      };
      if (!card) return null;
      const status = card.querySelector('[data-testid="merchant-order-status"]');
      const payment = card.querySelector('[data-testid="merchant-order-payment"]');
      const entries = [...card.querySelectorAll('[data-testid="merchant-order-timeline-entry"]')];
      return {
        currentStatus: card.getAttribute('data-current-status'),
        paymentStatus: card.getAttribute('data-payment-status'),
        statusBadge: status?.getAttribute('data-value') ?? null,
        paymentBadge: payment?.getAttribute('data-value') ?? null,
        known: entries.filter((entry) => entry.getAttribute('data-known') === 'true').length,
        unknown: entries.filter((entry) => entry.getAttribute('data-known') === 'false').length,
        entries: entries.map((entry) => ({
          known: entry.getAttribute('data-known'),
          text: entry.innerText,
        })),
        text: card.innerText,
      };
    })()`);

  log("Running the phone-first accept, prepare, shipping, delivery and collection flow...");
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

  await navigate(`${BASE_URL}/app/setup`, "merchant setup after acceptance");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-needs-attention\"]')?.getAttribute('data-pending-count') === '0'",
    "needs attention queue emptied after acceptance",
  );
  const afterAcceptanceSetupBody = await cdp.evaluate("document.body.innerText");
  assert(
    !afterAcceptanceSetupBody.includes("ORD-ABC234"),
    "An accepted order must leave the Needs Attention queue on reload",
  );
  await navigate(`${BASE_URL}/app/orders`, "merchant orders after acceptance");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-prepare\"]'))",
    "Start preparing action after acceptance reload",
  );

  await clickTestId("merchant-order-action-prepare");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-hand_to_shipping\"]'))",
    "Hand to shipping action while preparing",
  );
  await waitFor(
    cdp,
    "document.body.innerText.includes('Order marked as preparing.')",
    "preparing feedback",
  );
  const preparingBody = await cdp.evaluate("document.body.innerText");
  assert(
    !preparingBody.includes("Not prepared"),
    "Preparing must not be shown beside Not prepared",
  );
  const preparingCard = await readOrderCard();
  assert(
    preparingCard?.currentStatus === "preparing" &&
      preparingCard?.statusBadge === "preparing",
    `Before handoff the current status must be preparing, saw ${JSON.stringify(preparingCard)}`,
  );
  assert(
    preparingCard?.unknown === 0 && preparingCard?.known >= 2,
    "Known preparation steps must not be shown as unknown",
  );
  await capturePhoneScreenshot("03-order-preparing-360.png");

  log("Handing the order to shipping with an explicit stock confirmation...");
  await clickTestId("merchant-order-action-hand_to_shipping");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-shipping-confirm\"]'))",
    "shipping confirmation panel",
  );
  await capturePhoneScreenshot("04-shipping-confirm-360.png");

  await clickTestId("merchant-order-shipping-submit");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-deliver\"]'))",
    "Mark delivered action after handoff",
  );
  await waitFor(
    cdp,
    "document.body.innerText.includes('Handed 2 units to shipping and committed stock exactly once.')",
    "shipping feedback with committed quantity",
  );

  const shippedCard = await readOrderCard();
  assert(
    shippedCard?.currentStatus === "handed_to_shipping" &&
      shippedCard?.statusBadge === "handed_to_shipping" &&
      shippedCard?.paymentBadge === "awaiting_collection",
    `After handoff the current badge must be fulfillment, saw ${JSON.stringify(shippedCard)}`,
  );
  assert(
    shippedCard?.statusBadge !== "preparing",
    "Preparing must not remain the current-status badge after handoff",
  );
  assert(
    shippedCard?.text.includes("Preparing") &&
      shippedCard?.known >= 3 &&
      shippedCard?.unknown === 0,
    "The historical preparing step must remain in the timeline with a known time",
  );

  const [shippingInventory] = await pgClient`
    select on_hand, reserved
    from product_inventory
    where product_id = ${product.id}
  `;
  assert(
    shippingInventory.on_hand === 3,
    `Shipping two units must leave 3 on-hand, saw ${shippingInventory.on_hand}`,
  );
  assert(
    shippingInventory.reserved === 1,
    `Shipping two units must leave 1 reserved, saw ${shippingInventory.reserved}`,
  );

  const [shippedOrder] = await pgClient`
    select fulfillment_status, payment_status, handed_to_shipping_at,
           delivered_at, payment_collected_at, total
    from "order"
    where id = ${order.id}
  `;
  assert(
    shippedOrder.fulfillment_status === "handed_to_shipping",
    `Expected handed_to_shipping, saw ${shippedOrder.fulfillment_status}`,
  );
  assert(
    Boolean(shippedOrder.handed_to_shipping_at),
    "Handoff must record its timestamp",
  );
  assert(
    !shippedOrder.delivered_at && !shippedOrder.payment_collected_at,
    "Shipping must not record delivery or collection",
  );
  assert(
    shippedOrder.payment_status === "awaiting_collection",
    `Shipping must not change payment, saw ${shippedOrder.payment_status}`,
  );

  const [shippedReservation] = await pgClient`
    select status, committed_at
    from inventory_reservation
    where order_id = ${order.id}
  `;
  assert(
    shippedReservation.status === "committed",
    `Expected committed reservation, saw ${shippedReservation.status}`,
  );
  assert(
    Boolean(shippedReservation.committed_at),
    "Committed reservation must record its timestamp",
  );
  await capturePhoneScreenshot("05-handed-to-shipping-360.png");

  log("Marking the order delivered without changing payment or stock...");
  await clickTestId("merchant-order-action-deliver");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-collect_cod\"]'))",
    "Record COD collection action after delivery",
  );
  await waitFor(
    cdp,
    "document.body.innerText.includes('Order delivery recorded.')",
    "delivery feedback",
  );

  const deliveredCard = await readOrderCard();
  assert(
    deliveredCard?.currentStatus === "delivered" &&
      deliveredCard?.statusBadge === "delivered" &&
      deliveredCard?.paymentBadge === "awaiting_collection",
    `After delivery the status and payment badges must stay separate, saw ${JSON.stringify(deliveredCard)}`,
  );
  assert(
    deliveredCard?.statusBadge !== "preparing",
    "Preparing must not remain the current-status badge after delivery",
  );
  assert(
    deliveredCard?.known >= 4 && deliveredCard?.unknown === 0,
    "Delivery must add a known timeline entry",
  );

  const [deliveredOrder] = await pgClient`
    select fulfillment_status, payment_status, delivered_at,
           payment_collected_at, total
    from "order"
    where id = ${order.id}
  `;
  assert(
    deliveredOrder.fulfillment_status === "delivered",
    `Expected delivered, saw ${deliveredOrder.fulfillment_status}`,
  );
  assert(Boolean(deliveredOrder.delivered_at), "Delivery must record its timestamp");
  assert(
    deliveredOrder.payment_status === "awaiting_collection" &&
      !deliveredOrder.payment_collected_at,
    "Delivery must not change payment state",
  );
  assert(
    deliveredOrder.total === "37.00",
    `Delivery must preserve the order total, saw ${deliveredOrder.total}`,
  );
  const [afterDeliveryInventory] = await pgClient`
    select on_hand, reserved
    from product_inventory
    where product_id = ${product.id}
  `;
  assert(
    afterDeliveryInventory.on_hand === 3 && afterDeliveryInventory.reserved === 1,
    "Delivery must not change stock",
  );
  await capturePhoneScreenshot("06-delivered-360.png");

  log("Recording COD collection after delivery...");
  await clickTestId("merchant-order-action-collect_cod");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-collection-confirm\"]'))",
    "collection confirmation panel",
  );
  await capturePhoneScreenshot("07-collection-confirm-360.png");

  await clickTestId("merchant-order-collection-submit");
  await waitFor(
    cdp,
    "document.body.innerText.includes('Cash-on-delivery collection recorded.')",
    "collection feedback",
  );
  await waitFor(
    cdp,
    "!document.querySelector('[data-testid=\"merchant-order-action-collect_cod\"]')",
    "no further primary action after collection",
  );

  const collectedCard = await readOrderCard();
  assert(
    collectedCard?.currentStatus === "delivered" &&
      collectedCard?.statusBadge === "delivered" &&
      collectedCard?.paymentBadge === "collected",
    `After collection the status stays delivered and payment is separate, saw ${JSON.stringify(collectedCard)}`,
  );
  assert(
    collectedCard?.statusBadge !== "preparing",
    "Preparing must not remain the current-status badge after collection",
  );
  assert(
    collectedCard?.known >= 5 && collectedCard?.unknown === 0,
    "Newly executed actions must show their actual recorded timeline timestamps",
  );

  const [collectedOrder] = await pgClient`
    select fulfillment_status, payment_status, delivered_at,
           payment_collected_at, total
    from "order"
    where id = ${order.id}
  `;
  assert(
    collectedOrder.payment_status === "collected",
    `Expected collected payment, saw ${collectedOrder.payment_status}`,
  );
  assert(
    Boolean(collectedOrder.payment_collected_at),
    "Collection must record its timestamp",
  );
  assert(
    collectedOrder.fulfillment_status === "delivered" &&
      Boolean(collectedOrder.delivered_at),
    "Collection must not change delivery state",
  );
  assert(
    collectedOrder.total === "37.00",
    `Collection must preserve the order total, saw ${collectedOrder.total}`,
  );
  const [afterCollectionInventory] = await pgClient`
    select on_hand, reserved
    from product_inventory
    where product_id = ${product.id}
  `;
  assert(
    afterCollectionInventory.on_hand === 3 &&
      afterCollectionInventory.reserved === 1,
    "Collection must not change stock",
  );
  await capturePhoneScreenshot("08-collected-360.png");

  log("Checking Arabic RTL view of the completed order...");
  await cdp.send("Network.setCookie", {
    name: "rabet-merchant-locale",
    value: "ar",
    domain: "127.0.0.1",
    path: "/",
  });
  await navigate(`${BASE_URL}/app/orders`, "Arabic collected orders");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-orders-page\"]')?.getAttribute('dir') === 'rtl'",
    "Arabic RTL orders page",
  );
  const arabicCollectedBody = await cdp.evaluate("document.body.innerText");
  const arabicCollectedCard = await readOrderCard();
  assert(
    arabicCollectedCard?.statusBadge === "delivered" &&
      arabicCollectedCard?.paymentBadge === "collected" &&
      !arabicCollectedBody.includes("قيد التجهيز"),
    `Arabic current status must not remain preparing, saw ${JSON.stringify(arabicCollectedCard)}`,
  );
  for (const expected of [
    "طلبات الدفع عند الاستلام",
    "تم التحصيل",
    "تم التوصيل",
    "تم التوصيل وتحصيل الدفع نقدًا. اكتمل الطلب.",
  ]) {
    assert(
      arabicCollectedBody.includes(expected),
      `Arabic collected Orders page should include ${JSON.stringify(expected)}`,
    );
  }
  assert(
    !arabicCollectedBody.includes("لم يُجهّز"),
    "Arabic view must not show Preparing beside Not prepared",
  );
  const arabicCollectedOverflow = await cdp.evaluate(
    "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)",
  );
  assert(
    arabicCollectedOverflow <= 361,
    `Expected no horizontal scroll in Arabic at 360 px, saw ${arabicCollectedOverflow}`,
  );
  await capturePhoneScreenshot("09-collected-ar-360.png");

  log("Checking a historical delivered order with unknown event times...");
  await cdp.send("Network.setCookie", {
    name: "rabet-merchant-locale",
    value: "en",
    domain: "127.0.0.1",
    path: "/",
  });
  const [unknownHistoricalOrder] = await pgClient`
    insert into "order" (
      "store_id", "connection_id", "telegram_user_id", "telegram_chat_id",
      "reference", "checkout_key", "status", "payment_method", "payment_status",
      "fulfillment_status", "currency", "subtotal", "delivery_fee", "total",
      "customer_name", "customer_phone", "delivery_address",
      "placed_at", "accepted_at", "preparing_at", "created_at", "updated_at"
    )
    values (
      ${store.id}, ${connection.id}, 93004, 93004,
      'ORD-HJM234', ${crypto.randomUUID()}, 'preparing', 'cod', 'collected',
      'delivered', 'SAR', 11.00, 15.00, 26.00,
      'Historical Buyer', '+15550000003', '321 Historical Street',
      now() - interval '3 days', now() - interval '3 days' + interval '5 minutes',
      now() - interval '3 days' + interval '10 minutes',
      now() - interval '3 days', now() - interval '3 days' + interval '1 hour'
    )
    returning id
  `;
  await pgClient`
    insert into "order_item" (
      "order_id", "product_id", "product_name", "unit_price", "quantity",
      "line_total", "product_snapshot"
    )
    values (
      ${unknownHistoricalOrder.id}, ${product.id}, 'Synthetic COD Product', 11.00, 1, 11.00,
      ${JSON.stringify({
        name: "Synthetic COD Product",
        description: "Historical fixture",
        categoryId: category.id,
        unitPrice: "11.00",
        currency: "SAR",
      })}::jsonb
    )
  `;
  await navigate(`${BASE_URL}/app/orders`, "Orders with historical order");
  await waitFor(
    cdp,
    "document.body.innerText.includes('ORD-HJM234')",
    "historical order card",
  );

  const historicalCard = await readOrderCard("ORD-HJM234");
  assert(
    historicalCard?.currentStatus === "delivered" &&
      historicalCard?.statusBadge === "delivered" &&
      historicalCard?.paymentBadge === "collected",
    `Historical status must be current without inference, saw ${JSON.stringify(historicalCard)}`,
  );
  assert(
    historicalCard?.unknown === 3 && historicalCard?.known === 2,
    `Historical handoff/delivery/collection times must be unknown, saw ${JSON.stringify(historicalCard)}`,
  );
  assert(
    historicalCard?.text.includes("Time unknown"),
    "Historical missing event times must be explicitly marked unknown",
  );
  const completedCard = await readOrderCard();
  assert(
    completedCard?.unknown === 0 && completedCard?.known >= 5,
    "Newly executed order must keep exact recorded timeline dates",
  );
  await capturePhoneScreenshot("15-historical-unknown-360.png");

  log("Delivering a historical handed order with an unknown handoff time...");
  const [legacyProduct] = await pgClient`
    insert into "product" ("store_id", "category_id", "slug", "price", "is_active", "sort_order")
    values (${store.id}, ${category.id}, 'cod-browser-legacy-product', 11.00, true, 3)
    returning id
  `;
  await pgClient`
    insert into "product_inventory" ("product_id", "store_id", "on_hand", "reserved")
    values (${legacyProduct.id}, ${store.id}, 4, 0)
  `;
  const [legacyOrder] = await pgClient`
    insert into "order" (
      "store_id", "connection_id", "telegram_user_id", "telegram_chat_id",
      "reference", "checkout_key", "status", "payment_method", "payment_status",
      "fulfillment_status", "currency", "subtotal", "delivery_fee", "total",
      "customer_name", "customer_phone", "delivery_address",
      "placed_at", "accepted_at", "preparing_at", "created_at", "updated_at"
    )
    values (
      ${store.id}, ${connection.id}, 93005, 93005,
      'ORD-HLN345', ${crypto.randomUUID()}, 'preparing', 'cod', 'awaiting_collection',
      'handed_to_shipping', 'SAR', 11.00, 15.00, 26.00,
      'Legacy Handoff Buyer', '+15550000004', '654 Legacy Handoff Street',
      now() - interval '2 days', now() - interval '2 days' + interval '5 minutes',
      now() - interval '2 days' + interval '10 minutes',
      now() - interval '2 days', now() - interval '2 days' + interval '1 hour'
    )
    returning id
  `;
  const [legacyOrderItem] = await pgClient`
    insert into "order_item" (
      "order_id", "product_id", "product_name", "unit_price", "quantity",
      "line_total", "product_snapshot"
    )
    values (
      ${legacyOrder.id}, ${legacyProduct.id}, 'Legacy Handoff Product', 11.00, 1, 11.00,
      ${JSON.stringify({
        name: "Legacy Handoff Product",
        description: "Legacy handoff fixture",
        categoryId: category.id,
        unitPrice: "11.00",
        currency: "SAR",
      })}::jsonb
    )
    returning id
  `;
  await pgClient`
    insert into "inventory_reservation" (
      "order_id", "order_item_id", "product_id", "store_id", "quantity", "status",
      "reserved_at", "committed_at"
    )
    values (
      ${legacyOrder.id}, ${legacyOrderItem.id}, ${legacyProduct.id}, ${store.id},
      1, 'committed', now() - interval '2 days' + interval '10 minutes',
      now() - interval '2 days' + interval '20 minutes'
    )
  `;
  await navigate(`${BASE_URL}/app/orders`, "Orders with legacy handed order");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-deliver\"]'))",
    "deliver action for the legacy handed order",
  );

  const legacyBefore = await readOrderCard("ORD-HLN345");
  assert(
    legacyBefore?.statusBadge === "handed_to_shipping" &&
      legacyBefore?.paymentBadge === "awaiting_collection" &&
      legacyBefore?.unknown === 1,
    `Legacy handed order must start with unknown handoff, saw ${JSON.stringify(legacyBefore)}`,
  );

  await clickTestId("merchant-order-action-deliver");
  await waitFor(
    cdp,
    "document.body.innerText.includes('Order delivery recorded.')",
    "legacy delivery feedback",
  );
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-collect_cod\"]'))",
    "collection action after legacy delivery",
  );

  const legacyAfter = await readOrderCard("ORD-HLN345");
  const legacyHandoffEntry = legacyAfter?.entries.find((entry) =>
    entry.text.includes("Handed to shipping"),
  );
  const legacyDeliveryEntry = legacyAfter?.entries.find((entry) =>
    entry.text.includes("Delivered"),
  );
  assert(
    legacyAfter?.statusBadge === "delivered" &&
      legacyAfter?.paymentBadge === "awaiting_collection",
    `Legacy order must be delivered with payment still pending, saw ${JSON.stringify(legacyAfter)}`,
  );
  assert(
    legacyHandoffEntry?.known === "false" &&
      legacyHandoffEntry?.text.includes("Time unknown"),
    `Legacy handoff time must stay unknown, saw ${JSON.stringify(legacyHandoffEntry)}`,
  );
  assert(
    legacyDeliveryEntry?.known === "true" &&
      !legacyDeliveryEntry?.text.includes("Time unknown"),
    `Legacy delivery time must be recorded exactly, saw ${JSON.stringify(legacyDeliveryEntry)}`,
  );

  const [legacyAfterDb] = await pgClient`
    select fulfillment_status, payment_status, handed_to_shipping_at,
           delivered_at, payment_collected_at
    from "order"
    where id = ${legacyOrder.id}
  `;
  assert(
    legacyAfterDb.fulfillment_status === "delivered" &&
      legacyAfterDb.payment_status === "awaiting_collection",
    "Legacy delivery must preserve awaiting collection",
  );
  assert(
    legacyAfterDb.handed_to_shipping_at === null,
    "Legacy delivery must not invent a handoff timestamp",
  );
  assert(
    Boolean(legacyAfterDb.delivered_at) &&
      legacyAfterDb.payment_collected_at === null,
    "Legacy delivery must record its delivery time only",
  );
  const [legacyInventory] = await pgClient`
    select on_hand, reserved
    from product_inventory
    where product_id = ${legacyProduct.id}
  `;
  assert(
    legacyInventory.on_hand === 4 && legacyInventory.reserved === 0,
    "Legacy delivery must not change stock",
  );
  const [legacyReservation] = await pgClient`
    select status
    from inventory_reservation
    where order_id = ${legacyOrder.id}
  `;
  assert(
    legacyReservation.status === "committed",
    "Legacy delivery must not change the committed reservation",
  );
  await capturePhoneScreenshot("16-legacy-delivery-unknown-handoff-360.png");

  log("Running the phone-first pre-shipment cancellation flow on a second order...");
  await cdp.send("Network.setCookie", {
    name: "rabet-merchant-locale",
    value: "en",
    domain: "127.0.0.1",
    path: "/",
  });
  const [cancelOrder] = await pgClient`
    insert into "order" (
      "store_id", "connection_id", "telegram_user_id", "telegram_chat_id",
      "reference", "checkout_key", "status", "payment_method", "payment_status",
      "fulfillment_status", "currency", "subtotal", "delivery_fee", "total",
      "customer_name", "customer_phone", "delivery_address"
    )
    values (
      ${store.id}, ${connection.id}, 93003, 93003,
      'ORD-CAN234', ${crypto.randomUUID()}, 'placed', 'cod', 'awaiting_collection',
      'unfulfilled', 'SAR', 22.00, 15.00, 37.00,
      'Synthetic Cancel Buyer', '+15550000002', '789 Synthetic Cancel Street'
    )
    returning id
  `;
  const [cancelOrderItem] = await pgClient`
    insert into "order_item" (
      "order_id", "product_id", "product_name", "unit_price", "quantity",
      "line_total", "product_snapshot"
    )
    values (
      ${cancelOrder.id}, ${cancelProduct.id}, 'Synthetic Cancel Product', 11.00, 2, 22.00,
      ${JSON.stringify({
        name: "Synthetic Cancel Product",
        description: "Cancellation fixture",
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
    values (${cancelOrder.id}, ${cancelOrderItem.id}, ${cancelProduct.id}, ${store.id}, 2, 'reserved')
  `;
  await pgClient`
    update product_inventory
    set reserved = reserved + 2
    where product_id = ${cancelProduct.id}
  `;
  await navigate(`${BASE_URL}/app/orders`, "Orders with cancellation fixture");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-accept\"]'))",
    "Accept action for the cancellation order",
  );
  await clickTestId("merchant-order-action-accept");
  await waitFor(
    cdp,
    "document.body.innerText.includes('Order accepted.')",
    "acceptance feedback for the cancellation order",
  );
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-prepare\"]'))",
    "Prepare action for the cancellation order",
  );
  await clickTestId("merchant-order-action-prepare");
  await waitFor(
    cdp,
    "document.body.innerText.includes('Order marked as preparing.')",
    "preparing feedback for the cancellation order",
  );
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-cancel\"]')) && !document.querySelector('[data-testid=\"merchant-order-action-cancel\"]').disabled",
    "cancellation action while preparing",
  );
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
  await capturePhoneScreenshot("10-cancel-reason-360.png");

  await clickTestId("merchant-order-cancel-submit");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-action-feedback\"]'))",
    "cancellation feedback",
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

  await capturePhoneScreenshot("11-cancelled-360.png");

  await navigate(`${BASE_URL}/app/setup`, "merchant setup after cancellation");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-needs-attention\"]')?.getAttribute('data-pending-count') === '0'",
    "needs attention queue emptied after cancellation",
  );
  const afterCancellationSetupBody = await cdp.evaluate("document.body.innerText");
  assert(
    !afterCancellationSetupBody.includes("ORD-CAN234"),
    "A cancelled order must leave the Needs Attention queue on reload",
  );

  const [cancelledInventory] = await pgClient`
    select on_hand, reserved
    from product_inventory
    where product_id = ${cancelProduct.id}
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
    where order_id = ${cancelOrder.id}
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

  const [historicalOrder] = await pgClient`
    select fulfillment_status, payment_status, total
    from "order"
    where id = ${order.id}
  `;
  assert(
    historicalOrder.fulfillment_status === "delivered" &&
      historicalOrder.payment_status === "collected" &&
      historicalOrder.total === "37.00",
    "Cancelling another order must preserve the completed order",
  );
  const [historicalInventory] = await pgClient`
    select on_hand, reserved
    from product_inventory
    where product_id = ${product.id}
  `;
  assert(
    historicalInventory.on_hand === 3 && historicalInventory.reserved === 1,
    "Cancelling another order must not change the shipped product stock",
  );

  log("Checking Arabic RTL view of the cancelled order...");
  await cdp.send("Network.setCookie", {
    name: "rabet-merchant-locale",
    value: "ar",
    domain: "127.0.0.1",
    path: "/",
  });
  await navigate(`${BASE_URL}/app/orders`, "Arabic cancelled orders");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-orders-page\"]')?.getAttribute('dir') === 'rtl'",
    "Arabic RTL cancelled page",
  );
  const arabicBody = await cdp.evaluate("document.body.innerText");
  for (const expected of [
    "طلبات الدفع عند الاستلام",
    "تم التحصيل",
    "ملغي",
    "محرر",
    "الدفع عند الاستلام",
    cancellationReason,
  ]) {
    assert(
      arabicBody.includes(expected),
      `Arabic orders page should include ${JSON.stringify(expected)}`,
    );
  }
  assert(
    !arabicBody.includes("لم يُجهّز"),
    "Arabic view must not show Preparing beside Not prepared",
  );
  const arabicOverflow = await cdp.evaluate(
    "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)",
  );
  assert(
    arabicOverflow <= 361,
    `Expected no horizontal scroll in Arabic at 360 px, saw ${arabicOverflow}`,
  );
  await capturePhoneScreenshot("12-cancelled-ar-360.png");

  log("Seeding adjacent UX orders with different next actions...");
  const [uxProduct] = await pgClient`
    insert into "product" ("store_id", "category_id", "slug", "price", "is_active", "sort_order")
    values (${store.id}, ${category.id}, 'cod-browser-ux-product', 11.00, true, 4)
    returning id
  `;
  await pgClient`
    insert into "product_inventory" ("product_id", "store_id", "on_hand", "reserved")
    values (${uxProduct.id}, ${store.id}, 4, 3)
  `;
  const uxOrders = await pgClient`
    insert into "order" (
      "store_id", "connection_id", "telegram_user_id", "telegram_chat_id",
      "reference", "checkout_key", "status", "payment_method", "payment_status",
      "fulfillment_status", "currency", "subtotal", "delivery_fee", "total",
      "customer_name", "customer_phone", "delivery_address",
      "placed_at", "accepted_at", "preparing_at", "created_at", "updated_at",
      "handed_to_shipping_at", "delivered_at"
    )
    values
    (
      ${store.id}, ${connection.id}, 93006, 93006,
      'ORD-UXA234', ${crypto.randomUUID()}, 'preparing', 'cod', 'awaiting_collection',
      'unfulfilled', 'SAR', 22.00, 9.00, 31.00,
      'Adjacent Handoff Buyer', '+15550000006', '700 Adjacent Handoff Street',
      now() - interval '30 seconds', now() - interval '30 seconds',
      now() - interval '30 seconds', now() - interval '30 seconds',
      now() - interval '30 seconds', null, null
    ),
    (
      ${store.id}, ${connection.id}, 93007, 93007,
      'ORD-UXB345', ${crypto.randomUUID()}, 'preparing', 'cod', 'awaiting_collection',
      'delivered', 'SAR', 11.00, 9.00, 20.00,
      'Adjacent Collection Buyer', '+15550000007', '701 Adjacent Collection Street',
      now() - interval '30 seconds', now() - interval '30 seconds',
      now() - interval '30 seconds', now() - interval '30 seconds',
      now() - interval '30 seconds', now() - interval '2 hours',
      now() - interval '1 hour'
    ),
    (
      ${store.id}, ${connection.id}, 93008, 93008,
      'ORD-UXC456', ${crypto.randomUUID()}, 'preparing', 'cod', 'awaiting_collection',
      'unfulfilled', 'SAR', 11.00, 9.00, 20.00,
      'Arabic Shipping Copy Buyer', '+15550000008', '702 Arabic Shipping Copy Street',
      now() - interval '1 minute', now() - interval '1 minute',
      now() - interval '1 minute', now() - interval '1 minute',
      now() - interval '1 minute', null, null
    )
    returning id, reference
  `;
  const uxOrderByRef = new Map(uxOrders.map((row) => [row.reference, row.id]));
  const [uxAItem] = await pgClient`
    insert into "order_item" (
      "order_id", "product_id", "product_name", "unit_price", "quantity",
      "line_total", "product_snapshot"
    )
    values (
      ${uxOrderByRef.get("ORD-UXA234")}, ${uxProduct.id}, 'Adjacent Handoff Product',
      11.00, 2, 22.00,
      ${JSON.stringify({
        name: "Adjacent Handoff Product",
        description: "Adjacent UX fixture",
        categoryId: category.id,
        unitPrice: "11.00",
        currency: "SAR",
      })}::jsonb
    )
    returning id
  `;
  const [uxBItem] = await pgClient`
    insert into "order_item" (
      "order_id", "product_id", "product_name", "unit_price", "quantity",
      "line_total", "product_snapshot"
    )
    values (
      ${uxOrderByRef.get("ORD-UXB345")}, ${uxProduct.id}, 'Adjacent Collection Product',
      11.00, 1, 11.00,
      ${JSON.stringify({
        name: "Adjacent Collection Product",
        description: "Adjacent UX fixture",
        categoryId: category.id,
        unitPrice: "11.00",
        currency: "SAR",
      })}::jsonb
    )
    returning id
  `;
  const [uxCItem] = await pgClient`
    insert into "order_item" (
      "order_id", "product_id", "product_name", "unit_price", "quantity",
      "line_total", "product_snapshot"
    )
    values (
      ${uxOrderByRef.get("ORD-UXC456")}, ${uxProduct.id}, 'Arabic Shipping Copy Product',
      11.00, 1, 11.00,
      ${JSON.stringify({
        name: "Arabic Shipping Copy Product",
        description: "Arabic shipping copy fixture",
        categoryId: category.id,
        unitPrice: "11.00",
        currency: "SAR",
      })}::jsonb
    )
    returning id
  `;
  await pgClient`
    insert into "inventory_reservation" (
      "order_id", "order_item_id", "product_id", "store_id", "quantity", "status",
      "reserved_at", "committed_at"
    )
    values
    (
      ${uxOrderByRef.get("ORD-UXA234")}, ${uxAItem.id}, ${uxProduct.id},
      ${store.id}, 2, 'reserved', now() - interval '30 seconds', null
    ),
    (
      ${uxOrderByRef.get("ORD-UXB345")}, ${uxBItem.id}, ${uxProduct.id},
      ${store.id}, 1, 'committed', now() - interval '2 hours',
      now() - interval '2 hours'
    ),
    (
      ${uxOrderByRef.get("ORD-UXC456")}, ${uxCItem.id}, ${uxProduct.id},
      ${store.id}, 1, 'reserved', now() - interval '1 minute', null
    )
  `;

  await cdp.send("Network.setCookie", {
    name: "rabet-merchant-locale",
    value: "en",
    domain: "127.0.0.1",
    path: "/",
  });
  await navigate(`${BASE_URL}/app/orders`, "Adjacent UX orders");
  await waitFor(
    cdp,
    "document.body.innerText.includes('ORD-UXA234') && document.body.innerText.includes('ORD-UXB345')",
    "adjacent UX order cards",
  );
  await scrollToOrder("ORD-UXA234");
  const uxBefore = await readUxSequence();
  log(`UX before handoff: ${JSON.stringify(uxBefore)}`);
  assert(
    uxBefore.a && uxBefore.b && Math.abs(uxBefore.a.index - uxBefore.b.index) === 1,
    `Adjacent UX orders must be adjacent, saw ${JSON.stringify(uxBefore)}`,
  );
  await capturePhoneScreenshot("17-adjacent-orders-before-360.png");

  await clickOrderTestId("ORD-UXA234", "merchant-order-action-hand_to_shipping");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-shipping-confirm\"]'))",
    "adjacent handoff confirmation",
  );
  const uxShippingConfirmText = await cdp.evaluate(
    "document.querySelector('[data-testid=\"merchant-order-shipping-confirm\"]')?.innerText ?? ''",
  );
  log(`UX shipping confirmation: ${JSON.stringify(uxShippingConfirmText)}`);
  await capturePhoneScreenshot("17b-shipping-confirm-reference-360.png");
  await clickOrderTestId("ORD-UXA234", "merchant-order-shipping-submit");
  await waitFor(
    cdp,
    `(${findOrderCardExpression("ORD-UXA234")})?.getAttribute('data-current-status') === 'handed_to_shipping'`,
    "adjacent handoff status",
  );
  const uxAfterHandoff = await readUxSequence();
  const uxNeighborB = await readOrderCard("ORD-UXB345");
  const uxFocusAfterHandoff = await cdp.evaluate(
    "document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null",
  );
  log(`UX after handoff: ${JSON.stringify(uxAfterHandoff)} focus=${uxFocusAfterHandoff}`);
  assert(
    uxShippingConfirmText.includes("ORD-UXA234"),
    `Shipping confirmation must name the selected order, saw ${JSON.stringify(uxShippingConfirmText)}`,
  );
  assert(
    uxAfterHandoff.a && uxAfterHandoff.b &&
      uxAfterHandoff.a.index === uxBefore.a.index &&
      uxAfterHandoff.b.index === uxBefore.b.index,
    `Acted order and adjacent order must not change positions, before ${JSON.stringify(uxBefore)} after ${JSON.stringify(uxAfterHandoff)}`,
  );
  assert(
    uxAfterHandoff.a.top < uxAfterHandoff.viewportHeight &&
      uxAfterHandoff.a.bottom > 0,
    `Acted order must remain in view after handoff, saw ${JSON.stringify(uxAfterHandoff)}`,
  );
  assert(
    uxAfterHandoff.a.status === "handed_to_shipping" &&
      uxAfterHandoff.b.status === "delivered" &&
      uxNeighborB?.paymentBadge === "awaiting_collection",
    `Neighboring order must remain unchanged, saw ${JSON.stringify({ uxAfterHandoff, uxNeighborB })}`,
  );
  assert(
    uxFocusAfterHandoff === "merchant-order-action-deliver",
    `Focus must move to the selected order's next action, saw ${uxFocusAfterHandoff}`,
  );
  await capturePhoneScreenshot("18-adjacent-after-handoff-360.png");

  log("Exercising adjacent collection in Arabic RTL...");
  await cdp.send("Network.setCookie", {
    name: "rabet-merchant-locale",
    value: "ar",
    domain: "127.0.0.1",
    path: "/",
  });
  await navigate(`${BASE_URL}/app/orders`, "Arabic adjacent UX orders");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-orders-page\"]')?.getAttribute('dir') === 'rtl'",
    "Arabic adjacent RTL page",
  );
  await scrollToOrder("ORD-UXC456");
  await clickOrderTestId("ORD-UXC456", "merchant-order-action-hand_to_shipping");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-shipping-confirm\"]'))",
    "Arabic shipping confirmation",
  );
  const arabicShippingConfirmText = await cdp.evaluate(
    "document.querySelector('[data-testid=\"merchant-order-shipping-confirm\"]')?.innerText ?? ''",
  );
  log(`UX Arabic shipping confirmation: ${JSON.stringify(arabicShippingConfirmText)}`);
  assert(
    arabicShippingConfirmText.includes("ORD-UXC456") &&
      arabicShippingConfirmText.includes("المخزون الفعلي والمحجوز") &&
      arabicShippingConfirmText.includes("المتاحة للبيع"),
    `Arabic shipping confirmation must name the order and explain stock movement, saw ${JSON.stringify(arabicShippingConfirmText)}`,
  );
  await capturePhoneScreenshot("19c-shipping-confirm-reference-ar-360.png");
  await clickOrderTestId("ORD-UXC456", "merchant-order-shipping-cancel");

  await scrollToOrder("ORD-UXB345");
  const uxArabicBefore = await readUxSequence();
  await clickOrderTestId("ORD-UXB345", "merchant-order-action-collect_cod");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-order-collection-confirm\"]'))",
    "adjacent collection confirmation",
  );
  const uxCollectionConfirmText = await cdp.evaluate(
    "document.querySelector('[data-testid=\"merchant-order-collection-confirm\"]')?.innerText ?? ''",
  );
  log(`UX collection confirmation: ${JSON.stringify(uxCollectionConfirmText)}`);
  await capturePhoneScreenshot("19b-collection-confirm-reference-ar-360.png");
  await clickOrderTestId("ORD-UXB345", "merchant-order-collection-submit");
  await waitFor(
    cdp,
    `(${findOrderCardExpression("ORD-UXB345")})?.getAttribute('data-payment-status') === 'collected'`,
    "adjacent collection status",
  );
  const uxAfterCollection = await readUxSequence();
  const uxNeighborA = await readOrderCard("ORD-UXA234");
  const uxFocusAfterCollection = await cdp.evaluate(
    "document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null",
  );
  log(`UX after Arabic collection: ${JSON.stringify(uxAfterCollection)} focus=${uxFocusAfterCollection}`);
  assert(
    uxCollectionConfirmText.includes("ORD-UXB345") &&
      uxCollectionConfirmText.includes("20.00") &&
      uxCollectionConfirmText.includes("SAR"),
    `Collection confirmation must name the order and exact amount, saw ${JSON.stringify(uxCollectionConfirmText)}`,
  );
  assert(
    uxAfterCollection.a && uxAfterCollection.b &&
      uxAfterCollection.a.index === uxArabicBefore.a.index &&
      uxAfterCollection.b.index === uxArabicBefore.b.index,
    `Arabic acted order and neighbor must not change positions, before ${JSON.stringify(uxArabicBefore)} after ${JSON.stringify(uxAfterCollection)}`,
  );
  assert(
    uxAfterCollection.b.top < uxAfterCollection.viewportHeight &&
      uxAfterCollection.b.bottom > 0,
    `Acted order must remain in view after Arabic collection, saw ${JSON.stringify(uxAfterCollection)}`,
  );
  assert(
    uxAfterCollection.b.status === "delivered" &&
      uxAfterCollection.b.payment === "collected" &&
      uxNeighborA?.statusBadge === "handed_to_shipping",
    `Arabic neighbor must remain unchanged, saw ${JSON.stringify({ uxAfterCollection, uxNeighborA })}`,
  );
  assert(
    uxFocusAfterCollection === "merchant-order-action-feedback",
    `Focus must remain with the selected order's feedback, saw ${uxFocusAfterCollection}`,
  );
  const uxArabicOverflow = await cdp.evaluate(
    "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)",
  );
  assert(
    uxArabicOverflow <= 361,
    `Expected no horizontal scroll in Arabic adjacent UX view, saw ${uxArabicOverflow}`,
  );
  await capturePhoneScreenshot("19-adjacent-after-collection-ar-360.png");

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
    handoff: Boolean(document.querySelector('[data-testid="merchant-order-action-hand_to_shipping"]')),
    deliver: Boolean(document.querySelector('[data-testid="merchant-order-action-deliver"]')),
    collect: Boolean(document.querySelector('[data-testid="merchant-order-action-collect_cod"]')),
    cancel: Boolean(document.querySelector('[data-testid="merchant-order-action-cancel"]')),
    form: Boolean(document.querySelector('[data-testid="merchant-order-cancel-form"]')),
    readOnlyNotes: document.querySelectorAll('[data-testid="merchant-order-readonly-note"]').length,
    cards: document.querySelectorAll('[data-testid="merchant-order-card"]').length,
    text: document.body.innerText,
    overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }))()`);
  assert(!englishReadOnly.accept, "Read-only Orders must not render Accept");
  assert(!englishReadOnly.prepare, "Read-only Orders must not render Prepare");
  assert(!englishReadOnly.handoff, "Read-only Orders must not render handoff");
  assert(!englishReadOnly.deliver, "Read-only Orders must not render delivery");
  assert(!englishReadOnly.collect, "Read-only Orders must not render collection");
  assert(!englishReadOnly.cancel, "Read-only Orders must not render Cancel");
  assert(!englishReadOnly.form, "Read-only Orders must not render the cancel form");
  assert(
    englishReadOnly.readOnlyNotes >= 8,
    `Expected read-only notes for every order, saw ${englishReadOnly.readOnlyNotes}`,
  );
  assert(
    englishReadOnly.cards >= 8,
    `Expected every order to remain readable, saw ${englishReadOnly.cards}`,
  );
  assert(
    englishReadOnly.text.includes("This store is suspended."),
    "English read-only notice should be visible",
  );
  assert(
    englishReadOnly.text.includes(
      "You can review this order only. Accept, prepare, shipping, delivery, collection and cancel are unavailable",
    ),
    "English read-only per-order note should be visible",
  );
  assert(
    englishReadOnly.overflow <= 361,
    `Expected no horizontal scroll in English read-only mode, saw ${englishReadOnly.overflow}`,
  );
  await capturePhoneScreenshot("13-read-only-orders-en-360.png");

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
    handoff: Boolean(document.querySelector('[data-testid="merchant-order-action-hand_to_shipping"]')),
    deliver: Boolean(document.querySelector('[data-testid="merchant-order-action-deliver"]')),
    collect: Boolean(document.querySelector('[data-testid="merchant-order-action-collect_cod"]')),
    cancel: Boolean(document.querySelector('[data-testid="merchant-order-action-cancel"]')),
    form: Boolean(document.querySelector('[data-testid="merchant-order-cancel-form"]')),
    text: document.body.innerText,
    overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }))()`);
  assert(!arabicReadOnly.accept, "Arabic read-only Orders must not render Accept");
  assert(!arabicReadOnly.prepare, "Arabic read-only Orders must not render Prepare");
  assert(!arabicReadOnly.handoff, "Arabic read-only Orders must not render handoff");
  assert(!arabicReadOnly.deliver, "Arabic read-only Orders must not render delivery");
  assert(!arabicReadOnly.collect, "Arabic read-only Orders must not render collection");
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
  await capturePhoneScreenshot("14-read-only-orders-ar-360.png");

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

  log("Seeding 27 more pending orders (28 total) and an older selected order...");
  await pgClient`
    update "store"
    set status = 'active'
    where id = ${store.id}
  `;

  const attentionNow = Date.now();
  const fillerPlacedAt = new Date(attentionNow - 60 * 60 * 1000);
  const fillerAcceptedAt = new Date(attentionNow - 30 * 60 * 1000);
  for (let index = 0; index < 101; index += 1) {
    await pgClient`
      insert into "order" (
        "store_id", "connection_id", "telegram_user_id", "telegram_chat_id",
        "reference", "checkout_key", "status", "payment_method", "payment_status",
        "fulfillment_status", "currency", "subtotal", "delivery_fee", "total",
        "customer_name", "customer_phone", "delivery_address",
        "placed_at", "accepted_at", "created_at", "updated_at"
      )
      values (
        ${store.id}, ${connection.id}, ${94000 + index}, ${94000 + index},
        ${testOrderReference("ZZ", index)}, ${crypto.randomUUID()}, 'accepted', 'cod',
        'awaiting_collection', 'unfulfilled', 'SAR', 11.00, 0.00, 11.00,
        'Accepted Filler Buyer', '+15550000100', '100 Filler Street',
        ${fillerPlacedAt}, ${fillerAcceptedAt}, ${fillerPlacedAt}, ${fillerPlacedAt}
      )
    `;
  }

  const pendingAttentionOrders = [];
  const pendingBase = attentionNow - 10 * 24 * 60 * 60 * 1000;
  for (let index = 0; index < 27; index += 1) {
    const placedAt = new Date(pendingBase + index * 60 * 1000);
    const [pendingOrder] = await pgClient`
      insert into "order" (
        "store_id", "connection_id", "telegram_user_id", "telegram_chat_id",
        "reference", "checkout_key", "status", "payment_method", "payment_status",
        "fulfillment_status", "currency", "subtotal", "delivery_fee", "total",
        "customer_name", "customer_phone", "delivery_address",
        "placed_at", "created_at", "updated_at"
      )
      values (
        ${store.id}, ${connection.id}, ${94500 + index}, ${94500 + index},
        ${testOrderReference("PN", index)}, ${crypto.randomUUID()}, 'placed', 'cod',
        'awaiting_collection', 'unfulfilled', 'SAR', 11.00, 15.00, 26.00,
        'Pending Attention Buyer', '+15550000101', '200 Pending Street',
        ${placedAt}, ${placedAt}, ${placedAt}
      )
      returning id, reference
    `;
    pendingAttentionOrders.push(pendingOrder);
  }

  const selectedAttentionOrder =
    pendingAttentionOrders[pendingAttentionOrders.length - 1];

  await cdp.send("Network.setCookie", {
    name: "rabet-merchant-locale",
    value: "en",
    domain: "127.0.0.1",
    path: "/",
  });
  await navigate(`${BASE_URL}/app/setup`, "merchant setup with bounded preview");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-needs-attention\"]')?.getAttribute('data-pending-count') === '28'",
    "total pending count of 28",
  );
  const attentionPreview = await cdp.evaluate(`(() => {
    const section = document.querySelector('[data-testid="merchant-needs-attention"]');
    const links = [...(section?.querySelectorAll('[data-testid="merchant-needs-attention-link"]') ?? [])];
    const target = links.find(
      (link) => link.getAttribute('data-order-id') === ${JSON.stringify(selectedAttentionOrder.id)},
    );
    return {
      count: section?.getAttribute('data-pending-count') ?? null,
      previewCount: section?.getAttribute('data-preview-count') ?? null,
      note: section?.querySelector('[data-testid="merchant-needs-attention-preview-note"]')?.textContent?.trim() ?? null,
      linkCount: links.length,
      targetHref: target?.getAttribute('href') ?? null,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    };
  })()`);
  assert(
    attentionPreview.count === "28" && attentionPreview.previewCount === "20",
    `Expected 28 pending with a 20-row preview, saw ${JSON.stringify(attentionPreview)}`,
  );
  assert(
    attentionPreview.note === "Showing the first 20 of 28.",
    `Expected an explicit bounded-preview note, saw ${JSON.stringify(attentionPreview.note)}`,
  );
  assert(
    attentionPreview.linkCount === 20,
    `Expected only 20 preview links, saw ${JSON.stringify(attentionPreview.linkCount)}`,
  );
  assert(
    attentionPreview.targetHref ===
      `/app/orders?order=${selectedAttentionOrder.id}#merchant-order-${selectedAttentionOrder.id}`,
    `Expected the selected order selector and card anchor, saw ${JSON.stringify(attentionPreview.targetHref)}`,
  );
  assert(
    attentionPreview.overflow <= 361,
    `Expected no horizontal scroll with the bounded preview at 360 px, saw ${attentionPreview.overflow}`,
  );

  const attentionClicked = await cdp.evaluate(`(() => {
    const link = document.querySelector(
      '[data-testid="merchant-needs-attention-link"][data-order-id="${selectedAttentionOrder.id}"]',
    );
    if (!link) return false;
    link.click();
    return true;
  })()`);
  assert(attentionClicked, "The selected pending order link should be clickable");
  await waitFor(
    cdp,
    `window.location.pathname === '/app/orders' && new URLSearchParams(window.location.search).get('order') === ${JSON.stringify(selectedAttentionOrder.id)}`,
    "selected order on the Orders page",
  );
  await waitFor(
    cdp,
    `Boolean(document.getElementById('merchant-order-${selectedAttentionOrder.id}'))`,
    "selected order card",
  );
  await waitFor(
    cdp,
    `(() => {
      const card = document.getElementById('merchant-order-${selectedAttentionOrder.id}');
      if (!card) return false;
      const rect = card.getBoundingClientRect();
      return rect.top >= -1 && rect.top < window.innerHeight;
    })()`,
    "selected order card in view",
  );

  const selectedAttentionView = await cdp.evaluate(`(() => {
    const id = 'merchant-order-${selectedAttentionOrder.id}';
    const card = document.getElementById(id);
    const cards = [...document.querySelectorAll('[data-testid="merchant-order-card"]')];
    return {
      id: card?.id ?? null,
      reference: card?.querySelector('h2')?.textContent?.trim() ?? null,
      hash: window.location.hash,
      occurrences: cards.filter((candidate) => candidate.id === id).length,
      cardCount: cards.length,
      acceptAction: Boolean(
        card?.querySelector('[data-testid="merchant-order-action-accept"]'),
      ),
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    };
  })()`);
  assert(
    selectedAttentionView.id === `merchant-order-${selectedAttentionOrder.id}` &&
      selectedAttentionView.reference === selectedAttentionOrder.reference,
    `Expected the exact selected order card, saw ${JSON.stringify(selectedAttentionView)}`,
  );
  assert(
    selectedAttentionView.hash ===
      `#merchant-order-${selectedAttentionOrder.id}`,
    `Expected the selected card anchor in the URL, saw ${JSON.stringify(selectedAttentionView.hash)}`,
  );
  assert(
    selectedAttentionView.occurrences === 1 &&
      selectedAttentionView.cardCount === 101,
    `Expected the older order once after the 100-order list, saw ${JSON.stringify(selectedAttentionView)}`,
  );
  assert(
    selectedAttentionView.acceptAction,
    "The selected pending order must keep its existing Accept action",
  );
  assert(
    selectedAttentionView.overflow <= 361,
    `Expected no horizontal scroll on the selected older order, saw ${selectedAttentionView.overflow}`,
  );

  log("Checking an order selector from another store exposes no order data...");
  const [foreignAttentionStore] = await pgClient`
    insert into "store" ("name", "slug", "status")
    values (
      'Foreign Attention Store',
      ${`foreign-attention-${Date.now()}`},
      'active'
    )
    returning id
  `;
  const foreignAttentionReference = "ORD-XYZ234";
  const [foreignAttentionOrder] = await pgClient`
    insert into "order" (
      "store_id", "connection_id", "telegram_user_id", "telegram_chat_id",
      "reference", "checkout_key", "status", "payment_method", "payment_status",
      "fulfillment_status", "currency", "subtotal", "delivery_fee", "total",
      "customer_name", "customer_phone", "delivery_address"
    )
    values (
      ${foreignAttentionStore.id}, ${connection.id}, 94700, 94700,
      ${foreignAttentionReference}, ${crypto.randomUUID()}, 'placed', 'cod',
      'awaiting_collection', 'unfulfilled', 'SAR', 11.00, 15.00, 26.00,
      'Foreign Buyer', '+15550000102', '300 Foreign Street'
    )
    returning id
  `;
  await navigate(
    `${BASE_URL}/app/orders?order=${foreignAttentionOrder.id}#merchant-order-${foreignAttentionOrder.id}`,
    "Orders with another store's selector",
  );
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-orders-page\"]'))",
    "Orders page after another store's selector",
  );
  const foreignAttentionView = await cdp.evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-testid="merchant-order-card"]')];
    return {
      foreignCard: Boolean(
        document.getElementById('merchant-order-${foreignAttentionOrder.id}'),
      ),
      foreignText: document.body.innerText.includes(
        ${JSON.stringify(foreignAttentionReference)},
      ),
      cardCount: cards.length,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    };
  })()`);
  assert(
    !foreignAttentionView.foreignCard && !foreignAttentionView.foreignText,
    `Another store's order must never be rendered, saw ${JSON.stringify(foreignAttentionView)}`,
  );
  assert(
    foreignAttentionView.cardCount === 100,
    `The normal 100-order list must remain when another store's id is ignored, saw ${JSON.stringify(foreignAttentionView)}`,
  );
  assert(
    foreignAttentionView.overflow <= 361,
    `Expected no horizontal scroll after another store's selector, saw ${foreignAttentionView.overflow}`,
  );

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
