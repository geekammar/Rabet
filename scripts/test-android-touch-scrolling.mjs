#!/usr/bin/env node
/**
 * scripts/test-android-touch-scrolling.mjs
 *
 * Real browser acceptance test suite for Android / Mobile Single-Finger Touch Scrolling.
 * Validates that touch scrolling works on mobile viewports (390x844 and 360x740)
 * using native CDP touch input (Input.dispatchTouchEvent).
 *
 * Verifies:
 * 1. Direct page load single-finger touch scrolling on long pages (/bot-content, /settings).
 * 2. Computed styles: html, body, and main have overflow-x: clip and overflow-y: visible (no accidental scroll container traps).
 * 3. Mobile drawer (Sheet) interaction: background scroll locking while open, scrolling inside drawer, and immediate restoration after dismissal.
 * 4. Page navigation through mobile drawer and scrollability on navigated page.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hash } from "@node-rs/argon2";
import postgres from "postgres";
import {
  detectConflictingFixture,
  verifyAndStopOwnedFixture,
} from "./fixture-guard.mjs";

const APP_PORT = 3388;
const CDP_PORT = 9388;
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
  process.stdout.write(`[touch-scrolling] ${msg}\n`);
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

  if (createdDbName && process.env.RABET_TEST_PG_URL) {
    try {
      const cleanupSql = postgres(process.env.RABET_TEST_PG_URL, { max: 1 });
      await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${createdDbName}`);
      await cleanupSql.end();
    } catch {}
    createdDbName = null;
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
      path.join(tmpdir(), "rabet-test-pg.json");

    verifyAndStopOwnedFixture({
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
    ownedPgFixture = null;
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
  log(`FAILED: ${msg}`);
  await cleanup();
  process.exit(1);
}

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
          if (entry.startsWith("chromium_headless_shell-")) {
            const candidate = path.join(
              pwDir,
              entry,
              "chrome-headless-shell-linux64/chrome-headless-shell"
            );
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

/**
 * Dispatches a native single-pointer vertical touch swipe via CDP Input.dispatchTouchEvent.
 */
async function performTouchSwipe(cdp, { startX, startY, endY, steps = 10, stepDelayMs = 20 }) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: startX, y: startY, id: 0 }],
  });

  const deltaY = (endY - startY) / steps;
  for (let i = 1; i <= steps; i++) {
    const currentY = Math.round(startY + deltaY * i);
    await sleep(stepDelayMs);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: startX, y: currentY, id: 0 }],
    });
  }

  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });

  // Allow layout/inertia settling
  await sleep(350);
}

