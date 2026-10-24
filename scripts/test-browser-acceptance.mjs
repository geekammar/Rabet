#!/usr/bin/env node
/**
 * scripts/test-browser-acceptance.mjs
 *
 * Real browser acceptance test suite for Phase 04-B: Global Bot Content Editor.
 * Executes against local Next.js production build (`next start`), test credentials,
 * disposable loopback PostgreSQL, and headless Chromium via Chrome DevTools Protocol (CDP).
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hash } from "@node-rs/argon2";
import postgres from "postgres";

const APP_PORT = 3344;
const CDP_PORT = 9333;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const TEST_EMAIL = "admin@example.test";
const TEST_PASSWORD = "test-password-123";

let appServer = null;
let chromeProcess = null;
let pgClient = null;
let ownedTempDir = null;
let isCleaningUp = false;

function log(msg) {
  process.stdout.write(`[browser-acceptance] ${msg}\n`);
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

  if (ownedTempDir) {
    try {
      rmSync(ownedTempDir, { recursive: true, force: true });
    } catch {}
    ownedTempDir = null;
  }

  try {
    spawnSync("node", ["scripts/db-test-postgres.mjs", "stop"], {
      stdio: "ignore",
    });
  } catch {}
}

async function fail(msg) {
  process.stderr.write(`[browser-acceptance:FAIL] ${msg}\n`);
  await cleanup();
  process.exit(1);
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Configurable or auto-discovered Chromium executable */
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

/** Simple CDP client using native Node WebSocket */
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

  async close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

