#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hash } from "@node-rs/argon2";
import postgres from "postgres";
import {
  detectConflictingFixture,
  readPgState,
  verifyAndStopOwnedFixture,
} from "./fixture-guard.mjs";

const APP_PORT = 3355;
const CDP_PORT = 9344;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const TEST_EMAIL = "admin@example.test";
const TEST_PASSWORD = "test-password-123";

let appServer = null;
let chromeProcess = null;
let pgClient = null;
let ownedTempDir = null;
let ownedPgFixture = null;
let createdDbName = null;
let isCleaningUp = false;

function log(msg) {
  process.stdout.write(`[simple-catalog-browser] ${msg}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fail(msg) {
  process.stderr.write(`[simple-catalog-browser:FAIL] ${msg}\n`);
  await cleanup();
  process.exit(1);
}

async function cleanup() {
  if (isCleaningUp) return;
  isCleaningUp = true;

  if (chromeProcess) {
    try {
      chromeProcess.kill("SIGKILL");
    } catch {}
    chromeProcess = null;
  }

  if (appServer) {
    try {
      process.kill(-appServer.pid, "SIGKILL");
    } catch {}
    appServer = null;
  }

  if (pgClient) {
    try {
      await pgClient.end({ timeout: 2 });
    } catch {}
    pgClient = null;
  }

  if (createdDbName && process.env.RABET_TEST_PG_URL) {
    try {
      const adminSql = postgres(process.env.RABET_TEST_PG_URL, { max: 1 });
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${createdDbName}`);
      await adminSql.end();
    } catch {}
    createdDbName = null;
  }

  if (ownedPgFixture?.port) {
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
    if (!existsSync(pwDir)) continue;
    try {
      for (const entry of readdirSync(pwDir)) {
        if (entry.startsWith("chromium_headless_shell-")) {
          const candidate = path.join(
            pwDir,
            entry,
            "chrome-headless-shell-linux64/chrome-headless-shell",
          );
          if (existsSync(candidate)) return candidate;
        }
        if (entry.startsWith("chromium-")) {
          const candidate = path.join(pwDir, entry, "chrome-linux64/chrome");
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {}
  }

  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (existsSync(candidate)) return candidate;
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
      this.ws.onerror = (error) => reject(error);
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
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `CDP evaluate error: ${result.exceptionDetails.text} - ${
          result.exceptionDetails.exception?.description || ""
        }`,
      );
    }
    return result.result?.value;
  }

  async close() {
    if (this.ws) this.ws.close();
  }
}

async function waitFor(cdp, expression, label, timeout = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try {
      if (await cdp.evaluate(expression)) return;
    } catch {}
    await sleep(250);
  }
  await fail(`${label}: timed out waiting for ${expression}`);
}

async function navigate(cdp, pathName, selector, label) {
  await cdp.send("Page.navigate", { url: `${BASE_URL}${pathName}` });
  await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, label ?? pathName);
  await sleep(900);
}

async function click(cdp, selector) {
  await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("Element not found: " + ${JSON.stringify(selector)});
    element.click();
  })()`);
}

async function setInputValue(cdp, selector, value) {
  await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("Element not found: " + ${JSON.stringify(selector)});
    const proto = element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}

async function setCheckbox(cdp, selector, checked) {
  const actual = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("Checkbox not found: " + ${JSON.stringify(selector)});
    if (element.checked !== ${Boolean(checked)}) element.click();
    return element.checked;
  })()`);
  if (actual !== Boolean(checked)) {
    await fail(`Could not set ${selector} to ${checked}`);
  }
}

async function assertNoHorizontalOverflow(cdp, width, label) {
  const metrics = await cdp.evaluate(`(() => ({
    innerWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))()`);
  const widest = Math.max(metrics.documentWidth, metrics.bodyWidth);
  if (widest > width + 1) {
    await fail(
      `${label}: horizontal overflow at ${width}px (inner=${metrics.innerWidth}, document=${metrics.documentWidth}, body=${metrics.bodyWidth})`,
    );
  }
}

async function assertTouchTargets(cdp, label) {
  const offenders = await cdp.evaluate(`(() => {
    return Array.from(document.querySelectorAll('#main button:not([hidden]), #main a[href]:not([hidden])'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        return rect.width < 43.5 || rect.height < 43.5;
      })
      .map((element) => ({
        text: element.innerText.slice(0, 40),
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
      }));
  })()`);
  if (offenders.length > 0) {
    await fail(`${label}: undersized touch targets ${JSON.stringify(offenders)}`);
  }
}

