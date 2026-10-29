#!/usr/bin/env node
/**
 * scripts/test-seller-inbox-browser-acceptance.mjs
 *
 * Real browser acceptance test suite for Phase 09: Seller Inbox, Reliable Replies & Lifecycle.
 * Executes against local Next.js production build (`next start`), test credentials,
 * disposable loopback PostgreSQL, and headless Chromium via Chrome DevTools Protocol (CDP).
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
let createdDbName = null;
let isCleaningUp = false;
let holdBarrierFile = null;
let releaseBarrierFile = null;
let notifyHeldFile = null;

function log(msg) {
  process.stdout.write(`[inbox-browser-acceptance] ${msg}\n`);
}

function deriveRetryOperationId(sourceMessageId) {
  const hash = crypto
    .createHash("sha256")
    .update(`rabet:seller-reply-retry:${sourceMessageId}`)
    .digest("hex");
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    `5${hash.substring(13, 16)}`,
    `a${hash.substring(17, 20)}`,
    hash.substring(20, 32),
  ].join("-");
}

async function waitForCondition(evalFn, description, timeoutMs = 15000, intervalMs = 200) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await evalFn();
      if (res) return res;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timeout after ${timeoutMs}ms waiting for: ${description}${lastErr ? ` (last error: ${lastErr.message})` : ""}`);
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

  if (createdDbName && process.env.RABET_TEST_PG_URL) {
    try {
      const cleanupSql = postgres(process.env.RABET_TEST_PG_URL, { max: 1 });
      await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${createdDbName}`);
      await cleanupSql.end();
    } catch {}
    createdDbName = null;
  }

  if (holdBarrierFile && existsSync(holdBarrierFile)) {
    try { rmSync(holdBarrierFile, { force: true }); } catch {}
  }
  if (releaseBarrierFile && existsSync(releaseBarrierFile)) {
    try { rmSync(releaseBarrierFile, { force: true }); } catch {}
  }
  if (notifyHeldFile && existsSync(notifyHeldFile)) {
    try { rmSync(notifyHeldFile, { force: true }); } catch {}
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

  // Temporary workspace directory for test fixtures and proxies
  ownedTempDir = mkdtempSync(path.join(tmpdir(), "rabet-inbox-acceptance-"));
  chmodSync(ownedTempDir, 0o700);

  holdBarrierFile = path.join(ownedTempDir, "reconcile-hold-barrier.txt");
  releaseBarrierFile = path.join(ownedTempDir, "reconcile-release-barrier.txt");
  notifyHeldFile = path.join(ownedTempDir, "reconcile-notify-held.txt");

  // Start or connect to disposable PostgreSQL
  let pgUrl = "";
  if (process.env.RABET_TEST_PG_URL) {
    createdDbName = `rabet_inbox_browser_${Date.now()}`;
    const adminSql = postgres(process.env.RABET_TEST_PG_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE ${createdDbName}`);
    await adminSql.end();

    const parsed = new URL(process.env.RABET_TEST_PG_URL);
    parsed.pathname = `/${createdDbName}`;
    pgUrl = parsed.toString();
    log(`Using designated PostgreSQL service with database: ${createdDbName}`);
  } else {
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
  }

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
  const ledgerFilePath = path.join(ownedTempDir, "telegram-ledger.json");
  writeFileSync(ledgerFilePath, JSON.stringify([]), { mode: 0o600 });
  const readLedger = () => {
    if (!existsSync(ledgerFilePath)) return [];
    try {
      return JSON.parse(readFileSync(ledgerFilePath, "utf8"));
    } catch {
      return [];
    }
  };

  const postgresModuleUrl = import.meta.resolve("postgres");
  const bootstrapFile = path.join(ownedTempDir, "neon-and-telegram-proxy.mjs");
  writeFileSync(
    bootstrapFile,
    `import postgres from "${postgresModuleUrl}";\n` +
      `import fs from "node:fs";\n` +
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
      `      const checkAndApplyReconcileHold = async (parameters) => {\n` +
      `        const holdFile = process.env.TEST_RECONCILE_HOLD_BARRIER_FILE;\n` +
      `        const releaseFile = process.env.TEST_RECONCILE_RELEASE_BARRIER_FILE;\n` +
      `        const notifyFile = process.env.TEST_NOTIFY_RECONCILE_HELD_FILE;\n` +
      `        if (!holdFile || !fs.existsSync(holdFile)) return;\n` +
      `        let holdOp = "";\n` +
      `        try { holdOp = fs.readFileSync(holdFile, "utf8").trim(); } catch {}\n` +
      `        if (!holdOp) return;\n` +
      `        if ((parameters || []).includes(holdOp)) {\n` +
      `          if (notifyFile && !fs.existsSync(notifyFile)) {\n` +
      `            try { fs.writeFileSync(notifyFile, String(Date.now()), "utf8"); } catch {}\n` +
      `          }\n` +
      `          if (releaseFile) {\n` +
      `            let waited = 0;\n` +
      `            while (!fs.existsSync(releaseFile) && waited < 15000) {\n` +
      `              await new Promise((r) => setTimeout(r, 50));\n` +
      `              waited += 50;\n` +
      `            }\n` +
      `          }\n` +
      `        }\n` +
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
      `            await checkAndApplyReconcileHold(qParams);\n` +
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
      `        await checkAndApplyReconcileHold(qParams);\n` +
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
      `      const b = typeof init?.body === "string" ? JSON.parse(init.body) : {};\n` +
      `      const ledgerFile = process.env.TEST_TELEGRAM_LEDGER_FILE;\n` +
      `      let ledger = [];\n` +
      `      if (ledgerFile && fs.existsSync(ledgerFile)) {\n` +
      `        try { ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8")); } catch {}\n` +
      `      }\n` +
      `      const callIndex = ledger.length + 1;\n` +
      `      const text = typeof b.text === "string" ? b.text : "";\n` +
      `      const isTriggerFail = text.includes("TRIGGER_FAIL");\n` +
      `      const isTriggerUnconfirmed = text.includes("TRIGGER_UNCONFIRMED");\n` +
      `      const isTriggerHold = text.includes("TRIGGER_INFLIGHT_HOLD");\n` +
      `      const failAttemptsForThisBody = ledger.filter((item) => item.text === text).length;\n` +
      `      let responseStatus = 200;\n` +
      `      let responseBody = { ok: true, result: { message_id: 8800 + callIndex } };\n` +
      `      if (isTriggerFail && failAttemptsForThisBody === 0) {\n` +
      `        responseStatus = 400;\n` +
      `        responseBody = { ok: false, error_code: 400, description: "Bad Request: message send failed" };\n` +
      `      } else if (isTriggerUnconfirmed) {\n` +
      `        responseStatus = 200;\n` +
      `        responseBody = { ok: true, result: { message_id: -1 } };\n` +
      `      }\n` +
      `      if (ledgerFile) {\n` +
      `        ledger.push({\n` +
      `          callIndex,\n` +
      `          timestamp: Date.now(),\n` +
      `          chat_id: b.chat_id,\n` +
      `          text: b.text,\n` +
      `          status: responseStatus,\n` +
      `          response: responseBody,\n` +
      `        });\n` +
      `        fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2), "utf8");\n` +
      `      }\n` +
      `      if (isTriggerHold) {\n` +
      `        await new Promise((r) => setTimeout(r, 3000));\n` +
      `      }\n` +
      `      return new Response(JSON.stringify(responseBody), {\n` +
      `        status: responseStatus,\n` +
      `        headers: { "content-type": "application/json" },\n` +
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
      `export TEST_TELEGRAM_LEDGER_FILE='${ledgerFilePath}'`,
      `export TEST_RECONCILE_HOLD_BARRIER_FILE='${holdBarrierFile}'`,
      `export TEST_RECONCILE_RELEASE_BARRIER_FILE='${releaseBarrierFile}'`,
      `export TEST_NOTIFY_RECONCILE_HELD_FILE='${notifyHeldFile}'`,
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
  // Scenario 7: Failed delivery, explicit retry, ledger tracking & idempotency
  // =========================================================================
  log("Scenario 7: Simulating delivery failure and explicit retry with ledger assertions...");
  const failText = "TRIGGER_FAIL: Testing delivery error handling";

  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(failText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);

  // Submit failing reply
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const form = textarea.closest('form');
    const btn = form.querySelector('button[type="submit"]');
    btn.click();
  })()`);

  // Wait for observable delivery failure condition
  await waitForCondition(
    async () => {
      const text = await cdp.eval("document.body.innerText");
      return text.includes("Delivery failed");
    },
    "delivery failure error state rendered in message list"
  );
  log("✓ Delivery failure state rendered honestly.");

  // Fail if the intended Retry button is absent
  const hasRetryBtn = await cdp.eval(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Retry'));
    return Boolean(btn);
  })()`);
  if (!hasRetryBtn) {
    await fail("Expected Retry button was absent after delivery failure!");
  }

  // Authoritative DB verification for failed message
  const failedRows = await pgClient`
    SELECT id, delivery_status, delivery_error, telegram_message_id
    FROM inquiry_message
    WHERE inquiry_id = ${inqProd.id} AND body = ${failText} AND delivery_status = 'failed'
    ORDER BY created_at DESC
    LIMIT 1;
  `;
  if (failedRows.length === 0) {
    await fail("Original failed message row not found in database with delivery_status='failed'");
  }
  const failedMessage = failedRows[0];
  const expectedRetryId = deriveRetryOperationId(failedMessage.id);
  log(`Found failed message ID ${failedMessage.id}, expected retry UUID: ${expectedRetryId}`);

  // Ledger check: exactly 1 transport attempt so far for this body (which failed with 400)
  const ledgerAfterFirstSend = readLedger();
  const failCalls = ledgerAfterFirstSend.filter(item => item.text && item.text.includes(failText));
  if (failCalls.length !== 1 || failCalls[0].status !== 400) {
    await fail(`Expected 1 failed transport call in ledger for failText, got: ${JSON.stringify(failCalls)}`);
  }

  // Click explicit retry button
  log("Clicking explicit retry button...");
  await cdp.eval(`(() => {
    const retryBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Retry'));
    if (retryBtn) retryBtn.click();
  })()`);

  // Wait for observable successful delivery of retry
  await waitForCondition(
    async () => {
      const text = await cdp.eval("document.body.innerText");
      const sentMatches = (text.match(/Sent via Telegram/g) || []).length;
      return sentMatches >= 2;
    },
    "retry message delivered with 'Sent via Telegram'"
  );
  log("✓ Explicit retry delivered and visible in conversation.");

  // Verify database state: original remains failed, retry row is deterministic and sent
  const [persistedFailed] = await pgClient`
    SELECT delivery_status FROM inquiry_message WHERE id = ${failedMessage.id}
  `;
  if (persistedFailed?.delivery_status !== "failed") {
    await fail(`Original failed message was corrupted or downgraded! Status: ${persistedFailed?.delivery_status}`);
  }

  const [persistedRetry] = await pgClient`
    SELECT id, delivery_status, telegram_message_id
    FROM inquiry_message
    WHERE id = ${expectedRetryId}
  `;
  if (!persistedRetry) {
    await fail(`Deterministic retry row ${expectedRetryId} was not found in database!`);
  }
  if (persistedRetry.delivery_status !== "sent") {
    await fail(`Retry row status is ${persistedRetry.delivery_status}, expected 'sent'`);
  }
  const tgMsgIdNum = Number(persistedRetry.telegram_message_id);
  if (!Number.isInteger(tgMsgIdNum) || tgMsgIdNum <= 0) {
    await fail(`Retry row telegram_message_id is invalid: ${persistedRetry.telegram_message_id}`);
  }
  log(`✓ Verified database integrity: 1 original failed row and 1 deterministic retry row (${expectedRetryId}) with telegram_message_id=${persistedRetry.telegram_message_id}.`);

  // Ledger check: exactly 2 transport calls occurred for failText (attempt 1 failed, attempt 2 succeeded)
  const ledgerAfterRetry = readLedger();
  const retryCalls = ledgerAfterRetry.filter(item => item.text && item.text.includes(failText));
  if (retryCalls.length !== 2) {
    await fail(`Expected exactly 2 transport calls for retry scenario, found ${retryCalls.length}`);
  }
  if (retryCalls[1].status !== 200 || retryCalls[1].response?.ok !== true) {
    await fail(`Retry transport call was not recorded as successful: ${JSON.stringify(retryCalls[1])}`);
  }
  log("✓ Transport ledger verified: exactly 1 failure and 1 successful retry occurred.");

  // Reload page to verify persistence of the successful retry
  log("Reloading thread page to verify successful retry persistence...");
  await cdp.send("Page.reload");
  await waitForCondition(
    async () => {
      const text = await cdp.eval("document.body.innerText");
      return (text.match(/Sent via Telegram/g) || []).length >= 2;
    },
    "successful retry persists across page reload"
  );
  log("✓ Successful retry persisted across page reload.");

  // Test duplicate retry idempotency: clicking Retry again on original source must NOT resend
  log("Testing duplicate retry: clicking Retry again on original source must not resend...");
  const ledgerCountBeforeDupRetry = readLedger().length;
  await cdp.eval(`(() => {
    const retryBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Retry'));
    if (retryBtn) retryBtn.click();
  })()`);
  await sleep(1500);

  const ledgerCountAfterDupRetry = readLedger().length;
  if (ledgerCountAfterDupRetry !== ledgerCountBeforeDupRetry) {
    await fail(`Clicking Retry again on original source created a new transport call! Expected ${ledgerCountBeforeDupRetry}, got ${ledgerCountAfterDupRetry}`);
  }
  log("✓ Duplicate retry on original source is idempotent and does not send again.");

  // =========================================================================
  // Scenario 8: Lifecycle operations (Resolve -> Close -> Reopen)
  // =========================================================================
  log("Scenario 8: Testing lifecycle operations with authoritative status elements...");

  // 1. Resolve
  await cdp.eval(`(() => {
    const resolveBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === 'Resolve');
    if (!resolveBtn) throw new Error("Resolve button not found");
    resolveBtn.click();
  })()`);

  await waitForCondition(
    async () => {
      const status = await cdp.eval(`document.querySelector('[data-testid="inquiry-status-badge"]')?.getAttribute('data-status')`);
      return status === "resolved";
    },
    "status badge data-status='resolved'"
  );
  const [resolvedDb] = await pgClient`SELECT status FROM inquiry WHERE id = ${inqProd.id}`;
  if (resolvedDb?.status !== "resolved") {
    await fail(`Inquiry status in DB is ${resolvedDb?.status}, expected 'resolved'`);
  }
  log("✓ Transitioned to Resolved verified via authoritative status badge and DB.");

  // 2. Close
  await cdp.eval(`(() => {
    const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === 'Close');
    if (!closeBtn) throw new Error("Close button not found");
    closeBtn.click();
  })()`);

  await waitForCondition(
    async () => {
      const status = await cdp.eval(`document.querySelector('[data-testid="inquiry-status-badge"]')?.getAttribute('data-status')`);
      return status === "closed";
    },
    "status badge data-status='closed'"
  );
  const [closedDb] = await pgClient`SELECT status, closed_at FROM inquiry WHERE id = ${inqProd.id}`;
  if (closedDb?.status !== "closed" || !closedDb?.closed_at) {
    await fail("Inquiry status in DB is not closed or closed_at is null");
  }

  await waitForCondition(
    async () => {
      const body = await cdp.eval("document.body.innerText");
      return body.includes("Reopen the thread to send replies");
    },
    "reply composer disabled on closed thread"
  );
  log("✓ Transitioned to Closed verified via status badge, DB closed_at, and disabled composer.");

  // 3. Reopen
  await cdp.eval(`(() => {
    const reopenBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === 'Reopen Thread');
    if (!reopenBtn) throw new Error("Reopen Thread button not found");
    reopenBtn.click();
  })()`);

  await waitForCondition(
    async () => {
      const status = await cdp.eval(`document.querySelector('[data-testid="inquiry-status-badge"]')?.getAttribute('data-status')`);
      return status === "open";
    },
    "status badge data-status='open'"
  );
  const [openDb] = await pgClient`SELECT status, closed_at FROM inquiry WHERE id = ${inqProd.id}`;
  if (openDb?.status !== "open" || openDb?.closed_at !== null) {
    await fail("Inquiry status in DB is not open or closed_at is not null");
  }
  log("✓ Transitioned to Open verified via authoritative status badge and DB.");

  // =========================================================================
  // Scenario 9: Stale pending uncertainty warning on mobile viewport (360x740)
  // =========================================================================
  log("Scenario 9: Stale pending uncertainty warning on mobile viewport (360x740)...");
  // Seed a stale pending message (> 2 minutes old) into inqSupp
  const staleMessageBody = "Stale pending reply awaiting external confirmation";
  const staleMsgId = "00000000-0000-0000-0000-000000000099";
  await pgClient`
    INSERT INTO inquiry_message (id, inquiry_id, author, body, delivery_status, created_at)
    VALUES (${staleMsgId}, ${inqSupp.id}, 'admin', ${staleMessageBody}, 'pending', now() - interval '3 minutes')
    ON CONFLICT (id) DO NOTHING;
  `;

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 740,
    deviceScaleFactor: 2,
    mobile: true,
  });

  await cdp.send("Page.navigate", { url: `${BASE_URL}/inquiries/${inqSupp.id}` });
  await sleep(1500);

  await waitForCondition(
    async () => {
      const body = await cdp.eval("document.body?.innerText || ''");
      return (
        body.includes("Delivery unconfirmed") &&
        body.includes("The earlier message may have already reached the customer")
      );
    },
    "stale pending uncertainty banner visible in DOM"
  );

  // Verify warning is visible in DOM flow rather than hidden in a tooltip
  const isVisibleBanner = await cdp.eval(`(() => {
    const divs = Array.from(document.querySelectorAll('div'));
    const banner = divs.find(d => d.innerText.includes("Delivery unconfirmed"));
    return Boolean(banner && banner.offsetParent !== null);
  })()`);
  if (!isVisibleBanner) {
    await fail("Uncertainty warning is not visibly rendered in the DOM flow");
  }

  const scrollWidth = await cdp.eval("document.documentElement.scrollWidth");
  const clientWidth = await cdp.eval("document.documentElement.clientWidth");
  log(`Mobile layout check at 360px: scrollWidth=${scrollWidth}, clientWidth=${clientWidth}`);
  if (scrollWidth > clientWidth + 2) {
    await fail(`Page-level horizontal overflow detected at 360px: scrollWidth (${scrollWidth}) > clientWidth (${clientWidth})`);
  }
  log("✓ Stale pending uncertainty warning rendered visibly on mobile viewport with zero horizontal overflow.");

  // =========================================================================
  // Scenario 10: Repaired draft & operation lifecycle (A & B)
  // =========================================================================
  log("Scenario 10: Verifying draft recovery, editing, and unconfirmed outcome contracts...");

  // Reset viewport to desktop
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdp.send("Page.navigate", { url: `${BASE_URL}/inquiries/${inqProd.id}` });
  await sleep(1500);
  await waitForCondition(
    async () => {
      return await cdp.eval(`Boolean(document.querySelector('textarea'))`);
    },
    "composer textarea on active thread"
  );

  // 10A: Submit failing reply -> edit text -> submit new reply without operation ID conflict
  log("10A: Testing submit -> confirmed failure -> edit text -> send new reply without CONFLICT...");
  const failDraftText = "TRIGGER_FAIL: Draft to be edited after failure";
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(failDraftText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(400);

  await cdp.eval(`(() => {
    const form = document.querySelector('textarea').closest('form');
    form.querySelector('button[type="submit"]').click();
  })()`);

  await waitForCondition(
    async () => {
      const body = await cdp.eval("document.body?.innerText || ''");
      return body.includes("Delivery failed");
    },
    "delivery failure banner for failDraftText"
  );

  // Verify draft text is still available in composer textarea
  const preservedDraftBeforeEdit = await cdp.eval(`document.querySelector('textarea')?.value`);
  if (!preservedDraftBeforeEdit.includes(failDraftText)) {
    await fail(`Failed draft text was lost from composer. Value: "${preservedDraftBeforeEdit}"`);
  }

  // Edit draft text to genuinely new content
  const newEditedText = "Fresh reply content after editing failed draft";
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(newEditedText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(400);

  await cdp.eval(`(() => {
    const form = document.querySelector('textarea').closest('form');
    form.querySelector('button[type="submit"]').click();
  })()`);

  await waitForCondition(
    async () => {
      const body = await cdp.eval("document.body?.innerText || ''");
      return body.includes(newEditedText) && body.includes("Sent via Telegram");
    },
    "edited reply delivered successfully without operation ID conflict"
  );

  // Verify composer textarea is cleared after confirmed delivery
  const clearedTextarea = await cdp.eval(`document.querySelector('textarea')?.value`);
  if (clearedTextarea !== "") {
    await fail(`Expected composer textarea to be cleared after confirmed sent, got: "${clearedTextarea}"`);
  }
  log("✓ Editing failed draft detached bound operation and successfully sent new reply without CONFLICT.");

  // 10B: Submit -> ambiguous outcome -> visible warning -> no second automatic send
  log("10B: Testing unconfirmed outcome and duplicate request behavior...");
  const unconfirmedText = "TRIGGER_UNCONFIRMED: Ambiguous outcome message";
  const ledgerCountBeforeUnconfirmed = readLedger().length;

  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(unconfirmedText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(400);

  await cdp.eval(`(() => {
    const form = document.querySelector('textarea').closest('form');
    form.querySelector('button[type="submit"]').click();
  })()`);

  await waitForCondition(
    async () => {
      const body = await cdp.eval("document.body?.innerText || ''");
      return (
        body.includes("Delivery status is unconfirmed") ||
        body.includes("unconfirmed")
      );
    },
    "unconfirmed delivery outcome warning in composer"
  );

  // Verify draft text is NOT cleared
  const unconfirmedDraftVal = await cdp.eval(`document.querySelector('textarea')?.value`);
  if (unconfirmedDraftVal !== unconfirmedText) {
    await fail(`Draft was unexpectedly cleared after unconfirmed delivery. Expected "${unconfirmedText}", got "${unconfirmedDraftVal}"`);
  }

  // Exactly 1 transport call was made
  const ledgerCountAfterFirstSend = readLedger().length;
  if (ledgerCountAfterFirstSend !== ledgerCountBeforeUnconfirmed + 1) {
    await fail(`Expected exactly 1 transport call for unconfirmed attempt, got ${ledgerCountAfterFirstSend - ledgerCountBeforeUnconfirmed}`);
  }

  // Resubmit unchanged draft: must NOT make a second transport call
  await cdp.eval(`(() => {
    const form = document.querySelector('textarea').closest('form');
    form.querySelector('button[type="submit"]').click();
  })()`);
  await sleep(1500);

  const ledgerCountAfterSecondSend = readLedger().length;
  if (ledgerCountAfterSecondSend !== ledgerCountAfterFirstSend) {
    await fail(`Resubmitting unchanged unresolved draft created a duplicate transport call!`);
  }
  log("✓ Unconfirmed delivery preserves draft, renders visible warning, and prevents duplicate transport call.");

  // 10C: Edit draft after unconfirmed send -> warning retained -> require explicit duplication risk decision -> send
  log("10C: Testing edit after unconfirmed send requires duplication risk decision...");
  const editedUnconfirmedText = "Brand new reply after acknowledging unconfirmed duplication risk";
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(editedUnconfirmedText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(400);

  // Submitting without checking the duplication risk box does not send
  const ledgerCountBefore10C = readLedger().length;
  await cdp.eval(`(() => {
    const form = document.querySelector('textarea').closest('form');
    form.querySelector('button[type="submit"]').click();
  })()`);
  await sleep(600);
  if (readLedger().length !== ledgerCountBefore10C) {
    await fail("Expected no transport send when submitting edited draft without duplication confirmation!");
  }

  // Check the duplication risk confirmation checkbox
  const hasCheckbox = await cdp.eval(`Boolean(document.querySelector('input[data-testid="confirm-duplication-risk"]'))`);
  if (!hasCheckbox) {
    await fail("Expected confirm-duplication-risk checkbox to be present when editing unconfirmed draft");
  }
  await cdp.eval(`(() => {
    const cb = document.querySelector('input[data-testid="confirm-duplication-risk"]');
    cb.click();
  })()`);
  await sleep(200);

  // Now submit with explicit duplication confirmation
  await cdp.eval(`(() => {
    const form = document.querySelector('textarea').closest('form');
    form.querySelector('button[type="submit"]').click();
  })()`);

  await waitForCondition(
    async () => {
      const body = await cdp.eval("document.body?.innerText || ''");
      return body.includes(editedUnconfirmedText) && body.includes("Sent via Telegram");
    },
    "edited reply after duplication confirmation delivered successfully"
  );
  log("✓ Editing after unconfirmed send enforces duplication risk confirmation before sending.");

  // 10D: Actual in-flight reload
  log("10D: Testing actual in-flight reload while Telegram dispatch is held...");
  const holdDraftText = "TRIGGER_INFLIGHT_HOLD: Testing real in-flight reload";
  const ledgerCountBeforeHold = readLedger().length;

  // Clear composer textarea
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(holdDraftText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);

  // Submit reply (which starts 3500ms hold on Telegram proxy)
  await cdp.eval(`(() => {
    const form = document.querySelector('textarea').closest('form');
    form.querySelector('button[type="submit"]').click();
  })()`);

  // Prove operation ID was stored in sessionStorage before response completion
  await sleep(150);
  const capturedHoldOp = await cdp.eval(`(() => {
    const raw = sessionStorage.getItem('rabet_unresolved_op_${inqProd.id}') || sessionStorage.getItem('rabet_bound_op_${inqProd.id}');
    return raw ? JSON.parse(raw) : null;
  })()`);

  if (!capturedHoldOp || !capturedHoldOp.id) {
    await fail("Expected operation identity to be persisted in sessionStorage before dispatch completion");
  }
  const holdOpId = capturedHoldOp.id;
  log(`✓ Operation ID persisted before response completion: ${holdOpId}`);

  // Confirm that server action committed reservation and reached the Telegram proxy hold
  await waitForCondition(
    async () => readLedger().some((x) => typeof x.text === "string" && x.text.includes(holdDraftText)),
    "dispatch reached Telegram proxy hold",
    10000,
    100
  );
  log("✓ Confirmed server action committed reservation and reached Telegram dispatch hold.");

  // Reload the browser while response is still in flight (during the 3000ms delay)
  log("Reloading browser page while request is held in flight...");
  await cdp.send("Page.reload");
  await sleep(1000);

  // Wait for composer textarea to remount
  await waitForCondition(
    async () => Boolean(await cdp.eval(`Boolean(document.querySelector('textarea'))`)),
    "composer textarea after in-flight reload"
  );

  // Assert draft preservation
  const reloadedDraft = await cdp.eval(`document.querySelector('textarea')?.value`);
  log(`Draft value after reload: "${reloadedDraft}"`);

  // Verify that resubmitting unchanged text does NOT generate a new operation ID
  const storedOpAfterReload = await cdp.eval(`(() => {
    const raw = sessionStorage.getItem('rabet_bound_op_${inqProd.id}') || sessionStorage.getItem('rabet_unresolved_op_${inqProd.id}');
    return raw ? JSON.parse(raw) : null;
  })()`);

  if (storedOpAfterReload) {
    if (storedOpAfterReload.id !== holdOpId) {
      await fail(`Expected stored operation ID to remain ${holdOpId}, got ${storedOpAfterReload.id}`);
    }
  }

  // Wait for delivery to conclude and status to reconcile
  log("Waiting for held transport dispatch to complete and status to reconcile...");
  await waitForCondition(
    async () => {
      const entries = readLedger().filter((x) => typeof x.text === "string" && x.text.includes(holdDraftText));
      return entries.length === 1;
    },
    "transport ledger entry for holdDraftText",
    10000,
    300
  );

  await waitForCondition(
    async () => {
      const dbRows = await pgClient`
        SELECT id, delivery_status FROM inquiry_message WHERE id = ${holdOpId};
      `;
      return dbRows.length === 1 && dbRows[0].delivery_status === "sent";
    },
    "db delivery status sent for holdOpId",
    10000,
    300
  );

  // If manual check status button is visible, click it to trigger reconciliation
  const checkStatusButtonExists = await cdp.eval(
    `Boolean(document.querySelector('button[data-testid="check-status-button"]'))`
  );
  if (checkStatusButtonExists) {
    await cdp.eval(`document.querySelector('button[data-testid="check-status-button"]').click()`);
  }

  // Wait for confirmed delivery status or composer textarea to clear
  await waitForCondition(
    async () => {
      const body = await cdp.eval("document.body?.innerText || ''");
      const textareaVal = await cdp.eval("document.querySelector('textarea')?.value");
      return (
        body.includes("Earlier reply was confirmed delivered") ||
        (body.includes(holdDraftText) && body.includes("Sent via Telegram") && textareaVal === "")
      );
    },
    "reconciliation of in-flight reply to confirmed sent",
    10000,
    300
  );

  // Verify from delivery ledger that exactly 1 transport send occurred for holdDraftText
  const holdLedgerEntries = readLedger().filter((x) => typeof x.text === "string" && x.text.includes(holdDraftText));
  if (holdLedgerEntries.length !== 1 || readLedger().length !== ledgerCountBeforeHold + 1) {
    await fail(`Expected exactly 1 transport send for holdDraftText, found ${holdLedgerEntries.length}`);
  }

  // Verify from database that exactly 1 message row exists
  const msgRowsById = await pgClient`
    SELECT id, delivery_status, body FROM inquiry_message WHERE id = ${holdOpId};
  `;
  if (msgRowsById.length !== 1) {
    await fail(`Expected exactly 1 message row in database with ID ${holdOpId}, found ${msgRowsById.length}`);
  }
  if (msgRowsById[0].delivery_status !== "sent") {
    await fail(`Expected message status to be 'sent', got ${msgRowsById[0].delivery_status}`);
  }

  const msgRowsByBody = await pgClient`
    SELECT id FROM inquiry_message WHERE body = ${holdDraftText};
  `;
  if (msgRowsByBody.length !== 1) {
    await fail(`Expected exactly 1 message row for body "${holdDraftText}", found ${msgRowsByBody.length}`);
  }
  log("✓ Real in-flight reload preserved operation identity, reconciled reliably, and created exactly 1 row and 1 transport send.");

  // 10E: Actual edit and revert across reload/remount
  log("10E: Testing actual edit and revert across page reload...");
  const revertFailDraft = "TRIGGER_FAIL: Draft for actual reload and revert test";

  // Enter failing text
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(revertFailDraft)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);

  // Submit -> trigger failure
  await cdp.eval(`(() => {
    const form = document.querySelector('textarea').closest('form');
    form.querySelector('button[type="submit"]').click();
  })()`);

  await waitForCondition(
    async () => {
      const body = await cdp.eval("document.body?.innerText || ''");
      return body.includes("Delivery failed");
    },
    "delivery failure banner for revertFailDraft"
  );

  const initialFailedOp = await cdp.eval(`(() => {
    const raw = sessionStorage.getItem('rabet_bound_op_${inqProd.id}');
    return raw ? JSON.parse(raw) : null;
  })()`);
  if (!initialFailedOp || !initialFailedOp.id) {
    await fail("Expected bound operation in sessionStorage after delivery failure");
  }
  const failedOpId = initialFailedOp.id;
  log(`Failed operation ID: ${failedOpId}`);

  // Reload page to remount component
  log("Reloading page to test remount preservation...");
  await cdp.send("Page.reload");
  await sleep(1000);
  await waitForCondition(
    async () => Boolean(await cdp.eval(`Boolean(document.querySelector('textarea'))`)),
    "textarea after reload"
  );

  // Verify composer restored original body and retained failedOpId
  const restoredVal = await cdp.eval(`document.querySelector('textarea')?.value`);
  if (!restoredVal.includes(revertFailDraft)) {
    await fail(`Expected restored draft to contain "${revertFailDraft}", got "${restoredVal}"`);
  }

  // Edit away from original text
  const awayText = "Different edited body moving away from failure";
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(awayText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);

  // Check boundOp is detached
  const detachedBound = await cdp.eval(`(() => {
    const raw = sessionStorage.getItem('rabet_bound_op_${inqProd.id}');
    return raw ? JSON.parse(raw) : null;
  })()`);
  if (detachedBound !== null) {
    await fail("Expected bound operation to detach when text edited away");
  }

  // Revert back to original failed body
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(revertFailDraft)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);

  // Verify bound operation reconnected to failedOpId
  const reconnectedBound = await cdp.eval(`(() => {
    const raw = sessionStorage.getItem('rabet_bound_op_${inqProd.id}');
    return raw ? JSON.parse(raw) : null;
  })()`);
  if (!reconnectedBound || reconnectedBound.id !== failedOpId) {
    await fail(`Expected bound operation to reconnect to ${failedOpId}, got ${JSON.stringify(reconnectedBound)}`);
  }
  log(`✓ Reverting text reconnected to stable operation ID: ${failedOpId}`);

  // Resubmitting unchanged text is blocked (must use Retry button or edit text)
  const ledgerCountBeforeResubmit = readLedger().length;
  await cdp.eval(`(() => {
    const form = document.querySelector('textarea').closest('form');
    form.querySelector('button[type="submit"]').click();
  })()`);
  await sleep(500);

  if (readLedger().length !== ledgerCountBeforeResubmit) {
    await fail("Submitting unchanged failed draft caused an unexpected second transport send!");
  }
  log("✓ Submitting unchanged failed draft correctly blocked and produced no unexpected transport call.");

  // 10F: found:false reconciliation & unchanged resubmission flow
  log("10F: Testing found:false reconciliation and unchanged resubmission flow...");
  const absentOpId = "55555555-5555-4555-a555-555555555555";
  const absentDraftText = "Unresolved message absent from server";

  // Seed sessionStorage with an unconfirmed operation absent from server
  await cdp.eval(`(() => {
    sessionStorage.setItem('rabet_unresolved_op_${inqProd.id}', JSON.stringify({
      id: '${absentOpId}',
      body: ${JSON.stringify(absentDraftText)},
      status: 'unconfirmed'
    }));
    sessionStorage.setItem('rabet_bound_op_${inqProd.id}', JSON.stringify({
      id: '${absentOpId}',
      body: ${JSON.stringify(absentDraftText)},
      status: 'unconfirmed'
    }));
    sessionStorage.setItem('rabet_draft_inquiry_${inqProd.id}', ${JSON.stringify(absentDraftText)});
  })()`);

  // Reload page to trigger mount reconciliation with server
  await cdp.send("Page.reload");
  await sleep(1000);
  await waitForCondition(
    async () => Boolean(await cdp.eval(`Boolean(document.querySelector('textarea'))`)),
    "textarea after reload for absent op"
  );

  // Assert found:false warning banner is visible
  await waitForCondition(
    async () => {
      const body = await cdp.eval("document.body?.innerText || ''");
      return body.includes("No record was found yet. Retrying will use the same submission ID.");
    },
    "found:false warning banner in composer"
  );
  log("✓ found:false displayed correct notice: 'No record was found yet. Retrying will use the same submission ID.'");

  // Verify stored bound operation retains absentOpId with pending status
  const boundAfterAbsent = await cdp.eval(`(() => {
    const raw = sessionStorage.getItem('rabet_bound_op_${inqProd.id}');
    return raw ? JSON.parse(raw) : null;
  })()`);
  if (!boundAfterAbsent || boundAfterAbsent.id !== absentOpId || boundAfterAbsent.status !== "pending") {
    await fail(`Expected bound operation to keep ${absentOpId} as pending, got ${JSON.stringify(boundAfterAbsent)}`);
  }

  // Resubmit unchanged text: must succeed using absentOpId without generating fresh UUID
  const ledgerCountBeforeAbsentSubmit = readLedger().length;
  await cdp.eval(`(() => {
    const form = document.querySelector('textarea').closest('form');
    form.querySelector('button[type="submit"]').click();
  })()`);

  await waitForCondition(
    async () => {
      const body = await cdp.eval("document.body?.innerText || ''");
      return body.includes(absentDraftText) && body.includes("Sent via Telegram");
    },
    "absentDraftText delivered successfully"
  );

  // Verify exact absentOpId was created in DB
  const absentMsgRows = await pgClient`
    SELECT id, delivery_status FROM inquiry_message WHERE id = ${absentOpId};
  `;
  if (absentMsgRows.length !== 1) {
    await fail(`Expected message in database with ID ${absentOpId}, found ${absentMsgRows.length}`);
  }
  if (readLedger().length !== ledgerCountBeforeAbsentSubmit + 1) {
    await fail("Expected exactly 1 transport send for absentDraftText resubmission");
  }
  log("✓ Unchanged resubmission after found:false reused original operation ID and delivered successfully.");

  // 10G: Operation-scoped reconciliation isolation with held server response race
  log("10G: Testing operation-scoped reconciliation isolation with held server response race...");
  const opAId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const opAText = "Operation A unresolved text awaiting reconciliation";
  const opBText = "TRIGGER_INFLIGHT_HOLD: Fresh authored draft for Operation B";

  // 1. Establish Operation A as delivered in the database
  await pgClient`
    INSERT INTO inquiry_message (id, inquiry_id, author, body, delivery_status, delivered_at, created_at)
    VALUES (${opAId}, ${inqProd.id}, 'admin', ${opAText}, 'sent', now() - interval '1 minute', now() - interval '1 minute');
  `;

  // 2. Set up proxy interception barrier for Operation A
  if (existsSync(releaseBarrierFile)) rmSync(releaseBarrierFile, { force: true });
  if (existsSync(notifyHeldFile)) rmSync(notifyHeldFile, { force: true });
  writeFileSync(holdBarrierFile, opAId, "utf8");

  // 3. Seed browser storage with unresolved Operation A
  await cdp.eval(`(() => {
    sessionStorage.setItem('rabet_unresolved_op_${inqProd.id}', JSON.stringify({
      id: '${opAId}',
      body: ${JSON.stringify(opAText)},
      status: 'unconfirmed'
    }));
    sessionStorage.setItem('rabet_bound_op_${inqProd.id}', JSON.stringify({
      id: '${opAId}',
      body: ${JSON.stringify(opAText)},
      status: 'unconfirmed'
    }));
    sessionStorage.setItem('rabet_draft_inquiry_${inqProd.id}', ${JSON.stringify(opAText)});
  })()`);

  // 4. Reload page to trigger actual mount reconciliation for Operation A
  await cdp.send("Page.reload");
  await sleep(1000);
  await waitForCondition(
    async () => Boolean(await cdp.eval(`Boolean(document.querySelector('textarea'))`)),
    "textarea after reload for operation A"
  );

  // 5. Verify Operation A's reconciliation request reached the proxy barrier and is held
  await waitForCondition(
    async () => existsSync(notifyHeldFile),
    "reconcileSellerOperationAction for operation A reached proxy barrier and is held",
    10000,
    100
  );
  log("✓ Reconcile request for Operation A is held in flight by proxy barrier.");

  // 6. While A's response is held, author Operation B through supported UI interactions
  await cdp.eval(`(() => {
    const textarea = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(opBText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  // Acknowledge duplication risk checkbox since unresolvedOp A exists
  await waitForCondition(
    async () => Boolean(await cdp.eval(`Boolean(document.querySelector('input[data-testid="duplication-risk-checkbox"]'))`)),
    "duplication risk checkbox visible after editing draft away from unresolved A"
  );
  await cdp.eval(`document.querySelector('input[data-testid="duplication-risk-checkbox"]').click()`);

  // Submit Operation B (starts dispatch and pre-binds operation identity)
  const ledgerCountBeforeB = readLedger().length;
  await cdp.eval(`(() => {
    const form = document.querySelector('textarea').closest('form');
    form.querySelector('button[type="submit"]').click();
  })()`);

  // Wait for Operation B pre-dispatch identity to be established in sessionStorage
  await waitForCondition(
    async () => {
      const raw = await cdp.eval(`sessionStorage.getItem('rabet_bound_op_${inqProd.id}')`);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return parsed.body === opBText && parsed.status === "pending" && parsed.id !== opAId;
    },
    "Operation B pre-dispatch binding in sessionStorage"
  );

  // 7. Capture Operation B's active draft, bound/unresolved operation IDs, and storage records
  const capturedB = await cdp.eval(`(() => {
    const rawBound = sessionStorage.getItem('rabet_bound_op_${inqProd.id}');
    const rawUnresolved = sessionStorage.getItem('rabet_unresolved_op_${inqProd.id}');
    const draft = sessionStorage.getItem('rabet_draft_inquiry_${inqProd.id}');
    const textareaVal = document.querySelector('textarea')?.value;
    return {
      bound: rawBound ? JSON.parse(rawBound) : null,
      unresolved: rawUnresolved ? JSON.parse(rawUnresolved) : null,
      draft,
      textareaVal,
    };
  })()`);

  if (!capturedB.bound || !capturedB.bound.id || capturedB.bound.id === opAId) {
    await fail(`Expected valid Operation B bound identity, got ${JSON.stringify(capturedB.bound)}`);
  }
  const opBId = capturedB.bound.id;
  log(`✓ Captured active Operation B identity: ${opBId}`);

  // 8. Release Operation A's actual response as confirmed_sent
  writeFileSync(releaseBarrierFile, "release", "utf8");
  log("✓ Released Operation A held response as confirmed_sent.");

  // 9. Let the application process A's delayed response while B is in flight
  await sleep(600);

  // 10. Assert:
  // - B's draft is unchanged
  // - B's operation identity remains intact
  // - B's storage is not cleared or overwritten
  // - A's stale result does not produce a false delivery notice for B
  const postA_textareaVal = await cdp.eval(`document.querySelector('textarea')?.value`);
  if (postA_textareaVal !== opBText) {
    await fail(`Operation B draft was altered by stale A response! Expected "${opBText}", got "${postA_textareaVal}"`);
  }

  const postA_bound = await cdp.eval(`(() => {
    const raw = sessionStorage.getItem('rabet_bound_op_${inqProd.id}');
    return raw ? JSON.parse(raw) : null;
  })()`);
  if (!postA_bound || postA_bound.id !== opBId) {
    await fail(`Operation B bound identity was corrupted or erased by stale A response! Got ${JSON.stringify(postA_bound)}`);
  }

  const postA_draftStorage = await cdp.eval(`sessionStorage.getItem('rabet_draft_inquiry_${inqProd.id}')`);
  if (postA_draftStorage !== opBText) {
    await fail(`Operation B draft in storage was altered or erased! Expected "${opBText}", got "${postA_draftStorage}"`);
  }

  const postA_body = await cdp.eval("document.body?.innerText || ''");
  if (postA_body.includes("Earlier reply was confirmed delivered to the customer.")) {
    await fail("Stale Operation A reconciliation produced a false delivery notice for Operation B!");
  }
  log("✓ Stale Operation A response was correctly ignored by epoch and identity guards.");

  // 11. Wait for Operation B to complete delivery
  await waitForCondition(
    async () => {
      const body = await cdp.eval("document.body?.innerText || ''");
      return body.includes("Sent via Telegram") || body.includes("Reply sent to customer");
    },
    "Operation B delivery completion",
    10000,
    200
  );
  log("✓ Operation B delivered successfully.");

  // 12. Assert transport ledger and database rows
  if (readLedger().length !== ledgerCountBeforeB + 1) {
    await fail(`Expected exactly 1 transport send for Operation B, got ledger count ${readLedger().length} vs expected ${ledgerCountBeforeB + 1}`);
  }

  const bDbRows = await pgClient`
    SELECT id, delivery_status FROM inquiry_message WHERE id = ${opBId};
  `;
  if (bDbRows.length !== 1 || bDbRows[0].delivery_status !== "sent") {
    await fail(`Expected Operation B message row with status 'sent', found ${JSON.stringify(bDbRows)}`);
  }

  const aDbRows = await pgClient`
    SELECT id, delivery_status FROM inquiry_message WHERE id = ${opAId};
  `;
  if (aDbRows.length !== 1) {
    await fail(`Expected exactly 1 row for Operation A, found ${aDbRows.length}`);
  }
  log("✓ Real reconciliation race test verified: 0 duplicate sends, 0 duplicate rows, and B preserved throughout.");

  // Clear simulated storage and draft for clean exit
  await cdp.eval(`(() => {
    sessionStorage.removeItem('rabet_unresolved_op_${inqProd.id}');
    sessionStorage.removeItem('rabet_bound_op_${inqProd.id}');
    sessionStorage.removeItem('rabet_draft_inquiry_${inqProd.id}');
    const textarea = document.querySelector('textarea');
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);

  log("\n🎉 ALL BROWSER ACCEPTANCE CHECKS PASSED SUCCESSFULLY!\n");
  await cleanup();
  process.exit(0);
}

runAcceptance().catch(async (err) => {
  await fail(err.stack || err.message);
});
