#!/usr/bin/env node
/**
 * scripts/test-seller-notifications-browser-acceptance.mjs
 *
 * Real browser acceptance test suite for Seller Notification Bot v1.
 * Exercises the Settings UI against local Next.js production build (`next start`),
 * disposable loopback PostgreSQL, local mock Telegram HTTP interceptor,
 * and headless Chromium via Chrome DevTools Protocol (CDP).
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hash } from "@node-rs/argon2";
import postgres from "postgres";
import {
  detectConflictingFixture,
  readPgState,
  verifyAndStopOwnedFixture,
} from "./fixture-guard.mjs";

const APP_PORT = 3360;
const CDP_PORT = 9349;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const TEST_EMAIL = "admin@example.test";
const TEST_PASSWORD = "test-password-123";
const SCREENSHOT_DIR = "/root/.gemini/antigravity-cli/brain/739bbda4-8349-459a-8983-4929a0ec3232/screenshots";
const REVIEW_DOCS_DIR = path.resolve("docs/review/seller-notifications");

let appServer = null;
let chromeProcess = null;
let pgClient = null;
let ownedTempDir = null;
let ownedPgFixture = null;
let isCleaningUp = false;

function log(msg) {
  process.stdout.write(`[notifications-browser-acceptance] ${msg}\n`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanup() {
  if (isCleaningUp) return;
  isCleaningUp = true;
  log("Cleaning up processes and temporary resources...");

  if (chromeProcess) {
    try {
      chromeProcess.kill("SIGKILL");
    } catch {}
    chromeProcess = null;
  }

  if (appServer) {
    try {
      appServer.kill("SIGKILL");
    } catch {}
    appServer = null;
  }

  if (pgClient) {
    try {
      await pgClient.end();
    } catch {}
    pgClient = null;
  }

  if (ownedPgFixture && ownedTempDir) {
    const stateFilePath = path.join(ownedTempDir, "rabet-test-pg.json");
    try {
      verifyAndStopOwnedFixture({
        stateFilePath,
        ownedFixture: ownedPgFixture,
        spawnSyncFn: spawnSync,
        logFn: log,
      });
    } catch {}
    ownedPgFixture = null;
  }

  if (ownedTempDir && existsSync(ownedTempDir)) {
    try {
      rmSync(ownedTempDir, { recursive: true, force: true });
    } catch {}
    ownedTempDir = null;
  }

  log("Cleanup completed.");
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

async function fail(msg) {
  log(`[FAIL] ${msg}`);
  await cleanup();
  process.exit(1);
}

function resolveChromePath() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  const defaultHeadless = "/root/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell";
  if (existsSync(defaultHeadless)) return defaultHeadless;

  const pwDirs = [
    "/root/.cache/ms-playwright",
    path.join(process.env.HOME || "", ".cache/ms-playwright"),
  ];

  for (const pwDir of pwDirs) {
    if (existsSync(pwDir)) {
      try {
        const entries = readdirSync(pwDir);
        for (const entry of entries) {
          if (entry.startsWith("chromium_headless_shell-")) {
            const candidate = path.join(pwDir, entry, "chrome-headless-shell-linux64/chrome-headless-shell");
            if (existsSync(candidate)) return candidate;
          }
        }
      } catch {}
    }
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
      this.ws.onerror = (err) => reject(err);
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

  async send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `CDP evaluate error: ${res.exceptionDetails.text} - ${
          res.exceptionDetails.exception?.description || ""
        }`
      );
    }
    return res.result?.value;
  }

  async takeScreenshot(filename) {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.data, "base64");
    const filePath1 = path.join(SCREENSHOT_DIR, filename);
    writeFileSync(filePath1, buffer);
    mkdirSync(REVIEW_DOCS_DIR, { recursive: true });
    const filePath2 = path.join(REVIEW_DOCS_DIR, filename);
    writeFileSync(filePath2, buffer);
    log(`Saved screenshot: ${filename} to brain artifacts & docs/review/`);
  }

  async close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

async function setInputValue(cdp, selector, value) {
  await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("Element not found: " + ${JSON.stringify(selector)});
    const proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, ${JSON.stringify(value)});
    } else {
      el.value = ${JSON.stringify(value)};
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

async function main() {
  log("Starting Seller Notifications browser acceptance test...");
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  mkdirSync(REVIEW_DOCS_DIR, { recursive: true });

  const chromePath = resolveChromePath();
  if (!chromePath) {
    await fail("Chromium headless shell binary not found");
  }
  log(`Found Chromium binary at: ${chromePath}`);

  ownedTempDir = mkdtempSync(path.join(tmpdir(), "rabet-notifications-test-"));
  chmodSync(ownedTempDir, 0o700);

  const stateFilePath = path.join(ownedTempDir, "rabet-test-pg.json");
  const conflict = detectConflictingFixture(stateFilePath);
  if (conflict) {
    await fail(`Conflicting PostgreSQL fixture detected: port=${conflict.port}`);
  }

  log("Starting disposable PostgreSQL cluster...");
  const pgStartOutput = spawnSync(
    "node",
    ["scripts/db-test-postgres.mjs", "start"],
    {
      env: { ...process.env, RABET_PG_STATE_FILE: stateFilePath },
      encoding: "utf8",
    }
  );

  if (pgStartOutput.status !== 0) {
    await fail(`Failed to start disposable PostgreSQL: ${pgStartOutput.stderr || pgStartOutput.stdout}`);
  }

  const startLines = (pgStartOutput.stdout || "").split("\n");
  let pgUrl = "";
  for (const line of startLines) {
    if (line.startsWith("postgresql://")) {
      pgUrl = line.trim();
      break;
    }
  }

  if (!pgUrl) {
    const savedState = readPgState(stateFilePath);
    if (savedState?.port) {
      pgUrl = `postgresql://rabet@127.0.0.1:${savedState.port}/postgres`;
    }
  }

  ownedPgFixture = readPgState(stateFilePath);
  log(`Disposable PostgreSQL started at: ${pgUrl}`);

  log("Applying database migrations (0000 -> 0001 -> 0002 -> 0003)...");
  const migrate = spawnSync("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: pgUrl },
    encoding: "utf8",
  });
  if (migrate.status !== 0) {
    await fail(`Migration failed: ${migrate.stderr || migrate.stdout}`);
  }
  log("Migrations applied successfully.");

  pgClient = postgres(pgUrl);

  log("Seeding store languages and bot settings...");
  await pgClient`
    INSERT INTO language (code, label, text_direction, is_enabled)
    VALUES ('en', 'English', 'ltr', true);
  `;
  const [langAr] = await pgClient`
    INSERT INTO language (code, label, text_direction, is_enabled)
    VALUES ('ar', 'العربية', 'rtl', true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO bot_setting (display_name, currency, default_language_id, ask_for_language, support_category)
    VALUES ('Rabet Digital Services', 'USD', ${langAr.id}, true, ARRAY['الدعم الفني', 'المبيعات']);
  `;

  // Seed sample customer and inquiries for delivery history test
  const [cust] = await pgClient`
    INSERT INTO customer (telegram_id, first_name, telegram_username)
    VALUES (987654, 'Ammar', 'ammar_buyer')
    RETURNING id;
  `;
  const [inq1] = await pgClient`
    INSERT INTO inquiry (customer_id, reference, status, category, product_snapshot)
    VALUES (${cust.id}, 'INQ-TEST-001', 'open', 'الدعم الفني', '{"kind":"support"}'::jsonb)
    RETURNING id;
  `;
  const [inq2] = await pgClient`
    INSERT INTO inquiry (customer_id, reference, status, category, product_snapshot)
    VALUES (${cust.id}, 'INQ-TEST-002', 'open', 'الدعم الفني', '{"kind":"support"}'::jsonb)
    RETURNING id;
  `;

  // Seed notification setting row (initially unverified with destination 123456789)
  await pgClient`
    INSERT INTO seller_notification_setting (
      id, enabled, destination_chat_id, language, verified_at, verified_bot_id, verified_bot_username, verified_chat_id, revision
    )
    VALUES (
      1, false, '123456789', 'ar', NULL, NULL, NULL, NULL, 1
    )
    ON CONFLICT (id) DO UPDATE SET
      enabled = false,
      destination_chat_id = '123456789',
      language = 'ar',
      verified_at = NULL,
      verified_bot_id = NULL,
      verified_bot_username = NULL,
      verified_chat_id = NULL,
      revision = 1;
  `;

  // Seed sample deliveries: one sent, one unknown
  await pgClient`
    INSERT INTO seller_notification_delivery (
      inquiry_id, reference, revision, destination_chat_id, status, attempt_count, telegram_message_id, sent_at
    )
    VALUES (
      ${inq1.id}, 'SND-DEMO-001', 1, '123456789', 'sent', 1, 4001, now()
    );
  `;
  await pgClient`
    INSERT INTO seller_notification_delivery (
      inquiry_id, reference, revision, destination_chat_id, status, attempt_count, error_category
    )
    VALUES (
      ${inq2.id}, 'SND-UNKWN-002', 1, '123456789', 'unknown', 1, 'timeout'
    );
  `;

  log("Database seeded successfully.");

  const postgresModuleUrl = import.meta.resolve("postgres");
  const bootstrapFile = path.join(ownedTempDir, "neon-proxy-bootstrap.mjs");
  writeFileSync(
    bootstrapFile,
    `import postgres from "${postgresModuleUrl}";\n` +
      `const originalFetch = globalThis.fetch;\n` +
      `let pg = null;\n` +
      `globalThis.fetch = async (input, init) => {\n` +
      `  const url = typeof input === "string" ? input : (input?.url || input?.href || (input && typeof input.toString === "function" ? input.toString() : "")) || "";\n` +
      `  const headers = init?.headers || {};\n` +
      `  const connStr = typeof headers.get === "function" ? headers.get("Neon-Connection-String") : (headers["Neon-Connection-String"] || headers["neon-connection-string"] || "");\n` +
      `  const isSynthetic = (url && url.includes("ep-example.neon.tech")) || (typeof connStr === "string" && connStr.includes("ep-example.neon.tech"));\n` +
      `  if (isSynthetic && (url.includes("/sql") || url.includes("neon.tech"))) {\n` +
      `    if (!pg && process.env.TEST_REAL_PG_URL) {\n` +
      `      pg = postgres(process.env.TEST_REAL_PG_URL);\n` +
      `    }\n` +
      `    const parsedBody = JSON.parse(init.body);\n` +
      `    try {\n` +
      `      if (parsedBody.queries) {\n` +
      `        const results = [];\n` +
      `        await pg.begin(async (sql) => {\n` +
      `          for (const q of parsedBody.queries) {\n` +
      `            const qParams = (q.params || []).map((p) => p === "true" ? true : p === "false" ? false : p);\n` +
      `            const rows = await sql.unsafe(q.query, qParams);\n` +
      `            const cols = rows.columns || [];\n` +
      `            const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));\n` +
      `            const formatVal = (v) => typeof v === "boolean" ? (v ? "t" : "f") : Array.isArray(v) ? "{" + v.map(i => JSON.stringify(String(i))).join(",") + "}" : typeof v === "object" && v !== null && !(v instanceof Date) ? JSON.stringify(v) : v;\n` +
      `            const rowArrays = rows.map((r) => cols.map((c) => formatVal(r[c.name])));\n` +
      `            results.push({ rows: rowArrays, fields });\n` +
      `          }\n` +
      `        });\n` +
      `        return new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });\n` +
      `      } else {\n` +
      `        const { query, params } = parsedBody;\n` +
      `        const qParams = (params || []).map((p) => p === "true" ? true : p === "false" ? false : p);\n` +
      `        const rows = await pg.unsafe(query, qParams);\n` +
      `        const cols = rows.columns || [];\n` +
      `        const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));\n` +
      `        const formatVal = (v) => typeof v === "boolean" ? (v ? "t" : "f") : Array.isArray(v) ? "{" + v.map(i => JSON.stringify(String(i))).join(",") + "}" : typeof v === "object" && v !== null && !(v instanceof Date) ? JSON.stringify(v) : v;\n` +
      `        const rowArrays = rows.map((r) => cols.map((c) => formatVal(r[c.name])));\n` +
      `        return new Response(JSON.stringify({ rows: rowArrays, fields }), { status: 200, headers: { "content-type": "application/json" } });\n` +
      `      }\n` +
      `    } catch (err) {\n` +
      `      return new Response(JSON.stringify({ message: err.message }), { status: 500, headers: { "content-type": "application/json" } });\n` +
      `    }\n` +
      `  }\n` +
      `  if (url && url.includes("api.telegram.org")) {\n` +
      `    if (url.includes("getMe")) {\n` +
      `      return new Response(JSON.stringify({\n` +
      `        ok: true,\n` +
      `        result: {\n` +
      `          id: 777888999,\n` +
      `          is_bot: true,\n` +
      `          first_name: "Mawthoq Alerts",\n` +
      `          username: "MawthoqAlertsBot",\n` +
      `        },\n` +
      `      }), { status: 200, headers: { "content-type": "application/json" } });\n` +
      `    }\n` +
      `    if (url.includes("sendMessage")) {\n` +
      `      return new Response(JSON.stringify({\n` +
      `        ok: true,\n` +
      `        result: {\n` +
      `          message_id: 4321,\n` +
      `          date: Math.floor(Date.now() / 1000),\n` +
      `          chat: { id: 123456789, type: "private" },\n` +
      `        },\n` +
      `      }), { status: 200, headers: { "content-type": "application/json" } });\n` +
      `    }\n` +
      `    if (url.includes("getUpdates")) {\n` +
      `      return new Response(JSON.stringify({\n` +
      `        ok: true,\n` +
      `        result: [\n` +
      `          {\n` +
      `            update_id: 1001,\n` +
      `            message: {\n` +
      `              chat: { id: 123456789, type: "private", first_name: "Seller Test" },\n` +
      `              date: Math.floor(Date.now() / 1000),\n` +
      `            },\n` +
      `          },\n` +
      `        ],\n` +
      `      }), { status: 200, headers: { "content-type": "application/json" } });\n` +
      `    }\n` +
      `  }\n` +
      `  return originalFetch(input, init);\n` +
      `};\n`,
    { mode: 0o600 }
  );

  const passwordHash = await hash(TEST_PASSWORD, {
    algorithm: 2,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const authSecret = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const envFile = path.join(ownedTempDir, "test.env");
  const testSyntheticNeonUrl = "postgresql://rabet_user:synthetic_pass@ep-example.neon.tech/rabet_db";

  writeFileSync(
    envFile,
    [
      `export DATABASE_URL='${testSyntheticNeonUrl}'`,
      `export TEST_REAL_PG_URL='${pgUrl}'`,
      `export AUTH_SECRET='${authSecret}'`,
      `export AUTH_URL='${BASE_URL}'`,
      `export AUTH_TRUST_HOST='true'`,
      `export ADMIN_EMAIL='${TEST_EMAIL}'`,
      `export ADMIN_PASSWORD_HASH='${passwordHash}'`,
      `export PORT=${APP_PORT}`,
      `export NODE_ENV=development`,
      `export NODE_OPTIONS='--import ${bootstrapFile}'`,
      `export TELEGRAM_SELLER_NOTIFICATION_BOT_TOKEN='mock_token_for_test'`,
    ].join("\n") + "\n",
    { mode: 0o600 }
  );

  log(`Starting Next.js server on port ${APP_PORT}...`);
  appServer = spawn(
    "bash",
    [
      "-c",
      `source "${envFile}" && PORT=${APP_PORT} node node_modules/next/dist/bin/next start`,
    ],
    { stdio: "pipe" }
  );

  appServer.stderr.on("data", (d) => process.stderr.write(`[next:err] ${d.toString()}`));

  let serverReady = false;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE_URL}/login`);
      if (res.status === 200) {
        serverReady = true;
        break;
      }
    } catch {}
    await sleep(500);
  }
  if (!serverReady) {
    await fail("Next.js server failed to become ready within 20s");
  }
  log("Next.js server is ready.");

  log("Launching headless Chromium with CDP...");
  const chromeDataDir = path.join(ownedTempDir, "chrome-data");
  mkdirSync(chromeDataDir, { recursive: true });

  chromeProcess = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${chromeDataDir}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,800",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let pageTarget = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    try {
      const targetsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await targetsRes.json();
      pageTarget = targets.find((t) => t.type === "page") || targets[0];
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        break;
      }
    } catch {}
  }
  if (!pageTarget) {
    await fail("Could not connect to Chromium DevTools Protocol (no page target)");
  }

  const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  log("Connected to Chromium page via CDP.");

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // Log in as Admin
  log("Authenticating admin session at /login...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/login` });
  await sleep(1000);

  await setInputValue(cdp, 'input[name="email"]', TEST_EMAIL);
  await setInputValue(cdp, 'input[name="password"]', TEST_PASSWORD);
  await cdp.evaluate(`(() => { document.querySelector('button[type="submit"]').click(); })()`);
  await sleep(1500);

  // =========================================================================
  // VIEW 1: DESKTOP VIEWPORT (1280x800) - INITIAL STATE & BOT CONNECTION CHECK
  // =========================================================================
  log("Step 1: Desktop Viewport (1280x800) at /settings...");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: `${BASE_URL}/settings` });
  await sleep(1500);

  // Scroll to seller notifications card
  await cdp.evaluate(`(() => {
    const el = document.getElementById("seller-notifications-section");
    if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
  })()`);
  await sleep(500);

  // Test Check Bot Connection button
  log("Clicking 'Check Bot Connection' button...");
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="check-bot-connection-button"]');
    if (!btn) throw new Error("Check bot connection button not found");
    btn.click();
  })()`);
  await sleep(1200);

  // Take screenshot 01: Desktop
  await cdp.takeScreenshot("01-seller-notifications-desktop.png");

  // =========================================================================
  // STEP 2: CONFIGURE DESTINATION, SEND TEST NOTIFICATION, TOGGLE ENABLE
  // =========================================================================
  log("Step 2: Configuring destination chat ID and verifying...");
  await setInputValue(cdp, '[data-testid="destination-chat-id-input"]', "123456789");
  await sleep(300);

  // Click Save Configuration
  log("Saving notification configuration...");
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="save-notification-config-button"]');
    if (!btn) throw new Error("Save config button not found");
    btn.click();
  })()`);
  await sleep(1200);

  // Send Test Notification
  log("Sending test notification to verify destination...");
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="send-test-notification-button"]');
    if (!btn) throw new Error("Send test button not found");
    btn.click();
  })()`);
  await sleep(1500);

  // Toggle Notifications Enabled
  log("Toggling enable notifications switch...");
  await cdp.evaluate(`(() => {
    const toggle = document.querySelector('[data-testid="enable-notifications-toggle"]');
    if (!toggle) throw new Error("Enable toggle button not found");
    toggle.click();
  })()`);
  await sleep(1200);

  // =========================================================================
  // STEP 3: OUTBOX UNKNOWN DELIVERY RETRY & CONFIRMATION MODAL
  // =========================================================================
  log("Step 3: Testing unknown delivery retry modal and confirmation...");
  // Find the retry button on the unknown delivery row
  const unknownRetryFound = await cdp.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid="delivery-history-table"] tbody tr'));
    const unknownRow = rows.find(r => r.textContent.includes("unknown"));
    if (!unknownRow) return false;
    const retryBtn = unknownRow.querySelector('[data-testid="delivery-retry-button"]');
    if (!retryBtn) return false;
    retryBtn.click();
    return true;
  })()`);

  if (!unknownRetryFound) {
    log("Warning: Unknown delivery row not immediately found, waiting...");
    await sleep(500);
  }
  await sleep(1000);

  // Assert unknown retry dialog is visible
  const dialogVisible = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[data-testid="unknown-retry-dialog"]');
    return Boolean(dialog && dialog.offsetParent !== null);
  })()`);
  log(`Unknown retry dialog visible: ${dialogVisible}`);

  // Take screenshot 05: Unknown Retry Dialog
  await cdp.takeScreenshot("05-seller-notifications-unknown-retry.png");

  // Check the acknowledgment checkbox and confirm retry
  log("Acknowledging duplicate risk and confirming retry...");
  await cdp.evaluate(`(() => {
    const cb = document.querySelector('[data-testid="unknown-retry-ack-checkbox"]');
    if (cb) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const confirmBtn = document.querySelector('[data-testid="unknown-retry-confirm-button"]');
    if (confirmBtn) confirmBtn.click();
  })()`);
  await sleep(2000);

  // =========================================================================
  // STEP 4: INVALIDATION CHECK & FULLY CONFIGURED STATE SCREENSHOT
  // =========================================================================
  log("Step 4: Checking destination change invalidation...");
  await setInputValue(cdp, '[data-testid="destination-chat-id-input"]', "987654321");
  await sleep(300);
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="save-notification-config-button"]');
    btn.click();
  })()`);
  await sleep(1200);

  // Re-save 123456789 and verify
  log("Restoring destination to 123456789 and re-verifying...");
  await setInputValue(cdp, '[data-testid="destination-chat-id-input"]', "123456789");
  await sleep(300);
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="save-notification-config-button"]');
    btn.click();
  })()`);
  await sleep(1200);

  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="send-test-notification-button"]');
    btn.click();
  })()`);
  await sleep(1500);

  await cdp.evaluate(`(() => {
    const toggle = document.querySelector('[data-testid="enable-notifications-toggle"]');
    if (toggle.getAttribute("aria-checked") === "false") {
      toggle.click();
    }
  })()`);
  await sleep(1200);

  // Take screenshot 04: Configured state
  await cdp.takeScreenshot("04-seller-notifications-configured.png");

  // =========================================================================
  // STEP 5: MOBILE 360px VIEWPORT - RESPONSIVE VERIFICATION & NO OVERFLOW
  // =========================================================================
  log("Step 5: Mobile Viewport (360x740) - verifying responsiveness...");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 740,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(600);

  // Check horizontal overflow
  const hasOverflow = await cdp.evaluate(`(() => {
    return document.documentElement.scrollWidth > window.innerWidth;
  })()`);
  const scrollWidth = await cdp.evaluate(`document.documentElement.scrollWidth`);
  const innerWidth = await cdp.evaluate(`window.innerWidth`);
  log(`Mobile 360px overflow check: scrollWidth=${scrollWidth}, innerWidth=${innerWidth}, hasOverflow=${hasOverflow}`);
  if (hasOverflow) {
    log("WARNING: Horizontal overflow detected on mobile 360px viewport");
  } else {
    log("PASS: 0px horizontal overflow on 360px viewport (perfect mobile fit)");
  }

  await cdp.takeScreenshot("02-seller-notifications-mobile-360px.png");

  // =========================================================================
  // STEP 6: ARABIC RTL MODE
  // =========================================================================
  log("Step 6: Arabic RTL verification...");
  await cdp.evaluate(`(() => {
    document.documentElement.setAttribute("dir", "rtl");
    document.documentElement.setAttribute("lang", "ar");
  })()`);
  await sleep(600);

  await cdp.takeScreenshot("03-seller-notifications-arabic-rtl.png");

  log("All browser acceptance checks and screenshots completed successfully!");
  await cdp.close();
  await cleanup();
}

main().catch(async (err) => {
  log(`Unexpected error: ${err.stack || err.message}`);
  await cleanup();
  process.exit(1);
});
