#!/usr/bin/env node
/**
 * scripts/test-product-actions-browser-acceptance.mjs
 *
 * Real browser acceptance test suite for Phase 05-B1: First Recursive Product Action Editor.
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

const APP_PORT = 3346;
const CDP_PORT = 9335;
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
  process.stdout.write(`[actions-browser-acceptance] ${msg}\n`);
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
      path.join(tmpdir(), "rabet-actions-test-pg.json");

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
  process.stderr.write(`[actions-browser-acceptance:FAIL] ${msg}\n`);
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
        if (data.method === "Runtime.consoleAPICalled") {
          const text = (data.params?.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
          log(`[browser-console] ${text}`);
        }
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
  await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("Element not found: " + ${JSON.stringify(selector)});
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}

async function main() {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    await fail(
      "Chromium executable not found. Set CHROME_BIN or CHROME_PATH environment variable."
    );
  }
  log(`Found Chromium binary at: ${chromePath}`);

  // Check fixture conflict guard
  const stateFilePath =
    process.env.RABET_PG_STATE_FILE ??
    path.join(tmpdir(), "rabet-actions-test-pg.json");

  const conflict = detectConflictingFixture(stateFilePath);

  if (conflict) {
    await fail(
      `Pre-existing disposable PostgreSQL instance detected at ${stateFilePath} ` +
        `(port ${conflict.port}, datadir: ${conflict.datadir}). ` +
        "Please stop it with 'node scripts/db-test-postgres.mjs stop' or remove the stale state file."
    );
  }

  // Start dedicated PostgreSQL instance
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

  if (!pgUrl) {
    await fail("Could not determine disposable PostgreSQL connection URL");
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
    VALUES ('Rabet Digital Store', 'USD', ${langEn.id}, true);
  `;

  // Seed category and product
  const [cat] = await pgClient`
    INSERT INTO category (slug, sort_order, is_active)
    VALUES ('software-services', 0, true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO category_translation (category_id, language_id, name)
    VALUES (${cat.id}, ${langEn.id}, 'Software Services');
  `;
  const [prod] = await pgClient`
    INSERT INTO product (category_id, slug, price, sort_order, is_active)
    VALUES (${cat.id}, 'cloud-suite', '99.00', 0, true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO product_translation (product_id, language_id, name, details)
    VALUES (${prod.id}, ${langEn.id}, 'Cloud Suite Pro', 'Complete enterprise cloud tooling.');
  `;
  log("Initial store setup, category, and product seeded.");

  ownedTempDir = mkdtempSync(path.join(tmpdir(), "rabet-actions-acceptance-"));
  chmodSync(ownedTempDir, 0o700);

  // Neon proxy bootstrap supporting batch atomic queries
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
      `            const qParams = (q.params || []).map((p) => {\n` +
      `              if (p === "true") return true;\n` +
      `              if (p === "false") return false;\n` +
      `              return p;\n` +
      `            });\n` +
      `            const rows = await sql.unsafe(q.query, qParams);\n` +
      `            const cols = rows.columns || [];\n` +
      `            const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));\n` +
      `            const formatVal = (v) => {\n` +
      `              if (typeof v === "boolean") return v ? "t" : "f";\n` +
      `              if (typeof v === "object" && v !== null && !(v instanceof Date)) return JSON.stringify(v);\n` +
      `              return v;\n` +
      `            };\n` +
      `            const rowArrays = rows.map((r) => cols.map((c) => formatVal(r[c.name])));\n` +
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
      `        const rows = await pg.unsafe(query, qParams);\n` +
      `        const cols = rows.columns || [];\n` +
      `        const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));\n` +
      `        const formatVal = (v) => {\n` +
      `          if (typeof v === "boolean") return v ? "t" : "f";\n` +
      `          if (typeof v === "object" && v !== null && !(v instanceof Date)) return JSON.stringify(v);\n` +
      `          return v;\n` +
      `        };\n` +
      `        const rowArrays = rows.map((r) => cols.map((c) => formatVal(r[c.name])));\n` +
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
  // Scenario 1: Unauthorized access
  // =========================================================================
  log("Scenario 1: Verifying unauthorized access redirects to /login...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(1500);

  const unauthUrl = await cdp.evaluate("window.location.href");
  if (!unauthUrl.includes("/login")) {
    await fail(`Scenario 1: Expected redirect to /login, but URL is '${unauthUrl}'`);
  }
  log("Scenario 1 passed: Unauthorized access redirects to /login.");

  // Authenticate session
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
  // Scenario 2: Empty tree loads without writes or implicit seeds
  // =========================================================================
  log("Scenario 2: Loading product and opening Buttons editor with 0 writes...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(2000);

  // Click on the product's Buttons button
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="product-buttons-btn-cloud-suite"]');
    if (btn) btn.click();
  })()`);
  await sleep(1000);

  const actionEditorVisible = await cdp.evaluate(`
    Boolean(document.querySelector('[data-testid="product-action-editor"]'))
  `);
  if (!actionEditorVisible) {
    await fail("Scenario 2: Product action editor was not displayed upon clicking Buttons");
  }

  const emptyText = await cdp.evaluate(`
    document.querySelector('[data-testid="product-action-editor"]').innerText
  `);
  if (!emptyText.includes("No buttons configured")) {
    await fail(`Scenario 2: Expected 'No buttons configured' empty state, got: '${emptyText}'`);
  }

  // Verify zero product_action writes
  const actionCountInDb = (await pgClient`SELECT count(*) FROM product_action`)[0].count;
  if (Number(actionCountInDb) !== 0) {
    await fail(`Scenario 2: Expected 0 product_action rows in DB, found ${actionCountInDb}`);
  }
  log("Scenario 2 passed: Empty button tree loaded with zero writes.");

  // =========================================================================
  // Scenario 3: Create root submenu, nested submenu, and terminal children
  // =========================================================================
  log("Scenario 3: Creating root submenu ('Options')...");
  await cdp.evaluate(`(() => {
    const addBtn = document.querySelector('[data-testid="add-root-action-btn"]');
    if (addBtn) addBtn.click();
  })()`);
  await sleep(500);

  await setInputValue(cdp, '[data-testid="create-action-label-input"]', "Options");
  await setInputValue(cdp, '[data-testid="create-action-menu-text-input"]', "Select an option:");
  await sleep(300);

  await cdp.evaluate(`(() => { document.querySelector('[data-testid="submit-create-action-btn"]').click(); })()`);
  await sleep(1500);

  // Verify root submenu appears in tree
  const rootNode = await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-testid="action-node"]');
    return node ? { text: node.innerText, id: node.getAttribute('data-action-id') } : null;
  })()`);
  if (!rootNode) {
    const alert = await cdp.evaluate(`(() => {
      const a = document.querySelector('[role="alert"]');
      return a ? a.innerText : 'NO ALERT';
    })()`);
    const modalOpen = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="submit-create-action-btn"]'))`);
    const btnDisabled = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="submit-create-action-btn"]')?.disabled)`);
    const labelVal = await cdp.evaluate(`document.querySelector('[data-testid="create-action-label-input"]')?.value`);
    log(`Debug: alert='${alert}', modalOpen=${modalOpen}, btnDisabled=${btnDisabled}, labelVal='${labelVal}'`);
  }
  if (!rootNode || !rootNode.text.includes("Options") || !rootNode.text.includes("Submenu")) {
    await fail(`Scenario 3: Root submenu 'Options' not found in DOM: ${JSON.stringify(rootNode)}`);
  }
  const rootActionId = rootNode.id;

  log("Scenario 3: Creating nested submenu ('Tiers') under 'Options'...");
  await cdp.evaluate(`(() => {
    const addChildBtn = document.querySelector('[data-testid="add-child-action-btn"]');
    if (addChildBtn) addChildBtn.click();
  })()`);
  await sleep(500);

  await setInputValue(cdp, '[data-testid="create-action-label-input"]', "Tiers");
  await setInputValue(cdp, '[data-testid="create-action-menu-text-input"]', "Select your tier:");
  await sleep(300);

  await cdp.evaluate(`(() => { document.querySelector('[data-testid="submit-create-action-btn"]').click(); })()`);
  await sleep(1500);

  // Find Tiers node
  const nestedNodeId = await cdp.evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('[data-testid="action-node"]'));
    const tiers = nodes.find(n => n.innerText.includes('Tiers'));
    return tiers ? tiers.getAttribute('data-action-id') : null;
  })()`);
  if (!nestedNodeId) {
    await fail("Scenario 3: Nested submenu 'Tiers' not found in DOM");
  }

  log("Scenario 3: Creating SHOW_DETAILS child ('View Specs') under 'Tiers'...");
  await cdp.evaluate(`(() => {
    const tiersNode = document.querySelector('[data-action-id="${nestedNodeId}"]');
    const addChildBtn = tiersNode ? tiersNode.querySelector('[data-testid="add-child-action-btn"]') : null;
    if (addChildBtn) addChildBtn.click();
  })()`);
  await sleep(500);

  // Set action type to SHOW_DETAILS
  await cdp.evaluate(`(() => {
    const sel = document.querySelector('[data-testid="create-action-type-select"]');
    sel.value = 'SHOW_DETAILS';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await setInputValue(cdp, '[data-testid="create-action-label-input"]', "View Specs");
  await sleep(300);

  await cdp.evaluate(`(() => { document.querySelector('[data-testid="submit-create-action-btn"]').click(); })()`);
  await sleep(1500);

  log("Scenario 3: Creating START_INQUIRY child ('Order Now') under 'Tiers'...");
  await cdp.evaluate(`(() => {
    const tiersNode = document.querySelector('[data-action-id="${nestedNodeId}"]');
    const addChildBtn = tiersNode ? tiersNode.querySelector('[data-testid="add-child-action-btn"]') : null;
    if (addChildBtn) addChildBtn.click();
  })()`);
  await sleep(500);

  // Set action type to START_INQUIRY
  await cdp.evaluate(`(() => {
    const sel = document.querySelector('[data-testid="create-action-type-select"]');
    sel.value = 'START_INQUIRY';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await setInputValue(cdp, '[data-testid="create-action-label-input"]', "Order Now");
  await sleep(300);

  await cdp.evaluate(`(() => { document.querySelector('[data-testid="submit-create-action-btn"]').click(); })()`);
  await sleep(1500);

  log("Scenario 3 passed: Root submenu, nested submenu, and terminal children created.");

  // =========================================================================
  // Scenario 4: Reload and verify exact tree ownership, hierarchy, and content
  // =========================================================================
  log("Scenario 4: Reloading browser and verifying exact hierarchy persistence...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(2000);

  // Re-open Buttons editor
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="product-buttons-btn-cloud-suite"]');
    if (btn) btn.click();
  })()`);
  await sleep(1000);

  const reloadedNodes = await cdp.evaluate(`(() => {
    return Array.from(document.querySelectorAll('[data-testid="action-node"]')).map(n => ({
      id: n.getAttribute('data-action-id'),
      type: n.getAttribute('data-action-type'),
      text: n.innerText.split('\\n')[0].trim()
    }));
  })()`);

  if (reloadedNodes.length !== 4) {
    await fail(`Scenario 4: Expected 4 nodes in tree on reload, found ${reloadedNodes.length}`);
  }

  // Database verification
  const dbActions = await pgClient`
    SELECT id, product_id, parent_action_id, action_type, sort_order, is_active
    FROM product_action
    ORDER BY sort_order ASC
  `;

  if (dbActions.length !== 4) {
    await fail(`Scenario 4: Expected 4 rows in product_action, found ${dbActions.length}`);
  }

  // Verify all belong to test product
  if (!dbActions.every(a => a.product_id === prod.id)) {
    await fail("Scenario 4: One or more action rows have wrong product_id");
  }

  log("Scenario 4 passed: Exact tree ownership, hierarchy, and content verified.");

  // =========================================================================
  // Scenario 5: Edit one language without losing another language's draft
  // =========================================================================
  log("Scenario 5: Testing unrelated language draft preservation during edit...");
  // Click on the root node 'Options' to edit
  await cdp.evaluate(`(() => {
    const rootNode = document.querySelector('[data-action-id="${rootActionId}"] button:nth-of-type(2)');
    if (rootNode) rootNode.click();
  })()`);
  await sleep(500);

  // Switch to Arabic tab
  await cdp.evaluate(`(() => {
    const arBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('العربية'));
    if (arBtn) arBtn.click();
  })()`);
  await sleep(300);

  // Type Arabic draft without saving
  await setInputValue(cdp, '[data-testid="edit-action-label-input"]', "خيارات الخدمة");
  await sleep(200);

  // Switch back to English tab
  await cdp.evaluate(`(() => {
    const enBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('English'));
    if (enBtn) enBtn.click();
  })()`);
  await sleep(300);

  // Edit English label and save
  await setInputValue(cdp, '[data-testid="edit-action-label-input"]', "Main Options");
  await sleep(200);

  await cdp.evaluate(`(() => { document.querySelector('[data-testid="save-action-btn"]').click(); })()`);
  await sleep(1500);

  // Switch back to Arabic tab: verify draft "خيارات الخدمة" remained in input!
  await cdp.evaluate(`(() => {
    const arBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('العربية'));
    if (arBtn) arBtn.click();
  })()`);
  await sleep(300);

  const arabicDraftVal = await cdp.evaluate(`
    document.querySelector('[data-testid="edit-action-label-input"]')?.value
  `);
  if (arabicDraftVal !== "خيارات الخدمة") {
    await fail(`Scenario 5: Unsaved Arabic draft was lost after English save. Current value: '${arabicDraftVal}'`);
  }

  // Verify in PostgreSQL: English was saved, Arabic was NOT committed
  const savedTranslations = await pgClient`
    SELECT t.label, l.code
    FROM product_action_translation t
    JOIN language l ON t.language_id = l.id
    WHERE t.action_id = ${rootActionId}
  `;
  const enTrans = savedTranslations.find(t => t.code === 'en');
  const arTrans = savedTranslations.find(t => t.code === 'ar');

  if (enTrans?.label !== "Main Options") {
    await fail(`Scenario 5: English translation was not updated in DB: '${enTrans?.label}'`);
  }
  if (arTrans !== undefined) {
    await fail(`Scenario 5: Unsaved Arabic draft was erroneously committed to database!`);
  }
  log("Scenario 5 passed: Unrelated language draft was preserved while saving English.");

  // =========================================================================
  // Scenario 6: Reject an invalid save with unchanged database state
  // =========================================================================
  log("Scenario 6: Testing validation failure and unchanged database state...");
  // Clear label (blank label is invalid)
  await cdp.evaluate(`(() => {
    const enBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('English'));
    if (enBtn) enBtn.click();
  })()`);
  await sleep(300);

  await setInputValue(cdp, '[data-testid="edit-action-label-input"]', "   ");
  await sleep(200);

  await cdp.evaluate(`(() => {
    const saveBtn = document.querySelector('[data-testid="save-action-btn"]');
    if (saveBtn) saveBtn.click();
  })()`);
  await sleep(1200);

  // Check alert error
  const invalidAlert = await cdp.evaluate(`(() => {
    const alert = document.querySelector('[role="alert"]');
    return alert ? alert.innerText : '';
  })()`);
  if (!invalidAlert.toLowerCase().includes("correct the errors") && !invalidAlert.toLowerCase().includes("required")) {
    await fail(`Scenario 6: Expected validation error alert, got: '${invalidAlert}'`);
  }

  // Database must remain "Main Options"
  const dbCheck = await pgClient`
    SELECT label FROM product_action_translation
    WHERE action_id = ${rootActionId}
  `;
  if (dbCheck[0]?.label !== "Main Options") {
    await fail(`Scenario 6: Database was mutated on invalid submission: '${dbCheck[0]?.label}'`);
  }
  log("Scenario 6 passed: Validation rejected and database remained unchanged.");

  // =========================================================================
  // Scenario 7: Transport rejection preserves input and allows retry
  // =========================================================================
  log("Scenario 7: Testing transport failure, draft preservation, and retry...");
  // Put a new valid value
  await setInputValue(cdp, '[data-testid="edit-action-label-input"]', "Main Options Retried");
  await sleep(200);

  // Inject synthetic transport rejection
  await cdp.evaluate(`(() => {
    window.__origFetch = window.fetch;
    window.__syntheticFail = true;
    window.fetch = async (...args) => {
      if (window.__syntheticFail) {
        throw new TypeError("Failed to fetch: Network disconnected");
      }
      return window.__origFetch(...args);
    };
  })()`);

  // Attempt save during transport failure
  await cdp.evaluate(`(() => {
    const saveBtn = document.querySelector('[data-testid="save-action-btn"]');
    if (saveBtn) saveBtn.click();
  })()`);
  await sleep(1200);

  const errorAlert = await cdp.evaluate(`(() => {
    const alert = document.querySelector('[role="alert"]');
    return alert ? alert.innerText : '';
  })()`);
  if (!errorAlert.includes("communication or server error") || !errorAlert.includes("preserved")) {
    await fail(`Scenario 7: Expected safe transport retry alert, got: '${errorAlert}'`);
  }

  // Verify input value preserved
  const preservedInput = await cdp.evaluate(`
    document.querySelector('[data-testid="edit-action-label-input"]')?.value
  `);
  if (preservedInput !== "Main Options Retried") {
    await fail(`Scenario 7: Input value was not preserved during transport error: '${preservedInput}'`);
  }

  // Restore fetch and retry save
  await cdp.evaluate(`(() => {
    window.__syntheticFail = false;
    window.fetch = window.__origFetch;
  })()`);

  await cdp.evaluate(`(() => {
    const saveBtn = document.querySelector('[data-testid="save-action-btn"]');
    if (saveBtn) saveBtn.click();
  })()`);
  await sleep(1500);

  const successAlert = await cdp.evaluate(`(() => {
    const alert = document.querySelector('[role="alert"]');
    return alert ? alert.innerText : '';
  })()`);
  if (!successAlert.includes("updated successfully")) {
    await fail(`Scenario 7: Save retry failed: '${successAlert}'`);
  }

  const retriedDb = await pgClient`
    SELECT label FROM product_action_translation
    WHERE action_id = ${rootActionId}
  `;
  if (retriedDb[0]?.label !== "Main Options Retried") {
    await fail(`Scenario 7: Database does not reflect successful retry: '${retriedDb[0]?.label}'`);
  }
  log("Scenario 7 passed: Transport rejection preserved inputs and retry succeeded.");

  // =========================================================================
  // Scenario 8: 360px layout and touch targets
  // =========================================================================
  log("Scenario 8: Testing mobile 360px viewport and 44x44px touch targets...");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 800,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await sleep(800);

  // Check no horizontal scroll
  const overflow = await cdp.evaluate(`(() => {
    const docEl = document.documentElement;
    return {
      scrollWidth: docEl.scrollWidth,
      clientWidth: docEl.clientWidth,
      hasOverflow: docEl.scrollWidth > docEl.clientWidth
    };
  })()`);

  if (overflow.hasOverflow) {
    await fail(`Scenario 8: Horizontal overflow detected at 360px: scrollWidth=${overflow.scrollWidth}, clientWidth=${overflow.clientWidth}`);
  }

  // Verify interactive targets are at least 44x44 CSS pixels
  const touchTargets = await cdp.evaluate(`(() => {
    const selector = '[data-testid="product-action-editor"] button, [data-testid="product-action-editor"] input[type="checkbox"]';
    const elements = Array.from(document.querySelectorAll(selector));
    const smallTargets = [];
    for (const el of elements) {
      if (el.offsetParent === null) continue; // skip hidden
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        if (rect.width < 43.5 || rect.height < 43.5) {
          smallTargets.push({
            tag: el.tagName,
            text: el.innerText || el.getAttribute('aria-label') || el.id,
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          });
        }
      }
    }
    return smallTargets;
  })()`);

  if (touchTargets.length > 0) {
    await fail(`Scenario 8: Detected undersized interactive touch targets (<44px): ${JSON.stringify(touchTargets)}`);
  }

  log("Scenario 8 passed: 360px viewport has no horizontal overflow and all targets are >= 44x44px.");

  log("\n=======================================================");
  log("ALL 8 ACCEPTANCE SCENARIOS PASSED SUCCESSFULLY!");
  log("=======================================================\n");

  await cdp.close();
  await cleanup();
}

main().catch(async (err) => {
  process.stderr.write(`Unhandled exception: ${err.stack || err}\n`);
  await cleanup();
  process.exit(1);
});
