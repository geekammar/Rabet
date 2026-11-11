#!/usr/bin/env node
/**
 * scripts/test-payment-methods-browser-acceptance.mjs
 *
 * Real browser acceptance test suite for PR #22:
 * Central Payment Methods, Multilingual Save Integrity, Button Binding, and Preview Freshness.
 *
 * Exercises the complete real UI against local Next.js production build (`next start`),
 * disposable loopback PostgreSQL, and headless Chromium via Chrome DevTools Protocol (CDP).
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

const APP_PORT = 3350;
const CDP_PORT = 9339;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const TEST_EMAIL = "admin@example.test";
const TEST_PASSWORD = "test-password-123";
const SCREENSHOT_DIR = "/root/.gemini/antigravity-cli/brain/ec9cad45-96fd-4b75-bcf2-013541dce6c5/screenshots";

let appServer = null;
let chromeProcess = null;
let pgClient = null;
let ownedTempDir = null;
let ownedPgFixture = null;
let isCleaningUp = false;

function log(msg) {
  process.stdout.write(`[pm-browser-acceptance] ${msg}\n`);
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
      await pgClient.end({ timeout: 2 });
    } catch {}
    pgClient = null;
  }

  if (ownedPgFixture?.port) {
    log(`Stopping owned disposable PostgreSQL fixture (port ${ownedPgFixture.port})...`);
    verifyAndStopOwnedFixture(ownedPgFixture);
  }

  if (ownedTempDir && existsSync(ownedTempDir)) {
    try {
      rmSync(ownedTempDir, { recursive: true, force: true });
    } catch {}
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

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
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
    const filePath = path.join(SCREENSHOT_DIR, filename);
    writeFileSync(filePath, Buffer.from(res.data, "base64"));
    log(`Saved screenshot: ${filePath}`);
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
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}

async function main() {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    await fail("Chromium executable not found.");
  }
  log(`Found Chromium binary at: ${chromePath}`);

  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const stateFilePath = path.join(tmpdir(), "rabet-pm-test-pg.json");
  process.env.RABET_PG_STATE_FILE = stateFilePath;
  const conflicting = detectConflictingFixture(stateFilePath);
  if (conflicting) {
    log(`Cleaning up stale fixture on port ${conflicting.port}...`);
    spawnSync("node", ["scripts/db-test-postgres.mjs", "stop"], {
      env: { ...process.env, RABET_PG_STATE_FILE: stateFilePath },
      encoding: "utf8",
    });
  }

  log("Starting disposable PostgreSQL instance...");
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

  log("Applying database migrations (0000 -> 0001 -> 0002)...");
  const migrate = spawnSync("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: pgUrl },
    encoding: "utf8",
  });
  if (migrate.status !== 0) {
    await fail(`Migration failed: ${migrate.stderr || migrate.stdout}`);
  }
  log("Migrations applied successfully.");

  pgClient = postgres(pgUrl);

  log("Seeding store with English default, Arabic enabled, categories, and product...");
  const [langEn] = await pgClient`
    INSERT INTO language (code, label, text_direction, is_enabled)
    VALUES ('en', 'English', 'ltr', true)
    RETURNING id;
  `;
  const [langAr] = await pgClient`
    INSERT INTO language (code, label, text_direction, is_enabled)
    VALUES ('ar', 'العربية', 'rtl', true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO bot_setting (display_name, currency, default_language_id, ask_for_language, support_category)
    VALUES ('Rabet Digital Services', 'USD', ${langEn.id}, true, ARRAY['Support', 'Billing']);
  `;

  const [cat] = await pgClient`
    INSERT INTO category (slug, sort_order, is_active)
    VALUES ('cloud-tools', 0, true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO category_translation (category_id, language_id, name)
    VALUES (${cat.id}, ${langEn.id}, 'Cloud Tools');
  `;
  await pgClient`
    INSERT INTO category_translation (category_id, language_id, name)
    VALUES (${cat.id}, ${langAr.id}, 'أدوات سحابية');
  `;

  const [prod] = await pgClient`
    INSERT INTO product (category_id, slug, price, sort_order, is_active)
    VALUES (${cat.id}, 'devops-license', '49.00', 0, true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO product_translation (product_id, language_id, name, details)
    VALUES (${prod.id}, ${langEn.id}, 'DevOps License Pro', 'Annual server license.');
  `;
  await pgClient`
    INSERT INTO product_translation (product_id, language_id, name, details)
    VALUES (${prod.id}, ${langAr.id}, 'رخصة ديف أوبس برو', 'ترخيص خادم سنوي.');
  `;
  log("Initial database seeded.");

  ownedTempDir = mkdtempSync(path.join(tmpdir(), "rabet-pm-acceptance-"));
  chmodSync(ownedTempDir, 0o700);

  const postgresModuleUrl = import.meta.resolve("postgres");
  const bootstrapFile = path.join(ownedTempDir, "neon-proxy-bootstrap.mjs");
  writeFileSync(
    bootstrapFile,
    `import postgres from "${postgresModuleUrl}";\n` +
      `const originalFetch = globalThis.fetch;\n` +
      `let pg = null;\n` +
      `globalThis.fetch = async (input, init) => {\n` +
      `  const url = typeof input === "string" ? input : (input ? input.url : "");\n` +
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
      `export NODE_ENV=production`,
      `export NODE_OPTIONS='--import ${bootstrapFile}'`,
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
  // STEP 1: MOBILE VIEWPORT (375x812) - PAYMENT METHODS MANAGER & ATOMIC SAVE
  // =========================================================================
  log("Step 1: Setting mobile viewport (375x812) and navigating to /payment-methods...");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 375,
    height: 812,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(500);

  await cdp.send("Page.navigate", { url: `${BASE_URL}/payment-methods` });
  await sleep(1500);

  await cdp.takeScreenshot("01_mobile_payment_methods_empty.png");

  // Open "Add Payment Method" modal
  log("Opening Add Payment Method modal on mobile...");
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="create-payment-method-btn"]').click();
  })()`);
  await sleep(800);

  // Fill in symmetrical drafts
  await setInputValue(cdp, '[data-testid="create-admin-label-input"]', "Vodafone Cash (Personal)");
  // Toggle enabled
  await cdp.evaluate(`(() => {
    const cb = document.querySelector('[data-testid="create-status-toggle"]');
    if (cb && !cb.checked) cb.click();
  })()`);

  // Fill English draft
  await setInputValue(cdp, '[data-testid="create-title-input"]', "Vodafone Cash Wallet");
  await setInputValue(
    cdp,
    '[data-testid="create-instructions-input"]',
    "Send payment to 01012345678 and provide transaction ID in chat."
  );

  // Switch to Arabic tab
  await cdp.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const arTab = buttons.find((b) => b.innerText.includes('AR') || b.innerText.includes('العربية'));
    if (arTab) arTab.click();
  })()`);
  await sleep(400);

  // Fill Arabic draft
  await setInputValue(cdp, '[data-testid="create-title-input"]', "فودافون كاش (محفظة شخصية)");
  await setInputValue(
    cdp,
    '[data-testid="create-instructions-input"]',
    "أرسل المبلغ إلى 01012345678 مع كتابة رقم المعاملة في الرسالة."
  );

  await cdp.takeScreenshot("02_mobile_payment_methods_create_modal_arabic.png");

  // Submit creation
  log("Submitting new payment method...");
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="submit-create-payment-method-btn"]').click();
  })()`);
  await sleep(1500);

  // Verify in PostgreSQL
  const [createdPm] = await pgClient`
    SELECT id, admin_label, is_active FROM payment_method WHERE admin_label = 'Vodafone Cash (Personal)'
  `;
  if (!createdPm) {
    await fail("Payment method was not inserted into database!");
  }
  const pmTranslations = await pgClient`
    SELECT pmt.title, pmt.instructions, l.code
    FROM payment_method_translation pmt
    JOIN language l ON l.id = pmt.language_id
    WHERE pmt.payment_method_id = ${createdPm.id}
  `;
  if (pmTranslations.length !== 2) {
    await fail(`Expected 2 translation rows, got ${pmTranslations.length}`);
  }
  log(`Payment method created in DB: id=${createdPm.id}, translations=${pmTranslations.length}`);

  await cdp.takeScreenshot("03_mobile_payment_methods_list_enabled.png");

  // Open Preview Modal
  log("Opening Customer Preview modal on mobile...");
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="preview-method-btn"]').click();
  })()`);
  await sleep(600);

  await cdp.takeScreenshot("04_mobile_customer_preview_modal.png");

  // Close preview modal
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('button[aria-label="Close preview"]');
    if (btn) btn.click();
  })()`);
  await sleep(500);

  // =========================================================================
  // STEP 2: DESKTOP VIEWPORT (1280x800) - BINDING TO TWO BUTTONS
  // =========================================================================
  log("Step 2: Switching to desktop viewport (1280x800) and navigating to /catalog...");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(500);

  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(1500);

  // Open Product Action Editor
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="product-buttons-btn-devops-license"]');
    if (btn) btn.click();
  })()`);
  await sleep(1000);

  // Create Button 1: PAYMENT_METHOD bound to Vodafone Cash
  log("Creating Button 1 (PAYMENT_METHOD bound to Vodafone Cash)...");
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="add-root-action-btn"]').click();
  })()`);
  await sleep(500);

  await setInputValue(cdp, '[data-testid="create-action-type-select"]', "PAYMENT_METHOD");
  await sleep(400);
  await setInputValue(cdp, '[data-testid="create-action-label-input"]', "Pay via Vodafone Cash");
  await setInputValue(cdp, '[data-testid="create-action-payment-method-select"]', createdPm.id);
  await sleep(300);

  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="submit-create-action-btn"]').click();
  })()`);
  await sleep(1500);

  // Create Button 2: PAYMENT_METHOD bound to the same method
  log("Creating Button 2 (Instant Mobile Payment bound to Vodafone Cash)...");
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="add-root-action-btn"]').click();
  })()`);
  await sleep(500);

  await setInputValue(cdp, '[data-testid="create-action-type-select"]', "PAYMENT_METHOD");
  await sleep(400);
  await setInputValue(cdp, '[data-testid="create-action-label-input"]', "Instant Mobile Wallet");
  await setInputValue(cdp, '[data-testid="create-action-payment-method-select"]', createdPm.id);
  await sleep(300);

  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="submit-create-action-btn"]').click();
  })()`);
  await sleep(1500);

  // Verify in PostgreSQL: two actions share the same payment_method_id
  const boundActions = await pgClient`
    SELECT id, action_type, payment_method_id FROM product_action
    WHERE payment_method_id = ${createdPm.id}
  `;
  if (boundActions.length !== 2) {
    await fail(`Expected 2 actions bound to payment method, found ${boundActions.length}`);
  }
  log(`Verified: 2 buttons bound to payment_method_id=${createdPm.id}`);

  // Select Button 1 to display its preview card
  await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('[data-testid="select-action-btn"]'));
    if (btns[0]) btns[0].click();
  })()`);
  await sleep(800);

  await cdp.takeScreenshot("05_desktop_catalog_button1_bound_preview.png");

  // =========================================================================
  // STEP 3: SIMULTANEOUS MULTILINGUAL EDIT & PROPAGATION VIA REFRESH
  // =========================================================================
  log("Step 3: Editing central payment method simultaneously in English and Arabic...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/payment-methods` });
  await sleep(1500);

  // Click edit button
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="edit-method-btn"]').click();
  })()`);
  await sleep(600);

  // Update English draft
  await setInputValue(cdp, '[data-testid="edit-admin-label-input"]', "Vodafone Cash (Corporate)");
  await setInputValue(cdp, '[data-testid="edit-title-input"]', "Vodafone Cash Corporate Gateway");
  await setInputValue(
    cdp,
    '[data-testid="edit-instructions-input"]',
    "Corporate hotline: Send payment to 01099999999 and input order invoice ID."
  );

  // Switch to Arabic tab in edit modal
  await cdp.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const arTab = buttons.find((b) => b.innerText.includes('AR') || b.innerText.includes('العربية'));
    if (arTab) arTab.click();
  })()`);
  await sleep(400);

  // Update Arabic draft
  await setInputValue(cdp, '[data-testid="edit-title-input"]', "فودافون كاش (بوابة الشركات)");
  await setInputValue(
    cdp,
    '[data-testid="edit-instructions-input"]',
    "بوابة الشركات: حول إلى 01099999999 وسجل رقم الفاتورة في الإشعار."
  );

  // Save Changes
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="submit-edit-payment-method-btn"]').click();
  })()`);
  await sleep(1500);

  // Verify in PostgreSQL that BOTH languages updated atomically
  const [updatedEn] = await pgClient`
    SELECT title, instructions FROM payment_method_translation
    WHERE payment_method_id = ${createdPm.id} AND language_id = ${langEn.id}
  `;
  const [updatedAr] = await pgClient`
    SELECT title, instructions FROM payment_method_translation
    WHERE payment_method_id = ${createdPm.id} AND language_id = ${langAr.id}
  `;
  if (!updatedEn?.title?.includes("Corporate") || !updatedAr?.title?.includes("الشركات")) {
    await fail("Simultaneous multilingual save did not commit both languages!");
  }
  log("Verified: Simultaneous multilingual save committed atomically to DB.");

  // Go to /catalog and test Refresh button
  log("Navigating to /catalog to test explicit Refresh button and preview propagation...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(1500);

  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="product-buttons-btn-devops-license"]');
    if (btn) btn.click();
  })()`);
  await sleep(1000);

  // Select Button 1
  await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('[data-testid="select-action-btn"]'));
    if (btns[0]) btns[0].click();
  })()`);
  await sleep(500);

  // Click Refresh button
  log("Clicking Refresh button in action editor...");
  await cdp.evaluate(`(() => {
    const refreshBtn = document.querySelector('[data-testid="refresh-payment-methods-btn"]');
    if (refreshBtn) refreshBtn.click();
  })()`);
  await sleep(1000);

  // Check preview card contains updated title
  const previewTextButton1 = await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-testid="payment-method-preview-card"]');
    return card ? card.innerText : '';
  })()`);
  if (!previewTextButton1.includes("Vodafone Cash Corporate Gateway")) {
    await fail(`Button 1 preview did not update after refresh: '${previewTextButton1}'`);
  }
  log("Button 1 preview reflects updated method title!");

  // Select Button 2
  await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('[data-testid="select-action-btn"]'));
    if (btns[1]) btns[1].click();
  })()`);
  await sleep(500);

  const previewTextButton2 = await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-testid="payment-method-preview-card"]');
    return card ? card.innerText : '';
  })()`);
  if (!previewTextButton2.includes("Vodafone Cash Corporate Gateway")) {
    await fail(`Button 2 preview did not update after refresh: '${previewTextButton2}'`);
  }
  log("Button 2 preview also reflects updated method title!");

  await cdp.takeScreenshot("06_desktop_propagation_button2_preview.png");

  // =========================================================================
  // STEP 4: DISABLING CENTRAL METHOD PRESERVES BUTTON REFERENCES
  // =========================================================================
  log("Step 4: Disabling central payment method and verifying bindings remain...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/payment-methods` });
  await sleep(1500);

  // Toggle active to disabled
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="toggle-active-btn"]').click();
  })()`);
  await sleep(1000);

  // Verify in PostgreSQL
  const [disabledPm] = await pgClient`
    SELECT is_active FROM payment_method WHERE id = ${createdPm.id}
  `;
  if (disabledPm?.is_active !== false) {
    await fail("Payment method is_active was not set to false!");
  }
  log("Central payment method disabled in DB.");

  // Go to /catalog
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(1500);

  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="product-buttons-btn-devops-license"]');
    if (btn) btn.click();
  })()`);
  await sleep(1000);

  // Select Button 1
  await cdp.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('[data-testid="select-action-btn"]'));
    if (btns[0]) btns[0].click();
  })()`);
  await sleep(500);

  // Click refresh
  await cdp.evaluate(`(() => {
    const refreshBtn = document.querySelector('[data-testid="refresh-payment-methods-btn"]');
    if (refreshBtn) refreshBtn.click();
  })()`);
  await sleep(1000);

  // Verify selection is still createdPm.id and shows (Disabled)
  const selectedOptionValue = await cdp.evaluate(`(() => {
    const sel = document.querySelector('[data-testid="edit-action-payment-method-select"]');
    return {
      value: sel ? sel.value : '',
      text: sel ? sel.options[sel.selectedIndex]?.text : '',
    };
  })()`);

  if (selectedOptionValue.value !== createdPm.id) {
    await fail(`Button 1 lost its payment method reference! Got: '${selectedOptionValue.value}'`);
  }
  if (!selectedOptionValue.text.includes("Disabled")) {
    await fail(`Select option does not reflect disabled status: '${selectedOptionValue.text}'`);
  }
  log(`Button binding preserved with disabled indicator: '${selectedOptionValue.text}'`);

  await cdp.takeScreenshot("07_desktop_disabled_method_retains_binding.png");

  // =========================================================================
  // STEP 5: ARABIC-DEFAULT STORE VIEWPORT (375x812 MOBILE)
  // =========================================================================
  log("Step 5: Testing Arabic-default store configuration on mobile viewport...");
  await pgClient`
    UPDATE bot_setting SET default_language_id = ${langAr.id}
  `;

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 375,
    height: 812,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(500);

  await cdp.send("Page.navigate", { url: `${BASE_URL}/payment-methods` });
  await sleep(1500);

  await cdp.takeScreenshot("08_mobile_arabic_default_view.png");
  log("Arabic default store layout captured on mobile viewport.");

  // =========================================================================
  // STEP 6: ONE-LANGUAGE EDIT / SAVE / REOPEN REGRESSION (NARROW MOBILE 360x740)
  // =========================================================================
  log("Step 6: Testing one-language edit/save/reopen regression on narrow mobile viewport (360x740)...");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 740,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(500);

  // Switch default back to English for standard single-language scenario
  await pgClient`UPDATE bot_setting SET default_language_id = ${langEn.id}`;

  await cdp.send("Page.navigate", { url: `${BASE_URL}/payment-methods` });
  await sleep(1500);

  // Create English-only payment method with Arabic untouched
  log("Creating English-only payment method with untouched optional Arabic tab...");
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="create-payment-method-btn"]').click();
  })()`);
  await sleep(800);

  await setInputValue(cdp, '[data-testid="create-admin-label-input"]', "Cash on Delivery");
  await setInputValue(cdp, '[data-testid="create-title-input"]', "Pay on Delivery");
  await setInputValue(cdp, '[data-testid="create-instructions-input"]', "Hand exact cash to courier upon arrival.");

  // Submit English-only creation
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="submit-create-payment-method-btn"]').click();
  })()`);
  await sleep(1500);

  // Edit English-only method: change admin label and title while Arabic tab remains untouched
  log("Editing English-only method: changing admin label and title while Arabic remains untouched...");
  await cdp.evaluate(`(() => {
    const editBtns = Array.from(document.querySelectorAll('[data-testid="edit-method-btn"]'));
    const lastBtn = editBtns[editBtns.length - 1];
    if (lastBtn) lastBtn.click();
  })()`);
  await sleep(800);

  await setInputValue(cdp, '[data-testid="edit-admin-label-input"]', "Cash on Delivery (Courier)");
  await setInputValue(cdp, '[data-testid="edit-title-input"]', "Cash on Delivery (Courier)");

  // Submit Save Changes
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="submit-edit-payment-method-btn"]').click();
  })()`);
  await sleep(1500);

  // Verify modal closed without INVALID_INPUT failure
  const isEditModalOpen = await cdp.evaluate(`(() => {
    return Boolean(document.querySelector('[data-testid="edit-payment-method-modal"]'));
  })()`);
  if (isEditModalOpen) {
    await fail("Edit modal remained open; one-language save was blocked by untouched optional tab!");
  }
  log("One-language save succeeded cleanly and modal closed.");

  // Reopen modal to verify saved single-language state
  log("Reopening the edit modal to verify persisted single-language state...");
  await cdp.evaluate(`(() => {
    const editBtns = Array.from(document.querySelectorAll('[data-testid="edit-method-btn"]'));
    const lastBtn = editBtns[editBtns.length - 1];
    if (lastBtn) lastBtn.click();
  })()`);
  await sleep(800);

  await cdp.takeScreenshot("09_mobile_one_language_save_reopen.png");
  log("Captured one-language save/reopen screenshot on narrow mobile viewport (360x740).");

  // Verify in PostgreSQL that only English translation exists
  const codMethodRows = await pgClient`
    SELECT id, admin_label FROM payment_method WHERE admin_label = 'Cash on Delivery (Courier)'
  `;
  if (codMethodRows.length === 0) {
    await fail("Payment method 'Cash on Delivery (Courier)' not found in DB!");
  }
  const codTransRows = await pgClient`
    SELECT pmt.title, l.code FROM payment_method_translation pmt
    JOIN language l ON l.id = pmt.language_id
    WHERE pmt.payment_method_id = ${codMethodRows[0].id}
  `;
  if (codTransRows.length !== 1 || codTransRows[0].code !== "en") {
    await fail(`Expected exactly 1 English translation row, got: ${JSON.stringify(codTransRows)}`);
  }
  log("Verified in DB: Exactly 1 English translation persisted, optional Arabic was untouched.");

  log("\n=======================================================");
  log("ALL PAYMENT METHOD ACCEPTANCE SCENARIOS PASSED!");
  log("=======================================================\n");

  await cdp.close();
  await cleanup();
}

main().catch(async (err) => {
  log(`Unexpected error: ${err.stack || err.message}`);
  await cleanup();
  process.exit(1);
});
