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
    INSERT INTO bot_setting (display_name, currency, default_language_id, ask_for_language, support_category)
    VALUES ('Rabet Digital Store', 'USD', ${langEn.id}, true, ARRAY['Warranty', 'General Inquiries', 'Returns']);
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
      `              if (Array.isArray(v)) return "{" + v.map((item) => JSON.stringify(String(item))).join(",") + "}";\n` +
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
      `          if (Array.isArray(v)) return "{" + v.map((item) => JSON.stringify(String(item))).join(",") + "}";\n` +
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

  log("Scenario 3: Creating START_INQUIRY child ('Ask about this product') under 'Tiers'...");
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
  await setInputValue(cdp, '[data-testid="create-action-label-input"]', "Ask about this product");
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

  // Exact Database verification: ownership, types, relationships, sort orders, and labels
  const dbActions = await pgClient`
    SELECT a.id, a.product_id, a.parent_action_id, a.action_type, a.sort_order, a.is_active, t.label
    FROM product_action a
    JOIN product_action_translation t ON a.id = t.action_id
    WHERE a.product_id = ${prod.id}
    ORDER BY a.sort_order ASC, a.created_at ASC
  `;

  if (dbActions.length !== 4) {
    await fail(`Scenario 4: Expected 4 rows for product ${prod.id}, found ${dbActions.length}`);
  }

  const dbRoot = dbActions.find(a => a.parent_action_id === null);
  if (!dbRoot || dbRoot.action_type !== "OPEN_SUBMENU" || dbRoot.label !== "Options" || dbRoot.sort_order !== 0) {
    await fail(`Scenario 4: Root action failed contract: ${JSON.stringify(dbRoot)}`);
  }

  const dbTiers = dbActions.find(a => a.parent_action_id === dbRoot.id);
  if (!dbTiers || dbTiers.action_type !== "OPEN_SUBMENU" || dbTiers.label !== "Tiers" || dbTiers.sort_order !== 0) {
    await fail(`Scenario 4: Nested submenu 'Tiers' failed contract: ${JSON.stringify(dbTiers)}`);
  }

  const dbSpecs = dbActions.find(a => a.parent_action_id === dbTiers.id && a.action_type === "SHOW_DETAILS");
  if (!dbSpecs || dbSpecs.label !== "View Specs" || dbSpecs.sort_order !== 0) {
    await fail(`Scenario 4: Terminal 'SHOW_DETAILS' failed contract: ${JSON.stringify(dbSpecs)}`);
  }

  const dbInquiry = dbActions.find(a => a.parent_action_id === dbTiers.id && a.action_type === "START_INQUIRY");
  if (!dbInquiry || dbInquiry.label !== "Ask about this product" || dbInquiry.sort_order !== 1) {
    await fail(`Scenario 4: Terminal 'START_INQUIRY' failed contract: ${JSON.stringify(dbInquiry)}`);
  }

  // Verify DOM rendered text corresponds to saved content
  const domRoot = reloadedNodes.find(n => n.id === dbRoot.id);
  const domTiers = reloadedNodes.find(n => n.id === dbTiers.id);
  const domSpecs = reloadedNodes.find(n => n.id === dbSpecs.id);
  const domInquiry = reloadedNodes.find(n => n.id === dbInquiry.id);

  if (!domRoot || !domRoot.text.includes("Options")) {
    await fail("Scenario 4: DOM missing root 'Options' node");
  }
  if (!domTiers || !domTiers.text.includes("Tiers")) {
    await fail("Scenario 4: DOM missing nested 'Tiers' node");
  }
  if (!domSpecs || !domSpecs.text.includes("View Specs")) {
    await fail("Scenario 4: DOM missing 'View Specs' node");
  }
  if (!domInquiry || !domInquiry.text.includes("Ask about this product")) {
    await fail("Scenario 4: DOM missing 'Ask about this product' node");
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

  // =========================================================================
  // Scenario 9: Delayed-response regression & product switch safety
  // =========================================================================
  log("Scenario 9: Testing delayed-response reconciliation and product switch safety...");
  // Reset viewport to desktop
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(500);

  // 1. Delayed save regression
  // Select Action A (root)
  await cdp.evaluate(`(() => {
    const rootBtn = document.querySelector('[data-action-id="${rootActionId}"] button:nth-of-type(2)');
    if (rootBtn) rootBtn.click();
  })()`);
  await sleep(400);

  await setInputValue(cdp, '[data-testid="edit-action-label-input"]', "Main Options Delayed");
  await sleep(200);

  // Inject artificial delay into fetch
  await cdp.evaluate(`(() => {
    window.__origFetch = window.fetch;
    window.fetch = async (...args) => {
      await new Promise(r => setTimeout(r, 1200));
      return window.__origFetch(...args);
    };
  })()`);

  // Trigger Save on Action A
  await cdp.evaluate(`(() => {
    const saveBtn = document.querySelector('[data-testid="save-action-btn"]');
    if (saveBtn) saveBtn.click();
  })()`);
  await sleep(200);

  // Attempt to select Action B while Action A is pending (disabled in UI)
  await cdp.evaluate(`(() => {
    const bBtn = document.querySelector('[data-action-id="${nestedNodeId}"] button:nth-of-type(2)');
    if (bBtn) bBtn.click();
  })()`);

  // Wait for Action A save to complete
  await sleep(1800);

  // Now select Action B
  await cdp.evaluate(`(() => {
    const bBtn = document.querySelector('[data-action-id="${nestedNodeId}"] button:nth-of-type(2)');
    if (bBtn) bBtn.click();
  })()`);
  await sleep(500);

  const actionBValue = await cdp.evaluate(`(() => {
    return document.querySelector('[data-testid="edit-action-label-input"]')?.value;
  })()`);

  if (actionBValue !== "Tiers") {
    await fail(`Scenario 9: Action B draft was corrupted by delayed response of Action A: '${actionBValue}'`);
  }

  // Restore fetch
  await cdp.evaluate(`(() => {
    window.fetch = window.__origFetch;
  })()`);

  // 2. Delayed product load safety
  // Create second product in database
  const [prod2] = await pgClient`
    INSERT INTO product (id, category_id, slug, price, sort_order, is_active)
    VALUES (${crypto.randomUUID()}, ${cat.id}, 'cloud-suite-two', '29.99', 1, true)
    RETURNING id
  `;
  await pgClient`
    INSERT INTO product_translation (product_id, language_id, name)
    VALUES (${prod2.id}, ${langEn.id}, 'Cloud Suite Two')
  `;

  // Navigate back to catalog
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(1500);

  // Inject artificial delay into fetch for loading actions
  await cdp.evaluate(`(() => {
    window.__origFetch = window.fetch;
    window.fetch = async (...args) => {
      await new Promise(r => setTimeout(r, 1200));
      return window.__origFetch(...args);
    };
  })()`);

  // Click Buttons on Product 1
  await cdp.evaluate(`(() => {
    const btn1 = document.querySelector('[data-testid="product-buttons-btn-cloud-suite"]');
    if (btn1) btn1.click();
  })()`);
  await sleep(200);

  // Immediately go back and click Buttons on Product 2 before Product 1 load completes
  await cdp.evaluate(`(() => {
    const backBtn = document.querySelector('button[aria-label="Back to Product Details"]');
    if (backBtn) backBtn.click();
  })()`);
  await sleep(200);

  await cdp.evaluate(`(() => {
    const btn2 = document.querySelector('[data-testid="product-buttons-btn-cloud-suite-two"]');
    if (btn2) btn2.click();
  })()`);

  // Wait for both loads to settle
  await sleep(2500);

  // Verify Product 2 displays empty state with 0 nodes (Product 1's actions did not populate Product 2)
  const prod2NodeCount = await cdp.evaluate(`(() => {
    return document.querySelectorAll('[data-testid="action-node"]').length;
  })()`);
  const prod2EmptyText = await cdp.evaluate(`(() => {
    return document.querySelector('[data-testid="product-action-editor"]')?.innerText || '';
  })()`);

  // Restore fetch
  await cdp.evaluate(`(() => {
    window.fetch = window.__origFetch;
  })()`);

  if (prod2NodeCount !== 0 || !prod2EmptyText.includes("No buttons configured")) {
    await fail(`Scenario 9: Old product's actions leaked into new product during delayed load! Node count: ${prod2NodeCount}`);
  }

  log("Scenario 9 passed: Delayed response reconciliation and product switch scoping verified.");

  // =========================================================================
  // Scenario 10: Request Lifecycle Coordination Regressions (A, B, C)
  // =========================================================================
  log("Scenario 10: Testing request lifecycle coordination regressions (A, B, C)...");

  // Create third product in database for regression testing
  const [prod3] = await pgClient`
    INSERT INTO product (id, category_id, slug, price, sort_order, is_active)
    VALUES (${crypto.randomUUID()}, ${cat.id}, 'cloud-suite-three', '49.99', 2, true)
    RETURNING id
  `;
  await pgClient`
    INSERT INTO product_translation (product_id, language_id, name)
    VALUES (${prod3.id}, ${langEn.id}, 'Cloud Suite Three')
  `;

  // Navigate to catalog
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(1500);

  // --- Case 10A: Initial load versus create ---
  log("Scenario 10A: Testing initial load versus create coordination...");
  await cdp.evaluate(`(() => {
    window.__holdReadPromise = new Promise(resolve => { window.__releaseHeldRead = resolve; });
    window.__readInterceptCount = 0;
    window.__createInterceptCount = 0;
    window.__origFetch = window.fetch;
    window.fetch = async (...args) => {
      if (window.__holdRead) {
        window.__readInterceptCount++;
        await window.__holdReadPromise;
      }
      if (window.__trackCreates) {
        window.__createInterceptCount++;
      }
      return window.__origFetch(...args);
    };
    window.__holdRead = true;
    window.__trackCreates = true;
  })()`);

  // Click Buttons on Product 3 to trigger initial load
  await cdp.evaluate(`(() => {
    const btn3 = document.querySelector('[data-testid="product-buttons-btn-cloud-suite-three"]');
    if (btn3) btn3.click();
  })()`);
  await sleep(400);

  const readHeld = await cdp.evaluate(`window.__readInterceptCount > 0`);
  if (!readHeld) {
    await fail("Scenario 10A: Initial load request was not intercepted");
  }

  // Assert intended controls are disabled during initial load
  const controlsStateDuringLoad = await cdp.evaluate(`(() => {
    const addBtn = document.querySelector('[data-testid="add-root-action-btn"]');
    const refreshBtn = document.querySelector('button[aria-label="Refresh buttons"]');
    const isSpinnerVisible = Boolean(document.querySelector('.animate-spin'));
    return {
      addBtnDisabled: addBtn ? addBtn.disabled : true,
      refreshBtnDisabled: refreshBtn ? refreshBtn.disabled : true,
      isSpinnerVisible,
    };
  })()`);

  if (!controlsStateDuringLoad.addBtnDisabled) {
    await fail("Scenario 10A: Add Button was not disabled during initial load");
  }
  if (!controlsStateDuringLoad.refreshBtnDisabled) {
    await fail("Scenario 10A: Refresh Button was not disabled during initial load");
  }

  // Attempt programmatic click on Add Button during load
  await cdp.evaluate(`(() => {
    const addBtn = document.querySelector('[data-testid="add-root-action-btn"]');
    if (addBtn) addBtn.click();
  })()`);

  const modalOpenDuringLoad = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="submit-create-action-btn"]'))`);
  if (modalOpenDuringLoad) {
    await fail("Scenario 10A: Creation modal opened while initial load was active");
  }
  if (await cdp.evaluate(`window.__createInterceptCount !== 0`)) {
    await fail("Scenario 10A: Create action was triggered while initial load was active");
  }

  // Release loading
  await cdp.evaluate(`(() => {
    window.__holdRead = false;
    window.__releaseHeldRead();
  })()`);
  await sleep(800);

  // Verify load completed
  const addBtnAfterLoad = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="add-root-action-btn"]')?.disabled)`);
  if (addBtnAfterLoad) {
    await fail("Scenario 10A: Add Button remained disabled after load completed");
  }

  // Create an action ("Feature Root A")
  await cdp.evaluate(`(() => {
    const addBtn = document.querySelector('[data-testid="add-root-action-btn"]');
    if (addBtn) addBtn.click();
  })()`);
  await sleep(300);

  await setInputValue(cdp, '[data-testid="create-action-label-input"]', "Feature Root A");
  await sleep(200);

  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="submit-create-action-btn"]').click();
  })()`);
  await sleep(1500);

  // Confirm exactly one correct action appears
  const actionNodesA = await cdp.evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('[data-testid="action-node"]'));
    return nodes.map(n => ({ id: n.getAttribute('data-action-id'), text: n.innerText }));
  })()`);

  if (actionNodesA.length !== 1 || !actionNodesA[0].text.includes("Feature Root A")) {
    await fail(`Scenario 10A: Expected exactly 1 action 'Feature Root A', got: ${JSON.stringify(actionNodesA)}`);
  }

  // Check unique action IDs
  const uniqueIdsA = new Set(actionNodesA.map(n => n.id));
  if (uniqueIdsA.size !== actionNodesA.length) {
    await fail("Scenario 10A: Duplicate action IDs rendered in tree");
  }

  // Verify in PostgreSQL
  const dbActionsA = await pgClient`
    SELECT a.id, t.label
    FROM product_action a
    JOIN product_action_translation t ON a.id = t.action_id
    WHERE a.product_id = ${prod3.id}
  `;
  if (dbActionsA.length !== 1 || dbActionsA[0].label !== "Feature Root A") {
    await fail(`Scenario 10A: DB does not have exactly 1 action 'Feature Root A': ${JSON.stringify(dbActionsA)}`);
  }
  log("Scenario 10A passed: Initial load vs create coordination verified.");

  // --- Case 10B: Refresh versus mutation ---
  log("Scenario 10B: Testing refresh versus mutation coordination...");
  const rootAId = actionNodesA[0].id;
  await cdp.evaluate(`(() => {
    const nodeBtn = document.querySelector('[data-action-id="${rootAId}"] [data-testid="select-action-btn"]');
    if (nodeBtn) nodeBtn.click();
  })()`);
  await sleep(400);

  // Type an update into draft
  await setInputValue(cdp, '[data-testid="edit-action-label-input"]', "Feature Root A Updated");
  await sleep(200);

  // Hold Refresh response
  await cdp.evaluate(`(() => {
    window.__holdRefreshPromise = new Promise(resolve => { window.__releaseHeldRefresh = resolve; });
    window.__refreshInterceptCount = 0;
    window.__saveInterceptCount = 0;
    window.fetch = async (...args) => {
      if (window.__holdRefresh) {
        window.__refreshInterceptCount++;
        await window.__holdRefreshPromise;
      }
      if (window.__trackSaves) {
        window.__saveInterceptCount++;
      }
      return window.__origFetch(...args);
    };
    window.__holdRefresh = true;
    window.__trackSaves = false;
  })()`);

  // Click Refresh button
  await cdp.evaluate(`(() => {
    const refreshBtn = document.querySelector('button[aria-label="Refresh buttons"]');
    if (refreshBtn) refreshBtn.click();
  })()`);
  await sleep(300);

  // Assert Refresh is active and controls are disabled
  const refreshActive = await cdp.evaluate(`window.__refreshInterceptCount > 0`);
  if (!refreshActive) {
    await fail("Scenario 10B: Refresh request was not intercepted");
  }

  const controlsStateDuringRefresh = await cdp.evaluate(`(() => {
    const refreshBtn = document.querySelector('button[aria-label="Refresh buttons"]');
    const saveBtn = document.querySelector('[data-testid="save-action-btn"]');
    const addBtn = document.querySelector('[data-testid="add-root-action-btn"]');
    return {
      refreshDisabled: refreshBtn ? refreshBtn.disabled : false,
      saveDisabled: saveBtn ? saveBtn.disabled : false,
      addDisabled: addBtn ? addBtn.disabled : false,
    };
  })()`);

  if (!controlsStateDuringRefresh.refreshDisabled) {
    await fail("Scenario 10B: Refresh button was not disabled while refresh was active");
  }
  if (!controlsStateDuringRefresh.saveDisabled) {
    await fail("Scenario 10B: Save button was not disabled while refresh was active");
  }
  if (!controlsStateDuringRefresh.addDisabled) {
    await fail("Scenario 10B: Add button was not disabled while refresh was active");
  }

  // Attempt to submit save or create during refresh
  await cdp.evaluate(`(() => {
    window.__trackSaves = true;
    const saveBtn = document.querySelector('[data-testid="save-action-btn"]');
    if (saveBtn) saveBtn.click();
  })()`);

  const saveSentDuringRefresh = await cdp.evaluate(`window.__saveInterceptCount !== 0`);
  if (saveSentDuringRefresh) {
    await fail("Scenario 10B: Save mutation was submitted while refresh was active");
  }

  // Release refresh
  await cdp.evaluate(`(() => {
    window.__holdRefresh = false;
    window.__releaseHeldRefresh();
  })()`);
  await sleep(800);

  // Now save button is enabled again
  const saveBtnAfterRefresh = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="save-action-btn"]')?.disabled)`);
  if (saveBtnAfterRefresh) {
    await fail("Scenario 10B: Save button remained disabled after refresh finished");
  }

  // Re-enter edit label and save
  await setInputValue(cdp, '[data-testid="edit-action-label-input"]', "Feature Root A Authoritative");
  await sleep(200);

  await cdp.evaluate(`(() => {
    const saveBtn = document.querySelector('[data-testid="save-action-btn"]');
    if (saveBtn) saveBtn.click();
  })()`);
  await sleep(1500);

  // Verify authoritative result
  const savedDbB = await pgClient`
    SELECT label FROM product_action_translation
    WHERE action_id = ${rootAId}
  `;
  if (savedDbB[0]?.label !== "Feature Root A Authoritative") {
    await fail(`Scenario 10B: Database does not have authoritative saved label: '${savedDbB[0]?.label}'`);
  }
  log("Scenario 10B passed: Refresh vs mutation coordination verified.");

  // --- Case 10C: Mutation versus refresh ---
  log("Scenario 10C: Testing mutation versus refresh coordination...");
  await setInputValue(cdp, '[data-testid="edit-action-label-input"]', "Feature Root A Mutating");
  await sleep(200);

  await cdp.evaluate(`(() => {
    window.__holdMutationPromise = new Promise(resolve => { window.__releaseHeldMutation = resolve; });
    window.__mutationInterceptCount = 0;
    window.__refreshInterceptCountDuringMutation = 0;
    window.fetch = async (...args) => {
      if (window.__holdMutation) {
        window.__mutationInterceptCount++;
        await window.__holdMutationPromise;
      }
      if (window.__trackRefreshesDuringMutation) {
        window.__refreshInterceptCountDuringMutation++;
      }
      return window.__origFetch(...args);
    };
    window.__holdMutation = true;
    window.__trackRefreshesDuringMutation = true;
  })()`);

  // Click Save Button
  await cdp.evaluate(`(() => {
    const saveBtn = document.querySelector('[data-testid="save-action-btn"]');
    if (saveBtn) saveBtn.click();
  })()`);
  await sleep(300);

  // Assert Save mutation is in flight
  const mutationActive = await cdp.evaluate(`window.__mutationInterceptCount > 0`);
  if (!mutationActive) {
    await fail("Scenario 10C: Save mutation request was not intercepted");
  }

  // Assert controls disabled during mutation
  const controlsStateDuringMutation = await cdp.evaluate(`(() => {
    const saveBtn = document.querySelector('[data-testid="save-action-btn"]');
    const refreshBtn = document.querySelector('button[aria-label="Refresh buttons"]');
    const addBtn = document.querySelector('[data-testid="add-root-action-btn"]');
    return {
      saveDisabled: saveBtn ? saveBtn.disabled : false,
      refreshDisabled: refreshBtn ? refreshBtn.disabled : false,
      addDisabled: addBtn ? addBtn.disabled : false,
    };
  })()`);

  if (!controlsStateDuringMutation.saveDisabled) {
    await fail("Scenario 10C: Save button was not disabled while mutation was active");
  }
  if (!controlsStateDuringMutation.refreshDisabled) {
    await fail("Scenario 10C: Refresh button was not disabled while mutation was active");
  }
  if (!controlsStateDuringMutation.addDisabled) {
    await fail("Scenario 10C: Add button was not disabled while mutation was active");
  }

  // Attempt Refresh during mutation
  await cdp.evaluate(`(() => {
    const refreshBtn = document.querySelector('button[aria-label="Refresh buttons"]');
    if (refreshBtn) refreshBtn.click();
  })()`);

  const refreshSentDuringMutation = await cdp.evaluate(`window.__refreshInterceptCountDuringMutation !== 0`);
  if (refreshSentDuringMutation) {
    await fail("Scenario 10C: Refresh request was sent while mutation was in flight");
  }

  // Release mutation
  await cdp.evaluate(`(() => {
    window.__holdMutation = false;
    window.__releaseHeldMutation();
  })()`);
  await sleep(1500);

  // Restore fetch
  await cdp.evaluate(`(() => {
    window.fetch = window.__origFetch;
  })()`);

  // Verify label in tree and in DB
  const finalLabelNode = await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-action-id="${rootAId}"]');
    return node ? node.innerText : '';
  })()`);
  if (!finalLabelNode.includes("Feature Root A Mutating")) {
    await fail(`Scenario 10C: Action node does not have mutated label: '${finalLabelNode}'`);
  }

  const savedDbC = await pgClient`
    SELECT label FROM product_action_translation
    WHERE action_id = ${rootAId}
  `;
  if (savedDbC[0]?.label !== "Feature Root A Mutating") {
    await fail(`Scenario 10C: DB does not have mutated label: '${savedDbC[0]?.label}'`);
  }

  // Reload page to confirm persistence
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(1500);

  // Click Buttons on Cloud Suite Three
  await cdp.evaluate(`(() => {
    const btn3 = document.querySelector('[data-testid="product-buttons-btn-cloud-suite-three"]');
    if (btn3) btn3.click();
  })()`);
  await sleep(1000);

  const reloadedNodes10C = await cdp.evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('[data-testid="action-node"]'));
    return nodes.map(n => ({ id: n.getAttribute('data-action-id'), text: n.innerText }));
  })()`);

  if (reloadedNodes10C.length !== 1 || !reloadedNodes10C[0].text.includes("Feature Root A Mutating")) {
    await fail(`Scenario 10C: Persisted action not found after reload: ${JSON.stringify(reloadedNodes10C)}`);
  }

  log("Scenario 10C passed: Mutation vs refresh coordination and persistence verified.");
  log("Scenario 10 passed: All request coordination regressions (A, B, C) verified.");

  // =========================================================================
  // Scenario 11: Phase 05-B2 — Remaining Four Product Action Types
  // =========================================================================
  log("Scenario 11: Testing configuration and persistence of four new action types...");

  // Create a dedicated product in database for testing the 4 new action types
  const [prod4] = await pgClient`
    INSERT INTO product (id, category_id, slug, price, sort_order, is_active)
    VALUES (${crypto.randomUUID()}, ${cat.id}, 'cloud-suite-actions-four', '79.00', 3, true)
    RETURNING id
  `;
  await pgClient`
    INSERT INTO product_translation (product_id, language_id, name)
    VALUES (${prod4.id}, ${langEn.id}, 'Cloud Suite Actions Four')
  `;

  // Navigate to catalog
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(1500);

  // Open Buttons editor for prod4
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="product-buttons-btn-cloud-suite-actions-four"]');
    if (btn) btn.click();
  })()`);
  await sleep(1000);

  // 1. Create SEND_TEMPLATE_MESSAGE
  log("Scenario 11: Creating SEND_TEMPLATE_MESSAGE action...");
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="add-root-action-btn"]').click();
  })()`);
  await sleep(500);

  await cdp.evaluate(`(() => {
    const sel = document.querySelector('[data-testid="create-action-type-select"]');
    sel.value = 'SEND_TEMPLATE_MESSAGE';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await setInputValue(cdp, '[data-testid="create-action-label-input"]', "Special Offer");
  await setInputValue(
    cdp,
    '[data-testid="create-action-template-body-input"]',
    "Welcome {{customer_name}}! {{product_name}} is available for {{price}} at {{store_name}}."
  );
  await setInputValue(cdp, '[data-testid="create-action-ar-label-input"]', "عرض خاص");
  await setInputValue(
    cdp,
    '[data-testid="create-action-ar-template-body-input"]',
    "مرحباً {{customer_name}}! تفاصيل {{product_name}} بسعر {{price}}."
  );
  await sleep(300);

  await cdp.evaluate(`(() => { document.querySelector('[data-testid="submit-create-action-btn"]').click(); })()`);
  await sleep(1500);

  // 2. Create OPEN_URL
  log("Scenario 11: Creating OPEN_URL action...");
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="add-root-action-btn"]').click();
  })()`);
  await sleep(500);

  await cdp.evaluate(`(() => {
    const sel = document.querySelector('[data-testid="create-action-type-select"]');
    sel.value = 'OPEN_URL';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await setInputValue(cdp, '[data-testid="create-action-label-input"]', "External Docs");
  await setInputValue(cdp, '[data-testid="create-action-url-input"]', "https://example.com/docs");
  await sleep(300);

  await cdp.evaluate(`(() => { document.querySelector('[data-testid="submit-create-action-btn"]').click(); })()`);
  await sleep(1500);

  // 3. Create OPEN_SUPPORT
  log("Scenario 11: Creating OPEN_SUPPORT action...");
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="add-root-action-btn"]').click();
  })()`);
  await sleep(500);

  await setInputValue(cdp, '[data-testid="create-action-type-select"]', "OPEN_SUPPORT");
  await sleep(300);
  await setInputValue(cdp, '[data-testid="create-action-label-input"]', "Warranty Support");
  await setInputValue(cdp, '[data-testid="create-action-support-category-select"]', "Warranty");
  await sleep(300);

  await cdp.evaluate(`(() => { document.querySelector('[data-testid="submit-create-action-btn"]').click(); })()`);
  await sleep(1500);

  // 4. Create NAVIGATE_CATALOG
  log("Scenario 11: Creating NAVIGATE_CATALOG action...");
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="add-root-action-btn"]').click();
  })()`);
  await sleep(500);

  await setInputValue(cdp, '[data-testid="create-action-type-select"]', "NAVIGATE_CATALOG");
  await sleep(300);
  await setInputValue(cdp, '[data-testid="create-action-label-input"]', "Jump To Software");
  await setInputValue(cdp, '[data-testid="create-action-nav-kind-select"]', "category");
  await sleep(200);
  await setInputValue(cdp, '[data-testid="create-action-nav-target-select"]', cat.id);
  await sleep(300);

  await cdp.evaluate(`(() => { document.querySelector('[data-testid="submit-create-action-btn"]').click(); })()`);
  await sleep(1500);

  // 5. Reload and verify exact persistence in DOM and PostgreSQL
  log("Scenario 11: Reloading browser and verifying exact persistence in DOM and DB...");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(1500);

  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="product-buttons-btn-cloud-suite-actions-four"]');
    if (btn) btn.click();
  })()`);
  await sleep(1000);

  const reloadedActionNodes = await cdp.evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('[data-testid="action-node"]'));
    return nodes.map(n => ({
      id: n.getAttribute('data-action-id'),
      type: n.getAttribute('data-action-type'),
      text: n.innerText.split('\\n')[0].trim()
    }));
  })()`);

  if (reloadedActionNodes.length !== 4) {
    await fail(`Scenario 11: Expected 4 action nodes on reload, found ${reloadedActionNodes.length}`);
  }

  // Verify in PostgreSQL disposable database
  const dbActionsFour = await pgClient`
    SELECT a.id, a.action_type, a.url, a.navigate_category_id, a.navigate_product_id, a.action_config
    FROM product_action a
    WHERE a.product_id = ${prod4.id}
    ORDER BY a.sort_order ASC
  `;

  if (dbActionsFour.length !== 4) {
    await fail(`Scenario 11: Expected 4 product_action rows in DB, got ${dbActionsFour.length}`);
  }

  const dbMsg = dbActionsFour.find(a => a.action_type === "SEND_TEMPLATE_MESSAGE");
  if (!dbMsg) await fail("Scenario 11: SEND_TEMPLATE_MESSAGE not found in DB");

  const [dbMsgEnTrans] = await pgClient`
    SELECT label, template_body FROM product_action_translation
    WHERE action_id = ${dbMsg.id} AND language_id = ${langEn.id}
  `;
  if (!dbMsgEnTrans?.template_body?.includes("Welcome {{customer_name}}!")) {
    await fail(`Scenario 11: SEND_TEMPLATE_MESSAGE English template_body failed contract: ${dbMsgEnTrans?.template_body}`);
  }

  const [dbMsgArTrans] = await pgClient`
    SELECT label, template_body FROM product_action_translation
    WHERE action_id = ${dbMsg.id} AND language_id = (SELECT id FROM language WHERE code = 'ar')
  `;
  if (!dbMsgArTrans?.template_body?.includes("مرحباً {{customer_name}}!")) {
    await fail(`Scenario 11: SEND_TEMPLATE_MESSAGE Arabic template_body failed contract: ${dbMsgArTrans?.template_body}`);
  }

  const dbUrl = dbActionsFour.find(a => a.action_type === "OPEN_URL");
  if (!dbUrl || dbUrl.url !== "https://example.com/docs") {
    await fail(`Scenario 11: OPEN_URL failed contract: ${JSON.stringify(dbUrl)}`);
  }

  const dbSupport = dbActionsFour.find(a => a.action_type === "OPEN_SUPPORT");
  const dbSupportConfig = typeof dbSupport?.action_config === "string" ? JSON.parse(dbSupport.action_config) : dbSupport?.action_config;
  if (!dbSupport || dbSupportConfig?.support_category !== "Warranty") {
    await fail(`Scenario 11: OPEN_SUPPORT failed contract: ${JSON.stringify(dbSupport)}`);
  }

  const dbNav = dbActionsFour.find(a => a.action_type === "NAVIGATE_CATALOG");
  if (!dbNav || dbNav.navigate_category_id !== cat.id || dbNav.navigate_product_id !== null) {
    await fail(`Scenario 11: NAVIGATE_CATALOG failed contract: ${JSON.stringify(dbNav)}`);
  }

  // 6. Edit OPEN_URL configuration and verify persistence
  log("Scenario 11: Editing OPEN_URL configuration in drawer...");
  await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-action-id="${dbUrl.id}"] [data-testid="select-action-btn"]');
    if (node) node.click();
  })()`);
  await sleep(500);

  await setInputValue(cdp, '[data-testid="edit-action-url-input"]', "https://example.com/updated-docs");
  await sleep(300);

  await cdp.evaluate(`(() => { document.querySelector('[data-testid="save-action-btn"]').click(); })()`);
  await sleep(1500);

  const [dbUrlUpdated] = await pgClient`
    SELECT url FROM product_action WHERE id = ${dbUrl.id}
  `;
  if (dbUrlUpdated?.url !== "https://example.com/updated-docs") {
    await fail(`Scenario 11: Updated URL not persisted in DB: '${dbUrlUpdated?.url}'`);
  }

  // 7. Verify invalid URL submission leaves DB unchanged and preserves draft
  log("Scenario 11: Verifying invalid URL submission leaves DB unchanged...");
  await setInputValue(cdp, '[data-testid="edit-action-url-input"]', "http://insecure-url.com");
  await sleep(300);

  await cdp.evaluate(`(() => { document.querySelector('[data-testid="save-action-btn"]').click(); })()`);
  await sleep(1000);

  const invalidUrlAlert = await cdp.evaluate(`(() => {
    const alert = document.querySelector('[role="alert"]');
    return alert ? alert.innerText : '';
  })()`);
  if (!invalidUrlAlert.includes("HTTPS")) {
    await fail(`Scenario 11: Expected HTTPS validation error alert, got '${invalidUrlAlert}'`);
  }

  const [dbUrlUnchanged] = await pgClient`
    SELECT url FROM product_action WHERE id = ${dbUrl.id}
  `;
  if (dbUrlUnchanged?.url !== "https://example.com/updated-docs") {
    await fail("Scenario 11: Database was improperly mutated during invalid URL submission!");
  }

  const preservedInvalidDraft = await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid="edit-action-url-input"]');
    return input ? input.value : '';
  })()`);
  if (preservedInvalidDraft !== "http://insecure-url.com") {
    await fail(`Scenario 11: Invalid URL draft was not preserved: '${preservedInvalidDraft}'`);
  }

  // 8. Edit SEND_TEMPLATE_MESSAGE body and verify persistence on reload
  log("Scenario 11: Editing SEND_TEMPLATE_MESSAGE body and verifying persistence...");
  await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-action-id="${dbMsg.id}"] [data-testid="select-action-btn"]');
    if (node) node.click();
  })()`);
  await sleep(500);

  await setInputValue(
    cdp,
    '[data-testid="edit-action-template-body-input"]',
    "Updated offer for {{customer_name}}: {{product_name}} is {{price}} at {{store_name}}."
  );
  await sleep(300);

  await cdp.evaluate(`(() => { document.querySelector('[data-testid="save-action-btn"]').click(); })()`);
  await sleep(1500);

  // Reload page and check DB and DOM
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(1500);
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="product-buttons-btn-cloud-suite-actions-four"]');
    if (btn) btn.click();
  })()`);
  await sleep(1000);

  const [dbMsgUpdated] = await pgClient`
    SELECT template_body FROM product_action_translation
    WHERE action_id = ${dbMsg.id} AND language_id = ${langEn.id}
  `;
  if (!dbMsgUpdated?.template_body?.includes("Updated offer for {{customer_name}}")) {
    await fail(`Scenario 11: Updated template_body not persisted in DB: '${dbMsgUpdated?.template_body}'`);
  }

  // 9. Optional-language body draft preservation during another-language save
  log("Scenario 11: Testing optional-language body draft preservation during another-language save...");
  await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-action-id="${dbMsg.id}"] [data-testid="select-action-btn"]');
    if (node) node.click();
  })()`);
  await sleep(500);

  // Switch to Arabic tab
  await cdp.evaluate(`(() => {
    const arBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('العربية'));
    if (arBtn) arBtn.click();
  })()`);
  await sleep(300);

  // Set unsaved draft in Arabic template body
  await setInputValue(cdp, '[data-testid="edit-action-template-body-input"]', "مسودة عربية غير محفوظة");
  await sleep(300);

  // Switch back to English tab
  await cdp.evaluate(`(() => {
    const enBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('English'));
    if (enBtn) enBtn.click();
  })()`);
  await sleep(300);

  // Edit English label and save
  await setInputValue(cdp, '[data-testid="edit-action-label-input"]', "Special Offer Updated");
  await sleep(300);
  await cdp.evaluate(`(() => { document.querySelector('[data-testid="save-action-btn"]').click(); })()`);
  await sleep(1500);

  // Switch to Arabic tab again to verify draft was preserved in memory
  await cdp.evaluate(`(() => {
    const arBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('العربية'));
    if (arBtn) arBtn.click();
  })()`);
  await sleep(300);

  const preservedArDraft = await cdp.evaluate(`(() => {
    const input = document.querySelector('[data-testid="edit-action-template-body-input"]');
    return input ? input.value : '';
  })()`);
  if (!preservedArDraft.includes("مسودة عربية غير محفوظة")) {
    await fail(`Scenario 11: Arabic draft body was lost after English save: '${preservedArDraft}'`);
  }

  // Verify in PostgreSQL that the unsaved Arabic draft was NOT written to DB
  const [dbArTransCheck] = await pgClient`
    SELECT template_body FROM product_action_translation
    WHERE action_id = ${dbMsg.id} AND language_id = (SELECT id FROM language WHERE code = 'ar')
  `;
  if (dbArTransCheck?.template_body?.includes("مسودة عربية غير محفوظة")) {
    await fail("Scenario 11: Unsaved Arabic draft template body was committed to database!");
  }

  // 10. Invalid default-body rejection
  log("Scenario 11: Testing invalid default message body rejection...");
  // Switch to English tab
  await cdp.evaluate(`(() => {
    const enBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('English'));
    if (enBtn) enBtn.click();
  })()`);
  await sleep(300);

  // Clear English template body on active button and attempt to save
  await setInputValue(cdp, '[data-testid="edit-action-template-body-input"]', "");
  await sleep(300);
  await cdp.evaluate(`(() => { document.querySelector('[data-testid="save-action-btn"]').click(); })()`);
  await sleep(1000);

  const invalidBodyAlert = await cdp.evaluate(`(() => {
    const alert = document.querySelector('[role="alert"]');
    return alert ? alert.innerText : '';
  })()`);
  if (!invalidBodyAlert.toLowerCase().includes("message body") && !invalidBodyAlert.toLowerCase().includes("default language")) {
    await fail(`Scenario 11: Expected default-body rejection alert, got '${invalidBodyAlert}'`);
  }

  // Verify DB retains previous valid template body
  const [dbMsgUnmutated] = await pgClient`
    SELECT template_body FROM product_action_translation
    WHERE action_id = ${dbMsg.id} AND language_id = ${langEn.id}
  `;
  if (!dbMsgUnmutated?.template_body?.includes("Updated offer for {{customer_name}}")) {
    await fail("Scenario 11: DB was improperly mutated on invalid default body clearing!");
  }

  // 11. Edit OPEN_SUPPORT category and persistence
  log("Scenario 11: Editing OPEN_SUPPORT configuration and verifying persistence...");
  await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-action-id="${dbSupport.id}"] [data-testid="select-action-btn"]');
    if (node) node.click();
  })()`);
  await sleep(500);

  await setInputValue(cdp, '[data-testid="edit-action-support-category-select"]', "Returns");
  await sleep(300);
  await cdp.evaluate(`(() => { document.querySelector('[data-testid="save-action-btn"]').click(); })()`);
  await sleep(1500);

  const [dbSupportUpdated] = await pgClient`
    SELECT action_config FROM product_action WHERE id = ${dbSupport.id}
  `;
  const parsedSupportConfig = typeof dbSupportUpdated?.action_config === "string" ? JSON.parse(dbSupportUpdated.action_config) : dbSupportUpdated?.action_config;
  if (parsedSupportConfig?.support_category !== "Returns") {
    await fail(`Scenario 11: Support category update not persisted: ${JSON.stringify(parsedSupportConfig)}`);
  }

  // 12. Edit NAVIGATE_CATALOG target to product
  log("Scenario 11: Editing NAVIGATE_CATALOG destination to product and verifying persistence...");
  await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-action-id="${dbNav.id}"] [data-testid="select-action-btn"]');
    if (node) node.click();
  })()`);
  await sleep(500);

  await setInputValue(cdp, '[data-testid="edit-action-nav-kind-select"]', "product");
  await sleep(300);
  await setInputValue(cdp, '[data-testid="edit-action-nav-target-select"]', prod.id);
  await sleep(300);
  await cdp.evaluate(`(() => { document.querySelector('[data-testid="save-action-btn"]').click(); })()`);
  await sleep(1500);

  const [dbNavUpdated] = await pgClient`
    SELECT navigate_category_id, navigate_product_id FROM product_action WHERE id = ${dbNav.id}
  `;
  if (dbNavUpdated?.navigate_product_id !== prod.id || dbNavUpdated?.navigate_category_id !== null) {
    await fail(`Scenario 11: NAVIGATE_CATALOG product target update failed: ${JSON.stringify(dbNavUpdated)}`);
  }

  // 13. Safe deactivation through UI with unavailable soft-deleted target
  log("Scenario 11: Testing safe UI deactivation of action with soft-deleted target...");
  // Create a category and an active navigation action pointing to it
  const [softDelCat] = await pgClient`
    INSERT INTO category (id, slug, is_active, sort_order)
    VALUES (${crypto.randomUUID()}, 'soft-del-target-cat', true, 99)
    RETURNING id
  `;
  await pgClient`
    INSERT INTO category_translation (category_id, language_id, name)
    VALUES (${softDelCat.id}, ${langEn.id}, 'Soft Delete Target Cat')
  `;
  const [softDelAction] = await pgClient`
    INSERT INTO product_action (id, product_id, action_type, is_active, navigate_category_id, sort_order)
    VALUES (${crypto.randomUUID()}, ${prod4.id}, 'NAVIGATE_CATALOG', true, ${softDelCat.id}, 99)
    RETURNING id
  `;
  await pgClient`
    INSERT INTO product_action_translation (action_id, language_id, label)
    VALUES (${softDelAction.id}, ${langEn.id}, 'Jump to Soft Del Cat')
  `;

  // Soft-delete the target category in PostgreSQL
  await pgClient`
    UPDATE category SET deleted_at = NOW() WHERE id = ${softDelCat.id}
  `;

  // Reload page to reflect updated categories
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(1500);
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="product-buttons-btn-cloud-suite-actions-four"]');
    if (btn) btn.click();
  })()`);
  await sleep(1000);

  // Open the action in edit drawer
  await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-action-id="${softDelAction.id}"] [data-testid="select-action-btn"]');
    if (node) node.click();
  })()`);
  await sleep(500);

  // Verify honest target display in select
  const navTargetSelectHtml = await cdp.evaluate(`(() => {
    const sel = document.querySelector('[data-testid="edit-action-nav-target-select"]');
    return sel ? sel.innerHTML : '';
  })()`);
  if (!navTargetSelectHtml.includes("Unavailable / Deleted")) {
    await fail(`Scenario 11: Target select did not honestly display deleted category: '${navTargetSelectHtml}'`);
  }

  // Toggle active off
  await cdp.evaluate(`(() => {
    const toggle = document.querySelector('[data-testid="edit-action-is-active"]');
    if (toggle && toggle.checked) toggle.click();
  })()`);
  await sleep(300);

  // Click Save Changes
  await cdp.evaluate(`(() => { document.querySelector('[data-testid="save-action-btn"]').click(); })()`);
  await sleep(1500);

  // Verify in PostgreSQL: is_active=false, navigate_category_id unchanged
  const [softDelDbAction] = await pgClient`
    SELECT is_active, navigate_category_id FROM product_action WHERE id = ${softDelAction.id}
  `;
  if (softDelDbAction?.is_active !== false) {
    await fail(`Scenario 11: Expected is_active=false on deactivation, found: ${softDelDbAction?.is_active}`);
  }
  if (softDelDbAction?.navigate_category_id !== softDelCat.id) {
    await fail(`Scenario 11: navigate_category_id was modified or cleared on deactivation: ${softDelDbAction?.navigate_category_id}`);
  }

  // Attempt reactivation without selecting valid target should be rejected
  await cdp.evaluate(`(() => {
    const node = document.querySelector('[data-action-id="${softDelAction.id}"] [data-testid="select-action-btn"]');
    if (node) node.click();
  })()`);
  await sleep(500);
  await cdp.evaluate(`(() => {
    const toggle = document.querySelector('[data-testid="edit-action-is-active"]');
    if (toggle && !toggle.checked) toggle.click();
  })()`);
  await sleep(300);
  await cdp.evaluate(`(() => { document.querySelector('[data-testid="save-action-btn"]').click(); })()`);
  await sleep(1000);

  const reactivateAlert = await cdp.evaluate(`(() => {
    const alert = document.querySelector('[role="alert"]');
    return alert ? alert.innerText : '';
  })()`);
  if (!reactivateAlert.toLowerCase().includes("deleted") && !reactivateAlert.toLowerCase().includes("target")) {
    await fail(`Scenario 11: Reactivation with deleted target was not rejected: '${reactivateAlert}'`);
  }

  // 14. Hidden ancestor warning check
  log("Scenario 11: Verifying hidden-by-ancestor warning for inactive category ancestor...");
  // Create an inactive parent category and an active child category
  const [parentInactiveCat] = await pgClient`
    INSERT INTO category (id, slug, is_active, sort_order)
    VALUES (${crypto.randomUUID()}, 'inactive-parent-cat', false, 101)
    RETURNING id
  `;
  await pgClient`
    INSERT INTO category_translation (category_id, language_id, name)
    VALUES (${parentInactiveCat.id}, ${langEn.id}, 'Inactive Parent Category')
  `;
  const [childActiveCat] = await pgClient`
    INSERT INTO category (id, parent_id, slug, is_active, sort_order)
    VALUES (${crypto.randomUUID()}, ${parentInactiveCat.id}, 'active-child-cat', true, 102)
    RETURNING id
  `;
  await pgClient`
    INSERT INTO category_translation (category_id, language_id, name)
    VALUES (${childActiveCat.id}, ${langEn.id}, 'Active Child Category')
  `;

  // Reload page to refresh categories list in React
  await cdp.send("Page.navigate", { url: `${BASE_URL}/catalog` });
  await sleep(1500);
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('[data-testid="product-buttons-btn-cloud-suite-actions-four"]');
    if (btn) btn.click();
  })()`);
  await sleep(1000);

  // Open create modal for NAVIGATE_CATALOG
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="add-root-action-btn"]').click();
  })()`);
  await sleep(500);
  await setInputValue(cdp, '[data-testid="create-action-type-select"]', "NAVIGATE_CATALOG");
  await sleep(300);

  // Inspect the options in the category select
  const childOptionText = await cdp.evaluate(`(() => {
    const sel = document.querySelector('[data-testid="create-action-nav-target-select"]');
    if (!sel) return '';
    const opt = Array.from(sel.options).find(o => o.value === '${childActiveCat.id}');
    return opt ? opt.innerText : '';
  })()`);
  if (!childOptionText.includes("Hidden - Inactive ancestor")) {
    await fail(`Scenario 11: Target option did not display hidden-by-ancestor status: '${childOptionText}'`);
  }

  // Close create modal
  await cdp.evaluate(`(() => {
    const cancelBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Cancel'));
    if (cancelBtn) cancelBtn.click();
  })()`);
  await sleep(500);

  // 15. Touch targets >=44px and no horizontal overflow at 360px viewport
  log("Scenario 11: Verifying placeholder touch targets (>=44x44px) and 360px responsiveness...");
  // Set viewport to 360px width
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 740,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await sleep(500);

  // Open create modal for SEND_TEMPLATE_MESSAGE
  await cdp.evaluate(`(() => {
    document.querySelector('[data-testid="add-root-action-btn"]').click();
  })()`);
  await sleep(500);
  await setInputValue(cdp, '[data-testid="create-action-type-select"]', "SEND_TEMPLATE_MESSAGE");
  await sleep(500);

  // Verify no horizontal overflow in dialog
  const createModalOverflow = await cdp.evaluate(`(() => {
    return {
      scrollWidth: document.body.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  })()`);
  if (createModalOverflow.scrollWidth > createModalOverflow.clientWidth) {
    await fail(`Scenario 11: Horizontal overflow detected in create modal at 360px: scrollWidth=${createModalOverflow.scrollWidth}, clientWidth=${createModalOverflow.clientWidth}`);
  }

  // Check placeholder touch target sizes
  const placeholderSizes = await cdp.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter(b => b.innerText.includes('{{'));
    return buttons.map(b => {
      const rect = b.getBoundingClientRect();
      return { text: b.innerText, width: rect.width, height: rect.height };
    });
  })()`);

  const undersizedPlaceholders = placeholderSizes.filter(p => p.width < 44 || p.height < 44);
  if (undersizedPlaceholders.length > 0) {
    await fail(`Scenario 11: Undersized placeholder touch targets detected (<44px): ${JSON.stringify(undersizedPlaceholders)}`);
  }

  // Close create modal and reset viewport
  await cdp.evaluate(`(() => {
    const cancelBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Cancel'));
    if (cancelBtn) cancelBtn.click();
  })()`);
  await sleep(500);

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(500);

  log("Scenario 11 passed: All four new action types created, persisted, and edited successfully.");

  log("\n=======================================================");
  log("ALL 11 ACCEPTANCE SCENARIOS PASSED SUCCESSFULLY!");
  log("=======================================================\n");

  await cdp.close();
  await cleanup();
}

main().catch(async (err) => {
  process.stderr.write(`Unhandled exception: ${err.stack || err}\n`);
  await cleanup();
  process.exit(1);
});