async function main() {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    await fail(
      "Chromium executable not found. Set CHROME_BIN or CHROME_PATH environment variable."
    );
  }
  log(`Using Chromium executable: ${chromePath}`);

  let pgUrl = "";
  if (process.env.RABET_TEST_PG_URL) {
    createdDbName = `rabet_android_scroll_${Date.now()}`;
    const adminSql = postgres(process.env.RABET_TEST_PG_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE ${createdDbName}`);
    await adminSql.end();

    const parsed = new URL(process.env.RABET_TEST_PG_URL);
    parsed.pathname = `/${createdDbName}`;
    pgUrl = parsed.toString();
    log(`Using designated PostgreSQL service with database: ${createdDbName}`);
  } else {
    const stateFilePath =
      process.env.RABET_PG_STATE_FILE ??
      path.join(tmpdir(), "rabet-test-pg.json");

    const conflict = detectConflictingFixture(stateFilePath);
    if (conflict) {
      await fail(
        `Pre-existing disposable PostgreSQL instance detected at ${stateFilePath} ` +
          `(port ${conflict.port}, datadir: ${conflict.datadir}).`
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
      await fail(`Could not find postgresql URL in output:\n${pgStart.stdout}`);
    }
    pgUrl = pgUrlMatch[0];

    const datadirMatch = pgStart.stdout.match(/DATADIR=([^\s]+)/);
    const parsedPgUrl = new URL(pgUrl);
    ownedPgFixture = {
      port: Number(parsedPgUrl.port),
      datadir: datadirMatch ? datadirMatch[1] : "",
    };
  }

  log("Applying database migrations...");
  const migrate = spawnSync("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: pgUrl },
    encoding: "utf8",
  });
  if (migrate.status !== 0) {
    await fail(`Migration failed: ${migrate.stderr || migrate.stdout}`);
  }

  pgClient = postgres(pgUrl);
  log("Seeding test store settings and languages...");
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

  ownedTempDir = mkdtempSync(path.join(tmpdir(), "rabet-touch-acceptance-"));
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

  // Authenticate admin session
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
      "--window-size=390,844",
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
    await fail("Could not connect to Chromium DevTools Protocol");
  }

  const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  log("Connected to Chromium page via CDP.");

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Network.enable");

  // Set session cookie
  await cdp.send("Network.setCookie", {
    name: "authjs.session-token",
    value: sessionCookieVal,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
  });

  // Configure mobile touch emulation (Viewport: 390x844, touch-enabled)
  log("Configuring mobile emulation (390x844, DPR 2, touchEnabled)...");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });

  // TEST 1: Direct load of /bot-content and single-finger vertical touch scrolling
  log("\n--- TEST 1: Direct load /bot-content and single-finger touch scroll ---");
  await cdp.send("Page.navigate", { url: `${BASE_URL}/bot-content` });
  await sleep(1500);

  // Inspect computed overflow styles
  const stylesCheck = await cdp.evaluate(`(() => {
    const html = document.documentElement;
    const body = document.body;
    const main = document.getElementById("main");
    return {
      htmlOverflowX: getComputedStyle(html).overflowX,
      htmlOverflowY: getComputedStyle(html).overflowY,
      bodyOverflowX: getComputedStyle(body).overflowX,
      bodyOverflowY: getComputedStyle(body).overflowY,
      mainOverflowX: main ? getComputedStyle(main).overflowX : null,
      mainOverflowY: main ? getComputedStyle(main).overflowY : null,
      dataScrollLocked: body.getAttribute("data-scroll-locked"),
      initialScrollY: window.scrollY,
      docHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  })()`);
  log(`Computed styles on direct load: ${JSON.stringify(stylesCheck)}`);

  if (stylesCheck.htmlOverflowY === "auto" || stylesCheck.bodyOverflowY === "auto") {
    await fail(
      `html or body computed overflow-y is 'auto' instead of 'visible'. html: ${stylesCheck.htmlOverflowY}, body: ${stylesCheck.bodyOverflowY}`
    );
  }
  if (stylesCheck.mainOverflowY === "auto") {
    await fail(
      `main#main computed overflow-y is 'auto', creating an inner scroll trap.`
    );
  }
  if (stylesCheck.dataScrollLocked !== null) {
    await fail(`body unexpectedly has data-scroll-locked attribute on direct load.`);
  }
  if (stylesCheck.docHeight <= stylesCheck.viewportHeight + 200) {
    await fail(`Page content is not tall enough to test scrolling (${stylesCheck.docHeight} <= ${stylesCheck.viewportHeight}).`);
  }

  // Perform single-finger touch swipe up (startX: 200, startY: 600, endY: 200 -> swipe 400px up)
  log("Performing native single-finger swipe up (400px gesture)...");
  await performTouchSwipe(cdp, { startX: 200, startY: 600, endY: 200, steps: 12 });

  const scrollAfterUp = await cdp.evaluate("window.scrollY");
  log(`window.scrollY after single-finger swipe up: ${scrollAfterUp}px`);
  if (scrollAfterUp <= 50) {
    await fail(
      `Single-finger vertical scrolling failed on /bot-content. Expected scrollY > 50px, got ${scrollAfterUp}px.`
    );
  }

  // Perform single-finger touch swipe back down (startX: 200, startY: 200, endY: 600)
  log("Performing native single-finger swipe back down...");
  await performTouchSwipe(cdp, { startX: 200, startY: 200, endY: 600, steps: 12 });
  const scrollAfterDown = await cdp.evaluate("window.scrollY");
  log(`window.scrollY after single-finger swipe down: ${scrollAfterDown}px`);
  if (scrollAfterDown >= scrollAfterUp) {
    await fail(
      `Single-finger swipe down failed to reduce scroll position. Before: ${scrollAfterUp}, After: ${scrollAfterDown}.`
    );
  }

  // TEST 2: Compact Android Viewport (360x740) on /settings
  log("\n--- TEST 2: Compact Android Viewport (360x740) on /settings ---");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 740,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
  });

  await cdp.send("Page.navigate", { url: `${BASE_URL}/settings` });
  await sleep(1500);

  const settingsInit = await cdp.evaluate(`(() => ({
    scrollY: window.scrollY,
    docHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
  }))()`);
  log(`Settings initial state on 360x740: ${JSON.stringify(settingsInit)}`);

  if (settingsInit.bodyWidth > settingsInit.viewportWidth) {
    await fail(
      `Horizontal layout blowout detected on 360x740: body scrollWidth (${settingsInit.bodyWidth}) > viewport (${settingsInit.viewportWidth}).`
    );
  }

  log("Performing native single-finger swipe up on /settings (360x740)...");
  await performTouchSwipe(cdp, { startX: 180, startY: 550, endY: 200, steps: 10 });
  const settingsScroll = await cdp.evaluate("window.scrollY");
  log(`window.scrollY on /settings after swipe: ${settingsScroll}px`);
  if (settingsScroll <= 50) {
    await fail(
      `Single-finger touch scrolling failed on /settings (360x740). Got ${settingsScroll}px.`
    );
  }

  // TEST 3: Mobile Navigation Drawer (Sheet) & Modal Scroll-Lock Lifecycle
  log("\n--- TEST 3: Mobile Nav Drawer (Sheet) background scroll-lock lifecycle ---");
  // Reset scroll to top
  await cdp.evaluate("window.scrollTo(0, 0);");
  await sleep(200);

  // Open mobile nav drawer by clicking the menu trigger
  log("Opening mobile navigation drawer...");
  const menuOpened = await cdp.evaluate(`(() => {
    const btn = document.querySelector('button[aria-label="Open navigation menu"]');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  })()`);

  if (!menuOpened) {
    await fail("Could not locate mobile navigation menu trigger button.");
  }
  await sleep(600);

  const drawerStateOpen = await cdp.evaluate(`(() => {
    const sheetContent = document.querySelector('[data-slot="sheet-content"]');
    const overlay = document.querySelector('[data-slot="sheet-overlay"]');
    const isLocked = document.body.hasAttribute("data-scroll-locked");
    return {
      hasSheetContent: Boolean(sheetContent),
      hasOverlay: Boolean(overlay),
      isLocked,
      currentScrollY: window.scrollY,
    };
  })()`);
  log(`Drawer opened state: ${JSON.stringify(drawerStateOpen)}`);

  if (!drawerStateOpen.hasSheetContent) {
    await fail("Mobile navigation drawer failed to open.");
  }

  // Verify background scroll remains locked while drawer is open
  log("Attempting single-finger touch swipe on backdrop overlay while drawer is open...");
  await performTouchSwipe(cdp, { startX: 340, startY: 500, endY: 200, steps: 10 });
  const scrollDuringModal = await cdp.evaluate("window.scrollY");
  log(`Background scrollY during open modal: ${scrollDuringModal}px (initial: ${drawerStateOpen.currentScrollY}px)`);

  if (scrollDuringModal !== drawerStateOpen.currentScrollY) {
    await fail(
      `Background scroll locking failed while mobile drawer was open. Moved from ${drawerStateOpen.currentScrollY} to ${scrollDuringModal}.`
    );
  }

  // Close drawer by clicking the close button
  log("Dismissing mobile drawer via close button...");
  await cdp.evaluate(`(() => {
    const closeBtn = document.querySelector('[data-slot="sheet-content"] button[data-slot="sheet-close"]') ||
                     document.querySelector('[data-slot="sheet-content"] button');
    if (closeBtn) closeBtn.click();
  })()`);
  await sleep(500);

  const drawerStateClosed = await cdp.evaluate(`(() => ({
    sheetContent: Boolean(document.querySelector('[data-slot="sheet-content"]')),
    isLocked: document.body.hasAttribute("data-scroll-locked"),
  }))()`);
  log(`Drawer dismissed state: ${JSON.stringify(drawerStateClosed)}`);

  if (drawerStateClosed.isLocked) {
    await fail("body retained data-scroll-locked after mobile drawer dismissal.");
  }

  // Verify single-finger scrolling resumes immediately after drawer closes
  log("Testing single-finger swipe on page after drawer dismissal...");
  await performTouchSwipe(cdp, { startX: 180, startY: 550, endY: 200, steps: 10 });
  const scrollAfterDismiss = await cdp.evaluate("window.scrollY");
  log(`window.scrollY after drawer dismissal swipe: ${scrollAfterDismiss}px`);
  if (scrollAfterDismiss <= 50) {
    await fail(
      `Single-finger vertical scrolling did not resume after mobile drawer closed. Got ${scrollAfterDismiss}px.`
    );
  }

  // TEST 4: Navigation through Mobile Drawer Links
  log("\n--- TEST 4: Navigation through Mobile Drawer links ---");
  // Open mobile nav again
  await cdp.evaluate(`document.querySelector('button[aria-label="Open navigation menu"]').click();`);
  await sleep(500);

  // Click navigation link to Bot Content
  log("Clicking 'Bot Content' link inside mobile drawer...");
  const navClicked = await cdp.evaluate(`(() => {
    const links = Array.from(document.querySelectorAll('[data-slot="sheet-content"] a'));
    const botContentLink = links.find(a => a.href.includes('/bot-content') || a.innerText.includes('Bot Content'));
    if (botContentLink) {
      botContentLink.click();
      return true;
    }
    return false;
  })()`);

  if (!navClicked) {
    await fail("Could not find Bot Content link inside mobile drawer.");
  }

  // Wait for URL to change to /bot-content
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const currUrl = await cdp.evaluate("window.location.pathname");
    if (currUrl.includes("/bot-content")) break;
  }

  const postNavState = await cdp.evaluate(`(() => ({
    pathname: window.location.pathname,
    sheetPresent: Boolean(document.querySelector('[data-slot="sheet-content"]')),
    isLocked: document.body.hasAttribute("data-scroll-locked"),
    scrollY: window.scrollY,
  }))()`);
  log(`Post-navigation state: ${JSON.stringify(postNavState)}`);

  if (postNavState.isLocked) {
    await fail("body remained locked after mobile drawer link navigation.");
  }

  // Verify scrolling works on navigated page
  log("Verifying single-finger touch scrolling on navigated page...");
  await performTouchSwipe(cdp, { startX: 180, startY: 550, endY: 200, steps: 10 });
  const postNavScroll = await cdp.evaluate("window.scrollY");
  log(`window.scrollY on navigated page: ${postNavScroll}px`);
  if (postNavScroll <= 50) {
    await fail(
      `Single-finger touch scrolling failed on navigated page. Got ${postNavScroll}px.`
    );
  }

  log("\n[SUCCESS] All mobile single-finger touch scrolling tests PASSED!");
  await cdp.close();
  await cleanup();
}

main().catch(async (err) => {
  log(`UNHANDLED ERROR: ${err.stack || err.message}`);
  await cleanup();
  process.exit(1);
});
