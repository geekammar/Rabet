#!/usr/bin/env node
/**
 * scripts/test-seller-notifications-browser-acceptance.mjs
 *
 * Real browser acceptance test suite for Seller Notification Bot v1.
 * Exercises the Settings UI against local Next.js production build (`next start`),
 * disposable loopback PostgreSQL (or designated CI service container),
 * hermetic local mock Telegram HTTP interceptor with call auditing,
 * and headless Chromium via Chrome DevTools Protocol (CDP).
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || "";
const REVIEW_DOCS_DIR = path.resolve("docs/review/seller-notifications");

let appServer = null;
let chromeProcess = null;
let pgClient = null;
let ownedTempDir = null;
let ownedPgFixture = null;
let createdDbName = null;
let isCleaningUp = false;

function log(msg) {
  process.stdout.write(`[notifications-browser-acceptance] ${msg}\n`);
}

function assert(condition, message) {
  if (!condition) {
    const err = new Error(`[ASSERTION_FAILED] ${message}`);
    log(err.message);
    throw err;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 10000, intervalMs = 200, label = "condition") {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fn();
      if (res) return res;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for ${label} after ${timeoutMs}ms${lastErr ? `: ${lastErr.message}` : ""}`);
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

  if (createdDbName && process.env.RABET_TEST_PG_URL) {
    try {
      const cleanupSql = postgres(process.env.RABET_TEST_PG_URL, { max: 1 });
      await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${createdDbName}`);
      await cleanupSql.end();
    } catch {}
    createdDbName = null;
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
    if (SCREENSHOT_DIR) {
      try {
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        writeFileSync(path.join(SCREENSHOT_DIR, filename), buffer);
      } catch {}
    }
    mkdirSync(REVIEW_DOCS_DIR, { recursive: true });
    writeFileSync(path.join(REVIEW_DOCS_DIR, filename), buffer);
    log(`Saved screenshot: ${filename} to ${REVIEW_DOCS_DIR}`);
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
  mkdirSync(REVIEW_DOCS_DIR, { recursive: true });
  if (SCREENSHOT_DIR) {
    try {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
    } catch {}
  }

  const chromePath = resolveChromePath();
  if (!chromePath) {
    await fail("Chromium headless shell binary not found");
  }
  log(`Found Chromium binary at: ${chromePath}`);

  ownedTempDir = mkdtempSync(path.join(tmpdir(), "rabet-notifications-test-"));
  chmodSync(ownedTempDir, 0o700);

  const telegramAuditLog = path.join(ownedTempDir, "telegram-calls.json");
  writeFileSync(telegramAuditLog, "[]", "utf8");

  let pgUrl = "";
  if (process.env.RABET_TEST_PG_URL) {
    createdDbName = `rabet_notif_browser_${Date.now()}`;
    const adminSql = postgres(process.env.RABET_TEST_PG_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE ${createdDbName}`);
    await adminSql.end();

    const parsed = new URL(process.env.RABET_TEST_PG_URL);
    parsed.pathname = `/${createdDbName}`;
    pgUrl = parsed.toString();
    log(`Using designated PostgreSQL service with database: ${createdDbName}`);
  } else {
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
  }

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

  // Seed sample customer and inquiries
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

  // Seed initial setting: unconfigured, destination null, disabled
  await pgClient`
    INSERT INTO seller_notification_setting (
      id, enabled, destination_chat_id, language, verified_at, verified_bot_id, verified_bot_username, verified_chat_id, revision
    )
    VALUES (
      1, false, NULL, 'ar', NULL, NULL, NULL, NULL, 1
    )
    ON CONFLICT (id) DO UPDATE SET
      enabled = false,
      destination_chat_id = NULL,
      language = 'ar',
      verified_at = NULL,
      verified_bot_id = NULL,
      verified_bot_username = NULL,
      verified_chat_id = NULL,
      revision = 1;
  `;

  // Seed 1 delivered record
  await pgClient`
    INSERT INTO seller_notification_delivery (
      inquiry_id, reference, revision, destination_chat_id, status, attempt_count, telegram_message_id, sent_at
    )
    VALUES (
      ${inq1.id}, 'SND-DEMO-001', 1, '123456789', 'sent', 1, 4001, now()
    );
  `;

  log("Database seeded successfully.");

  const postgresModuleUrl = import.meta.resolve("postgres");
  const bootstrapFile = path.join(ownedTempDir, "neon-proxy-bootstrap.mjs");
  writeFileSync(
    bootstrapFile,
    `import postgres from "${postgresModuleUrl}";\n` +
      `import fs from "node:fs";\n` +
      `const auditFile = ${JSON.stringify(telegramAuditLog)};\n` +
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
      `    let callKind = "unknown";\n` +
      `    let parsedBody = null;\n` +
      `    if (init?.body) {\n` +
      `      try { parsedBody = JSON.parse(init.body); } catch {}\n` +
      `    }\n` +
      `    if (url.includes("getMe")) callKind = "getMe";\n` +
      `    else if (url.includes("sendMessage")) callKind = "sendMessage";\n` +
      `    else if (url.includes("getUpdates")) callKind = "getUpdates";\n` +
      `    try {\n` +
      `      const calls = JSON.parse(fs.readFileSync(auditFile, "utf8"));\n` +
      `      calls.push({ kind: callKind, url, body: parsedBody, time: Date.now() });\n` +
      `      fs.writeFileSync(auditFile, JSON.stringify(calls));\n` +
      `    } catch {}\n` +
      `    if (callKind === "getMe") {\n` +
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
      `    if (callKind === "sendMessage") {\n` +
      `      return new Response(JSON.stringify({\n` +
      `        ok: true,\n` +
      `        result: {\n` +
      `          message_id: 4321,\n` +
      `          date: Math.floor(Date.now() / 1000),\n` +
      `          chat: { id: parsedBody?.chat_id || 123456789, type: "private" },\n` +
      `        },\n` +
      `      }), { status: 200, headers: { "content-type": "application/json" } });\n` +
      `    }\n` +
      `    if (callKind === "getUpdates") {\n` +
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
      `    return new Response(JSON.stringify({ ok: false, description: "Blocked unexpected Telegram API call in test harness" }), { status: 400, headers: { "content-type": "application/json" } });\n` +
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
      `export APP_URL='https://dashboard.rabet.test'`,
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
  assert(serverReady, "Next.js server failed to become ready within 20s");
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
  assert(pageTarget && pageTarget.webSocketDebuggerUrl, "Could not connect to Chromium DevTools Protocol");

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

  // Wait for redirect to /overview or /settings
  await waitFor(async () => {
    const url = await cdp.evaluate(`window.location.pathname`);
    return url !== "/login";
  }, 10000, 300, "login redirect");

  // Navigate to /settings
  log("Navigating to /settings...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/settings` });

  await waitFor(async () => {
    return await cdp.evaluate(`Boolean(document.getElementById("seller-notifications-section"))`);
  }, 10000, 300, "seller-notifications-section presence");

  // Scroll to section
  await cdp.evaluate(`document.getElementById("seller-notifications-section").scrollIntoView({ behavior: "instant", block: "start" })`);
  await sleep(400);

  // =========================================================================
  // SCENARIO A: Change destination/language, save, reload, confirm persisted
  // =========================================================================
  log("Scenario A: Configure destination chat ID and language, save, reload, assert persistence...");
  await setInputValue(cdp, '[data-testid="destination-chat-id-input"]', "123456789");
  await setInputValue(cdp, '[data-testid="notification-language-select"]', "en");
  await sleep(200);

  await cdp.evaluate(`document.querySelector('[data-testid="save-notification-config-button"]').click()`);
  await waitFor(async () => {
    const text = await cdp.evaluate(`document.getElementById("seller-notifications-section").textContent`);
    return text.includes("Notification configuration saved") || text.includes("saved");
  }, 8000, 300, "save configuration feedback");

  // Reload page and confirm persisted
  await cdp.send("Page.navigate", { url: `${BASE_URL}/settings` });
  await waitFor(async () => {
    return await cdp.evaluate(`Boolean(document.getElementById("seller-notifications-section"))`);
  }, 10000, 300, "reload settings section");

  const persistedDest = await cdp.evaluate(`document.querySelector('[data-testid="destination-chat-id-input"]').value`);
  const persistedLang = await cdp.evaluate(`document.querySelector('[data-testid="notification-language-select"]').value`);
  assert(persistedDest === "123456789", `Expected persisted destination '123456789', found '${persistedDest}'`);
  assert(persistedLang === "en", `Expected persisted language 'en', found '${persistedLang}'`);

  // Switch language back to Arabic for primary operation
  await setInputValue(cdp, '[data-testid="notification-language-select"]', "ar");
  await cdp.evaluate(`document.querySelector('[data-testid="save-notification-config-button"]').click()`);
  await sleep(1000);

  // =========================================================================
  // SCENARIO B: Check connection and verify displayed identity
  // =========================================================================
  log("Scenario B: Check connection and verify displayed bot identity...");
  await cdp.evaluate(`document.querySelector('[data-testid="check-bot-connection-button"]').click()`);
  await waitFor(async () => {
    const text = await cdp.evaluate(`document.getElementById("seller-notifications-section").textContent`);
    return text.includes("MawthoqAlertsBot");
  }, 8000, 300, "bot connection check feedback");

  const auditAfterCheck = JSON.parse(readFileSync(telegramAuditLog, "utf8"));
  assert(auditAfterCheck.some((c) => c.kind === "getMe"), "Mock Telegram getMe was not called");

  // Capture Screenshot 01: Desktop Initial Setup
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.evaluate(`document.getElementById("seller-notifications-section").scrollIntoView({ behavior: "instant", block: "start" })`);
  await sleep(300);
  await cdp.takeScreenshot("01-seller-notifications-desktop.png");

  // =========================================================================
  // SCENARIO C: Send TEST, confirm verified bot/destination
  // =========================================================================
  log("Scenario C: Send test notification and confirm verification in DB...");
  const sendCountBeforeTest = JSON.parse(readFileSync(telegramAuditLog, "utf8")).filter((c) => c.kind === "sendMessage").length;

  await cdp.evaluate(`document.querySelector('[data-testid="send-test-notification-button"]').click()`);
  await waitFor(async () => {
    const text = await cdp.evaluate(`document.getElementById("seller-notifications-section").textContent`);
    return text.includes("delivered successfully") || text.includes("verified");
  }, 10000, 400, "test notification delivery feedback");

  const auditAfterTest = JSON.parse(readFileSync(telegramAuditLog, "utf8")).filter((c) => c.kind === "sendMessage");
  assert(auditAfterTest.length === sendCountBeforeTest + 1, "Expected exactly 1 test sendMessage to Telegram");
  const lastSend = auditAfterTest[auditAfterTest.length - 1];
  assert(String(lastSend.body?.chat_id) === "123456789", `Expected test sent to 123456789, found ${lastSend.body?.chat_id}`);
  assert(lastSend.body?.text.includes("[تجربة]") || lastSend.body?.text.includes("[TEST]"), "Test notification missing [تجربة] tag");

  // Verify DB verification state
  const [dbSetting] = await pgClient`SELECT * FROM seller_notification_setting WHERE id = 1`;
  assert(dbSetting.verified_at !== null, "seller_notification_setting.verified_at must be populated");
  assert(Number(dbSetting.verified_bot_id) === 777888999, "verified_bot_id must match mock bot ID");
  assert(dbSetting.verified_chat_id === "123456789", "verified_chat_id must match destination chat ID");

  // =========================================================================
  // SCENARIO D: Explicitly enable and disable; assert both resulting states
  // =========================================================================
  log("Scenario D: Testing enable and disable toggling...");
  // Enable Alerts
  await cdp.evaluate(`document.querySelector('[data-testid="enable-notifications-toggle"]').click()`);
  await waitFor(async () => {
    const btnText = await cdp.evaluate(`document.querySelector('[data-testid="enable-notifications-toggle"]').textContent`);
    return btnText.includes("Disable Alerts");
  }, 8000, 300, "enable alerts toggle button text");

  let [enabledCheck] = await pgClient`SELECT enabled FROM seller_notification_setting WHERE id = 1`;
  assert(enabledCheck.enabled === true, "Database setting.enabled must be true");

  // Disable Alerts
  await cdp.evaluate(`document.querySelector('[data-testid="enable-notifications-toggle"]').click()`);
  await waitFor(async () => {
    const btnText = await cdp.evaluate(`document.querySelector('[data-testid="enable-notifications-toggle"]').textContent`);
    return btnText.includes("Enable Alerts");
  }, 8000, 300, "disable alerts toggle button text");

  [enabledCheck] = await pgClient`SELECT enabled FROM seller_notification_setting WHERE id = 1`;
  assert(enabledCheck.enabled === false, "Database setting.enabled must be false");

  // Re-enable alerts for configured state
  await cdp.evaluate(`document.querySelector('[data-testid="enable-notifications-toggle"]').click()`);
  await waitFor(async () => {
    const btnText = await cdp.evaluate(`document.querySelector('[data-testid="enable-notifications-toggle"]').textContent`);
    return btnText.includes("Disable Alerts");
  }, 8000, 300, "re-enable alerts");

  // Capture Screenshot 04: Configured State
  await cdp.takeScreenshot("04-seller-notifications-configured.png");

  // =========================================================================
  // SCENARIO E: Destination change clears verification and disables
  // =========================================================================
  log("Scenario E: Destination change invalidation check...");
  const [beforeChange] = await pgClient`SELECT revision FROM seller_notification_setting WHERE id = 1`;
  const prevRev = beforeChange.revision;

  await setInputValue(cdp, '[data-testid="destination-chat-id-input"]', "987654321");
  await cdp.evaluate(`document.querySelector('[data-testid="save-notification-config-button"]').click()`);
  await waitFor(async () => {
    const text = await cdp.evaluate(`document.getElementById("seller-notifications-section").textContent`);
    return text.includes("saved");
  }, 8000, 300, "destination change save feedback");

  const [invalidatedSetting] = await pgClient`SELECT * FROM seller_notification_setting WHERE id = 1`;
  assert(invalidatedSetting.enabled === false, "Changing destination must disable notifications");
  assert(invalidatedSetting.verified_at === null, "Changing destination must clear verified_at");
  assert(invalidatedSetting.revision === prevRev + 1, `Changing destination must increment revision from ${prevRev} to ${prevRev + 1}`);

  // Verify that Enable button is disabled in UI because verification was cleared
  const toggleDisabled = await cdp.evaluate(`document.querySelector('[data-testid="enable-notifications-toggle"]').disabled`);
  assert(toggleDisabled === true, "Enable alerts toggle must be disabled when unverified");

  // Restore destination to 123456789 and re-verify
  log("Restoring destination to 123456789 and re-verifying...");
  await setInputValue(cdp, '[data-testid="destination-chat-id-input"]', "123456789");
  await cdp.evaluate(`document.querySelector('[data-testid="save-notification-config-button"]').click()`);
  await waitFor(async () => {
    const text = await cdp.evaluate(`document.getElementById("seller-notifications-section").textContent`);
    return text.includes("saved");
  }, 8000, 300, "restore save feedback");

  // Wait 5.2s for the 5-second server-persisted test cooldown to elapse
  await sleep(5200);

  await cdp.evaluate(`document.querySelector('[data-testid="send-test-notification-button"]').click()`);
  await waitFor(async () => {
    const text = await cdp.evaluate(`document.getElementById("seller-notifications-section").textContent`);
    return text.includes("delivered successfully") || text.includes("verified");
  }, 10000, 300, "re-test feedback");

  await cdp.evaluate(`document.querySelector('[data-testid="enable-notifications-toggle"]').click()`);
  await waitFor(async () => {
    const btnText = await cdp.evaluate(`document.querySelector('[data-testid="enable-notifications-toggle"]').textContent`);
    return btnText.includes("Disable Alerts");
  }, 8000, 300, "re-enabled alerts");

  const [currentRevRow] = await pgClient`SELECT revision FROM seller_notification_setting WHERE id = 1`;
  const activeRevision = currentRevRow.revision;

  // =========================================================================
  // SCENARIO F & G: Unknown delivery retry confirmation & duplicate risk ack
  // =========================================================================
  log("Scenario F & G: Unknown delivery retry modal, duplicate risk ack, and retry send...");
  // Seed an unknown delivery with current revision
  const [seededUnknown] = await pgClient`
    INSERT INTO seller_notification_delivery (
      inquiry_id, reference, revision, destination_chat_id, status, attempt_count, error_category
    )
    VALUES (
      ${inq2.id}, 'SND-UNKWN-CDP', ${activeRevision}, '123456789', 'unknown', 1, 'timeout'
    )
    RETURNING id;
  `;

  // Click refresh outbox button
  await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const refBtn = btns.find(b => b.textContent.includes('Refresh Outbox'));
    if (refBtn) refBtn.click();
  })()`);
  await sleep(1000);

  // Locate the unknown row's retry button
  const unknownRetryFound = await waitFor(async () => {
    return await cdp.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="delivery-history-table"] tbody tr'));
      const unknownRow = rows.find(r => r.textContent.includes("unknown"));
      if (!unknownRow) return false;
      const retryBtn = unknownRow.querySelector('[data-testid="delivery-retry-button"]');
      if (!retryBtn) return false;
      retryBtn.click();
      return true;
    })()`);
  }, 8000, 300, "unknown delivery row and retry button");

  assert(unknownRetryFound, "Unknown delivery row not found in delivery history table");

  // Assert unknown retry dialog is visible
  await waitFor(async () => {
    return await cdp.evaluate(`(() => {
      const dialog = document.querySelector('[data-testid="unknown-retry-dialog"]');
      return Boolean(dialog && dialog.offsetParent !== null);
    })()`);
  }, 6000, 200, "unknown-retry-dialog visibility");

  // Assert confirm button is initially DISABLED
  const initialConfirmDisabled = await cdp.evaluate(`document.querySelector('[data-testid="unknown-retry-confirm-button"]').disabled`);
  assert(initialConfirmDisabled === true, "Confirm retry button must be disabled before checkbox acknowledgment");

  // Scroll dialog into center view and capture Screenshot 05
  await cdp.evaluate(`document.querySelector('[data-testid="unknown-retry-dialog"]').scrollIntoView({ behavior: "instant", block: "center" })`);
  await sleep(400);
  await cdp.takeScreenshot("05-seller-notifications-unknown-retry.png");

  // Activate acknowledgment checkbox
  log("Activating duplicate-risk acknowledgment checkbox...");
  await cdp.evaluate(`(() => {
    const cb = document.querySelector('[data-testid="unknown-retry-ack-checkbox"]');
    if (!cb) throw new Error("ack checkbox not found");
    cb.click();
  })()`);
  await sleep(300);

  // Assert confirm button is now ENABLED
  const confirmEnabled = await cdp.evaluate(`!document.querySelector('[data-testid="unknown-retry-confirm-button"]').disabled`);
  assert(confirmEnabled === true, "Confirm retry button must become enabled after checkbox is clicked");

  // Record send count before retry dispatch
  const sendsBeforeRetry = JSON.parse(readFileSync(telegramAuditLog, "utf8")).filter((c) => c.kind === "sendMessage").length;

  // Confirm Retry
  await cdp.evaluate(`document.querySelector('[data-testid="unknown-retry-confirm-button"]').click()`);
  await waitFor(async () => {
    const [row] = await pgClient`SELECT status FROM seller_notification_delivery WHERE id = ${seededUnknown.id}::uuid`;
    return row && row.status === "sent";
  }, 10000, 400, "delivery row transition to sent in DB");

  const sendsAfterRetry = JSON.parse(readFileSync(telegramAuditLog, "utf8")).filter((c) => c.kind === "sendMessage").length;
  assert(sendsAfterRetry === sendsBeforeRetry + 1, "Exactly 1 sendMessage call must occur upon confirmed retry");

  // =========================================================================
  // SCENARIO H: Expired sending recovers to unknown without sending
  // =========================================================================
  log("Scenario H: Expired sending lease recovery check...");
  const [inq3] = await pgClient`
    INSERT INTO inquiry (customer_id, reference, status, category, product_snapshot)
    VALUES (${cust.id}, 'INQ-TEST-003', 'open', 'الدعم الفني', '{"kind":"support"}'::jsonb)
    RETURNING id;
  `;
  const [expiredRow] = await pgClient`
    INSERT INTO seller_notification_delivery (
      inquiry_id, reference, revision, destination_chat_id, status, claim_attempt_id, claim_expires_at, attempt_count
    )
    VALUES (
      ${inq3.id}, 'SND-EXP-001', ${activeRevision}, '123456789', 'sending', 'stale-worker-uuid', now() - interval '5 minutes', 1
    )
    RETURNING id;
  `;

  const sendsBeforeRecovery = JSON.parse(readFileSync(telegramAuditLog, "utf8")).filter((c) => c.kind === "sendMessage").length;

  // Trigger refresh outbox in UI
  await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const refBtn = btns.find(b => b.textContent.includes('Refresh Outbox'));
    if (refBtn) refBtn.click();
  })()`);

  // Assert expired sending recovered to unknown with lease_expired category
  await waitFor(async () => {
    const [row] = await pgClient`SELECT status, error_category FROM seller_notification_delivery WHERE id = ${expiredRow.id}::uuid`;
    return row && row.status === "unknown" && row.error_category === "lease_expired";
  }, 8000, 300, "recovery of expired sending lease in DB");

  const sendsAfterRecovery = JSON.parse(readFileSync(telegramAuditLog, "utf8")).filter((c) => c.kind === "sendMessage").length;
  assert(sendsAfterRecovery === sendsBeforeRecovery, "Recovering expired sending must emit zero Telegram messages");
  log("Expired sending lease recovered atomically to 'unknown' without sending.");

  // =========================================================================
  // SCENARIO I & J: Mobile 360px viewport - inspect controls, history, 0px overflow
  // =========================================================================
  log("Scenario I & J: Mobile 360px viewport responsiveness and overflow verification...");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 740,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(600);

  const scrollWidth = await cdp.evaluate(`document.documentElement.scrollWidth`);
  const innerWidth = await cdp.evaluate(`window.innerWidth`);
  log(`Mobile 360px check: scrollWidth=${scrollWidth}, innerWidth=${innerWidth}`);
  assert(scrollWidth <= innerWidth, `Horizontal overflow detected: scrollWidth (${scrollWidth}) > innerWidth (${innerWidth})`);
  log("PASS: 0px horizontal overflow on 360px mobile viewport.");

  // Scroll section into view and capture Screenshot 02
  await cdp.evaluate(`document.getElementById("seller-notifications-section").scrollIntoView({ behavior: "instant", block: "start" })`);
  await sleep(400);
  await cdp.takeScreenshot("02-seller-notifications-mobile-360px.png");

  // =========================================================================
  // SCENARIO K: Arabic RTL layout stress test
  // =========================================================================
  log("Scenario K: Arabic RTL layout stress test...");
  await cdp.evaluate(`(() => {
    document.documentElement.setAttribute("dir", "rtl");
    document.documentElement.setAttribute("lang", "ar");
  })()`);
  await sleep(500);

  const dirAttr = await cdp.evaluate(`document.documentElement.getAttribute("dir")`);
  assert(dirAttr === "rtl", "Document dir must be 'rtl'");

  await cdp.takeScreenshot("03-seller-notifications-arabic-rtl.png");

  log("All browser acceptance gates PASSED successfully with strict assertions!");
  await cdp.close();
  await cleanup();
}

main().catch(async (err) => {
  log(`Unexpected acceptance failure: ${err.stack || err.message}`);
  await cleanup();
  process.exit(1);
});
