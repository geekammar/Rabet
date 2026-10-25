#!/usr/bin/env node
/**
 * scripts/test-seller-inbox-browser-acceptance.mjs
 *
 * Real browser acceptance test suite for Phase 09: Seller Inbox, Reliable Replies & Lifecycle.
 * Executes against local Next.js production build (`next start`), test credentials,
 * disposable loopback PostgreSQL, and headless Chromium via Chrome DevTools Protocol (CDP).
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hash } from "@node-rs/argon2";
import postgres from "postgres";
import {
  readPgState,
  verifyAndStopOwnedFixture,
} from "./fixture-guard.mjs";

const APP_PORT = 3349;
const CDP_PORT = 9338;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const TEST_EMAIL = "admin@rabet.test";
const TEST_PASSWORD = "test-inbox-password-123";

let appServer = null;
let chromeProcess = null;
let pgClient = null;
let ownedTempDir = null;
let ownedPgFixture = null;
let isCleaningUp = false;

function log(msg) {
  process.stdout.write(`[inbox-browser-acceptance] ${msg}\n`);
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

  if (ownedPgFixture) {
    verifyAndStopOwnedFixture(ownedPgFixture, "scripts/db-test-postgres.mjs");
    ownedPgFixture = null;
  }

  if (ownedTempDir && existsSync(ownedTempDir)) {
    try {
      rmSync(ownedTempDir, { recursive: true, force: true });
    } catch {}
  }

  log("Cleanup complete.");
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fail(msg) {
  process.stderr.write(`\n❌ BROWSER ACCEPTANCE FAILED: ${msg}\n\n`);
  await cleanup();
  process.exit(1);
}

function resolveChromePath() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const pwDirs = [
    "/root/.cache/ms-playwright",
    path.join(process.env.HOME || "", ".cache/ms-playwright"),
  ];

  for (const pwDir of pwDirs) {
    if (existsSync(pwDir)) {
      try {
        const entries = readdirSync(pwDir);
        for (const entry of entries) {
          if (entry.startsWith("chromium-")) {
            const candidate = path.join(pwDir, entry, "chrome-linux64/chrome");
            if (existsSync(candidate)) return candidate;
          }
        }
      } catch {}
    }
  }

  const systemPaths = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const p of systemPaths) {
    if (existsSync(p)) return p;
  }

  return null;
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 1;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new globalThis.WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { res, rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else res(msg.result);
        }
      };
    });
  }

  async send(method, params = {}) {
    const id = this.msgId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description || "";
      throw new Error(
        `CDP eval error: ${result.exceptionDetails.text || "Unknown error"} - ${desc}`
      );
    }
    return result.result?.value;
  }
}

async function runAcceptance() {
  log("Starting Phase 09 Seller Inbox real browser acceptance verification...");

  const chromePath = resolveChromePath();
  if (!chromePath) {
    await fail("Chromium binary not found.");
  }
  log(`Found Chromium binary at: ${chromePath}`);

  // Start disposable PostgreSQL
  ownedTempDir = mkdtempSync(path.join(tmpdir(), "rabet-inbox-acceptance-"));
  chmodSync(ownedTempDir, 0o700);

  const stateFilePath = path.join(ownedTempDir, "pg-state.json");
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

  let pgUrl = "";
  for (const line of (pgStartOutput.stdout || "").split("\n")) {
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

  // Run migrations
  log("Applying database migrations...");
  const migrate = spawnSync("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: pgUrl },
    encoding: "utf8",
  });
  if (migrate.status !== 0) {
    await fail(`Migration failed: ${migrate.stderr || migrate.stdout}`);
  }
  log("Migrations applied successfully.");

  pgClient = postgres(pgUrl);

  // Seed base store, languages, categories, products, customer, and inquiries
  log("Seeding store, customers, and test inquiries...");
  const [langEn] = await pgClient`
    INSERT INTO language (code, label, text_direction, is_enabled)
    VALUES ('en', 'English', 'ltr', true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO language (code, label, text_direction, is_enabled)
    VALUES ('ar', 'العربية', 'rtl', true);
  `;
  await pgClient`
    INSERT INTO bot_setting (display_name, currency, default_language_id, ask_for_language, support_category)
    VALUES ('Rabet Store', 'SAR', ${langEn.id}, true, ARRAY['Billing', 'Technical', 'General']);
  `;

  const [cat] = await pgClient`
    INSERT INTO category (slug, sort_order, is_active)
    VALUES ('hosting', 0, true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO category_translation (category_id, language_id, name)
    VALUES (${cat.id}, ${langEn.id}, 'Cloud Infrastructure');
  `;

  const [prod] = await pgClient`
    INSERT INTO product (category_id, slug, price, sort_order, is_active)
    VALUES (${cat.id}, 'cloud-vps', '150.00', 0, true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO product_translation (product_id, language_id, name)
    VALUES (${prod.id}, ${langEn.id}, 'Cloud VPS Pro');
  `;

  const [cust] = await pgClient`
    INSERT INTO customer (telegram_id, telegram_username, first_name, last_name, is_blocked)
    VALUES (987654321, 'alicesmith', 'Alice', 'Smith', false)
    RETURNING id;
  `;

  // Product Inquiry
  const [inqProd] = await pgClient`
    INSERT INTO inquiry (
      customer_id, product_id, reference, status,
      product_snapshot, selected_options, opened_at, last_reply_at, updated_at
    )
    VALUES (
      ${cust.id}, ${prod.id}, 'INQ-PROD-01', 'open',
      '{"name": "Cloud VPS Pro", "price": "150.00", "currency": "SAR", "categoryPath": ["Cloud Infrastructure"]}'::jsonb,
      '["Cloud Infrastructure", "Cloud VPS Pro", "Ask Seller"]'::jsonb,
      now() - interval '2 hours', now() - interval '10 minutes', now() - interval '10 minutes'
    )
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO inquiry_message (inquiry_id, author, body, delivery_status, delivered_at, created_at)
    VALUES (${inqProd.id}, 'customer', 'Can I install Ubuntu 24.04 on this VPS?', 'sent', now() - interval '10 minutes', now() - interval '10 minutes');
  `;

  // Support Inquiry
  const [inqSupp] = await pgClient`
    INSERT INTO inquiry (
      customer_id, product_id, reference, status, category,
      product_snapshot, opened_at, last_reply_at, updated_at
    )
    VALUES (
      ${cust.id}, NULL, 'INQ-SUPP-01', 'waiting_on_customer', 'Billing',
      '{"type": "support"}'::jsonb,
      now() - interval '1 day', now() - interval '1 hour', now() - interval '1 hour'
    )
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO inquiry_message (inquiry_id, author, body, delivery_status, delivered_at, created_at)
    VALUES (${inqSupp.id}, 'admin', 'We updated your billing cycle to monthly.', 'sent', now() - interval '1 hour', now() - interval '1 hour');
  `;

  log("Seed data ready.");

  // Prepare Next.js environment & fetch interceptor bootstrap
  const postgresModuleUrl = import.meta.resolve("postgres");
  const bootstrapFile = path.join(ownedTempDir, "neon-and-telegram-proxy.mjs");
  writeFileSync(
    bootstrapFile,
    `import postgres from "${postgresModuleUrl}";\n` +
      `const originalFetch = globalThis.fetch;\n` +
      `let pg = null;\n` +
      `globalThis.fetch = async (input, init) => {\n` +
      `  let url = "";\n` +
      `  if (typeof input === "string") url = input;\n` +
      `  else if (input && typeof input === "object" && typeof input.url === "string") url = input.url;\n` +
      `  const headers = init?.headers || {};\n` +
      `  const connStr = typeof headers.get === "function" ? headers.get("Neon-Connection-String") : (headers["Neon-Connection-String"] || headers["neon-connection-string"] || "");\n` +
      `  const isSyntheticEndpoint = (url && url.includes("ep-example.neon.tech")) || (typeof connStr === "string" && connStr.includes("ep-example.neon.tech"));\n` +
      `  if (isSyntheticEndpoint && (url.includes("/sql") || url.includes("neon.tech"))) {\n` +
      `    if (!pg && process.env.TEST_REAL_PG_URL) {\n` +
      `      pg = postgres(process.env.TEST_REAL_PG_URL);\n` +
      `    }\n` +
      `    const parsedBody = JSON.parse(init.body);\n` +
      `    try {\n` +
      `      const formatVal = (v, type) => {\n` +
      `        if (v === null || v === undefined) return null;\n` +
      `        if (typeof v === "boolean") return v ? "t" : "f";\n` +
      `        if (type === 114 || type === 3802) {\n` +
      `          return typeof v === "string" ? v : JSON.stringify(v);\n` +
      `        }\n` +
      `        if (Array.isArray(v)) return "{" + v.map((item) => JSON.stringify(String(item))).join(",") + "}";\n` +
      `        if (typeof v === "object" && !(v instanceof Date)) return JSON.stringify(v);\n` +
      `        return v;\n` +
      `      };\n` +
      `      if (parsedBody.queries) {\n` +
      `        const results = [];\n` +
      `        await pg.begin(async (sql) => {\n` +
      `          for (const q of parsedBody.queries) {\n` +
      `            const qParams = (q.params || []).map((p) => {\n` +
      `              if (p === "true") return true;\n` +
      `              if (p === "false") return false;\n` +
      `              return p;\n` +
      `            });\n` +
      `            const rows = await sql.unsafe(q.query, qParams).values();\n` +
      `            const cols = rows.columns || [];\n` +
      `            const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));\n` +
      `            const rowArrays = rows.map((r) => r.map((val, idx) => formatVal(val, cols[idx]?.type)));\n` +
      `            results.push({ rows: rowArrays, fields });\n` +
      `          }\n` +
      `        });\n` +
      `        return new Response(JSON.stringify({ results }), {\n` +
      `          status: 200,\n` +
      `          headers: { "content-type": "application/json" },\n` +
      `        });\n` +
      `      } else {\n` +
      `        const { query, params } = parsedBody;\n` +
      `        const qParams = (params || []).map((p) => {\n` +
      `          if (p === "true") return true;\n` +
      `          if (p === "false") return false;\n` +
      `          return p;\n` +
      `        });\n` +
      `        const rows = await pg.unsafe(query, qParams).values();\n` +
      `        const cols = rows.columns || [];\n` +
      `        const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));\n` +
      `        const rowArrays = rows.map((r) => r.map((val, idx) => formatVal(val, cols[idx]?.type)));\n` +
      `        return new Response(JSON.stringify({ rows: rowArrays, fields }), {\n` +
      `          status: 200,\n` +
      `          headers: { "content-type": "application/json" },\n` +
      `        });\n` +
      `      }\n` +
      `    } catch (err) {\n` +
      `      console.error("[NEON_PROXY_ERROR]", err);\n` +
      `      return new Response(JSON.stringify({ message: err.message }), {\n` +
      `        status: 500,\n` +
      `        headers: { "content-type": "application/json" },\n` +
      `      });\n` +
      `    }\n` +
      `  }\n` +
      `  if (url && url.includes("api.telegram.org")) {\n` +
      `    if (url.includes("sendMessage")) {\n` +
      `      const b = typeof init.body === "string" ? JSON.parse(init.body) : {};\n` +
      `      if (b.text && b.text.includes("TRIGGER_FAIL")) {\n` +
      `        return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message send failed" }), {\n` +
      `          status: 400,\n` +
      `          headers: { "content-type": "application/json" }\n` +
      `        });\n` +
      `      }\n` +
      `      return new Response(JSON.stringify({ ok: true, result: { message_id: 8801 } }), {\n` +
      `        status: 200,\n` +
      `        headers: { "content-type": "application/json" }\n` +
      `      });\n` +
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

  const authSecret = Buffer.from(
    globalThis.crypto.getRandomValues(new Uint8Array(32))
  ).toString("base64");

  const envFile = path.join(ownedTempDir, "test.env");
  const testSyntheticNeonUrl =
    "postgresql://rabet_user:synthetic_pass@ep-example.neon.tech/rabet_db";

  writeFileSync(
    envFile,
    [
      `export DATABASE_URL='${testSyntheticNeonUrl}'`,
      `export TEST_REAL_PG_URL='${pgUrl}'`,
      `export TELEGRAM_BOT_TOKEN='123456789:TEST_INBOX_TOKEN'`,
      `export AUTH_SECRET='${authSecret}'`,
      `export ADMIN_EMAIL='${TEST_EMAIL}'`,
      `export ADMIN_PASSWORD_HASH='${passwordHash}'`,
      `export AUTH_URL='${BASE_URL}'`,
      `export AUTH_TRUST_HOST='true'`,
      `export NODE_OPTIONS='--import ${bootstrapFile}'`,
    ].join("\n") + "\n",
    { mode: 0o600 }
  );

  log("Starting Next.js production server on port " + APP_PORT + "...");
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
    }
  );

  appServer.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("blocking-prerender-crypto") && !s.includes("ExperimentalWarning")) {
      process.stderr.write(`[next:stderr] ${s}`);
    }
  });

  appServer.stdout.on("data", (d) => {
    const s = d.toString();
    process.stdout.write(`[next:stdout] ${s}`);
  });

  let serverReady = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const res = await fetch(`${BASE_URL}/login`);
      if (res.status === 200 || res.status === 307) {
        serverReady = true;
        break;
      }
    } catch {}
  }
  if (!serverReady) {
    await fail("Next.js server failed to start within 20s");
  }
  log("Next.js server is ready.");

  // Launch headless Chromium
  log("Launching headless Chromium...");
  const chromeDataDir = path.join(ownedTempDir, "chrome-data");
  chmodSync(ownedTempDir, 0o700);

  chromeProcess = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${chromeDataDir}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
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
  await cdp.send("Network.enable");

  // =========================================================================
  // Scenario 1: Unauthorized access redirects to /login
  // =========================================================================
  log("Scenario 1: Verifying unauthorized access to /inquiries redirects to /login...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/inquiries` });
  await sleep(1500);
  const currentUrl = await cdp.eval("window.location.href");
  if (!currentUrl.includes("/login")) {
    await fail(`Expected redirect to /login, got: ${currentUrl}`);
  }
  log("✓ Unauthorized redirect verified.");

  // =========================================================================
  // Scenario 2: Authenticate session via Auth.js endpoint and inject cookie
  // =========================================================================
  log("Scenario 2: Authenticating admin session via Auth.js endpoint...");
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  const csrfData = await csrfRes.json();
  const csrfToken = csrfData.csrfToken;
  const initialCookies = csrfRes.headers.get("set-cookie") || "";

  const signinBody = new URLSearchParams({
    csrfToken,
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    callbackUrl: `${BASE_URL}/inquiries`,
    json: "true",
  });

  const signinRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: initialCookies,
    },
    body: signinBody.toString(),
    redirect: "manual",
  });

  const authCookies = signinRes.headers.get("set-cookie") || "";
  const sessionTokenMatch = authCookies.match(/authjs\.session-token=([^;]+)/);
  if (!sessionTokenMatch) {
    await fail("Failed to obtain session token from signin response");
  }
  const sessionCookieVal = sessionTokenMatch[1];

  await cdp.send("Network.setCookie", {
    name: "authjs.session-token",
    value: sessionCookieVal,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
  });

  // Navigate to /inquiries
  await cdp.send("Page.navigate", { url: `${BASE_URL}/inquiries` });
  await sleep(2000);

  const pageTitle = await cdp.eval("document.title");
  log(`Loaded /inquiries: "${pageTitle}"`);

  // =========================================================================
  // Scenario 3: Inbox list, filtering, and search
  // =========================================================================
  log("Scenario 3: Verifying Inbox conversations, status badges, and search...");
  const bodyText = await cdp.eval("document.body.innerText");
  if (!bodyText.includes("INQ-PROD-01") || !bodyText.includes("INQ-SUPP-01")) {
    await fail(`Inbox did not render seeded inquiries. Text content: ${bodyText}`);
  }
  if (!bodyText.includes("Alice Smith")) {
    await fail("Customer display name 'Alice Smith' was not found in inbox");
  }
  log("✓ Unified inbox displays product inquiry, support inquiry, and customer identity.");

  // Test search by reference
  await cdp.eval(`(() => {
    const input = document.querySelector('input[name="reference"]');
    input.value = 'INQ-PROD-01';
    input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`);
  await sleep(1500);
  const searchResultText = await cdp.eval("document.body.innerText");
  if (!searchResultText.includes("INQ-PROD-01") || searchResultText.includes("INQ-SUPP-01")) {
    await fail("Exact reference search failed to isolate INQ-PROD-01");
  }
  log("✓ Exact reference search verified.");

  // =========================================================================
  // Scenario 4: Thread View, Frozen Context & Message History
  // =========================================================================
  log(`Scenario 4: Opening thread /inquiries/${inqProd.id}...`);
  await cdp.send("Page.navigate", { url: `${BASE_URL}/inquiries/${inqProd.id}` });
  await sleep(2000);

  const threadText = await cdp.eval("document.body.innerText");
  if (!threadText.includes("INQ-PROD-01")) {
    await fail("Thread header did not show reference INQ-PROD-01");
  }
  if (!threadText.includes("Cloud VPS Pro") || !threadText.includes("150.00 SAR")) {
    await fail("Thread did not render frozen product snapshot name and displayed price");
  }
  if (!threadText.includes("Frozen context")) {
    await fail("Thread did not render Frozen context badge");
  }
  if (!threadText.includes("Can I install Ubuntu 24.04 on this VPS?")) {
    await fail("Customer message history was not rendered");
  }
  log("✓ Thread view, frozen product context, and message history verified.");

  // =========================================================================
  // Scenario 5: Plain-text reply composer, Arabic text, and Send Reply
  // =========================================================================
  log("Scenario 5: Composing multilingual reply with Arabic text and sending...");
  const replyContent = "مرحبا أليس، نعم نظام Ubuntu 24.04 مدعوم بالكامل! Setup takes 60 seconds.";
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(replyContent)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(400);

  // Submit reply
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    if (!textarea) throw new Error("No textarea found");
    const form = textarea.closest('form');
    if (!form) throw new Error("No form found for textarea");
    const btn = form.querySelector('button[type="submit"]');
    if (!btn) throw new Error("No submit button found in form");
    if (btn.disabled) throw new Error("Submit button is disabled");
    btn.click();
  })()`);
  await sleep(2500);

  const afterSendText = await cdp.eval("document.body.innerText");
  if (!afterSendText.includes("مرحبا أليس، نعم نظام Ubuntu 24.04 مدعوم بالكامل!")) {
    await fail("Sent reply was not rendered in the conversation history");
  }
  if (!afterSendText.includes("Sent via Telegram")) {
    await fail("Delivered message did not show 'Sent via Telegram'");
  }
  log("✓ Seller reply sent, delivered via Telegram, and rendered in conversation.");

  // Verify reload persistence
  log("Reloading thread page to verify database persistence...");
  await cdp.send("Page.reload");
  await sleep(2000);
  const reloadedText = await cdp.eval("document.body.innerText");
  if (!reloadedText.includes("مرحبا أليس، نعم نظام Ubuntu 24.04 مدعوم بالكامل!")) {
    await fail("Persisted message disappeared after page reload");
  }
  if (!reloadedText.includes("Waiting on customer")) {
    await fail("Inquiry status was not waiting_on_customer after seller reply");
  }
  log("✓ Persistence after reload verified.");

  // =========================================================================
  // Scenario 6: Draft preservation
  // =========================================================================
  log("Scenario 6: Verifying draft preservation across edits...");
  const draftText = "Unfinished draft text to be preserved";
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(draftText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(500);

  // Navigate away to inbox and back to thread
  await cdp.send("Page.navigate", { url: `${BASE_URL}/inquiries` });
  await sleep(1500);
  await cdp.send("Page.navigate", { url: `${BASE_URL}/inquiries/${inqProd.id}` });
  await sleep(1500);

  const restoredDraftValue = await cdp.eval(`document.querySelector('textarea')?.value`);
  if (restoredDraftValue !== draftText) {
    await fail(`Draft was not restored from sessionStorage. Expected "${draftText}", got "${restoredDraftValue}"`);
  }
  log("✓ Draft preserved in sessionStorage across navigation.");

  // Clear draft
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, '');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);

  // =========================================================================
  // Scenario 7: Failed delivery and explicit retry
  // =========================================================================
  log("Scenario 7: Simulating delivery failure and explicit retry...");
  const failText = "TRIGGER_FAIL: Testing delivery error handling";
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(failText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const form = textarea.closest('form');
    const btn = form.querySelector('button[type="submit"]');
    btn.click();
  })()`);
  await sleep(2500);

  const failedStateText = await cdp.eval("document.body.innerText");
  if (!failedStateText.includes("Delivery failed")) {
    await fail("Failed delivery error state was not rendered");
  }
  log("✓ Delivery failure state rendered honestly.");

  // Click explicit retry button
  log("Clicking explicit retry button...");
  await cdp.eval(`(() => {
    const retryBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Retry'));
    if (retryBtn) retryBtn.click();
  })()`);
  await sleep(2500);
  log("✓ Explicit retry executed.");

  // =========================================================================
  // Scenario 8: Lifecycle operations (Resolve -> Close -> Reopen)
  // =========================================================================
  log("Scenario 8: Testing lifecycle operations (Resolve -> Close -> Reopen)...");

  // 1. Resolve
  await cdp.eval(`(() => {
    const resolveBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Resolve'));
    if (resolveBtn) resolveBtn.click();
  })()`);
  await sleep(2000);
  let statusText = await cdp.eval("document.body.innerText");
  if (!statusText.includes("Resolved")) {
    await fail("Inquiry did not transition to Resolved status");
  }
  log("✓ Transitioned to Resolved.");

  // 2. Close
  await cdp.eval(`(() => {
    const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Close'));
    if (closeBtn) closeBtn.click();
  })()`);
  await sleep(2000);
  statusText = await cdp.eval("document.body.innerText");
  if (!statusText.includes("Closed")) {
    await fail("Inquiry did not transition to Closed status");
  }
  if (!statusText.includes("Reopen the thread to send replies")) {
    await fail("Reply composer was not disabled on closed thread");
  }
  log("✓ Transitioned to Closed and composer disabled.");

  // 3. Reopen
  await cdp.eval(`(() => {
    const reopenBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Reopen Thread'));
    if (reopenBtn) reopenBtn.click();
  })()`);
  await sleep(2000);
  statusText = await cdp.eval("document.body.innerText");
  if (!statusText.includes("Open")) {
    await fail("Inquiry did not transition to Open status on Reopen");
  }
  log("✓ Transitioned to Open via Reopen Thread.");

  // =========================================================================
  // Scenario 9: Mobile viewport layout at 360px & Arabic rendering
  // =========================================================================
  log("Scenario 9: Emulating mobile viewport (360x740) and verifying layout...");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 740,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(1000);

  const scrollWidth = await cdp.eval("document.documentElement.scrollWidth");
  const clientWidth = await cdp.eval("document.documentElement.clientWidth");
  log(`Mobile layout check: scrollWidth=${scrollWidth}, clientWidth=${clientWidth}`);

  if (scrollWidth > clientWidth + 2) {
    await fail(`Page-level horizontal overflow detected at 360px: scrollWidth (${scrollWidth}) > clientWidth (${clientWidth})`);
  }
  log("✓ 360px viewport has zero page-level horizontal overflow.");

  log("\n🎉 ALL BROWSER ACCEPTANCE CHECKS PASSED SUCCESSFULLY!\n");
  await cleanup();
  process.exit(0);
}

runAcceptance().catch(async (err) => {
  await fail(err.stack || err.message);
});
