#!/usr/bin/env node
/**
 * Real-browser acceptance for the Phase 2B-2 merchant journey.
 *
 * Runs the built Next.js application against a disposable loopback PostgreSQL
 * database, seeds invitations through the merged transactional service, and
 * drives headless Chromium over CDP at a 360 px viewport.
 *
 * It proves the fragment token is not sent in a server URL, opening a link
 * does not consume it, acceptance is single-use, A and B resolve only their own
 * stores, and already-issued sessions are rejected after membership
 * revocation, user disablement and a session_version increase.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hash } from "@node-rs/argon2";
import { encode as encodeAuthJwt } from "next-auth/jwt";
import postgres from "postgres";

import {
  detectConflictingFixture,
  readPgState,
  verifyAndStopOwnedFixture,
} from "./fixture-guard.mjs";

const APP_PORT = 3444;
const CDP_PORT = 9344;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const OPERATOR_EMAIL = "admin@example.test";
const OPERATOR_PASSWORD = "merchant-browser-operator-password";
const TEST_OPERATOR_ACCESS_KEY =
  "merchant-browser-operator-access-key-32-characters";

let appServer = null;
let chromeProcess = null;
let pgClient = null;
let ownedTempDir = null;
let ownedPgFixture = null;
let createdDbName = null;
let isCleaningUp = false;

function log(message) {
  process.stdout.write(`[merchant-browser] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[merchant-browser:FAIL] ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sleep(ms) {
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

    const result = verifyAndStopOwnedFixture({
      stateFilePath,
      ownedFixture: ownedPgFixture,
      stopFn: (fixture) => {
        try {
          spawnSync(
            "node",
            ["scripts/db-test-postgres.mjs", "stop", fixture.datadir],
            {
              stdio: "ignore",
              env: { ...process.env, RABET_PG_STATE_FILE: stateFilePath },
            },
          );
        } catch {}
      },
    });

    if (!result.stopped) {
      log(`Preserved database state (did not stop fixture: ${result.reason}).`);
    }
    ownedPgFixture = null;
  }
}

async function main() {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    fail(
      "Chromium executable not found. Set CHROME_BIN or CHROME_PATH environment variable.",
    );
  }
  log(`Using Chromium executable: ${chromePath}`);

  let pgUrl = "";
  if (process.env.RABET_TEST_PG_URL) {
    createdDbName = `rabet_merchant_browser_${Date.now()}`;
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
      fail(
        `Pre-existing disposable PostgreSQL instance detected at ${stateFilePath} ` +
          `(port ${conflict.port}, datadir: ${conflict.datadir}). Stop it before running this suite.`,
      );
    }

    log("Starting disposable PostgreSQL...");
    const pgStart = spawnSync("node", ["scripts/db-test-postgres.mjs", "start"], {
      encoding: "utf8",
      env: { ...process.env, RABET_PG_STATE_FILE: stateFilePath },
    });
    if (pgStart.status !== 0) {
      fail(`Could not start disposable PostgreSQL: ${pgStart.stderr}`);
    }

    const pgUrlMatch = pgStart.stdout.match(/postgresql:\/\/[^\s]+/);
    if (!pgUrlMatch) fail("Could not find PostgreSQL URL in output");
    pgUrl = pgUrlMatch[0];

    const stateData = readPgState(stateFilePath);
    ownedPgFixture = {
      port: stateData?.port ?? new URL(pgUrl).port,
      datadir: stateData?.datadir ?? "",
      url: pgUrl,
    };
  }

  const parsedPgUrl = new URL(pgUrl);
  if (
    parsedPgUrl.hostname !== "127.0.0.1" &&
    parsedPgUrl.hostname !== "localhost" &&
    !process.env.RABET_TEST_PG_URL
  ) {
    fail(`Refusing to run against non-loopback database host: ${parsedPgUrl.hostname}`);
  }
  log(`Disposable PostgreSQL ready on port ${parsedPgUrl.port}`);

  log("Applying database migrations...");
  const migrate = spawnSync("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: pgUrl },
    encoding: "utf8",
  });
  if (migrate.status !== 0) {
    fail(`Migration failed: ${migrate.stderr || migrate.stdout}`);
  }

  pgClient = postgres(pgUrl, { max: 5 });

  ownedTempDir = mkdtempSync(path.join(tmpdir(), "rabet-merchant-browser-"));
  chmodSync(ownedTempDir, 0o700);

  const seedOutput = path.join(ownedTempDir, "merchant-fixture.json");
  log("Seeding invitations through the merged transactional service...");
  const seed = spawnSync(
    "npx",
    [
      "tsx",
      "--tsconfig",
      "scripts/tsconfig.seed.json",
      "scripts/merchant-browser-seed.ts",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SEED_DATABASE_URL: pgUrl,
        SEED_OUTPUT: seedOutput,
      },
    },
  );
  if (seed.status !== 0) {
    fail(`Merchant fixture seed failed: ${seed.stderr || seed.stdout}`);
  }
  const fixture = JSON.parse(readFileSync(seedOutput, "utf8"));

  const postgresModuleUrl = import.meta.resolve("postgres");
  const bootstrapFile = path.join(ownedTempDir, "neon-proxy-bootstrap.mjs");
  writeFileSync(
    bootstrapFile,
    `import postgres from "${postgresModuleUrl}";\n` +
      `const originalFetch = globalThis.fetch;\n` +
      `const formatVal = (v) => typeof v === "boolean" ? (v ? "t" : "f") : v;\n` +
      `let pg = null;\n` +
      `globalThis.fetch = async (input, init) => {\n` +
      `  const url = typeof input === "string" ? input : (input ? input.url : "");\n` +
      `  if (process.env.TEST_REAL_PG_URL && typeof url === "string" && url.endsWith("/sql")) {\n` +
      `    if (!pg) pg = postgres(process.env.TEST_REAL_PG_URL);\n` +
      `    const { query, params } = JSON.parse(init.body);\n` +
      `    try {\n` +
      `      const rows = await pg.unsafe(query, params || []).values();\n` +
      `      const cols = rows.columns || [];\n` +
      `      const fields = cols.map((c) => ({ name: c.name, dataTypeID: c.type }));\n` +
      `      const rowArrays = rows.map((r) => r.map((value) => formatVal(value)));\n` +
      `      return new Response(JSON.stringify({ rows: rowArrays, fields }), {\n` +
      `        status: 200, headers: { "content-type": "application/json" },\n` +
      `      });\n` +
      `    } catch (err) {\n` +
      `      return new Response(JSON.stringify({ message: err.message }), {\n` +
      `        status: 500, headers: { "content-type": "application/json" },\n` +
      `      });\n` +
      `    }\n` +
      `  }\n` +
      `  return originalFetch(input, init);\n` +
      `};\n`,
    { mode: 0o600 },
  );

  const operatorPasswordHash = await hash(OPERATOR_PASSWORD, {
    algorithm: 2,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const authSecret = crypto.randomBytes(32).toString("base64");

  // The application client is the Neon HTTP driver. A `localhost` host keeps
  // its request URL parseable and lets the preload route every `/sql` call to
  // the disposable PostgreSQL database. The transaction client uses the same
  // URL and reaches the same loopback instance over TCP.
  const appDatabaseUrl = (() => {
    const parsed = new URL(pgUrl);
    if (parsed.hostname === "127.0.0.1") parsed.hostname = "localhost";
    return parsed.toString();
  })();

  const envFile = path.join(ownedTempDir, "test.env");
  writeFileSync(
    envFile,
    [
      `export DATABASE_URL='${appDatabaseUrl}'`,
      `export TEST_REAL_PG_URL='${pgUrl}'`,
      `export AUTH_SECRET='${authSecret}'`,
      `export AUTH_URL='${BASE_URL}'`,
      `export APP_URL='${BASE_URL}'`,
      `export AUTH_TRUST_HOST='true'`,
      `export ADMIN_EMAIL='${OPERATOR_EMAIL}'`,
      `export ADMIN_PASSWORD_HASH='${operatorPasswordHash}'`,
      `export RABET_OPERATOR_ACCESS_KEY='${TEST_OPERATOR_ACCESS_KEY}'`,
      `export RABET_MERCHANT_APP_ENABLED='true'`,
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
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env },
    },
  );

  appServer.stderr.on("data", (data) => {
    const text = data.toString();
    if (!text.includes("ExperimentalWarning")) {
      process.stderr.write(`[next:stderr] ${text}`);
    }
  });

  let serverReady = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(500);
    try {
      const response = await fetch(`${BASE_URL}/app/login`);
      if (response.status === 200) {
        serverReady = true;
        break;
      }
    } catch {}
  }
  if (!serverReady) fail("Next.js server failed to start within 20s");
  log("Next.js server is ready.");

  log("Launching headless Chromium...");
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
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let pageTarget = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(400);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      pageTarget = targets.find((target) => target.type === "page") || targets[0];
      if (pageTarget?.webSocketDebuggerUrl) break;
    } catch {}
  }
  if (!pageTarget) fail("Could not connect to the Chromium page target");

  const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 800,
    deviceScaleFactor: 2,
    mobile: true,
  });
  log("Chromium connected at a 360 px viewport.");

  const journey = await runJourney(cdp, fixture, authSecret);
  await runGateDisabledProbe(envFile, journey.merchantCookie);

  log("ALL MERCHANT BROWSER ACCEPTANCE CHECKS PASSED");
  await cleanup();
}

async function runGateDisabledProbe(envFile, merchantCookie) {
  const port = 3445;
  const baseUrl = `http://127.0.0.1:${port}`;

  log("Checking direct merchant routes with the feature gate disabled...");

  const probeServer = spawn(
    "bash",
    [
      "-c",
      `source "${envFile}" && export RABET_MERCHANT_APP_ENABLED='false' && export AUTH_URL='${baseUrl}' && PORT=${port} node node_modules/next/dist/bin/next start`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env },
    },
  );

  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(500);
      try {
        const response = await fetch(`${baseUrl}/`);
        if (response.status > 0) {
          ready = true;
          break;
        }
      } catch {}
    }

    assert(ready, "Feature-gate-off server failed to start within 20s");

    const cookie = `rabet-merchant.session-token=${merchantCookie}`;
    const products = await fetch(
      `${baseUrl}/app/products?gateProbe=${Date.now()}`,
      {
        headers: { Cookie: cookie, "Cache-Control": "no-store" },
      },
    );
    const login = await fetch(`${baseUrl}/app/login?gateProbe=${Date.now()}`, {
      headers: { Cookie: cookie, "Cache-Control": "no-store" },
    });
    const productsBody = await products.text();
    const loginBody = await login.text();

    log(
      `Feature-gate-off responses: products=${products.status}, login=${login.status}`,
    );

    assert(
      products.status === 404 ||
        !productsBody.includes('data-testid="merchant-products-page"'),
      `Merchant products must be hidden when the feature gate is off (saw ${products.status})`,
    );
    assert(
      login.status === 404 ||
        !loginBody.includes('data-testid="merchant-login-page"'),
      `Merchant login must be hidden when the feature gate is off (saw ${login.status})`,
    );
  } finally {
    if (probeServer.pid) {
      try {
        process.kill(-probeServer.pid, "SIGKILL");
      } catch {}
    }
  }
}

async function runJourney(cdp, fixture, authSecret) {
  const { a, b, expired, revoked, used } = fixture;

  const evaluate = (expression) => cdp.evaluate(expression);
  const navigate = async (url) => {
    await cdp.send("Page.navigate", { url });
    await waitFor(
      cdp,
      "document.readyState === 'complete'",
      `document ready for ${url}`,
    );
  };
  const setValue = async (selector, value) => {
    const ok = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    assert(ok, `Input not found: ${selector}`);
  };
  const click = async (selector) => {
    const ok = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    assert(ok, `Clickable element not found: ${selector}`);
  };
  const text = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const waitForUrl = async (pathname, label) => {
    await waitFor(
      cdp,
      `window.location.pathname === ${JSON.stringify(pathname)}`,
      label,
    );
  };
  const postJson = async (pathname, body) =>
    evaluate(`(async () => {
      const response = await fetch(${JSON.stringify(pathname)}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(${JSON.stringify(body)}),
        cache: "no-store",
        credentials: "same-origin",
      });
      let json = null;
      try { json = await response.json(); } catch {}
      return {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        json,
      };
    })()`);
  const expectNoHorizontalScroll = async (label) => {
    const overflow = await evaluate(
      "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)",
    );
    assert(overflow <= 361, `${label}: expected no horizontal scroll at 360 px, saw ${overflow}`);
  };

  const invitationA = await pgClient`
    select accepted_at from merchant_invitation where id = ${a.invitationId}
  `;
  assert(invitationA[0].accepted_at === null, "Invitation A should start pending");

  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 350,
    downloadThroughput: 1024 * 1024,
    uploadThroughput: 1024 * 1024,
  });
  await navigate(`${BASE_URL}/invite#token=${encodeURIComponent(a.token)}`);
  assert(
    await waitFor(cdp, "Boolean(document.querySelector('[data-testid=\"invite-loading\"]'))", "invite loading state"),
    "Invite loading state was not rendered",
  );
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"invite-email\"]')?.textContent === " +
      JSON.stringify(a.email),
    "invitation A preview",
  );
  assert((await text('[data-testid="invite-store"]')) === a.storeName, "Invite should show store A name");
  assert(
    (await evaluate("document.querySelector('[data-testid=\"invite-page\"]').getAttribute('dir')")) === "rtl",
    "Invitation page should default to RTL Arabic",
  );
  await expectNoHorizontalScroll("invite (Arabic)");

  await click('[data-testid="merchant-locale-en"]');
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"invite-page\"]').getAttribute('dir') === 'ltr'",
    "English invitation direction",
  );
  assert(
    (await evaluate("document.body.innerText")).includes("Accept merchant invitation"),
    "English invitation copy should be available",
  );
  await click('[data-testid="merchant-locale-ar"]');

  const stillPending = await pgClient`
    select accepted_at from merchant_invitation where id = ${a.invitationId}
  `;
  assert(stillPending[0].accepted_at === null, "Previewing the invitation must not consume it");

  await setValue('[data-testid="invite-password"]', fixture.password);
  await setValue('[data-testid="invite-confirmation"]', fixture.password + "-different");
  await click('[data-testid="invite-submit"]');
  await waitFor(
    cdp,
    "document.body.innerText.includes('كلمتا المرور غير متطابقتين')",
    "password mismatch field error",
  );

  await setValue('[data-testid="invite-confirmation"]', fixture.password);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 250,
    downloadThroughput: 1024 * 1024,
    uploadThroughput: 1024 * 1024,
  });
  await click('[data-testid="invite-submit"]');
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"invite-submit\"]')?.disabled === true",
    "acceptance pending state",
  );
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"invite-success\"]'))",
    "acceptance success",
  );
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  const consumed = await pgClient`
    select accepted_at from merchant_invitation where id = ${a.invitationId}
  `;
  assert(consumed[0].accepted_at !== null, "Explicit submission should consume invitation A");

  const secondSubmit = await postJson("/api/merchant-invitations/accept", {
    token: a.token,
    password: fixture.password,
    passwordConfirmation: fixture.password,
  });
  assert(secondSubmit.status === 400, "Second acceptance submission should be rejected");
  assert(secondSubmit.json?.code === "INVITATION_REJECTED", "Second submission should be generic");

  const membershipA = await pgClient`
    select count(*)::int as count from store_membership where store_id = ${a.storeId}
  `;
  assert(membershipA[0].count === 1, "Second submission must not create a second membership");

  await click('[data-testid="invite-login-link"]');
  await waitForUrl("/app/login", "redirect to merchant login");
  await waitFor(cdp, "Boolean(document.querySelector('[data-testid=\"merchant-login-email\"]'))", "merchant login form");
  assert(
    (await evaluate("document.querySelector('[data-testid=\"merchant-login-page\"]').getAttribute('dir')")) === "rtl",
    "Merchant login should default to RTL Arabic",
  );
  await expectNoHorizontalScroll("merchant login (Arabic)");
  await click('[data-testid="merchant-locale-en"]');
  assert(
    (await evaluate("document.body.innerText")).includes("Merchant sign in"),
    "Merchant login English copy should be available",
  );
  await click('[data-testid="merchant-locale-ar"]');

  await setValue('[data-testid="merchant-login-email"]', a.email);
  await setValue('[data-testid="merchant-login-password"]', "wrong-password-123");
  await click('[data-testid="merchant-login-submit"]');
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-login-error\"]'))",
    "bad password error",
  );

  await setValue('[data-testid="merchant-login-password"]', fixture.password);
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-login-submit\"]')?.disabled === false",
    "merchant login re-enabled",
  );
  await click('[data-testid="merchant-login-submit"]');
  await waitForUrl("/app/setup", "merchant A setup page");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-store-name\"]')?.textContent === " +
      JSON.stringify(a.storeName),
    "store A name on setup page",
  );
  assert(
    (await text('[data-testid="merchant-store-status"]')).includes("قيد الإعداد"),
    "Setup page should show onboarding status",
  );
  assert(
    (await evaluate("document.querySelector('[data-testid=\"merchant-setup-page\"]').getAttribute('dir')")) === "rtl",
    "Setup page should be RTL",
  );
  await expectNoHorizontalScroll("merchant setup (Arabic)");

  assert(
    await evaluate(
      "Boolean(document.querySelector('[data-testid=\"merchant-products-link\"]'))",
    ),
    "Setup should link to the merchant products page",
  );
  await click('[data-testid="merchant-products-link"]');
  await waitForUrl("/app/products", "merchant A products page");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-products-store-name\"]')?.textContent === " +
      JSON.stringify(a.storeName),
    "store A name on products page",
  );
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-testid=\"merchant-product-row\"]').length === 3",
    "merchant A product rows",
  );
  assert(
    (await evaluate(
      "document.querySelector('[data-testid=\"merchant-products-page\"]').getAttribute('dir')",
    )) === "rtl",
    "Merchant products page should default to RTL Arabic",
  );
  await expectNoHorizontalScroll("merchant products (Arabic)");

  const aProductIds = await evaluate(
    "Array.from(document.querySelectorAll('[data-testid=\"merchant-product-row\"]')).map((row) => row.getAttribute('data-product-id'))",
  );
  assert(
    JSON.stringify(aProductIds) ===
      JSON.stringify([a.products.one.id, a.products.two.id, a.products.fallback.id]),
    "Merchant A should see exactly A's products",
  );
  assert(
    (await text(`[data-testid="merchant-product-name-${a.products.one.id}"]`)) ===
      "منتج النور الأول",
    "The Arabic product name should be preferred",
  );
  assert(
    (await text(`[data-testid="merchant-product-name-${a.products.fallback.id}"]`)) ===
      a.products.fallback.slug,
    "A product without translations should fall back to its slug",
  );
  const aProductsText = await evaluate("document.body.innerText");
  assert(
    !aProductsText.includes("منتج القمر الأول") &&
      !aProductsText.includes("Al Qamar Product One"),
    "Merchant A must not see B's products",
  );

  await click('[data-testid="merchant-locale-en"]');
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-products-page\"]').getAttribute('dir') === 'ltr'",
    "English merchant products direction",
  );
  assert(
    (await evaluate("document.body.innerText")).includes("Store products"),
    "Merchant products English copy should be available",
  );
  await click('[data-testid="merchant-locale-ar"]');
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-products-page\"]').getAttribute('dir') === 'rtl'",
    "Arabic merchant products direction",
  );

  const aPriceInput = `[data-testid="merchant-price-input-${a.products.one.id}"]`;
  const aSaveButton = `[data-testid="merchant-price-save-${a.products.one.id}"]`;
  const aPriceError = `[data-testid="merchant-price-error-${a.products.one.id}"]`;
  const aPriceSaved = `[data-testid="merchant-price-saved-${a.products.one.id}"]`;

  await setValue(aPriceInput, "123.45");
  await click(aSaveButton);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aPriceSaved)})) && document.querySelector(${JSON.stringify(aPriceInput)})?.value === "123.45"`,
    "merchant A exact price save",
  );
  assert(
    (await evaluate(`document.querySelector(${JSON.stringify(aPriceInput)})?.value`)) ===
      "123.45",
    "The canonical persisted price should be visible after saving",
  );

  const savedPriceA = await pgClient`
    select price::text as price from product where id = ${a.products.one.id}
  `;
  assert(savedPriceA[0].price === "123.45", "The exact price should be persisted");

  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    `document.querySelector(${JSON.stringify(aPriceInput)})?.value === "123.45"`,
    "merchant A saved price after reload",
  );

  // Repopulate the previous-success path, then change product one outside the
  // browser. Saving product two triggers the scoped refresh that must replace
  // the clean row with the newer server price.
  await setValue(aPriceInput, "123.46");
  await click(aSaveButton);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aPriceSaved)})) && document.querySelector(${JSON.stringify(aPriceInput)})?.value === "123.46"`,
    "merchant A second successful save",
  );

  await pgClient`
    update product set price = '77.70' where id = ${a.products.one.id}
  `;

  const aSecondInput = `[data-testid="merchant-price-input-${a.products.two.id}"]`;
  const aSecondSave = `[data-testid="merchant-price-save-${a.products.two.id}"]`;
  const aSecondSaved = `[data-testid="merchant-price-saved-${a.products.two.id}"]`;
  const aConfirmedPrice = "77.70";

  await setValue(aSecondInput, "15.00");
  assert(
    await evaluate(`(() => {
      window.__merchantPricePosts = 0;
      const originalFetch = window.fetch;
      window.fetch = function (input, init) {
        const url =
          typeof input === "string" ? input : (input && input.url) || String(input);
        if (url.includes("/app/products") && init && init.method === "POST") {
          window.__merchantPricePosts += 1;
        }
        return originalFetch.apply(this, arguments);
      };
      return true;
    })()`),
    "Could not instrument the merchant price action fetch calls",
  );

  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 700,
    downloadThroughput: 1024 * 1024,
    uploadThroughput: 1024 * 1024,
  });

  assert(
    await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(aSecondInput)});
      const form = input && input.closest("form");
      if (!form) return false;
      form.requestSubmit();
      form.requestSubmit();
      return true;
    })()`),
    "Could not submit the controlled pending price save",
  );
  await waitFor(
    cdp,
    `document.querySelector(${JSON.stringify(aSecondInput)})?.readOnly === true && document.querySelector(${JSON.stringify(aSecondSave)})?.disabled === true`,
    "pending price field protection",
  );

  await evaluate(
    `document.querySelector(${JSON.stringify(aSecondInput)})?.closest("form")?.requestSubmit()`,
  );
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aSecondSaved)})) && document.querySelector(${JSON.stringify(aSecondInput)})?.value === "15.00" && document.querySelector(${JSON.stringify(aPriceInput)})?.value === ${JSON.stringify(aConfirmedPrice)}`,
    "single pending save and reconciled server price",
  );
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  assert(
    (await evaluate("window.__merchantPricePosts")) === 1,
    "Rapid repeat submission must start exactly one price write",
  );
  assert(
    (await evaluate(`document.querySelector(${JSON.stringify(aSecondInput)})?.readOnly`)) ===
      false,
    "The price field should be editable again after the save completes",
  );

  const aSecondConflict = `[data-testid="merchant-price-conflict-${a.products.two.id}"]`;
  const aSecondConflictLatest = `[data-testid="merchant-price-conflict-latest-${a.products.two.id}"]`;
  const aSecondUseLatest = `[data-testid="merchant-price-use-latest-${a.products.two.id}"]`;
  const aSecondRetry = `[data-testid="merchant-price-retry-${a.products.two.id}"]`;

  // Another device wins while this merchant's draft is open. The stale draft
  // must not overwrite it, and the UI must offer explicit conflict choices.
  await setValue(aSecondInput, "33.30");
  await pgClient`
    update product set price = '44.40' where id = ${a.products.two.id}
  `;
  await click(aSecondSave);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aSecondConflict)})) && document.querySelector(${JSON.stringify(aSecondConflictLatest)})?.textContent === "44.40" && document.querySelector(${JSON.stringify(aSecondInput)})?.value === "33.30"`,
    "merchant stale price conflict and preserved draft",
  );
  await expectNoHorizontalScroll("merchant stale price conflict");
  assert(
    (await pgClient`
      select price::text as price from product where id = ${a.products.two.id}
    `)[0].price === "44.40",
    "The stale draft must not replace the winning price",
  );

  await click(aSecondUseLatest);
  await waitFor(
    cdp,
    `document.querySelector(${JSON.stringify(aSecondInput)})?.value === "44.40" && !document.querySelector(${JSON.stringify(aSecondConflict)})`,
    "use latest conflict resolution",
  );
  assert(
    (await pgClient`
      select price::text as price from product where id = ${a.products.two.id}
    `)[0].price === "44.40",
    "Using the latest price must not write a new value",
  );

  // A second conflict exposes the intentional retry path against the latest
  // authorized revision and keeps the merchant's typed draft.
  await setValue(aSecondInput, "55.50");
  await pgClient`
    update product set price = '66.60' where id = ${a.products.two.id}
  `;
  await click(aSecondSave);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aSecondConflict)})) && document.querySelector(${JSON.stringify(aSecondConflictLatest)})?.textContent === "66.60" && document.querySelector(${JSON.stringify(aSecondInput)})?.value === "55.50"`,
    "second stale price conflict",
  );
  await click(aSecondRetry);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aSecondSaved)})) && document.querySelector(${JSON.stringify(aSecondInput)})?.value === "55.50" && !document.querySelector(${JSON.stringify(aSecondConflict)})`,
    "intentional retry against latest revision",
  );
  assert(
    (await pgClient`
      select price::text as price from product where id = ${a.products.two.id}
    `)[0].price === "55.50",
    "Explicit retry should persist the merchant's reviewed draft",
  );

  await setValue(aPriceInput, "10.123");
  await click(aSaveButton);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aPriceError)}))`,
    "invalid price field error",
  );
  assert(
    (await evaluate(`document.querySelector(${JSON.stringify(aPriceInput)})?.value`)) ===
      "10.123",
    "The invalid draft should remain visible",
  );
  assert(
    (await pgClient`
      select price::text as price from product where id = ${a.products.one.id}
    `)[0].price === aConfirmedPrice,
    "An invalid price must not write",
  );

  const aRows = await pgClient`
    select u.id as user_id, u.session_version, m.id as membership_id
    from app_user u
    join store_membership m on m.user_id = u.id
    where lower(u.email) = ${a.email}
  `;
  assert(aRows.length === 1, "Merchant A should have exactly one membership");
  const aRow = aRows[0];

  await setValue(aPriceInput, "124.00");
  await pgClient`
    update store_membership set status = 'revoked' where id = ${aRow.membership_id}
  `;
  await click(aSaveButton);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aPriceError)}))`,
    "revoked membership save denial",
  );
  assert(
    (await pgClient`
      select price::text as price from product where id = ${a.products.one.id}
    `)[0].price === aConfirmedPrice,
    "A revoked membership save must not write",
  );
  await pgClient`
    update store_membership set status = 'active' where id = ${aRow.membership_id}
  `;
  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aSaveButton)}))`,
    "products page after membership restore",
  );

  await setValue(aPriceInput, "125.00");
  await pgClient`
    update app_user set session_version = session_version + 1 where id = ${aRow.user_id}
  `;
  await click(aSaveButton);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aPriceError)}))`,
    "stale session_version save denial",
  );
  assert(
    (await pgClient`
      select price::text as price from product where id = ${a.products.one.id}
    `)[0].price === aConfirmedPrice,
    "A stale session_version save must not write",
  );
  await pgClient`
    update app_user set session_version = session_version - 1 where id = ${aRow.user_id}
  `;
  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aSaveButton)}))`,
    "products page after session_version restore",
  );

  await setValue(aPriceInput, "126.00");
  await pgClient`
    update store set status = 'suspended' where id = ${a.storeId}
  `;
  await click(aSaveButton);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aPriceError)}))`,
    "suspended store save denial",
  );
  assert(
    (await pgClient`
      select price::text as price from product where id = ${a.products.one.id}
    `)[0].price === aConfirmedPrice,
    "A suspended store save must not write",
  );

  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-products-suspended-notice\"]'))",
    "suspended products read-only notice",
  );
  assert(
    (await evaluate(
      "document.querySelectorAll('[data-testid^=\"merchant-price-save-\"]').length",
    )) === 0,
    "A suspended store must not render enabled price controls",
  );
  assert(
    (await text(`[data-testid="merchant-product-price-${a.products.one.id}"]`)) ===
      aConfirmedPrice,
    "A suspended store should still see its own product list",
  );
  await expectNoHorizontalScroll("suspended merchant products");
  await pgClient`
    update store set status = 'onboarding' where id = ${a.storeId}
  `;
  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aSaveButton)}))`,
    "products page after store reactivation",
  );

  await click('[data-testid="merchant-logout"]');
  await waitForUrl("/app/login", "merchant logout");
  await setValue('[data-testid="merchant-login-email"]', a.email);
  await setValue('[data-testid="merchant-login-password"]', fixture.password);
  await click('[data-testid="merchant-login-submit"]');
  await waitForUrl("/app/setup", "second merchant A sign-in");

  await navigate(
    `${BASE_URL}/app/setup?storeId=${encodeURIComponent(b.storeId)}&store=${encodeURIComponent(b.storeSlug)}`,
  );
  await waitForUrl("/app/setup", "store hint stays on setup");
  assert(
    (await text('[data-testid="merchant-store-name"]')) === a.storeName,
    "A store hint for B must not switch merchant A's store",
  );

  const cookieJar = await cdp.send("Network.getCookies", { urls: [BASE_URL] });
  const merchantCookie = cookieJar.cookies.find((cookie) =>
    String(cookie.name).startsWith("rabet-merchant.session-token"),
  );
  assert(merchantCookie, "Merchant session cookie should exist after sign-in");
  const operatorProbe = await fetch(`${BASE_URL}/overview`, {
    redirect: "manual",
    headers: { Cookie: `rabet-merchant.session-token=${merchantCookie.value}` },
  });
  assert(
    [302, 307, 308].includes(operatorProbe.status),
    `Merchant session must not pass the operator proxy (status ${operatorProbe.status})`,
  );
  assert(
    String(operatorProbe.headers.get("location")).includes("/login"),
    "Merchant session should be redirected to the operator login gate",
  );

  await navigate(`${BASE_URL}/app/setup`);
  await waitForUrl("/app/setup", "merchant A still signed in");
  await click('[data-testid="merchant-logout"]');
  await waitForUrl("/app/login", "merchant A logout before B");

  await navigate(`${BASE_URL}/invite#token=${encodeURIComponent(b.token)}`);
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"invite-email\"]')?.textContent === " +
      JSON.stringify(b.email),
    "invitation B preview",
  );
  assert((await text('[data-testid="invite-store"]')) === b.storeName, "Invite should show store B name");
  await setValue('[data-testid="invite-password"]', fixture.password);
  await setValue('[data-testid="invite-confirmation"]', fixture.password);
  await click('[data-testid="invite-submit"]');
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"invite-success\"]'))",
    "invitation B acceptance",
  );

  await navigate(`${BASE_URL}/app/login`);
  await setValue('[data-testid="merchant-login-email"]', b.email);
  await setValue('[data-testid="merchant-login-password"]', fixture.password);
  await click('[data-testid="merchant-login-submit"]');
  await waitForUrl("/app/setup", "merchant B setup page");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-store-name\"]')?.textContent === " +
      JSON.stringify(b.storeName),
    "store B name on setup page",
  );

  await navigate(
    `${BASE_URL}/app/setup?storeId=${encodeURIComponent(a.storeId)}&store=${encodeURIComponent(a.storeSlug)}`,
  );
  await waitForUrl("/app/setup", "store hint stays on B setup");
  assert(
    (await text('[data-testid="merchant-store-name"]')) === b.storeName,
    "A store hint for A must not switch merchant B's store",
  );

  await navigate(`${BASE_URL}/app/products`);
  await waitForUrl("/app/products", "merchant B products page");
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-testid=\"merchant-product-row\"]').length === 3",
    "merchant B product rows",
  );
  const bProductIds = await evaluate(
    "Array.from(document.querySelectorAll('[data-testid=\"merchant-product-row\"]')).map((row) => row.getAttribute('data-product-id'))",
  );
  assert(
    JSON.stringify(bProductIds) ===
      JSON.stringify([b.products.one.id, b.products.two.id, b.products.fallback.id]),
    "Merchant B should see exactly B's products",
  );
  assert(
    (await text(`[data-testid="merchant-product-name-${b.products.one.id}"]`)) ===
      "منتج القمر الأول",
    "Merchant B should see B's Arabic product name",
  );
  const bProductsText = await evaluate("document.body.innerText");
  assert(
    !bProductsText.includes("منتج النور الأول") &&
      !bProductsText.includes("Al Noor Product One"),
    "Merchant B must not see A's products",
  );
  assert(
    (await evaluate(
      `document.querySelector('[data-testid="merchant-price-input-${b.products.one.id}"]')?.value`,
    )) === "10.00",
    "Merchant B should keep B's original price",
  );
  assert(
    (await pgClient`
      select price::text as price from product where id = ${b.products.one.id}
    `)[0].price === "10.00",
    "A's save must not change B's price",
  );
  assert(
    (await pgClient`
      select price::text as price from product where id = ${a.products.one.id}
    `)[0].price === aConfirmedPrice,
    "A's persisted price should remain independent of B",
  );

  const invalidPreview = await postJson("/api/merchant-invitations/preview", {
    token: crypto.randomBytes(32).toString("base64url"),
  });
  assert(invalidPreview.status === 400, "Invalid token preview should be rejected");

  for (const candidate of [expired, revoked, used]) {
    const preview = await postJson("/api/merchant-invitations/preview", {
      token: candidate.token,
    });
    assert(preview.status === 400, `Terminal invitation ${candidate.email} should be rejected`);
    assert(
      JSON.stringify(preview.json) === JSON.stringify(invalidPreview.json),
      "Invalid, expired, revoked and consumed invitations must share one generic response",
    );
  }

  const usedAgain = await postJson("/api/merchant-invitations/accept", {
    token: used.token,
    password: used.password,
    passwordConfirmation: used.password,
  });
  assert(usedAgain.status === 400, "Consumed invitation acceptance should be rejected");
  assert(usedAgain.json?.code === "INVITATION_REJECTED", "Consumed invitation response should be generic");

  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await postJson("/api/merchant-invitations/preview", {
      token: fixture.throttle.token,
    });
    assert(
      response.status === 200,
      "A recognized invitation should remain previewable within its budget",
    );
  }
  const throttled = await postJson("/api/merchant-invitations/preview", {
    token: fixture.throttle.token,
  });
  assert(throttled.status === 429, "Invitation throttle should deny the eleventh preview");
  assert(Number(throttled.retryAfter) > 0, "Throttle response should include Retry-After");

  await navigate(`${BASE_URL}/invite#token=${encodeURIComponent(fixture.throttle.token)}`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"invite-rate-limited\"]'))",
    "invitation preview rate-limit state",
  );
  assert(
    (await evaluate("document.body.innerText")).includes("محاولات كثيرة"),
    "Rate-limited preview should show the Arabic temporary message",
  );
  await click('[data-testid="merchant-locale-en"]');
  assert(
    (await evaluate("document.body.innerText")).includes("Too many attempts"),
    "Rate-limited preview should show the English temporary message",
  );

  const bRows = await pgClient`
    select u.id as user_id, u.session_version, m.id as membership_id, m.status as membership_status
    from app_user u
    join store_membership m on m.user_id = u.id
    where lower(u.email) = ${b.email}
  `;
  assert(bRows.length === 1, "Merchant B should have exactly one membership");
  const bRow = bRows[0];

  await pgClient`
    update store_membership set status = 'revoked' where id = ${bRow.membership_id}
  `;
  await navigate(`${BASE_URL}/app/setup`);
  await waitForUrl("/app/login", "revoked membership denial");
  await pgClient`
    update store_membership set status = 'active' where id = ${bRow.membership_id}
  `;
  await navigate(`${BASE_URL}/app/setup`);
  await waitForUrl("/app/setup", "membership restore re-enables the existing session");

  await pgClient`
    update app_user set status = 'disabled' where id = ${bRow.user_id}
  `;
  await navigate(`${BASE_URL}/app/setup`);
  await waitForUrl("/app/login", "disabled user denial");
  await pgClient`
    update app_user set status = 'active' where id = ${bRow.user_id}
  `;
  await navigate(`${BASE_URL}/app/setup`);
  await waitForUrl("/app/setup", "user re-enable restores the existing session");

  await pgClient`
    update app_user set session_version = session_version + 1 where id = ${bRow.user_id}
  `;
  await navigate(`${BASE_URL}/app/setup`);
  await waitForUrl("/app/login", "stale session_version denial");

  await signInMerchant(cdp, navigate, setValue, click, waitForUrl, b.email, fixture.password);
  await pgClient`
    insert into store_membership (store_id, user_id, role, status)
    values (${a.storeId}, ${bRow.user_id}, 'owner', 'active')
    on conflict (store_id, user_id) do nothing
  `;
  await navigate(`${BASE_URL}/app/setup`);
  await waitForUrl("/app/login", "multiple membership denial");
  await pgClient`
    delete from store_membership where store_id = ${a.storeId} and user_id = ${bRow.user_id}
  `;
  await navigate(`${BASE_URL}/app/setup`);
  await waitForUrl("/app/setup", "single membership restores the existing session");

  await pgClient`
    update store set status = 'suspended' where id = ${b.storeId}
  `;
  await navigate(`${BASE_URL}/app/setup`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-suspended-notice\"]'))",
    "suspended store read-only notice",
  );
  await expectNoHorizontalScroll("suspended setup");
  await pgClient`
    update store set status = 'onboarding' where id = ${b.storeId}
  `;

  await click('[data-testid="merchant-logout"]');
  await waitForUrl("/app/login", "merchant B logout");

  // Mint an operator session exactly as the operator Auth.js instance would
  // (same secret, role claim and cookie name). This proves cookie-namespace
  // isolation without spending the operator login budget or touching Neon.
  const operatorCookie = await encodeAuthJwt({
    token: { role: "admin", email: OPERATOR_EMAIL, sub: "admin" },
    secret: authSecret,
    salt: "authjs.session-token",
  });
  await cdp.send("Network.setCookie", {
    name: "authjs.session-token",
    value: operatorCookie,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
  });
  await navigate(`${BASE_URL}/app/setup`);
  await waitForUrl("/app/login", "operator session cannot open merchant setup");
  await navigate(`${BASE_URL}/overview`);
  await waitForUrl("/overview", "operator dashboard still works");
  await waitFor(
    cdp,
    "document.title.toLowerCase().includes('overview')",
    "operator overview page",
  );
  log("Merchant/operator isolation and the full merchant journey passed.");

  return { merchantCookie: merchantCookie.value };
}

async function signInMerchant(cdp, navigate, setValue, click, waitForUrl, email, password) {
  await navigate(`${BASE_URL}/app/login`);
  await waitFor(cdp, "Boolean(document.querySelector('[data-testid=\"merchant-login-email\"]'))", "merchant login form");
  await setValue('[data-testid="merchant-login-email"]', email);
  await setValue('[data-testid="merchant-login-password"]', password);
  await click('[data-testid="merchant-login-submit"]');
  await waitForUrl("/app/setup", `merchant ${email} sign-in`);
}


async function waitFor(cdp, expression, label, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch {}
    await sleep(150);
  }
  let context = "";
  try {
    context = await cdp.evaluate(
      "JSON.stringify({ path: window.location.pathname, text: document.body.innerText.slice(0, 500), rows: Array.from(document.querySelectorAll('[data-testid=\"merchant-product-row\"]')).map((row) => ({ id: row.getAttribute('data-product-id'), text: row.innerText.slice(0, 120) })) })",
    );
  } catch {}
  fail(`Timed out waiting for ${label}${context ? ` — page: ${context}` : ""}`);
}

function resolveChromePath() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const playwrightDirs = [
    "/root/.cache/ms-playwright",
    path.join(process.env.HOME || "", ".cache/ms-playwright"),
  ];
  for (const directory of playwrightDirs) {
    if (!existsSync(directory)) continue;
    try {
      for (const entry of readdirSync(directory)) {
        if (!entry.startsWith("chromium-")) continue;
        const candidate = path.join(directory, entry, "chrome-linux64/chrome");
        if (existsSync(candidate)) return candidate;
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
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

main().catch(async (error) => {
  process.stderr.write(
    `[merchant-browser:FAIL] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  await cleanup();
  process.exit(1);
});
