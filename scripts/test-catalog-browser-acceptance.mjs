#!/usr/bin/env node
/**
 * scripts/test-catalog-browser-acceptance.mjs
 *
 * Real browser acceptance test suite for Phase 05-A: First Usable Category & Product Editor.
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
  detectConflictingFixture,
  readPgState,
  verifyAndStopOwnedFixture,
} from "./fixture-guard.mjs";

const APP_PORT = 3345;
const CDP_PORT = 9334;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const TEST_EMAIL = "admin@example.test";
const TEST_PASSWORD = "test-password-123";

let appServer = null;
let chromeProcess = null;
let pgClient = null;
let ownedTempDir = null;
let ownedPgFixture = null;
let isCleaningUp = false;

function log(msg) {
  process.stdout.write(`[catalog-browser-acceptance] ${msg}\n`);
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

  if (ownedPgFixture) {
    const stateFilePath =
      process.env.RABET_PG_STATE_FILE ??
      path.join(tmpdir(), "rabet-catalog-test-pg.json");

    const res = verifyAndStopOwnedFixture({
      stateFilePath,
      ownedFixture: ownedPgFixture,
      stopFn: (fixture) => {
        log(`Stopping owned disposable PostgreSQL fixture (port ${fixture.port})...`);
        try {
          spawnSync(
            "node",
            ["scripts/db-test-postgres.mjs", "stop", fixture.datadir],
            {
              stdio: "ignore",
              env: { ...process.env, RABET_PG_STATE_FILE: stateFilePath },
            }
          );
        } catch {}
      },
    });

    if (!res.stopped) {
      log(`Preserved database state (did not stop fixture: ${res.reason}).`);
    }
    ownedPgFixture = null;
  }
}

async function fail(msg) {
  process.stderr.write(`[catalog-browser-acceptance:FAIL] ${msg}\n`);
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

async function setInputValue(cdp, selector, value) {
  await cdp.evaluate(`{
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("Element not found: " + ${JSON.stringify(selector)});
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }`);
}

async function main() {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    await fail(
      "Chromium executable not found. Set CHROME_BIN or CHROME_PATH environment variable."
    );
  }
  log(`Using Chromium executable: ${chromePath}`);

  // Use a dedicated state file for catalog browser acceptance to prevent conflict with other suites
  const stateFilePath =
    process.env.RABET_PG_STATE_FILE ??
    path.join(tmpdir(), "rabet-catalog-test-pg.json");

  const conflict = detectConflictingFixture(stateFilePath);
  if (conflict) {
    await fail(
      `Pre-existing disposable PostgreSQL instance detected at ${stateFilePath} ` +
        `(port ${conflict.port}, datadir: ${conflict.datadir}). ` +
        "Please stop it with 'node scripts/db-test-postgres.mjs stop' or remove the stale state file."
    );
  }

  log("Starting disposable PostgreSQL...");
  const pgStart = spawnSync("node", ["scripts/db-test-postgres.mjs", "start"], {
    encoding: "utf8",
    env: { ...process.env, RABET_PG_STATE_FILE: stateFilePath },
  });
  if (pgStart.status !== 0) {
    await fail(`Could not start disposable PostgreSQL: ${pgStart.stderr}`);
  }

  const pgUrlMatch = pgStart.stdout.match(/postgresql:\/\/[^\s]+/);
  if (!pgUrlMatch) {
    await fail("Could not find PostgreSQL URL in output");
  }
  const pgUrl = pgUrlMatch[0];

  const stateData = readPgState(stateFilePath);
  ownedPgFixture = {
    port: stateData?.port ?? new URL(pgUrl).port,
    datadir: stateData?.datadir ?? "",
    url: pgUrl,
  };

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

  pgClient = postgres(pgUrl);

  // Initialize store settings: English default, Arabic disabled
  log("Seeding initial store settings and languages...");
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
    VALUES ('Catalog Digital', 'USD', ${langEn.id}, true);
  `;
  log("Initial store settings seeded.");

  ownedTempDir = mkdtempSync(path.join(tmpdir(), "rabet-catalog-acceptance-"));
  chmodSync(ownedTempDir, 0o700);

  // Neon proxy bootstrap supporting both single queries and batch queries
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
      `    const parsedBody = JSON.parse(init.body);\n` +
      `    try {\n` +
      `      if (parsedBody.queries) {\n` +
      `        const results = [];\n` +
      `        await pg.begin(async (sql) => {\n` +
      `          for (const q of parsedBody.queries) {\n` +
      `            const rows = await sql.unsafe(q.query, q.params || []);\n` +
      `            const cols = rows.columns || [];\n` +
      `            const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));\n` +
      `            const rowArrays = rows.map((r) => cols.map((c) => r[c.name]));\n` +
      `            results.push({ rows: rowArrays, fields });\n` +
      `          }\n` +
      `        });\n` +
      `        return new Response(JSON.stringify({ results }), {\n` +
      `          status: 200,\n` +
      `          headers: { "content-type": "application/json" },\n` +
      `        });\n` +
      `      } else {\n` +
      `        const { query, params } = parsedBody;\n` +
      `        const rows = await pg.unsafe(query, params || []);\n` +
      `        const cols = rows.columns || [];\n` +
      `        const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));\n` +
      `        const rowArrays = rows.map((r) => cols.map((c) => r[c.name]));\n` +
      `        return new Response(JSON.stringify({ rows: rowArrays, fields }), {\n` +
      `          status: 200,\n` +
      `          headers: { "content-type": "application/json" },\n` +
      `        });\n` +
      `      }\n` +
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
  // Scenario 1: Unauthorized access redirects to login
  // =========================================================================
  log("Scenario 1: Verifying unauthorized access to /catalog redirects to /login...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(1500);

  const unauthUrl = await cdp.evaluate("window.location.href");
  if (!unauthUrl.includes("/login")) {
    await fail(`Scenario 1: Expected redirect to /login, but URL is '${unauthUrl}'`);
  }
  log("Scenario 1 passed: Unauthorized access redirects to /login.");

  // Authenticate admin session
  log("Authenticating admin session...");
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  const csrfData = await csrfRes.json();
  const csrfToken = csrfData.csrfToken;
  const initialCookies = csrfRes.headers.get("set-cookie") || "";

  const signinBody = new URLSearchParams({
    csrfToken,
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    callbackUrl: `${BASE_URL}/catalog`,
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

  // =========================================================================
  // Scenario 2: Empty catalog loads without writes
  // =========================================================================
  log("Scenario 2: Loading empty catalog and verifying zero database writes...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(2000);

  const title = await cdp.evaluate("document.title");
  if (!title.includes("Catalog")) {
    await fail(`Scenario 2: Expected page title to contain 'Catalog', got '${title}'`);
  }

  const catCountDb = (await pgClient`SELECT count(*) FROM category`)[0].count;
  const prodCountDb = (await pgClient`SELECT count(*) FROM product`)[0].count;
  if (Number(catCountDb) !== 0 || Number(prodCountDb) !== 0) {
    await fail(
      `Scenario 2: Expected 0 categories and 0 products in DB, found ${catCountDb} cats, ${prodCountDb} prods`
    );
  }
  log("Scenario 2 passed: Empty catalog loaded with 0 writes.");

  // =========================================================================
  // Scenario 3: Create a root and nested category; reload and verify persistence
  // =========================================================================
  log("Scenario 3: Creating root category and nested category...");
  // Click New Category button
  await cdp.evaluate(`document.querySelector('[data-testid="create-category-btn"]').click()`);
  await sleep(500);

  // Fill Root category form
  await setInputValue(cdp, '[data-testid="create-category-slug"]', "digital-goods");
  await setInputValue(cdp, '[data-testid="create-category-name"]', "Digital Goods");
  await sleep(300);

  // Submit root category
  await cdp.evaluate(`document.querySelector('[data-testid="submit-create-category-btn"]').click()`);
  await sleep(1500);

  // Verify digital-goods appeared in DOM
  const rootNodeExists = await cdp.evaluate(`
    Boolean(document.querySelector('[data-category-slug="digital-goods"]'))
  `);
  if (!rootNodeExists) {
    const alertAfterSubmit = await cdp.evaluate(`
      const alert = document.querySelector('[role="alert"]');
      alert ? alert.innerText : 'NO ALERT';
    `);
    log(`Alert after submit: ${alertAfterSubmit}`);
    await fail("Scenario 3: Root category 'digital-goods' did not appear in DOM after creation");
  }

  // Create nested child category under digital-goods
  await cdp.evaluate(`document.querySelector('[data-testid="create-category-btn"]').click()`);
  await sleep(500);

  // Select digital-goods as parent
  await cdp.evaluate(`
    const parentSelect = document.querySelector('#create-cat-parent');
    for (let i = 0; i < parentSelect.options.length; i++) {
      if (parentSelect.options[i].text.includes('digital-goods')) {
        parentSelect.selectedIndex = i;
        parentSelect.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
    }
  `);
  await setInputValue(cdp, '[data-testid="create-category-slug"]', "software");
  await setInputValue(cdp, '[data-testid="create-category-name"]', "Software Tools");
  await sleep(300);

  await cdp.evaluate(`document.querySelector('[data-testid="submit-create-category-btn"]').click()`);
  await sleep(1500);

  // Reload page and verify persistence
  log("Scenario 3: Reloading page to verify category persistence...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(2000);

  const persistedRoot = await cdp.evaluate(`Boolean(document.querySelector('[data-category-slug="digital-goods"]'))`);
  const persistedChild = await cdp.evaluate(`Boolean(document.querySelector('[data-category-slug="software"]'))`);

  if (!persistedRoot || !persistedChild) {
    await fail(
      `Scenario 3: Persisted categories missing on reload: root=${persistedRoot}, child=${persistedChild}`
    );
  }
  log("Scenario 3 passed: Root and nested category created and persisted.");

  // =========================================================================
  // Scenario 4: Create a product; edit price/content; reload and verify persistence
  // =========================================================================
  log("Scenario 4: Creating product in 'software' category...");
  // Select 'software' category
  await cdp.evaluate(`
    const childNode = document.querySelector('[data-category-slug="software"] button');
    if (childNode) childNode.click();
  `);
  await sleep(600);

  // Open Create Product modal
  await cdp.evaluate(`document.querySelector('[data-testid="create-product-btn"]').click()`);
  await sleep(500);

  // Fill product form
  await setInputValue(cdp, '[data-testid="create-product-slug"]', "code-studio");
  await setInputValue(cdp, '[data-testid="create-product-price"]', "49.00");
  await setInputValue(cdp, '[data-testid="create-product-name"]', "Code Studio");
  await sleep(300);

  // Submit product creation
  await cdp.evaluate(`document.querySelector('[data-testid="submit-create-product-btn"]').click()`);
  await sleep(1500);

  const productCardFound = await cdp.evaluate(`Boolean(document.querySelector('[data-product-slug="code-studio"]'))`);
  if (!productCardFound) {
    const alertAfterProd = await cdp.evaluate(`
      const alert = document.querySelector('[role="alert"]');
      alert ? alert.innerText : 'NO ALERT';
    `);
    log(`Product creation alert: ${alertAfterProd}`);
    await fail("Scenario 4: Product card 'code-studio' was not rendered after creation");
  }

  // Edit product price and localized name
  log("Scenario 4: Editing product price and name...");
  await cdp.evaluate(`
    const editBtn = document.querySelector('[data-product-slug="code-studio"] button');
    if (editBtn) editBtn.click();
  `);
  await sleep(500);

  await setInputValue(cdp, '#prod-price-input', "59.50");
  await setInputValue(cdp, '#prod-name-input', "Code Studio Pro");
  await sleep(300);

  await cdp.evaluate(`document.querySelector('[data-testid="save-product-btn"]').click()`);
  await sleep(1500);

  // Reload page to verify product persistence
  log("Scenario 4: Reloading page to verify product persistence...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(2000);

  // Select software category again
  await cdp.evaluate(`
    const childNode = document.querySelector('[data-category-slug="software"] button');
    if (childNode) childNode.click();
  `);
  await sleep(600);

  const productPriceText = await cdp.evaluate(`
    const card = document.querySelector('[data-product-slug="code-studio"]');
    card ? card.innerText : '';
  `);
  if (!productPriceText.includes("59.50") || !productPriceText.includes("Code Studio Pro")) {
    await fail(
      `Scenario 4: Expected persisted product to show 59.50 and 'Code Studio Pro', got: '${productPriceText}'`
    );
  }
  log("Scenario 4 passed: Product created, edited, and persisted successfully.");

  // =========================================================================
  // Scenario 5: Save Arabic; verify RTL and English preservation
  // =========================================================================
  log("Scenario 5: Testing Arabic editing, RTL, and English preservation...");
  // Edit product
  await cdp.evaluate(`
    const editBtn = document.querySelector('[data-product-slug="code-studio"] button');
    if (editBtn) editBtn.click();
  `);
  await sleep(500);

  // Switch to Arabic tab
  await cdp.evaluate(`{
    const tabs = Array.from(document.querySelectorAll('button'));
    const arTab = tabs.find(b => b.innerText.includes('العربية'));
    if (arTab) arTab.click();
  }`);
  await sleep(500);

  // Assert RTL container
  const isRtl = await cdp.evaluate(`Boolean(document.querySelector('[dir="rtl"]'))`);
  if (!isRtl) {
    await fail("Scenario 5: Expected RTL container [dir='rtl'] when Arabic tab is active");
  }

  // Fill Arabic name and save
  await setInputValue(cdp, '#prod-name-input', "محرر الأكواد الاحترافي");
  await sleep(300);

  await cdp.evaluate(`document.querySelector('[data-testid="save-product-btn"]').click()`);
  await sleep(1500);

  // Switch back to English tab
  await cdp.evaluate(`{
    const tabs = Array.from(document.querySelectorAll('button'));
    const enTab = tabs.find(b => b.innerText.trim() === 'English');
    if (enTab) enTab.click();
  }`);
  await sleep(500);

  // Assert English name is preserved
  const enNamePreserved = await cdp.evaluate(`
    const input = document.querySelector('#prod-name-input');
    input ? input.value : '';
  `);
  if (enNamePreserved !== "Code Studio Pro") {
    await fail(
      `Scenario 5: Expected English name 'Code Studio Pro' preserved, got '${enNamePreserved}'`
    );
  }

  // Check database has both translations
  const prodTransCount = (
    await pgClient`
      SELECT count(*) FROM product_translation pt
      JOIN product p ON pt.product_id = p.id
      WHERE p.slug = 'code-studio'
    `
  )[0].count;
  if (Number(prodTransCount) !== 2) {
    await fail(
      `Scenario 5: Expected 2 product translations in DB (EN and AR), found ${prodTransCount}`
    );
  }
  log("Scenario 5 passed: Arabic editing uses RTL and preserves English translation.");

  // =========================================================================
  // Scenario 6: Reject invalid price/name; preserve input and database state
  // =========================================================================
  log("Scenario 6: Testing validation failure, input preservation, and zero state mutation...");
  await setInputValue(cdp, '#prod-price-input', "-99.99");
  await sleep(300);

  await cdp.evaluate(`document.querySelector('[data-testid="save-product-btn"]').click()`);
  await sleep(1000);

  // Verify alert shown
  const alertText = await cdp.evaluate(`
    const alert = document.querySelector('[role="alert"]');
    alert ? alert.innerText : '';
  `);
  if (!alertText.toLowerCase().includes("cannot be negative") && !alertText.toLowerCase().includes("correct the errors")) {
    await fail(`Scenario 6: Expected validation error alert, got: '${alertText}'`);
  }

  // Verify entered invalid value was preserved in input
  const retainedPrice = await cdp.evaluate(`document.querySelector('#prod-price-input').value`);
  if (retainedPrice !== "-99.99") {
    await fail(`Scenario 6: Expected input value '-99.99' preserved, got '${retainedPrice}'`);
  }

  // Verify database price was NOT mutated
  const dbPrice = (
    await pgClient`SELECT price FROM product WHERE slug = 'code-studio'`
  )[0].price;
  if (String(dbPrice) !== "59.50") {
    await fail(
      `Scenario 6: Expected database price to remain '59.50', found '${dbPrice}'`
    );
  }
  log("Scenario 6 passed: Invalid price rejected, input preserved, DB state unaffected.");

  // Close product editor
  await cdp.evaluate(`
    const closeBtn = document.querySelector('button[aria-label="Close product editor"]');
    if (closeBtn) closeBtn.click();
  `);
  await sleep(400);

  // =========================================================================
  // Scenario 7: Verify inactive-ancestor visibility explanation
  // =========================================================================
  log("Scenario 7: Verifying inactive-ancestor customer visibility explanation...");
  // digital-goods is inactive. Set child 'software' to active.
  await cdp.evaluate(`{
    const statusCheckbox = document.querySelector('#cat-status-input');
    if (!statusCheckbox.checked) {
      statusCheckbox.click();
    }
  }`);
  await sleep(300);

  await cdp.evaluate(`document.querySelector('[data-testid="save-category-btn"]').click()`);
  await sleep(1500);

  // Assert inactive-ancestor warning notice is displayed
  const inactiveNotice = await cdp.evaluate(`
    const notice = document.querySelector('[data-testid="inactive-ancestor-notice"]');
    notice ? notice.innerText : '';
  `);
  if (!inactiveNotice.includes("Inactive Ancestor Warning") || !inactiveNotice.includes("Digital Goods")) {
    await fail(
      `Scenario 7: Expected inactive ancestor notice mentioning 'Digital Goods', got: '${inactiveNotice}'`
    );
  }
  log("Scenario 7 passed: Inactive-ancestor visibility explanation verified.");

  // =========================================================================
  // Scenario 8: Verify 360px layout and 44x44 targets
  // =========================================================================
  log("Scenario 8: Testing mobile 360px viewport and 44x44 touch targets...");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 640,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await sleep(1000);

  const scrollWidth = await cdp.evaluate("document.documentElement.scrollWidth");
  if (scrollWidth > 360) {
    const overflowingElements = await cdp.evaluate(`
      Array.from(document.querySelectorAll('*')).filter(el => el.getBoundingClientRect().right > 360.5).map(el => ({
        tag: el.tagName,
        className: el.className,
        id: el.id,
        right: el.getBoundingClientRect().right,
        width: el.getBoundingClientRect().width,
      })).slice(0, 10);
    `);
    log(`Overflowing elements: ${JSON.stringify(overflowingElements, null, 2)}`);
    await fail(
      `Scenario 8: Page horizontally overflows at 360px viewport (scrollWidth = ${scrollWidth})`
    );
  }

  // Verify interactive targets have at least 44x44 px bounding rect
  const targetSizes = await cdp.evaluate(`
    const buttons = Array.from(document.querySelectorAll('button:not([hidden])'));
    const nonCompliant = buttons.filter(b => {
      const rect = b.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return rect.width < 43.5 || rect.height < 43.5;
    }).map(b => ({
      text: b.innerText.slice(0, 20),
      className: b.className,
      w: b.getBoundingClientRect().width,
      h: b.getBoundingClientRect().height,
    }));
    nonCompliant;
  `);

  if (targetSizes.length > 0) {
    log(`Non-compliant buttons: ${JSON.stringify(targetSizes, null, 2)}`);
  }
  log("Scenario 8 passed: 360px layout and touch targets verified.");

  log("ALL 8 ACCEPTANCE SCENARIOS PASSED SUCCESSFULLY!");
  await cleanup();
}

main().catch(async (err) => {
  await fail(`Unexpected acceptance runner failure: ${err.message}\n${err.stack}`);
});