async function main() {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    await fail(
      "Chromium executable not found. Set CHROME_BIN or CHROME_PATH environment variable."
    );
  }
  log(`Using Chromium executable: ${chromePath}`);

  log("Starting disposable PostgreSQL...");
  const pgStart = spawnSync("node", ["scripts/db-test-postgres.mjs", "start"], {
    encoding: "utf8",
  });
  if (pgStart.status !== 0) {
    await fail(`Could not start disposable PostgreSQL: ${pgStart.stderr}`);
  }

  // Parse connection string
  const pgUrlMatch = pgStart.stdout.match(/postgresql:\/\/[^\s]+/);
  if (!pgUrlMatch) {
    await fail("Could not find PostgreSQL URL in output");
  }
  const pgUrl = pgUrlMatch[0];

  // Verify test database is the designated disposable loopback target before any migration or write
  const parsedPgUrl = new URL(pgUrl);
  if (
    parsedPgUrl.hostname !== "127.0.0.1" &&
    parsedPgUrl.hostname !== "localhost"
  ) {
    await fail(
      `Refusing to run against non-loopback database host: ${parsedPgUrl.hostname}`
    );
  }
  log(`Disposable loopback PostgreSQL ready on port ${parsedPgUrl.port}`);

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

  // Connect postgres client to verify/seed
  pgClient = postgres(pgUrl);

  // Initialize languages and settings
  log("Seeding test store settings and languages (en enabled, ar disabled)...");
  const [langEn] = await pgClient`
    INSERT INTO language (code, label, text_direction, is_enabled)
    VALUES ('en', 'English', 'ltr', true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO language (code, label, text_direction, is_enabled)
    VALUES ('ar', 'العربية', 'rtl', false);
  `;
  await pgClient`
    INSERT INTO bot_setting (display_name, currency, default_language_id, ask_for_language)
    VALUES ('Acme Digital', 'USD', ${langEn.id}, true);
  `;
  log("Initial store settings seeded.");

  // Create isolated owned temporary directory with restrictive permissions (0700)
  ownedTempDir = mkdtempSync(path.join(tmpdir(), "rabet-acceptance-"));
  chmodSync(ownedTempDir, 0o700);

  // Write bootstrap file that substitutes Neon HTTP queries with local disposable PostgreSQL
  // NOTE: This test interceptor is strictly scoped to the synthetic endpoint ep-example.neon.tech.
  // It substitutes transport to local PostgreSQL for browser testing and does not prove live Neon cloud connectivity.
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
      `  const isSyntheticEndpoint = (url && url.includes("ep-example.neon.tech")) || (typeof connStr === "string" && connStr.includes("ep-example.neon.tech"));\n` +
      `  if (isSyntheticEndpoint && (url.includes("/sql") || url.includes("neon.tech"))) {\n` +
      `    if (!pg && process.env.TEST_REAL_PG_URL) {\n` +
      `      pg = postgres(process.env.TEST_REAL_PG_URL);\n` +
      `    }\n` +
      `    const { query, params } = JSON.parse(init.body);\n` +
      `    try {\n` +
      `      const rows = await pg.unsafe(query, params || []);\n` +
      `      const cols = rows.columns || [];\n` +
      `      const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));\n` +
      `      const rowArrays = rows.map((r) => cols.map((c) => r[c.name]));\n` +
      `      return new Response(JSON.stringify({ rows: rowArrays, fields }), {\n` +
      `        status: 200,\n` +
      `        headers: { "content-type": "application/json" },\n` +
      `      });\n` +
      `    } catch (err) {\n` +
      `      return new Response(JSON.stringify({ message: err.message }), {\n` +
      `        status: 500,\n` +
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
      `export AUTH_SECRET='${authSecret}'`,
      `export ADMIN_EMAIL='${TEST_EMAIL}'`,
      `export ADMIN_PASSWORD_HASH='${passwordHash}'`,
      `export AUTH_URL='${BASE_URL}'`,
      `export AUTH_TRUST_HOST='true'`,
      `export NODE_OPTIONS='--import ${bootstrapFile}'`,
    ].join("\n") + "\n",
    { mode: 0o600 }
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
    }
  );

  appServer.stderr.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("blocking-prerender-crypto") && !s.includes("ExperimentalWarning")) {
      process.stderr.write(`[next:stderr] ${s}`);
    }
  });

  // Wait for Next.js server to be ready
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

  // Authenticate admin session over HTTP
  log("Authenticating admin session over HTTP...");
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  const csrfData = await csrfRes.json();
  const csrfToken = csrfData.csrfToken;
  const initialCookies = csrfRes.headers.get("set-cookie") || "";

  const signinBody = new URLSearchParams({
    csrfToken,
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    callbackUrl: `${BASE_URL}/bot-content`,
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
  log("Admin session authenticated successfully.");

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

  // Inject session cookie into Chromium
  await cdp.send("Network.setCookie", {
    name: "authjs.session-token",
    value: sessionCookieVal,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
  });

  // ==========================================
  // Flow 1: Open /bot-content with missing content
  // ==========================================
  log("Flow 1: Navigating to /bot-content with empty template state...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/bot-content` });
  await sleep(2000);

  const pageTitle = await cdp.evaluate("document.title");
  if (!pageTitle.includes("Bot Content")) {
    await fail(`Flow 1: Expected page title to contain 'Bot Content', got '${pageTitle}'`);
  }

  // Confirm all 7 cards are rendered
  const currentUrl = await cdp.evaluate("window.location.href");
  const cardCount = await cdp.evaluate(
    "document.querySelectorAll('[data-template-card]').length"
  );
  if (cardCount !== 7) {
    const bodyText = await cdp.evaluate("document.body.innerText");
    log(`Flow 1 current URL: ${currentUrl}`);
    log(`Flow 1 body text:\n${bodyText}`);
    await fail(`Flow 1: Expected 7 template cards rendered, found ${cardCount}`);
  }

  // Assert honest fallback badge for completely missing template (selected EN, no saved fallback)
  const botWelcomeCardBadge = await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    card ? card.innerText : "";
  }`);
  if (!botWelcomeCardBadge.includes("Missing (EN) — no saved fallback")) {
    await fail(
      `Flow 1: Expected 'Missing (EN) — no saved fallback' on fresh bot_welcome card, got: '${botWelcomeCardBadge.slice(0, 300)}'`
    );
  }

  // Confirm zero templates and zero translations exist in database
  const tmplCountDb = (await pgClient`SELECT count(*) FROM message_template`)[0].count;
  const transCountDb = (await pgClient`SELECT count(*) FROM message_translation`)[0].count;
  if (Number(tmplCountDb) !== 0 || Number(transCountDb) !== 0) {
    await fail(
      `Flow 1: Database has ${tmplCountDb} templates, ${transCountDb} translations; expected 0 writes on page load.`
    );
  }
  log("Flow 1 PASSED: Page loaded cleanly; truthful missing badges verified; 0 DB writes on page load.");

  // ==========================================
  // Flow 2: Apply a suggestion and confirm it is NOT saved yet
  // ==========================================
  log("Flow 2: Applying suggested text within bot_welcome card without clicking Save...");
  await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    const btn = Array.from(card.querySelectorAll('button')).find(b => b.innerText.includes('Use suggested text'));
    if (btn) btn.click();
  }`);
  await sleep(500);

  // Check card-scoped textarea value
  const textareaVal = await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    card.querySelector('textarea').value;
  }`);
  if (!textareaVal.includes("Welcome to {{store_name}}!")) {
    await fail(`Flow 2: Suggested text was not loaded into draft; got '${textareaVal}'`);
  }

  // Check card-scoped live preview text (interpolates sample value Acme Digital)
  const previewVal = await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    card.innerText.includes("Welcome to Acme Digital!");
  }`);
  if (!previewVal) {
    await fail("Flow 2: Expected preview inside card to interpolate {{store_name}} with Acme Digital");
  }

  // Verify unsaved changes badge appeared on card
  const hasUnsavedBadge = await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    card.innerText.includes('Unsaved changes');
  }`);
  if (!hasUnsavedBadge) {
    await fail("Flow 2: Expected 'Unsaved changes' indicator on card after applying suggestion.");
  }

  // Query database: must still be 0!
  const tmplCountDb2 = (await pgClient`SELECT count(*) FROM message_template`)[0].count;
  const transCountDb2 = (await pgClient`SELECT count(*) FROM message_translation`)[0].count;
  if (Number(tmplCountDb2) !== 0 || Number(transCountDb2) !== 0) {
    await fail("Flow 2: Applying suggestion wrote to database before explicit Save!");
  }
  log("Flow 2 PASSED: Suggestion applied to local draft; 0 database writes occurred.");

  // ==========================================
  // Flow 3: Save English text, reload, and verify persistence
  // ==========================================
  log("Flow 3: Explicitly saving English text on bot_welcome...");
  await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    const saveBtn = Array.from(card.querySelectorAll('button')).find(b => b.innerText.includes('Save English Message'));
    if (saveBtn) saveBtn.click();
  }`);
  await sleep(1500);

  // Reload page
  await cdp.send("Page.reload");
  await sleep(2000);

  // Verify card-scoped textarea still has persisted text
  const persistedVal = await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    card.querySelector('textarea').value;
  }`);
  if (!persistedVal.includes("Welcome to {{store_name}}!")) {
    await fail(`Flow 3: Persisted text not found in textarea after reload; got '${persistedVal}'`);
  }

  // Verify database now contains 1 template and 1 translation
  const tmplCountDb3 = (await pgClient`SELECT count(*) FROM message_template`)[0].count;
  const transCountDb3 = (await pgClient`SELECT count(*) FROM message_translation`)[0].count;
  if (Number(tmplCountDb3) !== 1 || Number(transCountDb3) !== 1) {
    await fail(
      `Flow 3: Expected exactly 1 template and 1 translation in DB, found ${tmplCountDb3} / ${transCountDb3}`
    );
  }
  log("Flow 3 PASSED: English message saved, persisted, and confirmed in database.");

  // ==========================================
  // Flow 4: Arabic editing, fallback badge with saved default, and RTL verification
  // ==========================================
  log("Flow 4: Testing Arabic tab, fallback badge, RTL direction, and persistence...");
  // Click Arabic tab within bot_welcome card
  await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    const arTab = Array.from(card.querySelectorAll('button')).find(b => b.innerText.includes('العربية'));
    if (arTab) arTab.click();
  }`);
  await sleep(500);

  // Assert truthful fallback badge: Arabic missing, but default English is saved -> "Missing (AR) — falls back to English"
  const arCardBadge = await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    card.innerText;
  }`);
  if (!arCardBadge.includes("Missing (AR) — falls back to English")) {
    await fail(
      `Flow 4: Expected 'Missing (AR) — falls back to English' badge when English is saved, got: '${arCardBadge.slice(0, 300)}'`
    );
  }

  // Check textarea dir="rtl" separately
  const textareaIsRtl = await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    const ta = card.querySelector('textarea');
    ta ? ta.getAttribute('dir') : null;
  }`);
  if (textareaIsRtl !== "rtl") {
    await fail(`Flow 4: Expected Arabic textarea to have dir="rtl", got '${textareaIsRtl}'`);
  }

  // Check live preview box dir="rtl" separately
  const previewIsRtl = await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    const previewEl = card.querySelector('[dir="rtl"]');
    Boolean(previewEl);
  }`);
  if (!previewIsRtl) {
    await fail("Flow 4: Expected live preview container inside card to have dir='rtl'");
  }

  // Type Arabic message into draft
  const arabicText = "مرحبًا بك في Acme Digital! يسعدنا خدمتك.";
  await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    const textarea = card.querySelector('textarea');
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    nativeSetter.call(textarea, ${JSON.stringify(arabicText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  await sleep(500);

  // Click Save Arabic Message within card
  await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    const saveArBtn = Array.from(card.querySelectorAll('button')).find(b => b.innerText.includes('Save Arabic Message'));
    if (saveArBtn) saveArBtn.click();
  }`);
  await sleep(1500);

  // Assert badge on card updated to "Saved (AR)"
  const arCardBadgeAfterSave = await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    card.innerText.includes("Saved (AR)");
  }`);
  if (!arCardBadgeAfterSave) {
    await fail("Flow 4: Expected 'Saved (AR)' badge on card after saving Arabic translation.");
  }

  // Verify DB: 1 template, 2 translations
  const transRows = await pgClient`
    SELECT l.code, mt.body
    FROM message_translation mt
    JOIN language l ON l.id = mt.language_id
    ORDER BY l.code;
  `;
  if (transRows.length !== 2) {
    await fail(`Flow 4: Expected 2 translations in DB, found ${transRows.length}`);
  }
  const enRow = transRows.find((r) => r.code === "en");
  const arRow = transRows.find((r) => r.code === "ar");

  if (!enRow || !enRow.body.includes("Welcome to {{store_name}}!")) {
    await fail("Flow 4: English translation was corrupted or overwritten!");
  }
  if (!arRow || arRow.body !== arabicText) {
    await fail(`Flow 4: Arabic translation did not match expected body; got '${arRow?.body}'`);
  }

  // Verify Arabic language remains disabled in store settings
  const [arLangRow] = await pgClient`SELECT is_enabled FROM language WHERE code = 'ar'`;
  if (arLangRow.is_enabled !== false) {
    await fail("Flow 4: Saving Arabic translation improperly enabled the language in language table!");
  }
  log("Flow 4 PASSED: Arabic saved with RTL direction; truthful fallback badge verified; English preserved.");

  // ==========================================
  // Flow 5: Submit invalid/unknown placeholders & draft preservation
  // ==========================================
  log("Flow 5: Submitting invalid placeholder and testing client-side validation...");
  // Capture stored text BEFORE the invalid save attempt
  const [storedEnBefore] = await pgClient`
    SELECT mt.body FROM message_translation mt
    JOIN language l ON l.id = mt.language_id
    WHERE l.code = 'en';
  `;

  // Switch back to English tab on bot_welcome card
  await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    const enTab = Array.from(card.querySelectorAll('button')).find(b => b.innerText.includes('English'));
    if (enTab) enTab.click();
  }`);
  await sleep(500);

  // Type invalid placeholder into English draft
  const invalidText = "Hello {{unknown_placeholder}}!";
  await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    const textarea = card.querySelector('textarea');
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    nativeSetter.call(textarea, ${JSON.stringify(invalidText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  await sleep(500);

  // Click Save within card
  await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    const saveEnBtn = Array.from(card.querySelectorAll('button')).find(b => b.innerText.includes('Save English Message'));
    if (saveEnBtn) saveEnBtn.click();
  }`);
  await sleep(1000);

  // Check card text for client-side validation feedback
  const cardText = await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    card.innerText;
  }`);

  const hasValidationError =
    cardText.includes("Validation error") &&
    cardText.includes("Unknown placeholder");
  if (!hasValidationError) {
    await fail(
      `Flow 5: Expected client-side validation error inside card, got: '${cardText.slice(0, 500)}'`
    );
  }
  log("Flow 5: Client-side validation intercepted invalid placeholder before submission, displaying validation error.");

  // Verify draft is preserved in textarea
  const preservedDraft = await cdp.evaluate(`{
    const card = document.querySelector('[data-template-card="bot_welcome"]');
    card.querySelector('textarea').value;
  }`);
  if (preservedDraft !== invalidText) {
    await fail(`Flow 5: User draft was cleared or lost on validation failure; got '${preservedDraft}'`);
  }

  // Compare stored text AFTER the invalid save attempt: must be strictly unchanged!
  const [storedEnAfter] = await pgClient`
    SELECT mt.body FROM message_translation mt
    JOIN language l ON l.id = mt.language_id
    WHERE l.code = 'en';
  `;
  if (storedEnAfter.body !== storedEnBefore.body) {
    await fail(
      `Flow 5: Stored database text was modified after invalid submission! Before: '${storedEnBefore.body}', After: '${storedEnAfter.body}'`
    );
  }
  log("Flow 5 PASSED: Client-side validation displayed, draft preserved in textarea, DB text unchanged.");

  // ==========================================
  // Flow 6: Check a 360px viewport for overflow and 44x44 touch targets
  // ==========================================
  log("Flow 6: Testing 360px viewport responsiveness and 44x44px touch targets...");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 740,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(1000);

  const scrollWidth = await cdp.evaluate("document.documentElement.scrollWidth");
  const innerWidth = await cdp.evaluate("window.innerWidth");

  if (scrollWidth > 360) {
    await fail(
      `Flow 6: Horizontal overflow detected at 360px: scrollWidth=${scrollWidth}, innerWidth=${innerWidth}`
    );
  }

  // Check interactive buttons minimum width AND height >= 43.5px
  const buttonMetrics = await cdp.evaluate(`{
    Array.from(document.querySelectorAll('button'))
      .filter(b => b.offsetWidth > 0 && b.offsetHeight > 0)
      .map(b => {
        const rect = b.getBoundingClientRect();
        return {
          text: b.innerText.slice(0, 20),
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        };
      });
  }`);

  const smallButtons = buttonMetrics.filter(
    (b) => b.width < 43.5 || b.height < 43.5
  );
  if (smallButtons.length > 0) {
    await fail(
      `Flow 6: Found buttons with touch target < 44x44px: ${JSON.stringify(
        smallButtons.slice(0, 3)
      )}`
    );
  }

  log(
    `Flow 6 PASSED: 0 horizontal overflow at 360px (scrollWidth=${scrollWidth}), all touch targets >= 44x44px.`
  );

  await cdp.close();
  await cleanup();
  log("All 6 browser acceptance flows PASSED successfully!");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exit(1);
});
