#!/usr/bin/env node
/**
 * scripts/test-browser-acceptance.mjs
 *
 * Real browser acceptance test suite for Phase 04-B: Global Bot Content Editor.
 * Executes against local Next.js production build (`next start`), test credentials,
 * disposable loopback PostgreSQL, and headless Chromium via Chrome DevTools Protocol (CDP).
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hash } from "@node-rs/argon2";
import postgres from "postgres";

const APP_PORT = 3344;
const CDP_PORT = 9333;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const TEST_EMAIL = "admin@example.test";
const TEST_PASSWORD = "test-password-123";

const CHROME_PATH = "/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";

let proxyServer = null;
let appServer = null;
let chromeProcess = null;
let pgClient = null;

function log(msg) {
  process.stdout.write(`[browser-acceptance] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[browser-acceptance:FAIL] ${msg}\n`);
  cleanup();
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanup() {
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

  if (proxyServer) {
    try {
      proxyServer.close();
    } catch {}
    proxyServer = null;
  }

  if (pgClient) {
    try {
      await pgClient.end();
    } catch {}
    pgClient = null;
  }

  try {
    rmSync(path.resolve("scripts/neon-proxy-bootstrap.mjs"), { force: true });
  } catch {}

  try {
    spawnSync("node", ["scripts/db-test-postgres.mjs", "stop"], {
      stdio: "ignore",
    });
  } catch {}
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

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
  log("Starting disposable PostgreSQL...");
  const pgStart = spawnSync("node", ["scripts/db-test-postgres.mjs", "start"], {
    encoding: "utf8",
  });
  if (pgStart.status !== 0) {
    fail(`Could not start disposable PostgreSQL: ${pgStart.stderr}`);
  }

  // Parse connection string
  const pgUrlMatch = pgStart.stdout.match(/postgresql:\/\/[^\s]+/);
  if (!pgUrlMatch) {
    fail("Could not find PostgreSQL URL in output");
  }
  const pgUrl = pgUrlMatch[0];
  log(`Disposable PostgreSQL ready at ${pgUrl}`);

  // Run migrations
  log("Applying database migrations...");
  const migrate = spawnSync("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: pgUrl },
    encoding: "utf8",
  });
  if (migrate.status !== 0) {
    fail(`Migration failed: ${migrate.stderr || migrate.stdout}`);
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

  // Write bootstrap file that intercepts Neon HTTP queries via globalThis.fetch
  log("Setting up Neon HTTP fetch interceptor for Next.js server...");
  const bootstrapFile = path.resolve("scripts/neon-proxy-bootstrap.mjs");

  writeFileSync(
    bootstrapFile,
    `import postgres from "postgres";\n` +
      `const originalFetch = globalThis.fetch;\n` +
      `let pg = null;\n` +
      `globalThis.fetch = async (input, init) => {\n` +
      `  const url = typeof input === "string" ? input : (input ? input.url : "");\n` +
      `  if (url && (url.includes("/sql") || url.includes("neon.tech"))) {\n` +
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
      `};\n`
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

  const envDir = mkdtempSync(path.join(tmpdir(), "rabet-browser-"));
  const envFile = path.join(envDir, "test.env");

  const testSyntheticNeonUrl = "postgresql://rabet_user:synthetic_pass@ep-test.neon.tech/rabet_db";

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
    ].join("\n") + "\n"
  );

  appServer = spawn(
    "bash",
    ["-c", `set -a; . ${envFile}; set +a; exec npx next start -p ${APP_PORT}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
      detached: true,
    }
  );

  await new Promise((resolve, reject) => {
    let ready = false;
    const check = (data) => {
      const text = data.toString();
      if (text.includes("Ready") && !ready) {
        ready = true;
        resolve();
      }
    };
    appServer.stdout.on("data", check);
    appServer.stderr.on("data", (data) => {
      process.stderr.write(`[next:stderr] ${data.toString()}`);
      check(data);
    });
    appServer.on("error", reject);
    setTimeout(() => {
      if (!ready) reject(new Error("Next.js server startup timeout"));
    }, 30000);
  });
  log("Next.js server is ready.");

  // Obtain admin session cookie via signIn
  log("Authenticating admin session over HTTP...");
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  const csrfData = await csrfRes.json();
  const csrfCookie = csrfRes.headers.getSetCookie?.() || [];

  const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie.map((c) => c.split(";")[0]).join("; "),
    },
    body: new URLSearchParams({
      csrfToken: csrfData.csrfToken,
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      callbackUrl: `${BASE_URL}/bot-content`,
    }).toString(),
    redirect: "manual",
  });

  const setCookies = loginRes.headers.getSetCookie?.() || [];
  const sessionTokenCookie = setCookies.find((c) =>
    c.includes("authjs.session-token")
  );
  if (!sessionTokenCookie) {
    fail("Failed to obtain authjs.session-token cookie from login response.");
  }

  const [cookiePair] = sessionTokenCookie.split(";");
  const [cookieName, cookieVal] = cookiePair.split("=");
  log("Admin session authenticated successfully.");

  // Launch headless Chromium
  log("Launching headless Chromium...");
  chromeProcess = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  // Wait for CDP port
  await sleep(1500);

  // Get active target WS URL
  const versionRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const versionData = await versionRes.json();
  log(`Connected to Chromium: ${versionData.Browser}`);

  const targetsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const targets = await targetsRes.json();
  const pageTarget = targets.find((t) => t.type === "page") || targets[0];
  if (!pageTarget) {
    fail("No page target found in Chromium.");
  }

  const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");

  // Inject session cookie into Chromium
  await cdp.send("Network.setCookie", {
    name: cookieName,
    value: cookieVal,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
  });
  log("Session cookie injected into Chromium.");

  // ==========================================
  // Flow 1: Open /bot-content with missing content
  // ==========================================
  log("Flow 1: Navigating to /bot-content with empty template state...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/bot-content` });
  await sleep(2000);

  const pageTitle = await cdp.evaluate("document.title");
  if (!pageTitle.includes("Bot Content")) {
    fail(`Flow 1: Expected page title to contain 'Bot Content', got '${pageTitle}'`);
  }

  const currentUrl = await cdp.evaluate("window.location.href");
  log(`Current URL: ${currentUrl}`);

  // Confirm cards are rendered
  const cardCount = await cdp.evaluate(
    "document.querySelectorAll('textarea').length"
  );
  if (cardCount !== 7) {
    const pageHtml = await cdp.evaluate("document.body.innerText");
    log(`Page text: ${pageHtml.slice(0, 500)}`);
    fail(`Flow 1: Expected 7 template textareas rendered, found ${cardCount}`);
  }

  // Confirm missing content indicators exist
  const missingBadges = await cdp.evaluate(
    "document.body.innerText.includes('Missing — falls back to English')"
  );
  if (!missingBadges) {
    fail("Flow 1: Missing fallback badge not displayed on uninitialized templates");
  }

  // Confirm zero templates and zero translations exist in database
  const tmplCountDb = (await pgClient`SELECT count(*) FROM message_template`)[0].count;
  const transCountDb = (await pgClient`SELECT count(*) FROM message_translation`)[0].count;
  if (Number(tmplCountDb) !== 0 || Number(transCountDb) !== 0) {
    fail(`Flow 1: Database has ${tmplCountDb} templates, ${transCountDb} translations; expected 0 writes on page load.`);
  }
  log("Flow 1 PASSED: Page loaded cleanly; 0 database templates/translations created.");

  // ==========================================
  // Flow 2: Apply a suggestion and confirm it is NOT saved yet
  // ==========================================
  log("Flow 2: Applying suggested text without clicking Save...");
  // Click first 'Use suggested text' button
  await cdp.evaluate(`
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Use suggested text'));
    if (btn) btn.click();
  `);
  await sleep(500);

  // Check textarea value (contains raw placeholder {{store_name}})
  const textareaVal = await cdp.evaluate(`document.querySelectorAll('textarea')[0].value`);
  if (!textareaVal.includes("Welcome to {{store_name}}!")) {
    fail(`Flow 2: Suggested text was not loaded into draft; got '${textareaVal}'`);
  }

  // Check live preview text (interpolates sample value Acme Digital)
  const previewVal = await cdp.evaluate(`document.body.innerText.includes("Welcome to Acme Digital!")`);
  if (!previewVal) {
    fail("Flow 2: Expected preview to interpolate {{store_name}} with Acme Digital");
  }

  // Verify unsaved changes badge appeared
  const hasUnsavedBadge = await cdp.evaluate(
    "document.body.innerText.includes('Unsaved changes')"
  );
  if (!hasUnsavedBadge) {
    fail("Flow 2: Expected 'Unsaved changes' indicator after applying suggestion.");
  }

  // Query database: must still be 0!
  const tmplCountDb2 = (await pgClient`SELECT count(*) FROM message_template`)[0].count;
  const transCountDb2 = (await pgClient`SELECT count(*) FROM message_translation`)[0].count;
  if (Number(tmplCountDb2) !== 0 || Number(transCountDb2) !== 0) {
    fail("Flow 2: Applying suggestion wrote to database before explicit Save!");
  }
  log("Flow 2 PASSED: Suggestion applied to local draft; 0 database writes occurred.");

  // ==========================================
  // Flow 3: Save English text, reload, and verify persistence
  // ==========================================
  log("Flow 3: Saving English text on bot_welcome...");
  await cdp.evaluate(`
    const saveBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Save English Message'));
    if (saveBtn) saveBtn.click();
  `);
  await sleep(1500);

  // Reload page
  await cdp.send("Page.reload");
  await sleep(2000);

  // Verify textarea still has persisted text
  const persistedVal = await cdp.evaluate(`document.querySelectorAll('textarea')[0].value`);
  if (!persistedVal.includes("Welcome to {{store_name}}!")) {
    fail(`Flow 3: Persisted text not found in textarea after reload; got '${persistedVal}'`);
  }

  // Verify database now contains 1 template and 1 translation
  const tmplCountDb3 = (await pgClient`SELECT count(*) FROM message_template`)[0].count;
  const transCountDb3 = (await pgClient`SELECT count(*) FROM message_translation`)[0].count;
  if (Number(tmplCountDb3) !== 1 || Number(transCountDb3) !== 1) {
    fail(`Flow 3: Expected exactly 1 template and 1 translation in DB, found ${tmplCountDb3} / ${transCountDb3}`);
  }
  log("Flow 3 PASSED: English message saved, persisted, and confirmed in database.");

  // ==========================================
  // Flow 4: Save Arabic using registered test language; verify RTL and English preservation
  // ==========================================
  log("Flow 4: Editing Arabic on bot_welcome...");
  // Click Arabic tab on the first card
  await cdp.evaluate(`
    const arTab = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('العربية'));
    if (arTab) arTab.click();
  `);
  await sleep(500);

  // Check textarea dir="rtl"
  const isRtl = await cdp.evaluate(`document.querySelectorAll('textarea')[0].getAttribute('dir')`);
  if (isRtl !== "rtl") {
    fail(`Flow 4: Expected Arabic textarea to have dir="rtl", got '${isRtl}'`);
  }

  // Check live preview box dir="rtl"
  const previewIsRtl = await cdp.evaluate(`
    const preview = document.querySelector('[dir="rtl"]');
    Boolean(preview);
  `);
  if (!previewIsRtl) {
    fail("Flow 4: Expected live preview container to have dir='rtl'");
  }

  // Type Arabic message into draft
  const arabicText = "مرحبًا بك في Acme Digital! يسعدنا خدمتك.";
  await cdp.evaluate(`{
    const textarea = document.querySelectorAll('textarea')[0];
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    nativeSetter.call(textarea, ${JSON.stringify(arabicText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  await sleep(500);

  // Click Save Arabic Message
  await cdp.evaluate(`{
    const saveArBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Save Arabic Message'));
    if (saveArBtn) saveArBtn.click();
  }`);
  await sleep(1500);

  // Verify DB: 1 template, 2 translations
  const transRows = await pgClient`
    SELECT l.code, mt.body
    FROM message_translation mt
    JOIN language l ON l.id = mt.language_id
    ORDER BY l.code;
  `;
  if (transRows.length !== 2) {
    fail(`Flow 4: Expected 2 translations in DB, found ${transRows.length}`);
  }
  const enRow = transRows.find((r) => r.code === "en");
  const arRow = transRows.find((r) => r.code === "ar");

  if (!enRow || !enRow.body.includes("Welcome to {{store_name}}!")) {
    fail("Flow 4: English translation was corrupted or overwritten!");
  }
  if (!arRow || arRow.body !== arabicText) {
    fail(`Flow 4: Arabic translation did not match expected body; got '${arRow?.body}'`);
  }

  // Verify Arabic language remains disabled in store settings
  const [arLangRow] = await pgClient`SELECT is_enabled FROM language WHERE code = 'ar'`;
  if (arLangRow.is_enabled !== false) {
    fail("Flow 4: Saving Arabic translation improperly enabled the language in language table!");
  }
  log("Flow 4 PASSED: Arabic saved with RTL direction; English preserved; Arabic remains disabled.");

  // ==========================================
  // Flow 5: Submit invalid/unknown placeholders
  // ==========================================
  log("Flow 5: Submitting invalid placeholder and testing preservation...");
  // Switch back to English tab
  await cdp.evaluate(`{
    const enTab = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('English'));
    if (enTab) enTab.click();
  }`);
  await sleep(500);

  // Type invalid placeholder into English draft
  const invalidText = "Hello {{unknown_placeholder}}!";
  await cdp.evaluate(`{
    const textarea = document.querySelectorAll('textarea')[0];
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    nativeSetter.call(textarea, ${JSON.stringify(invalidText)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  await sleep(500);

  const valBeforeSave = await cdp.evaluate("document.querySelectorAll('textarea')[0].value");
  log(`Flow 5 textarea value before save: '${valBeforeSave}'`);

  // Click Save
  await cdp.evaluate(`{
    const saveEnBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Save English Message'));
    if (saveEnBtn) {
      saveEnBtn.click();
    }
  }`);
  await sleep(1500);

  // Check what the page shows
  const bodyText = await cdp.evaluate("document.body.innerText");

  // Verify validation error appeared
  const hasErrorMsg = bodyText.includes('Unknown placeholder') || bodyText.includes('Validation error');
  if (!hasErrorMsg) {
    log(`Flow 5 debug text: ${bodyText.slice(0, 800)}`);
    fail("Flow 5: Expected validation error alert when unknown placeholder was submitted.");
  }

  // Verify draft is preserved in textarea
  const preservedDraft = await cdp.evaluate(`document.querySelectorAll('textarea')[0].value`);
  if (preservedDraft !== invalidText) {
    fail(`Flow 5: User input was cleared or lost on validation failure; got '${preservedDraft}'`);
  }

  // Verify database still has the original valid text
  const [currentEnInDb] = await pgClient`
    SELECT mt.body FROM message_translation mt
    JOIN language l ON l.id = mt.language_id
    WHERE l.code = 'en';
  `;
  if (currentEnInDb.body === invalidText) {
    fail("Flow 5: Database was updated with invalid placeholder!");
  }
  log("Flow 5 PASSED: Validation error shown, draft preserved in textarea, database unchanged.");

  // ==========================================
  // Flow 6: Check a 360px viewport for overflow and usable controls
  // ==========================================
  log("Flow 6: Testing 360px viewport responsiveness and touch targets...");
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
    fail(`Flow 6: Horizontal overflow detected at 360px: scrollWidth=${scrollWidth}, innerWidth=${innerWidth}`);
  }

  // Check interactive buttons minimum height
  const buttonHeights = await cdp.evaluate(`
    Array.from(document.querySelectorAll('button'))
      .filter(b => b.offsetWidth > 0 && b.offsetHeight > 0)
      .map(b => ({
        text: b.innerText.slice(0, 20),
        height: b.getBoundingClientRect().height
      }))
  `);

  const smallButtons = buttonHeights.filter((b) => b.height < 43.5);
  if (smallButtons.length > 0) {
    fail(`Flow 6: Found buttons with touch target < 44px: ${JSON.stringify(smallButtons.slice(0, 3))}`);
  }

  log(`Flow 6 PASSED: 0 horizontal overflow at 360px (scrollWidth=${scrollWidth}), touch targets >= 44px.`);

  await cdp.close();
  await cleanup();
  log("All 6 browser acceptance flows PASSED successfully!");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