async function main() {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    await fail("Chromium executable not found. Set CHROME_BIN or CHROME_PATH.");
  }
  log(`Using Chromium: ${chromePath}`);

  let pgUrl = "";
  if (process.env.RABET_TEST_PG_URL) {
    createdDbName = `rabet_simple_catalog_${Date.now()}`;
    const adminSql = postgres(process.env.RABET_TEST_PG_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE ${createdDbName}`);
    await adminSql.end();

    const parsed = new URL(process.env.RABET_TEST_PG_URL);
    parsed.pathname = `/${createdDbName}`;
    pgUrl = parsed.toString();
    log(`Using designated PostgreSQL service database: ${createdDbName}`);
  } else {
    const stateFilePath = path.join(tmpdir(), "rabet-simple-catalog-test-pg.json");
    process.env.RABET_PG_STATE_FILE = stateFilePath;
    const conflicting = detectConflictingFixture(stateFilePath);
    if (conflicting) {
      spawnSync("node", ["scripts/db-test-postgres.mjs", "stop"], {
        env: { ...process.env, RABET_PG_STATE_FILE: stateFilePath },
        encoding: "utf8",
      });
    }

    const started = spawnSync(
      "node",
      ["scripts/db-test-postgres.mjs", "start"],
      {
        env: { ...process.env, RABET_PG_STATE_FILE: stateFilePath },
        encoding: "utf8",
      },
    );
    if (started.status !== 0) {
      await fail(`Disposable PostgreSQL failed: ${started.stderr || started.stdout}`);
    }

    for (const line of (started.stdout || "").split("\n")) {
      if (line.startsWith("postgresql://")) {
        pgUrl = line.trim();
        break;
      }
    }
    ownedPgFixture = readPgState(stateFilePath);
    if (!pgUrl && ownedPgFixture?.port) {
      pgUrl = `postgresql://rabet@127.0.0.1:${ownedPgFixture.port}/postgres`;
    }
  }

  if (!pgUrl) {
    await fail("No PostgreSQL URL available for the acceptance database.");
  }

  log("Applying migrations...");
  const migration = spawnSync("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: pgUrl },
    encoding: "utf8",
  });
  if (migration.status !== 0) {
    await fail(`Migration failed: ${migration.stderr || migration.stdout}`);
  }

  pgClient = postgres(pgUrl);

  const [english] = await pgClient`
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
    VALUES ('Simple Catalog Store', 'USD', ${english.id}, true);
  `;

  const [everyday] = await pgClient`
    INSERT INTO category (slug, sort_order, is_active)
    VALUES ('everyday', 0, true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO category_translation (category_id, language_id, name)
    VALUES (${everyday.id}, ${english.id}, 'Everyday');
  `;
  const [phones] = await pgClient`
    INSERT INTO category (parent_id, slug, sort_order, is_active)
    VALUES (${everyday.id}, 'phones', 0, true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO category_translation (category_id, language_id, name)
    VALUES (${phones.id}, ${english.id}, 'Phones');
  `;
  const [paused] = await pgClient`
    INSERT INTO category (slug, sort_order, is_active)
    VALUES ('paused', 1, false)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO category_translation (category_id, language_id, name)
    VALUES (${paused.id}, ${english.id}, 'Paused');
  `;

  const [seededPhone] = await pgClient`
    INSERT INTO product (category_id, slug, price, sort_order, is_active)
    VALUES (${phones.id}, 'seeded-phone', '99.00', 0, true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO product_translation (product_id, language_id, name, description, details)
    VALUES (${seededPhone.id}, ${english.id}, 'Seeded Phone', 'Seeded description', 'Seeded details');
  `;
  const [seededHidden] = await pgClient`
    INSERT INTO product (category_id, slug, price, sort_order, is_active)
    VALUES (${paused.id}, 'seeded-hidden', '42.00', 0, true)
    RETURNING id;
  `;
  await pgClient`
    INSERT INTO product_translation (product_id, language_id, name)
    VALUES (${seededHidden.id}, ${english.id}, 'Seeded Hidden Product');
  `;

  ownedTempDir = mkdtempSync(path.join(tmpdir(), "rabet-simple-catalog-"));
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
      `  const connStr = typeof headers.get === "function" ? headers.get("Neon-Connection-String") : (headers["Neon-Connection-String"] || "");\n` +
      `  const isSynthetic = (url && url.includes("ep-example.neon.tech")) || (typeof connStr === "string" && connStr.includes("ep-example.neon.tech"));\n` +
      `  if (isSynthetic && (url.includes("/sql") || url.includes("neon.tech"))) {\n` +
      `    if (!pg && process.env.TEST_REAL_PG_URL) pg = postgres(process.env.TEST_REAL_PG_URL);\n` +
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
      `            results.push({ rows: rows.map((r) => cols.map((c) => formatVal(r[c.name]))), fields });\n` +
      `          }\n` +
      `        });\n` +
      `        return new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });\n` +
      `      }\n` +
      `      const { query, params } = parsedBody;\n` +
      `      const qParams = (params || []).map((p) => p === "true" ? true : p === "false" ? false : p);\n` +
      `      const rows = await pg.unsafe(query, qParams);\n` +
      `      const cols = rows.columns || [];\n` +
      `      const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));\n` +
      `      const formatVal = (v) => typeof v === "boolean" ? (v ? "t" : "f") : Array.isArray(v) ? "{" + v.map(i => JSON.stringify(String(i))).join(",") + "}" : typeof v === "object" && v !== null && !(v instanceof Date) ? JSON.stringify(v) : v;\n` +
      `      return new Response(JSON.stringify({ rows: rows.map((r) => cols.map((c) => formatVal(r[c.name]))), fields }), { status: 200, headers: { "content-type": "application/json" } });\n` +
      `    } catch (error) {\n` +
      `      return new Response(JSON.stringify({ message: error.message }), { status: 500, headers: { "content-type": "application/json" } });\n` +
      `    }\n` +
      `  }\n` +
      `  return originalFetch(input, init);\n` +
      `};\n`,
    { mode: 0o600 },
  );

  const passwordHash = await hash(TEST_PASSWORD, {
    algorithm: 2,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const authSecret = Buffer.from(
    globalThis.crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64");

  const envFile = path.join(ownedTempDir, "test.env");
  const syntheticNeonUrl =
    "postgresql://rabet_user:synthetic_pass@ep-example.neon.tech/rabet_db";
  writeFileSync(
    envFile,
    [
      `export DATABASE_URL='${syntheticNeonUrl}'`,
      `export TEST_REAL_PG_URL='${pgUrl}'`,
      `export AUTH_SECRET='${authSecret}'`,
      `export AUTH_URL='${BASE_URL}'`,
      `export AUTH_TRUST_HOST='true'`,
      `export ADMIN_EMAIL='${TEST_EMAIL}'`,
      `export ADMIN_PASSWORD_HASH='${passwordHash}'`,
      `export NODE_ENV=production`,
      `export NODE_OPTIONS='--import ${bootstrapFile}'`,
    ].join("\n") + "\n",
    { mode: 0o600 },
  );

  appServer = spawn(
    "bash",
    [
      "-c",
      `source "${envFile}" && PORT=${APP_PORT} node node_modules/next/dist/bin/next start`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env } },
  );
  appServer.stdout.on("data", (chunk) => {
    process.stdout.write(`[next:out] ${chunk.toString()}`);
  });
  appServer.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    if (!text.includes("ExperimentalWarning")) {
      process.stderr.write(`[next:err] ${text}`);
    }
  });

  let serverReady = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}/login`);
      if (response.status === 200) {
        serverReady = true;
        break;
      }
    } catch {}
    await sleep(500);
  }
  if (!serverReady) {
    await fail("Next.js server did not become ready.");
  }

  const chromeDataDir = path.join(ownedTempDir, "chrome-data");
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
    { stdio: "ignore" },
  );

  let pageTarget = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(300);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      pageTarget = targets.find((target) => target.type === "page") || targets[0];
      if (pageTarget?.webSocketDebuggerUrl) break;
    } catch {}
  }
  if (!pageTarget) {
    await fail("Could not connect to Chromium DevTools Protocol.");
  }

  const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  log("Logging in as admin...");
  await navigate(cdp, "/login", 'input[name="email"]', "login");
  await setInputValue(cdp, 'input[name="email"]', TEST_EMAIL);
  await setInputValue(cdp, 'input[name="password"]', TEST_PASSWORD);
  await cdp.evaluate(`document.querySelector('button[type="submit"]').click()`);
  await waitFor(cdp, `!location.pathname.startsWith("/login")`, "login redirect");

  log("Scenario 1: independent product list, fields, status and search");
  await navigate(cdp, "/products", '[data-testid="products-admin"]', "products page");
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid="product-row"]').length === 2`,
    "seeded product rows",
  );
  const productListText = await cdp.evaluate(
    `document.querySelector('[data-testid="products-admin"]').innerText`,
  );
  for (const expected of [
    "Seeded Phone",
    "Everyday › Phones",
    "USD",
    "99.00",
    "Active",
    "Seeded Hidden Product",
    "Active (hidden by category)",
  ]) {
    if (!productListText.includes(expected)) {
      await fail(`Scenario 1: product list is missing '${expected}'.`);
    }
  }
  await setInputValue(cdp, '[data-testid="product-search"]', "hidden");
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid="product-row"]').length === 1`,
    "search filtering",
  );
  const filteredSlug = await cdp.evaluate(
    `document.querySelector('[data-testid="product-row"]').dataset.productSlug`,
  );
  if (filteredSlug !== "seeded-hidden") {
    await fail(`Scenario 1: expected seeded-hidden after search, got ${filteredSlug}`);
  }
  await setInputValue(cdp, '[data-testid="product-search"]', "");

  log("Scenario 2: root/child category display and category creation");
  await navigate(cdp, "/categories", '[data-testid="categories-admin"]', "categories page");
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid="category-row"]').length === 3`,
    "seeded category rows",
  );
  const categoryListText = await cdp.evaluate(
    `document.querySelector('[data-testid="categories-admin"]').innerText`,
  );
  for (const expected of [
    "Root category",
    "Child of Everyday",
    "0 direct · 1 including subcategories",
  ]) {
    if (!categoryListText.includes(expected)) {
      await fail(`Scenario 2: category list is missing '${expected}'.`);
    }
  }

  await click(cdp, '[data-testid="add-category-btn"]');
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="category-form"]'))`,
    "category form",
  );
  const parentDefault = await cdp.evaluate(
    `document.querySelector('[data-testid="category-parent-select"]').value`,
  );
  if (parentDefault !== "root") {
    await fail(`Scenario 2: expected top-level default parent, got ${parentDefault}`);
  }
  await setInputValue(cdp, '[data-testid="category-slug-input"]', "browser-root");
  await setInputValue(cdp, '[data-testid="category-name-input"]', "Browser Root");
  await click(cdp, '[data-testid="save-category-submit-btn"]');
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-category-slug="browser-root"]'))`,
    "created root category",
  );
  const [browserRoot] = await pgClient`
    SELECT id, parent_id FROM category WHERE slug = 'browser-root';
  `;
  if (!browserRoot || browserRoot.parent_id !== null) {
    await fail("Scenario 2: browser-root was not persisted as a top-level category.");
  }

  await click(cdp, '[data-testid="add-category-btn"]');
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="category-form"]'))`,
    "child category form",
  );
  await setInputValue(cdp, '[data-testid="category-parent-select"]', browserRoot.id);
  await setInputValue(cdp, '[data-testid="category-slug-input"]', "browser-child");
  await setInputValue(cdp, '[data-testid="category-name-input"]', "Browser Child");
  await click(cdp, '[data-testid="save-category-submit-btn"]');
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-category-slug="browser-child"]'))`,
    "created child category",
  );
  const [browserChild] = await pgClient`
    SELECT id, parent_id FROM category WHERE slug = 'browser-child';
  `;
  if (!browserChild || browserChild.parent_id !== browserRoot.id) {
    await fail("Scenario 2: browser-child parent relationship was not preserved.");
  }
  const renderedRoots = await cdp.evaluate(`(() => {
    const root = document.querySelector('[data-category-slug="browser-root"]');
    const child = document.querySelector('[data-category-slug="browser-child"]');
    return {
      root: root?.dataset.categoryRoot,
      child: child?.dataset.categoryRoot,
      childText: child?.innerText ?? "",
    };
  })()`);
  if (
    renderedRoots.root !== "true" ||
    renderedRoots.child !== "false" ||
    !renderedRoots.childText.includes("Child of Browser Root")
  ) {
    await fail(`Scenario 2: root/child display incorrect: ${JSON.stringify(renderedRoots)}`);
  }

  log("Scenario 3: create product with direct category and default inquiry");
  await navigate(cdp, "/products", '[data-testid="products-admin"]', "products page after categories");
  await click(cdp, '[data-testid="add-product-btn"]');
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="product-form"]'))`,
    "product form",
  );
  const inquiryDefault = await cdp.evaluate(
    `document.querySelector('[data-testid="product-allow-inquiry-input"]').checked`,
  );
  if (!inquiryDefault) {
    await fail("Scenario 3: default inquiry option must be enabled by default.");
  }
  await setInputValue(cdp, '[data-testid="product-category-select"]', browserChild.id);
  await setInputValue(cdp, '[data-testid="product-slug-input"]', "browser-product");
  await setInputValue(cdp, '[data-testid="product-price-input"]', "15.50");
  await setInputValue(cdp, '[data-testid="product-name-input"]', "Browser Product");
  await setInputValue(
    cdp,
    '[data-testid="product-description-input"]',
    "Created from the simple form",
  );
  await setInputValue(
    cdp,
    '[data-testid="product-details-input"]',
    "Full details from the simple form",
  );
  await click(cdp, '[data-testid="save-product-submit-btn"]');
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-product-slug="browser-product"]'))`,
    "created product row",
  );

  const [browserProduct] = await pgClient`
    SELECT id, category_id, slug, price, is_active
    FROM product
    WHERE slug = 'browser-product';
  `;
  if (!browserProduct) {
    await fail("Scenario 3: browser-product was not persisted.");
  }
  if (browserProduct.category_id !== browserChild.id) {
    await fail("Scenario 3: product category assignment was not persisted.");
  }
  if (browserProduct.is_active !== false) {
    await fail("Scenario 3: new product must start inactive.");
  }
  const inquiryActions = await pgClient`
    SELECT id, action_type, parent_action_id, is_active, sort_order
    FROM product_action
    WHERE product_id = ${browserProduct.id};
  `;
  if (
    inquiryActions.length !== 1 ||
    inquiryActions[0].action_type !== "START_INQUIRY" ||
    inquiryActions[0].parent_action_id !== null ||
    inquiryActions[0].is_active !== true
  ) {
    await fail(`Scenario 3: expected one root START_INQUIRY action, got ${JSON.stringify(inquiryActions)}`);
  }
  const inquiryTranslations = await pgClient`
    SELECT label, language_id
    FROM product_action_translation
    WHERE action_id = ${inquiryActions[0].id};
  `;
  if (
    inquiryTranslations.length !== 1 ||
    inquiryTranslations[0].label !== "Ask about this product" ||
    inquiryTranslations[0].language_id !== english.id
  ) {
    await fail(`Scenario 3: default inquiry translation incorrect: ${JSON.stringify(inquiryTranslations)}`);
  }
  const inquiryRows = await pgClient`
    SELECT id FROM inquiry WHERE product_id = ${browserProduct.id};
  `;
  if (inquiryRows.length !== 0) {
    await fail("Scenario 3: no inquiry row may exist before a customer taps.");
  }

  log("Scenario 4: opening and cancelling an edit form changes no data");
  const beforeCancel = await pgClient`
    SELECT
      (SELECT count(*)::int FROM product) AS products,
      (SELECT count(*)::int FROM product_action) AS actions,
      (SELECT count(*)::int FROM inquiry) AS inquiries;
  `;
  await click(
    cdp,
    '[data-testid="product-row"][data-product-slug="browser-product"] [data-testid="edit-product-btn"]',
  );
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="product-form"]'))`,
    "edit product form",
  );
  const editInitial = await cdp.evaluate(`(() => ({
    slug: document.querySelector('[data-testid="product-slug-input"]').value,
    price: document.querySelector('[data-testid="product-price-input"]').value,
    name: document.querySelector('[data-testid="product-name-input"]').value,
    active: document.querySelector('[data-testid="product-active-input"]').checked,
  }))()`);
  if (
    editInitial.slug !== "browser-product" ||
    editInitial.price !== "15.50" ||
    editInitial.name !== "Browser Product" ||
    editInitial.active !== false
  ) {
    await fail(`Scenario 4: edit form did not initialize from saved values: ${JSON.stringify(editInitial)}`);
  }
  await click(cdp, '[data-testid="cancel-product-btn"]');
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="products-admin"]'))`,
    "products after cancel",
  );
  const afterCancel = await pgClient`
    SELECT
      (SELECT count(*)::int FROM product) AS products,
      (SELECT count(*)::int FROM product_action) AS actions,
      (SELECT count(*)::int FROM inquiry) AS inquiries;
  `;
  if (JSON.stringify(beforeCancel[0]) !== JSON.stringify(afterCancel[0])) {
    await fail(`Scenario 4: cancelling wrote data: ${JSON.stringify(beforeCancel[0])} -> ${JSON.stringify(afterCancel[0])}`);
  }

  log("Scenario 5: edit activation, price, translation and category assignment");
  await click(
    cdp,
    '[data-testid="product-row"][data-product-slug="browser-product"] [data-testid="edit-product-btn"]',
  );
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="product-form"]'))`,
    "edit product form again",
  );
  await setCheckbox(cdp, '[data-testid="product-active-input"]', true);
  await setInputValue(cdp, '[data-testid="product-price-input"]', "18.25");
  await setInputValue(cdp, '[data-testid="product-name-input"]', "Browser Product Updated");
  await setInputValue(cdp, '[data-testid="product-category-select"]', everyday.id);
  await click(cdp, '[data-testid="save-product-submit-btn"]');
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-product-slug="browser-product"]'))`,
    "product list after edit",
  );

  const [editedProduct] = await pgClient`
    SELECT id, category_id, slug, price, is_active
    FROM product
    WHERE slug = 'browser-product';
  `;
  if (
    !editedProduct ||
    editedProduct.category_id !== everyday.id ||
    editedProduct.price !== "18.25" ||
    editedProduct.is_active !== true
  ) {
    await fail(`Scenario 5: product edit was not persisted correctly: ${JSON.stringify(editedProduct)}`);
  }
  const [editedTranslation] = await pgClient`
    SELECT name, description, details
    FROM product_translation
    WHERE product_id = ${browserProduct.id} AND language_id = ${english.id};
  `;
  if (
    editedTranslation?.name !== "Browser Product Updated" ||
    editedTranslation?.description !== "Created from the simple form" ||
    editedTranslation?.details !== "Full details from the simple form"
  ) {
    await fail(`Scenario 5: translation was not preserved/updated: ${JSON.stringify(editedTranslation)}`);
  }
  const actionsAfterEdit = await pgClient`
    SELECT id FROM product_action WHERE product_id = ${browserProduct.id};
  `;
  if (actionsAfterEdit.length !== 1 || actionsAfterEdit[0].id !== inquiryActions[0].id) {
    await fail("Scenario 5: editing duplicated or removed the default inquiry action.");
  }

  log("Scenario 6: QA-24 return from Buttons editor preserves fields and active state");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await navigate(
    cdp,
    `/catalog?actionProduct=${browserProduct.id}`,
    '[data-testid="product-action-editor"]',
    "advanced buttons editor deep link",
  );
  await click(cdp, '[aria-label="Back to Product Details"]');
  await waitFor(
    cdp,
    `Boolean(document.querySelector('#prod-slug-input'))`,
    "product edit form after Buttons",
  );
  const qa24 = await cdp.evaluate(`(() => ({
    slug: document.querySelector('#prod-slug-input').value,
    price: document.querySelector('#prod-price-input').value,
    active: document.querySelector('#prod-status-input').checked,
  }))()`);
  if (
    qa24.slug !== "browser-product" ||
    qa24.price !== "18.25" ||
    qa24.active !== true
  ) {
    await fail(`QA-24 regression: blank or stale editor after Buttons: ${JSON.stringify(qa24)}`);
  }
  await navigate(cdp, "/catalog", '[data-testid="catalog-editor"]', "advanced catalog");
  const advancedCategoryCount = await cdp.evaluate(
    `document.querySelectorAll('[data-testid="category-node"]').length`,
  );
  if (advancedCategoryCount === 0) {
    await fail("Scenario 6: existing advanced category navigation did not render.");
  }

  log("Scenario 7: mobile widths 320, 360, 390 and 430 CSS px");
  for (const width of [320, 360, 390, 430]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 800,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await navigate(cdp, "/products", '[data-testid="products-admin"]', `products at ${width}px`);
    await assertNoHorizontalOverflow(cdp, width, `products ${width}px`);
    await assertTouchTargets(cdp, `products ${width}px`);

    await navigate(cdp, "/categories", '[data-testid="categories-admin"]', `categories at ${width}px`);
    await assertNoHorizontalOverflow(cdp, width, `categories ${width}px`);
    await assertTouchTargets(cdp, `categories ${width}px`);
  }

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 800,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await navigate(cdp, "/products", '[data-testid="products-admin"]', "products form mobile");
  await click(cdp, '[data-testid="add-product-btn"]');
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="product-form"]'))`,
    "mobile product form",
  );
  await assertNoHorizontalOverflow(cdp, 360, "product form 360px");
  await assertTouchTargets(cdp, "product form 360px");

  log("ALL SIMPLE CATALOG BROWSER SCENARIOS PASSED");
  await cleanup();
  process.exit(0);
}

main().catch(async (error) => {
  await fail(`Unexpected failure: ${error.message}\n${error.stack}`);
});
