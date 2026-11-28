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
      `    const booleanColumns = new Set(["is_active", "enabled", "ask_for_language", "is_enabled", "is_blocked"]);\n` +
      `    const booleanIndexes = new Set();\n` +
      `    for (const match of query.matchAll(/"([a-z_]+)"\\s*=\\s*\\$(\\d+)/g)) {\n` +
      `      if (booleanColumns.has(match[1])) booleanIndexes.add(Number(match[2]));\n` +
      `    }\n` +
      `    const normalizedParams = (params || []).map((value, index) =>\n` +
      `      typeof value === "string" && booleanIndexes.has(index + 1)\n` +
      `        ? value === "true"\n` +
      `        : value,\n` +
      `    );\n` +
      `    try {\n` +
      `      const rows = await pg.unsafe(query, normalizedParams).values();\n` +
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
      `export RABET_COD_ORDERS_ENABLED='true'`,
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
    const createProduct = await fetch(
      `${baseUrl}/app/products/new?gateProbe=${Date.now()}`,
      {
        headers: { Cookie: cookie, "Cache-Control": "no-store" },
      },
    );
    const categories = await fetch(
      `${baseUrl}/app/categories?gateProbe=${Date.now()}`,
      {
        headers: { Cookie: cookie, "Cache-Control": "no-store" },
      },
    );
    const productsBody = await products.text();
    const loginBody = await login.text();
    const createProductBody = await createProduct.text();
    const categoriesBody = await categories.text();

    log(
      `Feature-gate-off responses: products=${products.status}, login=${login.status}, create=${createProduct.status}, categories=${categories.status}`,
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
    assert(
      createProduct.status === 404 ||
        !createProductBody.includes(
          'data-testid="merchant-product-create-page"',
        ),
      `Merchant product creation must be hidden when the feature gate is off (saw ${createProduct.status})`,
    );
    assert(
      categories.status === 404 ||
        !categoriesBody.includes('data-testid="merchant-categories-page"'),
      `Merchant categories must be hidden when the feature gate is off (saw ${categories.status})`,
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
  const { a, b, empty, expired, revoked, used } = fixture;

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
      const prototype = el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
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
  const expectMerchantLocale = async (
    pageTestId,
    locale,
    expectedTitle,
    label,
  ) => {
    const direction = locale === "ar" ? "rtl" : "ltr";

    await waitFor(
      cdp,
      `document.querySelector('[data-testid="${pageTestId}"]')?.getAttribute('dir') === ${JSON.stringify(direction)} && ` +
        `document.querySelector('[data-testid="${pageTestId}"]')?.getAttribute('lang') === ${JSON.stringify(locale)}`,
      `${label} ${locale} direction and language`,
    );
    await waitFor(
      cdp,
      `document.querySelector('[data-testid="merchant-locale-${locale}"]')?.getAttribute('aria-pressed') === 'true'`,
      `${label} active ${locale} toggle`,
    );
    await waitFor(
      cdp,
      `document.title === ${JSON.stringify(expectedTitle)}`,
      `${label} ${locale} document title`,
    );
  };
  const expectInputValue = async (selector, expected, label) => {
    await waitFor(
      cdp,
      `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(expected)}`,
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
  assert((await evaluate("document.querySelector('[data-testid=\"invite-store\"]').value")) === a.storeName, "Invite should show store A name");
  assert(
    (await evaluate("document.querySelector('[data-testid=\"invite-page\"]').getAttribute('dir')")) === "rtl",
    "Invitation page should default to RTL Arabic",
  );
  await expectNoHorizontalScroll("invite (Arabic)");
  assert(
    (await evaluate("document.body.innerText")).includes("دعوة لإدارة متجرك على نكمل"),
    "Arabic Nokmel invitation copy should be available",
  );
  assert(
    (await evaluate(
      "document.querySelector('[data-testid=\"invite-brand\"]')?.getAttribute('aria-label')",
    )) === "نكمل",
    "Arabic invitation brand should be accessible",
  );

  const inviteTitleAr = "دعوة لإدارة متجرك على نكمل — Rabet";
  const inviteTitleEn = "You’re invited to manage your store on Nokmel — Rabet";

  await click('[data-testid="merchant-locale-en"]');
  await expectMerchantLocale(
    "invite-page",
    "en",
    inviteTitleEn,
    "English invitation",
  );
  assert(
    (await evaluate("document.body.innerText")).includes(
      "You’re invited to manage your store on Nokmel",
    ),
    "English invitation copy should be available",
  );
  assert(
    (await evaluate(
      "document.querySelector('[data-testid=\"invite-brand\"]')?.getAttribute('aria-label')",
    )) === "Nokmel",
    "English invitation brand should be accessible",
  );

  await navigate(`${BASE_URL}/invite#token=${encodeURIComponent(a.token)}`);
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"invite-email\"]')?.textContent === " +
      JSON.stringify(a.email),
    "invitation A preview after locale reload",
  );
  await expectMerchantLocale(
    "invite-page",
    "en",
    inviteTitleEn,
    "English invitation after reload",
  );
  await click('[data-testid="merchant-locale-ar"]');
  await expectMerchantLocale(
    "invite-page",
    "ar",
    inviteTitleAr,
    "Arabic invitation restored",
  );

  const stillPending = await pgClient`
    select accepted_at from merchant_invitation where id = ${a.invitationId}
  `;
  assert(stillPending[0].accepted_at === null, "Previewing the invitation must not consume it");

  await setValue('[data-testid="invite-password"]', "short");
  await click('[data-testid="invite-submit"]');
  await waitFor(
    cdp,
    "Boolean(document.querySelector('#invite-password-error'))",
    "password length field error",
  );
  await setValue('[data-testid="invite-password"]', fixture.password);
  await click('[data-testid="merchant-locale-en"]');
  await expectMerchantLocale(
    "invite-page",
    "en",
    inviteTitleEn,
    "English invitation submission",
  );
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
  await waitForUrl("/app/setup", "setup directly after accepting invitation A");
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

  await click('[data-testid="merchant-logout"]');
  await waitForUrl("/app/login", "redirect to merchant login");
  await navigate(`${BASE_URL}/app`);
  await waitForUrl("/app/login", "signed-out merchant PWA entry");
  await waitFor(cdp, "Boolean(document.querySelector('[data-testid=\"merchant-login-email\"]'))", "merchant login form");
  await waitFor(
    cdp,
    "document.querySelectorAll('link[rel=manifest]').length === 1 && document.querySelector('link[rel=manifest]').getAttribute('href') === '/app/manifest.webmanifest'",
    "merchant install manifest on signed-out login",
  );
  const merchantManifestResponse = await fetch(`${BASE_URL}/app/manifest.webmanifest`, {
    redirect: "manual",
  });
  assert(
    merchantManifestResponse.ok &&
      merchantManifestResponse.headers.get("content-type")?.startsWith("application/manifest+json"),
    "The merchant manifest should be public and served as a web app manifest",
  );
  const merchantManifest = await merchantManifestResponse.json();
  assert(
    merchantManifest.id === "/app" &&
      merchantManifest.start_url === "/app" &&
      merchantManifest.scope === "/app" &&
      merchantManifest.display === "standalone",
    "The merchant install should have its own identity and launch into /app",
  );
  const adminManifest = await fetch(`${BASE_URL}/manifest.webmanifest`).then((res) => res.json());
  assert(
    adminManifest.start_url === "/overview" && adminManifest.scope === "/",
    "The existing admin install should still launch into /overview",
  );
  await expectMerchantLocale(
    "merchant-login-page",
    "en",
    "Merchant sign in — Rabet",
    "English login after invitation",
  );
  assert(
    (await evaluate("document.body.innerText")).includes("Merchant sign in"),
    "Merchant login English copy should be available",
  );
  await click('[data-testid="merchant-locale-ar"]');
  await expectMerchantLocale(
    "merchant-login-page",
    "ar",
    "تسجيل دخول التاجر — Rabet",
    "Arabic login restored",
  );
  await expectNoHorizontalScroll("merchant login (Arabic)");

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
    "document.querySelectorAll('link[rel=manifest]').length === 1 && document.querySelector('link[rel=manifest]').getAttribute('href') === '/app/manifest.webmanifest'",
    "merchant install manifest on authenticated setup",
  );
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

  await click('a[href="/app/setup/storefront"]');
  await waitForUrl("/app/setup/storefront", "storefront identity page");
  const identityForm = '[data-testid="merchant-storefront-profile"]';
  await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(identityForm)}))`, "storefront identity form");
  await setValue(`${identityForm} [name="welcome"]`, "أهلًا بك في واجهة نكمل");
  const storefrontPreview = '[data-testid="merchant-storefront-preview"]';
  await waitFor(
    cdp,
    `document.querySelector(${JSON.stringify(storefrontPreview)})?.textContent.includes("أهلًا بك في واجهة نكمل")`,
    "local storefront preview",
  );
  await click(`${identityForm} button[type="submit"]`);
  await waitFor(
    cdp,
    `document.querySelector(${JSON.stringify(identityForm + ' [role="status"]')})?.textContent.includes("تم الحفظ")`,
    "storefront identity save",
  );
  await navigate(`${BASE_URL}/app/setup/storefront`);
  await expectInputValue(`${identityForm} [name="welcome"]`, "أهلًا بك في واجهة نكمل", "saved storefront welcome");
  await click('a[href="/app/setup"]');
  await waitForUrl("/app/setup", "return from storefront identity");


  const installHelp = '[data-testid="merchant-install-help"]';
  assert(
    await evaluate(`document.querySelector(${JSON.stringify(installHelp)})?.open === false`),
    "Install help should start collapsed for a connected merchant",
  );
  await click(`${installHelp} summary`);
  assert((await text(installHelp)).includes("إضافة إلى الشاشة الرئيسية"), "Arabic install guidance");
  await expectNoHorizontalScroll("expanded merchant install help");
  await click('[data-testid="merchant-locale-en"]');
  await waitFor(
    cdp,
    `document.querySelector(${JSON.stringify(installHelp)})?.innerText.includes("Install app")`,
    "English installation instructions",
  );
  await click('[data-testid="merchant-locale-ar"]');
  await click(`${installHelp} summary`);

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
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-products-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "merchant A products hydration",
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
  assert(
    (await evaluate(
      "document.querySelectorAll('[data-testid^=\"merchant-product-category-inactive-\"]').length",
    )) === 0,
    "An active-category fixture must not show the inactive-category warning",
  );
  assert(
    (await text(`[data-testid="merchant-product-available-${a.products.one.id}"]`)) ===
      "متاح في الكتالوج",
    "An available product should say it is available in the catalog",
  );
  assert(
    (await evaluate(
      `Boolean(document.querySelector('[data-testid="merchant-product-publish-${a.products.one.id}"]'))`,
    )) === false,
    "An available product must not offer the draft publish action",
  );
  assert(
    (await text(`[data-testid="merchant-availability-disable-${a.products.one.id}"]`)) ===
      "إيقاف الإتاحة",
    "The Arabic stop-availability action should be present",
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
  assert(
    (await evaluate("document.body.innerText")).includes("Available in the catalog") &&
      (await evaluate("document.body.innerText")).includes("Stop availability") &&
      !(await evaluate("document.body.innerText")).includes("Make product available"),
    "An active product should show only the English stop-availability action",
  );
  assert(
    (await evaluate(
      "document.querySelectorAll('button[data-testid^=\"merchant-product-publish-\"]').length",
    )) === 0,
    "An active product must not render an English publish action",
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
    `document.querySelector(${JSON.stringify(aPriceInput)})?.value === "123.45" && document.querySelector('[data-testid="merchant-products-page"]')?.getAttribute('data-hydrated') === 'true'`,
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

  await evaluate("window.__merchantPricePosts = 0");
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
  assert(
    (await evaluate("window.__merchantPricePosts")) === 0,
    "Using the latest price must not send a price-write request",
  );

  const aFallbackInput = `[data-testid="merchant-price-input-${a.products.fallback.id}"]`;
  const aFallbackSave = `[data-testid="merchant-price-save-${a.products.fallback.id}"]`;
  const aFallbackConflict = `[data-testid="merchant-price-conflict-${a.products.fallback.id}"]`;
  const aFallbackConflictLatest = `[data-testid="merchant-price-conflict-latest-${a.products.fallback.id}"]`;
  const aFallbackUseLatest = `[data-testid="merchant-price-use-latest-${a.products.fallback.id}"]`;

  // Keep a genuine draft in another row while a third device price arrives.
  // The adopted row is clean server state, so the normal scoped refresh from
  // saving product one must show the third price and leave the draft alone.
  await setValue(aFallbackInput, "9.99");
  await pgClient`
    update product set price = '47.70' where id = ${a.products.two.id}
  `;
  await click(aSaveButton);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aPriceSaved)})) && document.querySelector(${JSON.stringify(aSecondInput)})?.value === "47.70" && document.querySelector(${JSON.stringify(aFallbackInput)})?.value === "9.99"`,
    "adopted row refresh and unrelated draft preservation",
  );
  assert(
    (await evaluate("window.location.pathname")) === "/app/products",
    "The adopted-row refresh must not use a hard navigation",
  );

  // A fresh edit after adoption must use the revision of the displayed price,
  // not the older page props, and save without a spurious conflict.
  await pgClient`
    update product set price = '35.50' where id = ${a.products.fallback.id}
  `;
  await click(aFallbackSave);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aFallbackConflict)})) && document.querySelector(${JSON.stringify(aFallbackConflictLatest)})?.textContent === "35.50" && document.querySelector(${JSON.stringify(aFallbackInput)})?.value === "9.99"`,
    "fallback conflict before adopted fresh edit",
  );
  await click(aFallbackUseLatest);
  await waitFor(
    cdp,
    `document.querySelector(${JSON.stringify(aFallbackInput)})?.value === "35.50" && !document.querySelector(${JSON.stringify(aFallbackConflict)})`,
    "fallback adopted latest price",
  );
  await setValue(aFallbackInput, "36.60");
  await click(aFallbackSave);
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="merchant-price-saved-${a.products.fallback.id}"]')) && document.querySelector(${JSON.stringify(aFallbackInput)})?.value === "36.60" && !document.querySelector(${JSON.stringify(aFallbackConflict)})`,
    "fresh edit after adoption uses displayed revision",
  );
  assert(
    (await pgClient`
      select price::text as price from product where id = ${a.products.fallback.id}
    `)[0].price === "36.60",
    "Fresh edit after adoption should persist without a spurious conflict",
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

  const aAvailabilityDisable = `[data-testid="merchant-availability-disable-${a.products.one.id}"]`;
  const aProductPublish = `[data-testid="merchant-product-publish-${a.products.one.id}"]`;
  const aAvailabilitySaved = `[data-testid="merchant-availability-saved-${a.products.one.id}"]`;
  const aPriceUseLatest = `[data-testid="merchant-price-use-latest-${a.products.one.id}"]`;

  await setValue(aPriceInput, "12.34");
  await click(aAvailabilityDisable);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aAvailabilitySaved)})) && document.querySelector(${JSON.stringify(aPriceInput)})?.value === "12.34" && Boolean(document.querySelector('[data-testid="merchant-product-status-${a.products.one.id}"]')) && document.querySelector(${JSON.stringify(aProductPublish)})?.disabled === false`,
    "availability save preserves a genuine price draft and offers publish",
  );
  assert(
    (await text(aProductPublish)) === "نشر المنتج",
    "A stopped product should offer the Arabic publish action",
  );
  assert(
    (await evaluate(
      `Boolean(document.querySelector(${JSON.stringify(aAvailabilityDisable)}))`,
    )) === false,
    "A stopped product must not keep the stop-availability action",
  );
  assert(
    (await pgClient`
      select is_active from product where id = ${a.products.one.id}
    `)[0].is_active === false,
    "Stopping availability should persist unavailable state",
  );

  await click(aSaveButton);
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="merchant-price-conflict-${a.products.one.id}"]')) && document.querySelector(${JSON.stringify(aPriceInput)})?.value === "12.34"`,
    "availability refresh does not rebase the price draft",
  );
  assert(
    (await pgClient`
      select price::text as price from product where id = ${a.products.one.id}
    `)[0].price === aConfirmedPrice,
    "The price draft must not silently overwrite after an availability refresh",
  );
  await click(aPriceUseLatest);
  await waitFor(
    cdp,
    `document.querySelector(${JSON.stringify(aPriceInput)})?.value === ${JSON.stringify(aConfirmedPrice)} && !document.querySelector('[data-testid="merchant-price-conflict-${a.products.one.id}"]')`,
    "adopt latest price after availability refresh",
  );

  const aTwoConflict = `[data-testid="merchant-availability-conflict-${a.products.two.id}"]`;
  const aTwoConflictLatest = `[data-testid="merchant-availability-conflict-latest-${a.products.two.id}"]`;
  const aTwoDisable = `[data-testid="merchant-availability-disable-${a.products.two.id}"]`;
  const aTwoAvailable = `[data-testid="merchant-product-available-${a.products.two.id}"]`;
  const aFallbackSaved = `[data-testid="merchant-price-saved-${a.products.fallback.id}"]`;

  await setValue(aPriceInput, "12.34");
  await pgClient`
    update product set is_active = false where id = ${a.products.two.id}
  `;
  await click(aTwoDisable);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aTwoConflict)})) && document.querySelector(${JSON.stringify(aTwoConflictLatest)})?.textContent === "غير متاح"`,
    "stale availability conflict from freshly authorized data",
  );
  assert(
    (await pgClient`
      select price::text as price, is_active from product where id = ${a.products.two.id}
    `)[0].is_active === false,
    "A stale availability write must not replace the newer state",
  );
  assert(
    (await pgClient`
      select price::text as price from product where id = ${a.products.two.id}
    `)[0].price === "55.50",
    "An availability conflict must leave the price unchanged",
  );

  await pgClient`
    update product set is_active = true where id = ${a.products.two.id}
  `;
  await setValue(aFallbackInput, "36.70");
  await click(aFallbackSave);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aFallbackSaved)})) && Boolean(document.querySelector(${JSON.stringify(aTwoAvailable)})) && document.querySelector(${JSON.stringify(aTwoConflictLatest)})?.textContent === "متاح" && document.querySelector(${JSON.stringify(aPriceInput)})?.value === "12.34"`,
    "newer scoped refresh wins over the conflict snapshot and preserves the price draft",
  );
  assert(
    (await pgClient`
      select price::text as price from product where id = ${a.products.fallback.id}
    `)[0].price === "36.70",
    "Saving row B should persist its price and trigger the normal scoped refresh",
  );

  await pgClient`
    update product set is_active = true where id = ${a.products.two.id}
  `;
  await click(aTwoDisable);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(aTwoConflict)})) && document.querySelector(${JSON.stringify(aTwoConflictLatest)})?.textContent === "متاح" && Boolean(document.querySelector(${JSON.stringify(aTwoAvailable)}))`,
    "failed availability follow-up keeps the newest confirmed state",
  );
  assert(
    (await pgClient`
      select is_active from product where id = ${a.products.two.id}
    `)[0].is_active === true,
    "A failed availability follow-up must not overwrite the newer state",
  );

  await waitFor(
    cdp,
    `document.querySelector(${JSON.stringify(aTwoDisable)})?.disabled === false`,
    "availability conflict decision control ready",
  );
  await click(aTwoDisable);
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="merchant-availability-saved-${a.products.two.id}"]')) && !document.querySelector(${JSON.stringify(aTwoConflict)}) && Boolean(document.querySelector('[data-testid="merchant-product-status-${a.products.two.id}"]'))`,
    "fresh explicit availability decision after conflict",
  );
  assert(
    (await pgClient`
      select is_active from product where id = ${a.products.two.id}
    `)[0].is_active === false,
    "A fresh availability decision should persist after a conflict",
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
    (await evaluate(
      "document.querySelectorAll('button[data-testid^=\"merchant-product-publish-\"], button[data-testid^=\"merchant-availability-disable-\"]').length",
    )) === 0,
    "A suspended store must not render usable publish or availability controls",
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
  assert((await evaluate("document.querySelector('[data-testid=\"invite-store\"]').value")) === b.storeName, "Invite should show store B name");
  await setValue('[data-testid="invite-password"]', fixture.password);
  await click('[data-testid="invite-submit"]');
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
  assert(
    (await text(`[data-testid="merchant-product-available-${b.products.one.id}"]`)) ===
      "متاح في الكتالوج",
    "Merchant B should see B's own available state",
  );
  assert(
    (await evaluate(
      "document.querySelectorAll('[data-testid^=\"merchant-product-category-inactive-\"]').length",
    )) === 0,
    "Merchant B's active category must not show A's category warning",
  );
  const bAvailabilityRow = await pgClient`
    select is_active from product where id = ${b.products.one.id}
  `;
  assert(
    bAvailabilityRow[0].is_active === true,
    "A's availability writes must not change B's product state",
  );

  await click('[data-testid="merchant-categories-link"]');
  await waitForUrl("/app/categories", "merchant B categories page");
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid="merchant-category-row"]').length === 1`,
    "merchant B category rows",
  );
  assert(
    (await evaluate(
      `document.querySelector('[data-testid="merchant-category-row"]')?.getAttribute('data-category-id')`,
    )) === b.products.categoryId,
    "Merchant B should see exactly B's category",
  );
  assert(
    (await text(`[data-testid="merchant-category-name-${b.products.categoryId}"]`)) ===
      "browser-store-b-category",
    "A category without translations should fall back to its saved slug",
  );
  assert(
    (await evaluate(
      `Boolean(document.querySelector('[data-testid="merchant-category-row"][data-category-id="${a.products.categoryId}"]'))`,
    )) === false,
    "Merchant B must not see A's category",
  );
  assert(
    (await evaluate(
      `document.querySelector('[data-testid="merchant-category-path-${b.products.categoryId}"]')?.getAttribute('data-path-visible')`,
    )) === "true",
    "Merchant B's active category path should be visible",
  );
  await expectNoHorizontalScroll("merchant B categories (Arabic)");
  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid="merchant-product-row"]').length === 3`,
    "merchant B products restored after category check",
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
  await click('[data-testid="merchant-locale-ar"]');
  await expectMerchantLocale(
    "invite-page",
    "ar",
    inviteTitleAr,
    "Arabic restored after rate-limit message",
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

  await navigate(`${BASE_URL}/invite#token=${encodeURIComponent(empty.token)}`);
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"invite-email\"]')?.textContent === " +
      JSON.stringify(empty.email),
    "empty store invitation preview",
  );
  assert((await evaluate("document.querySelector('[data-testid=\"invite-store\"]').value")) === empty.storeName, "Invite should show empty store name");
  await setValue('[data-testid="invite-password"]', fixture.password);
  await click('[data-testid="invite-submit"]');
  await waitForUrl("/app/setup", "empty merchant setup page");

  await navigate(`${BASE_URL}/app/products`);
  await waitForUrl("/app/products", "empty merchant products page");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-products-empty\"]')) && document.querySelector('[data-testid=\"merchant-products-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "empty products state",
  );
  assert(
    await evaluate(
      "Boolean(document.querySelector('[data-testid=\"merchant-add-first-product-link\"]'))",
    ),
    "The empty state should offer adding the first product",
  );
  assert(
    await evaluate(
      "Boolean(document.querySelector('[data-testid=\"merchant-add-product-link\"]'))",
    ),
    "The products page should show a visible add-product entry",
  );
  await expectNoHorizontalScroll("empty merchant products (Arabic)");

  await click('[data-testid="merchant-add-first-product-link"]');
  await waitForUrl("/app/products/new", "merchant add-product form");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-product-create-form\"]')) && document.querySelector('[data-testid=\"merchant-product-create-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "merchant add-product form ready",
  );
  assert(
    (await evaluate(
      "document.querySelector('[data-testid=\"merchant-product-create-page\"]').getAttribute('dir')",
    )) === "rtl",
    "The add-product form should default to RTL Arabic",
  );
  assert(
    (await evaluate(
      "document.querySelector('[data-testid=\"merchant-product-category\"]')?.value",
    )) === "",
    "A store with no categories should start in create-category mode",
  );
  await expectNoHorizontalScroll("merchant add-product form (Arabic)");

  await setValue('[data-testid="merchant-product-name"]', "منتج البداية الأول");
  await setValue('[data-testid="merchant-product-price"]', "87.65");
  await setValue('[data-testid="merchant-product-new-category"]', "قسم البداية");
  await sleep(150);
  await navigate(`${BASE_URL}/app/products/new`);
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-product-name\"]')?.value === 'منتج البداية الأول' && document.querySelector('[data-testid=\"merchant-product-price\"]')?.value === '87.65' && document.querySelector('[data-testid=\"merchant-product-create-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "restored seven-day product draft",
  );
  assert(
    (await evaluate(
      "document.querySelector('[data-testid=\"merchant-product-new-category\"]')?.value",
    )) === "قسم البداية",
    "The draft should retain the new category name",
  );
  const emptyDraftKey = await evaluate(`(() => {
    return Object.keys(window.localStorage).find((key) =>
      key.startsWith("rabet:draft:") && key.includes(${JSON.stringify(empty.storeId)})
    ) ?? null;
  })()`);
  assert(emptyDraftKey, "The draft key should include the authenticated merchant store");

  const savedAtBeforeReload = await evaluate(
    `JSON.parse(window.localStorage.getItem(${JSON.stringify(emptyDraftKey)})).savedAt`,
  );
  await navigate(`${BASE_URL}/app/products/new`);
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-product-name\"]')?.value === 'منتج البداية الأول' && document.querySelector('[data-testid=\"merchant-product-create-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "draft reload before timestamp check",
  );
  const savedAtAfterReload = await evaluate(
    `JSON.parse(window.localStorage.getItem(${JSON.stringify(emptyDraftKey)})).savedAt`,
  );
  assert(
    savedAtAfterReload === savedAtBeforeReload,
    "Reloading the form without an edit must not renew the draft timestamp",
  );
  await sleep(30);
  await setValue('[data-testid="merchant-product-price"]', "87.66");
  await waitFor(
    cdp,
    `JSON.parse(window.localStorage.getItem(${JSON.stringify(emptyDraftKey)})).savedAt > ${savedAtAfterReload}`,
    "draft timestamp refreshed after an edit",
  );

  await evaluate(`(() => {
    const key = ${JSON.stringify(emptyDraftKey)};
    const draft = JSON.parse(window.localStorage.getItem(key));
    draft.savedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    window.localStorage.setItem(key, JSON.stringify(draft));
    window.localStorage.setItem(
      "rabet:draft:" + ${JSON.stringify(empty.storeId)} + ":another-user:merchant-product-create",
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        name: "مسودة مستخدم آخر",
        price: "1.00",
        categoryId: "",
        newCategoryName: "",
        useNewCategory: true,
      }),
    );
    return true;
  })()`);
  await navigate(`${BASE_URL}/app/products/new`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-product-name\"]')) && document.querySelector('[data-testid=\"merchant-product-create-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "expired draft form reload",
  );
  assert(
    (await evaluate(
      "document.querySelector('[data-testid=\"merchant-product-name\"]')?.value",
    )) === "",
    "An expired draft must be ignored",
  );
  assert(
    (await evaluate(
      "document.querySelector('[data-testid=\"merchant-product-price\"]')?.value",
    )) === "",
    "An expired draft price must be ignored",
  );
  assert(
    (await evaluate(
      "document.querySelector('[data-testid=\"merchant-product-name\"]')?.value",
    )) !== "مسودة مستخدم آخر",
    "Another user's draft must not be loaded",
  );

  await setValue('[data-testid="merchant-product-name"]', "منتج البداية الأول");
  await setValue('[data-testid="merchant-product-price"]', "87.65");
  await setValue('[data-testid="merchant-product-stock"]', "4");
  await setValue('[data-testid="merchant-product-new-category"]', "قسم البداية");
  assert(
    await evaluate(`(() => {
      window.__merchantProductCreatePosts = 0;
      const originalFetch = window.fetch;
      window.fetch = function (input, init) {
        const url =
          typeof input === "string" ? input : (input && input.url) || String(input);
        if (url.includes("/app/products/new") && init && init.method === "POST") {
          window.__merchantProductCreatePosts += 1;
        }
        return originalFetch.apply(this, arguments);
      };
      return true;
    })()`),
    "Could not instrument the merchant product-create action fetch calls",
  );

  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 700,
    downloadThroughput: 1024 * 1024,
    uploadThroughput: 1024 * 1024,
  });
  assert(
    await evaluate(`(() => {
      const form = document.querySelector('[data-testid="merchant-product-create-form"]');
      if (!form) return false;
      form.requestSubmit();
      form.requestSubmit();
      return true;
    })()`),
    "Could not submit the controlled first product draft",
  );
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-product-submit\"]')?.disabled === true",
    "pending first product protection",
  );
  await evaluate(
    `document.querySelector('[data-testid="merchant-product-create-form"]')?.requestSubmit()`,
  );
  await waitForUrl("/app/products", "first draft product products list");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-product-created-notice\"]')) && document.querySelectorAll('[data-testid=\"merchant-product-row\"]').length === 1",
    "first draft product success and list row",
  );
  assert(
    (await evaluate("window.__merchantProductCreatePosts")) === 1,
    "Rapid repeat submission must start exactly one product write",
  );
  assert(
    (await text('[data-testid="merchant-product-created-notice"]')) === "تمت إضافة المنتج.",
    "The success notice should use the approved Arabic copy",
  );
  const createdProductId = await evaluate(
    "document.querySelector('[data-testid=\"merchant-product-row\"]')?.getAttribute('data-product-id') ?? null",
  );
  assert(createdProductId !== null, "The draft product row should be visible");
  assert(
    (await text(`[data-testid="merchant-product-status-${createdProductId}"]`)) ===
      "مسودة",
    "The newly created unavailable product should show the Arabic draft label",
  );
  await click('[data-testid="merchant-locale-en"]');
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="merchant-product-status-${createdProductId}"]')?.textContent === 'Draft' && document.querySelector('[data-testid="merchant-product-publish-${createdProductId}"]')?.textContent === 'Publish product'`,
    "English draft label and publish action",
  );
  assert(
    (await evaluate(
      `Boolean(document.querySelector('[data-testid="merchant-availability-disable-${createdProductId}"]'))`,
    )) === false,
    "A draft product must not render the English stop-availability action",
  );
  await click('[data-testid="merchant-locale-ar"]');
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="merchant-product-status-${createdProductId}"]')?.textContent === 'مسودة'`,
    "Arabic draft label restored",
  );
  const emptyProductName = await evaluate(
    "document.querySelector('[data-testid^=\"merchant-product-name-\"]')?.textContent ?? null",
  );
  assert(emptyProductName === "منتج البداية الأول", "The saved product name should appear in the scoped list");
  await expectNoHorizontalScroll("first draft product list (Arabic)");

  const emptyDraftCleared = await evaluate(
    `window.localStorage.getItem(${JSON.stringify(emptyDraftKey)}) === null`,
  );
  assert(emptyDraftCleared, "A successful save must clear the user/store draft");

  const emptyCatalog = await pgClient`
    select
      p.id as product_id,
      p.store_id as product_store_id,
      p.category_id,
      p.price::text as price,
      p.is_active as product_active,
      c.store_id as category_store_id,
      c.is_active as category_active,
      pt.name as product_name,
      ct.name as category_name,
      (select count(*)::int from category where store_id = ${empty.storeId}) as category_count,
      (select count(*)::int from product where store_id = ${empty.storeId}) as product_count,
      (select on_hand from product_inventory where product_id = p.id) as on_hand
    from product p
    join category c on c.id = p.category_id
    join product_translation pt on pt.product_id = p.id
    join category_translation ct on ct.category_id = c.id
    where p.store_id = ${empty.storeId}
  `;
  assert(emptyCatalog.length === 1, "Empty store A should persist exactly one product");
  assert(emptyCatalog[0].category_count === 1, "The inline category should be created once");
  assert(emptyCatalog[0].product_count === 1, "Duplicate submissions must not create extra products");
  assert(emptyCatalog[0].product_store_id === empty.storeId, "The product must belong to the empty store");
  assert(emptyCatalog[0].category_store_id === empty.storeId, "The category must belong to the empty store");
  assert(emptyCatalog[0].price === "87.65", "The exact decimal price should persist");
  assert(emptyCatalog[0].on_hand === 4, "The initial stock should persist for publishing");
  assert(emptyCatalog[0].product_active === false, "A new product must start unavailable");
  assert(emptyCatalog[0].category_active === false, "A new category must start inactive");
  assert(emptyCatalog[0].product_name === "منتج البداية الأول", "The product translation should persist");
  assert(emptyCatalog[0].category_name === "قسم البداية", "The category translation should persist");

  const firstDraftReloadToken = `firstDraftReload=${Date.now()}`;
  await navigate(`${BASE_URL}/app/products?${firstDraftReloadToken}`);
  await waitFor(
    cdp,
    `window.location.search.includes(${JSON.stringify(firstDraftReloadToken)}) && document.querySelectorAll('[data-testid="merchant-product-row"]').length === 1 && document.querySelector('[data-testid="merchant-product-name-${emptyCatalog[0].product_id}"]')?.textContent === 'منتج البداية الأول' && document.querySelector('[data-testid="merchant-product-status-${emptyCatalog[0].product_id}"]')?.textContent === 'مسودة' && document.querySelector('[data-testid="merchant-products-page"]')?.getAttribute('data-hydrated') === 'true'`,
    "first draft product and status after reload",
  );

  const emptyProductPublish = `[data-testid="merchant-product-publish-${createdProductId}"]`;
  const emptyAvailabilityDisable = `[data-testid="merchant-availability-disable-${createdProductId}"]`;
  const emptyAvailabilitySaved = `[data-testid="merchant-availability-saved-${createdProductId}"]`;
  const emptyPublishNotReady = `[data-testid="merchant-product-publish-not-ready-${createdProductId}"]`;
  const emptyPublishSaved = `[data-testid="merchant-product-published-${createdProductId}"]`;
  const emptyCategoryWarning = `[data-testid="merchant-product-category-inactive-${createdProductId}"]`;

  assert(
    (await evaluate(
      `Boolean(document.querySelector(${JSON.stringify(emptyCategoryWarning)}))`,
    )) === true,
    "A product under the newly created inactive category should show the category warning",
  );
  assert(
    (await text(emptyCategoryWarning)).includes("أحد أقسامه الأعلى"),
    "The Arabic category warning should explain that a parent category can hide the product",
  );
  assert(
    (await text(`[data-testid="merchant-product-status-${createdProductId}"]`)) ===
      "مسودة",
    "The first product should start as a draft",
  );
  assert(
    (await text(emptyProductPublish)) === "نشر المنتج",
    "The first product should offer the Arabic publish action",
  );
  assert(
    (await evaluate(
      `Boolean(document.querySelector(${JSON.stringify(emptyAvailabilityDisable)}))`,
    )) === false,
    "A draft product must not render a stop-availability action",
  );

  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 700,
    downloadThroughput: 1024 * 1024,
    uploadThroughput: 1024 * 1024,
  });

  assert(
    await evaluate(`(() => {
      window.__merchantProductPublishPosts = 0;
      const originalFetch = window.fetch;
      window.fetch = function (input, init) {
        const url =
          typeof input === "string" ? input : (input && input.url) || String(input);
        if (url.includes("/app/products") && init && init.method === "POST") {
          window.__merchantProductPublishPosts += 1;
        }
        return originalFetch.apply(this, arguments);
      };
      const button = document.querySelector(${JSON.stringify(emptyProductPublish)});
      if (!button) return false;
      button.click();
      button.click();
      return true;
    })()`),
    "Could not submit the controlled publish action",
  );
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(emptyPublishNotReady)})) && Boolean(document.querySelector(${JSON.stringify(emptyCategoryWarning)})) && Boolean(document.querySelector('[data-testid="merchant-product-status-${createdProductId}"]')) && !document.querySelector(${JSON.stringify(emptyPublishSaved)})`,
    "publish refused while the category remains unavailable",
  );
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  assert(
    (await evaluate("window.__merchantProductPublishPosts")) === 1,
    "Rapid repeat submission must start exactly one publish write",
  );
  assert(
    (await text(emptyPublishNotReady)).includes(
      "المنتج غير جاهز للنشر بعد:",
    ) &&
      (await text(emptyPublishNotReady)).includes(
        "القسم أو أحد أقسامه الأعلى غير متاح.",
      ),
    "The refused publish should explain the unavailable category path",
  );
  assert(
    (await pgClient`
      select p.is_active as product_active, c.is_active as category_active
      from product p
      join category c on c.id = p.category_id
      where p.id = ${createdProductId}
    `)[0].product_active === false,
    "Publishing an unready draft must leave the product inactive",
  );
  assert(
    (await pgClient`
      select is_active from category where id = ${emptyCatalog[0].category_id}
    `)[0].is_active === false,
    "A refused publish must not activate the product category",
  );

  const createdCategoryId = emptyCatalog[0].category_id;
  assert(
    await evaluate(
      `Boolean(document.querySelector('[data-testid="merchant-product-category-manage-${createdProductId}"]')) && Boolean(document.querySelector('[data-testid="merchant-categories-link"]'))`,
    ),
    "The category warning and the products header should link to category management",
  );

  await click(`[data-testid="merchant-product-category-manage-${createdProductId}"]`);
  await waitForUrl("/app/categories", "merchant categories page from warning");
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid="merchant-category-row"]').length === 1 && Boolean(document.querySelector('[data-testid="merchant-categories-page"]'))`,
    "single merchant category row",
  );
  assert(
    (await evaluate(
      `document.querySelector('[data-testid="merchant-categories-page"]').getAttribute('dir')`,
    )) === "rtl",
    "The categories page should default to RTL Arabic",
  );
  assert(
    (await evaluate(
      `document.querySelector('[data-testid="merchant-category-row"]')?.getAttribute('data-category-id')`,
    )) === createdCategoryId,
    "The categories page should list the merchant's own category",
  );
  assert(
    (await text(`[data-testid="merchant-category-name-${createdCategoryId}"]`)) ===
      "قسم البداية",
    "The category name should use the saved Arabic translation",
  );
  assert(
    (await text(`[data-testid="merchant-category-saved-${createdCategoryId}"]`)).includes(
      "متوقفة",
    ),
    "The newly created category should start with saved availability off",
  );
  assert(
    (await evaluate(
      `document.querySelector('[data-testid="merchant-category-path-${createdCategoryId}"]')?.getAttribute('data-path-visible')`,
    )) === "false",
    "An unavailable category should have an unavailable effective path",
  );
  assert(
    (await text(`[data-testid="merchant-category-enable-${createdCategoryId}"]`)) ===
      "إتاحة القسم",
    "The Arabic category enable action should be present",
  );
  assert(
    (await text(`[data-testid="merchant-category-disable-${createdCategoryId}"]`)) ===
      "إيقاف إتاحة القسم",
    "The Arabic category disable action should be present",
  );
  await expectNoHorizontalScroll("merchant categories (Arabic)");

  await click('[data-testid="merchant-locale-en"]');
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="merchant-categories-page"]').getAttribute('dir') === 'ltr'`,
    "English merchant categories direction",
  );
  assert(
    (await evaluate("document.body.innerText")).includes("Store categories") &&
      (await evaluate("document.body.innerText")).includes(
        "Make category available",
      ) &&
      (await evaluate("document.body.innerText")).includes(
        "Stop category availability",
      ),
    "Category availability actions should have English labels",
  );
  await click('[data-testid="merchant-locale-ar"]');
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="merchant-categories-page"]').getAttribute('dir') === 'rtl'`,
    "Arabic merchant categories direction",
  );

  const categoryEnable = `[data-testid="merchant-category-enable-${createdCategoryId}"]`;
  const categoryDisable = `[data-testid="merchant-category-disable-${createdCategoryId}"]`;
  const categorySaved = `[data-testid="merchant-category-saved-notice-${createdCategoryId}"]`;
  const categoryPath = `[data-testid="merchant-category-path-${createdCategoryId}"]`;
  const categoryConflict = `[data-testid="merchant-category-conflict-${createdCategoryId}"]`;
  const categoryConflictLatest = `[data-testid="merchant-category-conflict-latest-${createdCategoryId}"]`;

  assert(
    await evaluate(`(() => {
      window.__merchantCategoryPosts = 0;
      const originalFetch = window.fetch;
      window.fetch = function (input, init) {
        const url =
          typeof input === "string" ? input : (input && input.url) || String(input);
        if (url.includes("/app/categories") && init && init.method === "POST") {
          window.__merchantCategoryPosts += 1;
        }
        return originalFetch.apply(this, arguments);
      };
      return true;
    })()`),
    "Could not instrument the merchant category action fetch calls",
  );

  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 700,
    downloadThroughput: 1024 * 1024,
    uploadThroughput: 1024 * 1024,
  });
  assert(
    await evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(categoryEnable)});
      if (!button) return false;
      button.click();
      button.click();
      return true;
    })()`),
    "Could not submit the controlled category availability save",
  );
  await waitFor(
    cdp,
    `document.querySelector(${JSON.stringify(categoryEnable)})?.disabled === true`,
    "pending category availability protection",
  );
  await evaluate(
    `document.querySelector(${JSON.stringify(categoryEnable)})?.click()`,
  );
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(categorySaved)})) && document.querySelector(${JSON.stringify(categoryPath)})?.getAttribute('data-path-visible') === 'true' && document.querySelector(${JSON.stringify(categoryDisable)})?.disabled === false`,
    "first category made available and path visible",
  );
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  assert(
    (await evaluate("window.__merchantCategoryPosts")) === 1,
    "Rapid repeat submission must start exactly one category write",
  );
  assert(
    (await pgClient`
      select is_active from category where id = ${createdCategoryId}
    `)[0].is_active === true,
    "Enabling the category should persist its own availability",
  );

  await pgClient`
    update category set is_active = false where id = ${createdCategoryId}
  `;
  await click(categoryDisable);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(categoryConflict)})) && document.querySelector(${JSON.stringify(categoryConflictLatest)})?.textContent === "متوقفة" && document.querySelector(${JSON.stringify(categoryEnable)})?.disabled === false`,
    "stale category revision conflict from freshly authorized data",
  );
  assert(
    (await pgClient`
      select is_active from category where id = ${createdCategoryId}
    `)[0].is_active === false,
    "A stale category write must not replace the newer state",
  );

  await click(categoryEnable);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(categorySaved)})) && !document.querySelector(${JSON.stringify(categoryConflict)}) && document.querySelector(${JSON.stringify(categoryPath)})?.getAttribute('data-path-visible') === 'true'`,
    "fresh explicit category decision after conflict",
  );
  assert(
    (await pgClient`
      select is_active from category where id = ${createdCategoryId}
    `)[0].is_active === true,
    "A fresh explicit category decision should persist after a conflict",
  );

  await click('[data-testid="merchant-categories-back"]');
  await waitForUrl("/app/products", "products page after enabling category");
  await waitFor(
    cdp,
    `!document.querySelector(${JSON.stringify(emptyCategoryWarning)}) && Boolean(document.querySelector('[data-testid="merchant-product-status-${createdProductId}"]')) && document.querySelector(${JSON.stringify(emptyProductPublish)})?.disabled === false && document.querySelector('[data-testid="merchant-products-page"]')?.getAttribute('data-hydrated') === 'true'`,
    "draft publish ready after the category path becomes available",
  );

  await click(emptyProductPublish);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(emptyPublishSaved)})) && Boolean(document.querySelector('[data-testid="merchant-product-available-${createdProductId}"]')) && !document.querySelector(${JSON.stringify(emptyCategoryWarning)}) && !document.querySelector(${JSON.stringify(emptyPublishNotReady)}) && Boolean(document.querySelector(${JSON.stringify(emptyAvailabilityDisable)}))`,
    "published product becomes available after every prerequisite is met",
  );
  assert(
    (await pgClient`
      select p.is_active as product_active, c.is_active as category_active
      from product p
      join category c on c.id = p.category_id
      where p.id = ${createdProductId}
    `)[0].product_active === true &&
      (
        await pgClient`
          select is_active from category where id = ${emptyCatalog[0].category_id}
        `
      )[0].is_active === true,
    "Publishing should persist product availability without changing the category decision",
  );

  const categoryEnabledReloadToken = `categoryEnabledReload=${Date.now()}`;
  await navigate(`${BASE_URL}/app/products?${categoryEnabledReloadToken}`);
  await waitFor(
    cdp,
    `window.location.search.includes(${JSON.stringify(categoryEnabledReloadToken)}) && Boolean(document.querySelector('[data-testid="merchant-product-available-${createdProductId}"]')) && !document.querySelector(${JSON.stringify(emptyCategoryWarning)}) && document.querySelector('[data-testid="merchant-product-available-${createdProductId}"]')?.textContent === "متاح في الكتالوج"`,
    "enabled category path after product reload",
  );

  await click('[data-testid="merchant-categories-link"]');
  await waitForUrl("/app/categories", "merchant categories page from products header");
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="merchant-category-row"]')) && document.querySelector(${JSON.stringify(categoryDisable)})?.disabled === false`,
    "category page ready for explicit disable",
  );
  await click(categoryDisable);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(categorySaved)})) && document.querySelector(${JSON.stringify(categoryPath)})?.getAttribute('data-path-visible') === 'false' && document.querySelector(${JSON.stringify(categoryEnable)})?.disabled === false`,
    "category disabled again while product stays enabled",
  );
  assert(
    (await pgClient`
      select p.is_active as product_active, c.is_active as category_active
      from product p
      join category c on c.id = p.category_id
      where p.id = ${createdProductId}
    `)[0].product_active === true,
    "Disabling a category must not disable its products",
  );
  assert(
    (await pgClient`
      select c.is_active as category_active
      from category c
      where c.id = ${createdCategoryId}
    `)[0].category_active === false,
    "Disabling a category should persist only its own availability",
  );

  await click('[data-testid="merchant-categories-back"]');
  await waitForUrl("/app/products", "products page after disabling category");
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="merchant-product-available-${createdProductId}"]')) && Boolean(document.querySelector(${JSON.stringify(emptyCategoryWarning)})) && document.querySelector('[data-testid="merchant-product-available-${createdProductId}"]')?.textContent === "الإتاحة مفعّلة"`,
    "category warning returns after its path is disabled",
  );

  const categoryDisabledReloadToken = `categoryDisabledReload=${Date.now()}`;
  await navigate(`${BASE_URL}/app/products?${categoryDisabledReloadToken}`);
  await waitFor(
    cdp,
    `window.location.search.includes(${JSON.stringify(categoryDisabledReloadToken)}) && Boolean(document.querySelector(${JSON.stringify(emptyCategoryWarning)})) && document.querySelector('[data-testid="merchant-product-available-${createdProductId}"]')?.textContent === "الإتاحة مفعّلة"`,
    "disabled category path and enabled product after reload",
  );

  await navigate(`${BASE_URL}/app/categories?categoryReload=${Date.now()}`);
  await waitFor(
    cdp,
    `document.querySelector(${JSON.stringify(categoryPath)})?.getAttribute('data-path-visible') === 'false' && document.querySelector('[data-testid="merchant-category-saved-${createdCategoryId}"]')?.textContent.includes("متوقفة")`,
    "category saved state after reload",
  );
  await expectNoHorizontalScroll("category state after reload");
  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(emptyCategoryWarning)}))`,
    "products warning before the next product step",
  );

  // Delayed-refresh consistency: an available ancestor with an enabled child.
  // A separate connection stops the ancestor after the page snapshot, then a
  // stale action returns a conflict while the scoped refresh is held.
  const repairAncestorId = crypto.randomUUID();
  const repairChildId = crypto.randomUUID();
  const repairSuffix = crypto.randomUUID();
  const [rootOrderRow] = await pgClient`
    select coalesce(max(sort_order), 0) + 1 as root_order
    from category
    where parent_id is null
  `;
  await pgClient`
    insert into category (id, store_id, parent_id, slug, sort_order, is_active)
    values
      (
        ${repairAncestorId},
        ${empty.storeId},
        null,
        ${`repair-ancestor-${repairSuffix}`},
        ${rootOrderRow.root_order},
        true
      ),
      (
        ${repairChildId},
        ${empty.storeId},
        ${repairAncestorId},
        ${`repair-child-${repairSuffix}`},
        0,
        true
      )
  `;
  await pgClient`
    insert into category_translation (category_id, language_id, name)
    select entry.category_id, language.id, entry.name
    from (
      values
        (${repairAncestorId}::uuid, ${"قسم أصل الإصلاح"}::text),
        (${repairChildId}::uuid, ${"قسم فرع الإصلاح"}::text)
    ) as entry(category_id, name)
    join language on language.code = 'ar'
  `;

  await navigate(`${BASE_URL}/app/categories`);
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="merchant-category-path-${repairAncestorId}"]')?.getAttribute('data-path-visible') === 'true' && document.querySelector('[data-testid="merchant-category-path-${repairChildId}"]')?.getAttribute('data-path-visible') === 'true'`,
    "available ancestor and enabled child before stale conflict",
  );
  assert(
    (await text(`[data-testid="merchant-category-saved-${repairAncestorId}"]`)).includes(
      "مفعّلة",
    ) &&
      (await text(`[data-testid="merchant-category-saved-${repairChildId}"]`)).includes(
        "مفعّلة",
      ),
    "The repair fixture should start with both categories enabled",
  );

  assert(
    await evaluate(`(() => {
      window.__categoryRefreshGate = { hold: false, held: false, done: false, release: null };
      const originalFetch = window.fetch;
      window.fetch = function (...args) {
        const input = args[0];
        const init = args[1];
        const url =
          typeof input === "string" ? input : (input && input.url) || String(input);
        const method =
          (init && init.method) || (input && input.method) || "GET";
        if (
          window.__categoryRefreshGate.hold &&
          String(method).toUpperCase() === "GET" &&
          url.includes("/app/categories")
        ) {
          window.__categoryRefreshGate.hold = false;
          window.__categoryRefreshGate.held = true;
          return new Promise((resolve, reject) => {
            window.__categoryRefreshGate.release = () =>
              originalFetch
                .apply(this, args)
                .then((response) => {
                  window.__categoryRefreshGate.done = true;
                  resolve(response);
                }, reject);
          });
        }
        return originalFetch.apply(this, args);
      };
      return true;
    })()`),
    "Could not install the delayed category refresh gate",
  );

  await pgClient`
    update category set is_active = false where id = ${repairAncestorId}
  `;
  await evaluate("window.__categoryRefreshGate.hold = true");
  await click(`[data-testid="merchant-category-disable-${repairAncestorId}"]`);
  await waitFor(
    cdp,
    `Boolean(document.querySelector('[data-testid="merchant-category-conflict-${repairAncestorId}"]')) && window.__categoryRefreshGate?.held === true`,
    "stale ancestor conflict before the scoped refresh is released",
  );
  assert(
    (await text(`[data-testid="merchant-category-saved-${repairAncestorId}"]`)).includes(
      "متوقفة",
    ),
    "The confirmed-off ancestor should keep the saved-off label during the delay",
  );
  assert(
    (await evaluate(
      `document.querySelector('[data-testid="merchant-category-path-${repairAncestorId}"]')?.getAttribute('data-path-visible')`,
    )) === "false",
    "A confirmed-off ancestor must not show an available path during the delay",
  );
  assert(
    (await text(`[data-testid="merchant-category-saved-${repairChildId}"]`)).includes(
      "مفعّلة",
    ),
    "The enabled child should keep its saved-on label during the delay",
  );
  assert(
    (await evaluate(
      `document.querySelector('[data-testid="merchant-category-path-${repairChildId}"]')?.getAttribute('data-path-visible')`,
    )) === "false",
    "The enabled child must not claim a confirmed path while its ancestor is confirmed off",
  );
  assert(
    (await text(`[data-testid="merchant-category-path-notice-${repairChildId}"]`)).includes(
      "يبقى هذا الفرع مخفيًا",
    ),
    "The child should explain that its branch remains hidden during the delay",
  );
  await expectNoHorizontalScroll("delayed category conflict");

  await evaluate("window.__categoryRefreshGate.release()");
  await waitFor(
    cdp,
    `window.__categoryRefreshGate?.done === true && document.querySelector('[data-testid="merchant-category-enable-${repairAncestorId}"]')?.disabled === false && document.querySelector('[data-testid="merchant-category-path-${repairAncestorId}"]')?.getAttribute('data-path-visible') === 'false' && document.querySelector('[data-testid="merchant-category-path-${repairChildId}"]')?.getAttribute('data-path-visible') === 'false' && document.querySelector('[data-testid="merchant-category-saved-${repairAncestorId}"]')?.textContent.includes("متوقفة")`,
    "authoritative unavailable path after releasing the refresh",
  );
  assert(
    (await pgClient`
      select is_active from category where id = ${repairAncestorId}
    `)[0].is_active === false,
    "The released refresh should agree with the persisted stopped ancestor",
  );
  assert(
    (await pgClient`
      select is_active from category where id = ${repairChildId}
    `)[0].is_active === true,
    "Stopping the ancestor must not change the child's own availability",
  );

  await click(`[data-testid="merchant-category-enable-${repairAncestorId}"]`);
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="merchant-category-saved-${repairAncestorId}"]')?.textContent.includes("مفعّلة") && document.querySelector('[data-testid="merchant-category-path-${repairAncestorId}"]')?.getAttribute('data-path-visible') === 'true' && document.querySelector('[data-testid="merchant-category-path-${repairChildId}"]')?.getAttribute('data-path-visible') === 'true'`,
    "permitted ancestor and child path after explicit re-enable",
  );
  assert(
    (await pgClient`
      select is_active from product where id = ${createdProductId}
    `)[0].is_active === true,
    "The repair flow must not change the existing product decision",
  );
  assert(
    (await pgClient`
      select c.is_active as child_active, root.is_active as root_active
      from category c
      join category root on root.id = ${repairAncestorId}
      where c.id = ${repairChildId}
    `)[0].child_active === true,
    "The repair flow must not change the child category decision",
  );
  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(emptyCategoryWarning)})) && Boolean(document.querySelector('[data-testid="merchant-product-available-${createdProductId}"]'))`,
    "products warning preserved after repair category scenario",
  );

  await click(emptyAvailabilityDisable);
  await waitFor(
    cdp,
    `Boolean(document.querySelector(${JSON.stringify(emptyAvailabilitySaved)})) && Boolean(document.querySelector('[data-testid="merchant-product-status-${createdProductId}"]')) && Boolean(document.querySelector(${JSON.stringify(emptyCategoryWarning)}))`,
    "first product stopped and draft label restored",
  );
  assert(
    (await pgClient`
      select is_active from product where id = ${createdProductId}
    `)[0].is_active === false,
    "Stopping the first product availability should persist",
  );

  const unavailableReloadToken = `unavailableReload=${Date.now()}`;
  await navigate(`${BASE_URL}/app/products?${unavailableReloadToken}`);
  await waitFor(
    cdp,
    `window.location.search.includes(${JSON.stringify(unavailableReloadToken)}) && Boolean(document.querySelector('[data-testid="merchant-product-status-${createdProductId}"]')) && Boolean(document.querySelector(${JSON.stringify(emptyCategoryWarning)})) && document.querySelector('[data-testid="merchant-product-available-${createdProductId}"]') === null && document.querySelector(${JSON.stringify(emptyProductPublish)})?.disabled === false && document.querySelector('[data-testid="merchant-products-page"]')?.getAttribute('data-hydrated') === 'true'`,
    "unavailable state and category warning after reload",
  );
  await expectNoHorizontalScroll("first product availability states");

  await click('[data-testid="merchant-add-product-link"]');
  await waitForUrl("/app/products/new", "add another product form");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-product-category\"]')?.value === " +
      JSON.stringify(emptyCatalog[0].category_id) +
      " && document.querySelector('[data-testid=\"merchant-product-create-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "last-used category restored only from the current store list",
  );
  assert(
    (await evaluate(
      "Boolean(document.querySelector('[data-testid=\"merchant-product-new-category\"]'))",
    )) === false,
    "An existing remembered category should not reopen create-category mode",
  );

  await setValue('[data-testid="merchant-product-name"]', "منتج خطأ");
  await setValue('[data-testid="merchant-product-price"]', "9.999");
  await sleep(150);
  const savedAtBeforeInvalidSubmit = await evaluate(
    `JSON.parse(window.localStorage.getItem(${JSON.stringify(emptyDraftKey)})).savedAt`,
  );
  await click('[data-testid="merchant-product-submit"]');
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-product-price-error\"]'))",
    "invalid product price error",
  );
  await sleep(150);
  const savedAtAfterInvalidSubmit = await evaluate(
    `JSON.parse(window.localStorage.getItem(${JSON.stringify(emptyDraftKey)})).savedAt`,
  );
  assert(
    savedAtAfterInvalidSubmit === savedAtBeforeInvalidSubmit,
    "A failed submission without a new edit must not renew the draft timestamp",
  );
  assert(
    (await evaluate(
      "document.querySelector('[data-testid=\"merchant-product-name\"]')?.value",
    )) === "منتج خطأ",
    "The form should retain its name after validation failure",
  );
  assert(
    (await evaluate(
      "document.querySelector('[data-testid=\"merchant-product-price\"]')?.value",
    )) === "9.999",
    "The form should retain its invalid price for correction",
  );
  assert(
    (
      await pgClient`
        select count(*)::int as count from product where store_id = ${empty.storeId}
      `
    )[0].count === 1,
    "Invalid input must not create another product",
  );

  const availableProductId = crypto.randomUUID();
  await pgClient`
    insert into product (id, store_id, category_id, slug, price, is_active, sort_order)
    values (
      ${availableProductId},
      ${empty.storeId},
      ${emptyCatalog[0].category_id},
      ${`available-fixture-${crypto.randomUUID()}`},
      '12.50',
      true,
      99
    )
  `;
  await pgClient`
    insert into product_translation (product_id, language_id, name)
    select ${availableProductId}, id, 'منتج متاح'
    from language
    where code = 'en'
  `;

  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-testid=\"merchant-product-row\"]').length === 2",
    "draft and available fixture rows",
  );
  assert(
    (await text(`[data-testid="merchant-product-status-${emptyCatalog[0].product_id}"]`)) ===
      "مسودة",
    "The unavailable fixture row should keep the draft label",
  );
  assert(
    (await evaluate(
      `document.querySelector('[data-testid="merchant-product-status-${availableProductId}"]') === null`,
    )) === true,
    "An available fixture row must not show the draft label",
  );

  await pgClient`
    update store set status = 'suspended' where id = ${empty.storeId}
  `;
  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-products-suspended-notice\"]'))",
    "empty store suspended notice",
  );
  assert(
    (await text(`[data-testid="merchant-product-status-${emptyCatalog[0].product_id}"]`)) ===
      "مسودة",
    "The draft label should remain visible in suspended read-only mode",
  );
  assert(
    (await evaluate(
      "document.querySelectorAll('[data-testid=\"merchant-add-product-link\"], [data-testid=\"merchant-add-first-product-link\"]').length",
    )) === 0,
    "A suspended store must not render add-product actions",
  );
  await navigate(`${BASE_URL}/app/categories`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-categories-suspended-notice\"]')) && Boolean(document.querySelector('[data-testid=\"merchant-category-row\"]'))",
    "suspended categories read-only state",
  );
  assert(
    (await evaluate(
      "document.querySelectorAll('[data-testid^=\"merchant-category-enable-\"], [data-testid^=\"merchant-category-disable-\"]').length",
    )) === 0,
    "A suspended store must not render usable category availability controls",
  );
  assert(
    (await text(`[data-testid="merchant-category-saved-${createdCategoryId}"]`)).includes(
      "متوقفة",
    ),
    "A suspended store should still read its own category availability",
  );
  await expectNoHorizontalScroll("suspended merchant categories");
  await navigate(`${BASE_URL}/app/products/new`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-product-create-suspended-notice\"]'))",
    "suspended add-product read-only notice",
  );
  assert(
    (await evaluate(
      "Boolean(document.querySelector('[data-testid=\"merchant-product-create-form\"]'))",
    )) === false,
    "A suspended store must not render the create form",
  );
  await expectNoHorizontalScroll("suspended add-product page");
  await pgClient`
    update store set status = 'onboarding' where id = ${empty.storeId}
  `;
  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-add-product-link\"]'))",
    "empty store restored after suspension",
  );
  const localBlockedScript = await cdp.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source:
        "Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('local storage blocked'); } });",
    },
  );
  await navigate(`${BASE_URL}/app/products/new`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-product-create-form\"]')) && document.querySelector('[data-testid=\"merchant-product-create-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "form usable without local storage",
  );
  await setValue('[data-testid="merchant-product-name"]', "نموذج بلا تخزين محلي");
  await setValue('[data-testid="merchant-product-price"]', "1.00");
  assert(
    (await evaluate(
      "document.querySelector('[data-testid=\"merchant-product-name\"]')?.value",
    )) === "نموذج بلا تخزين محلي",
    "The form should remain usable when local draft storage is unavailable",
  );
  await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: localBlockedScript.identifier,
  });
  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-add-product-link\"]'))",
    "products page after local storage failure probe",
  );

  const beforeStorageFailure = (
    await pgClient`
      select count(*)::int as count from product where store_id = ${empty.storeId}
    `
  )[0].count;
  const sessionBlockedScript = await cdp.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source:
        "Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new Error('session storage blocked'); } });",
    },
  );
  await navigate(`${BASE_URL}/app/products/new`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-product-create-form\"]')) && document.querySelector('[data-testid=\"merchant-product-create-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "form usable without session storage",
  );
  await setValue('[data-testid="merchant-product-name"]', "منتج بعد تعذر الجلسة");
  await setValue('[data-testid="merchant-product-price"]', "12.34");
  await click('[data-testid="merchant-product-submit"]');
  await waitForUrl("/app/products", "success despite session storage failure");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-product-created-notice\"]'))",
    "success notice despite session storage failure",
  );
  await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: sessionBlockedScript.identifier,
  });

  const afterStorageFailure = (
    await pgClient`
      select count(*)::int as count from product where store_id = ${empty.storeId}
    `
  )[0].count;
  assert(
    afterStorageFailure === beforeStorageFailure + 1,
    "A storage failure after server success must create exactly one product",
  );
  assert(
    (await evaluate(
      "document.querySelector('[data-testid^=\"merchant-product-name-\"]')?.textContent ?? ''",
    )).length > 0,
    "The product list should render after a storage failure",
  );

  log("Checking persistent merchant language across the accepted journey...");
  await navigate(`${BASE_URL}/app/setup`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-setup-page\"]'))",
    "language journey setup page",
  );
  await expectMerchantLocale(
    "merchant-setup-page",
    "ar",
    "إعداد المتجر — Rabet",
    "Arabic setup default",
  );
  await click('[data-testid="merchant-locale-en"]');
  await expectMerchantLocale(
    "merchant-setup-page",
    "en",
    "Store setup — Rabet",
    "English setup selection",
  );
  await click('[data-testid="merchant-products-link"]');
  await waitForUrl("/app/products", "language journey products page");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-products-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "language journey products hydration",
  );
  await expectMerchantLocale(
    "merchant-products-page",
    "en",
    "Store products — Rabet",
    "English products after internal navigation",
  );
  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-products-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "language journey products reload hydration",
  );
  await expectMerchantLocale(
    "merchant-products-page",
    "en",
    "Store products — Rabet",
    "English products after full reload",
  );

  const localeProductId = await evaluate(
    "document.querySelector('[data-testid=\"merchant-product-row\"]')?.getAttribute('data-product-id') ?? null",
  );
  assert(localeProductId !== null, "The locale journey needs a product row");
  const localePriceInput = `[data-testid="merchant-price-input-${localeProductId}"]`;
  await setValue(localePriceInput, "77.77");
  await evaluate(`(() => {
    window.__merchantLocaleWrites = 0;
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
      if (init && init.method === "POST") {
        window.__merchantLocaleWrites += 1;
      }
      return originalFetch.call(this, input, init);
    };
    return true;
  })()`);
  await click('[data-testid="merchant-locale-ar"]');
  await expectMerchantLocale(
    "merchant-products-page",
    "ar",
    "منتجات المتجر — Rabet",
    "Arabic products after toggle",
  );
  await expectInputValue(
    localePriceInput,
    "77.77",
    "Typed price should survive Arabic selection",
  );
  await click('[data-testid="merchant-locale-en"]');
  await expectMerchantLocale(
    "merchant-products-page",
    "en",
    "Store products — Rabet",
    "English products restored",
  );
  await expectInputValue(
    localePriceInput,
    "77.77",
    "Typed price should survive English selection",
  );
  assert(
    (await evaluate("window.__merchantLocaleWrites")) === 0,
    "Changing language must not submit or replay a product mutation",
  );

  await click('[data-testid="merchant-add-product-link"]');
  await waitForUrl("/app/products/new", "language journey add product page");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-product-create-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "language journey add product hydration",
  );
  await expectMerchantLocale(
    "merchant-product-create-page",
    "en",
    "Add product — Rabet",
    "English add product",
  );
  await setValue('[data-testid="merchant-product-name"]', "Locale persistence draft");
  await setValue('[data-testid="merchant-product-price"]', "4.20");
  await click('[data-testid="merchant-locale-ar"]');
  await expectMerchantLocale(
    "merchant-product-create-page",
    "ar",
    "إضافة منتج — Rabet",
    "Arabic add product",
  );
  await expectInputValue(
    '[data-testid="merchant-product-name"]',
    "Locale persistence draft",
    "Typed product name should survive Arabic selection",
  );
  await expectInputValue(
    '[data-testid="merchant-product-price"]',
    "4.20",
    "Typed product price should survive Arabic selection",
  );
  await click('[data-testid="merchant-locale-en"]');
  await expectMerchantLocale(
    "merchant-product-create-page",
    "en",
    "Add product — Rabet",
    "English add product restored",
  );
  await expectInputValue(
    '[data-testid="merchant-product-name"]',
    "Locale persistence draft",
    "Typed product name should survive English selection",
  );
  assert(
    (await evaluate("window.__merchantLocaleWrites")) === 0,
    "Language toggles on the create form must not submit a product",
  );

  await navigate(`${BASE_URL}/app/categories`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-categories-page\"]'))",
    "language journey categories page",
  );
  await expectMerchantLocale(
    "merchant-categories-page",
    "en",
    "Store categories — Rabet",
    "English categories after direct navigation",
  );

  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-products-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "language journey products before back",
  );
  await expectMerchantLocale(
    "merchant-products-page",
    "en",
    "Store products — Rabet",
    "English products before back test",
  );
  await click('[data-testid="merchant-categories-link"]');
  await waitForUrl("/app/categories", "language journey categories for back");
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"merchant-categories-page\"]'))",
    "language journey categories hydration for back",
  );
  await click('[data-testid="merchant-locale-ar"]');
  await expectMerchantLocale(
    "merchant-categories-page",
    "ar",
    "أقسام المتجر — Rabet",
    "Arabic categories before back",
  );
  await evaluate("window.history.back()");
  await waitForUrl("/app/products", "language journey back to products");
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-products-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "language journey back products hydration",
  );
  await expectMerchantLocale(
    "merchant-products-page",
    "ar",
    "منتجات المتجر — Rabet",
    "Arabic products after Back",
  );

  await navigate(`${BASE_URL}/app/products`);
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-products-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "language journey Arabic products reload",
  );
  await expectMerchantLocale(
    "merchant-products-page",
    "ar",
    "منتجات المتجر — Rabet",
    "Arabic products after reload",
  );
  await navigate(`${BASE_URL}/app/products/new`);
  await waitFor(
    cdp,
    "document.querySelector('[data-testid=\"merchant-product-create-page\"]')?.getAttribute('data-hydrated') === 'true'",
    "language journey Arabic add product direct navigation",
  );
  await expectMerchantLocale(
    "merchant-product-create-page",
    "ar",
    "إضافة منتج — Rabet",
    "Arabic add product after direct navigation",
  );
  log("Persistent merchant language checks passed.");

  await click('[data-testid="merchant-logout"]');
  await waitForUrl("/app/login", "empty store merchant logout");
  log("Empty-store first category and draft product journey passed.");

  log("Checking accessible invitation revocation...");
  const adminRows = await pgClient`
    select email, session_version
    from app_user
    where id = ${fixture.adminUserId}
  `;
  assert(adminRows.length === 1, "The seeded platform Super Admin should exist");
  const platformCookie = await encodeAuthJwt({
    token: {
      platformAdminId: fixture.adminUserId,
      role: "platform_admin",
      sessionVersion: adminRows[0].session_version,
    },
    secret: authSecret,
    salt: "rabet-platform.session-token",
  });
  await cdp.send("Network.setCookie", {
    name: "rabet-platform.session-token",
    value: platformCookie,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
  });
  await navigate(`${BASE_URL}/platform/invitations`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"platform-invitations-page\"]'))",
    "platform invitations page",
  );

  const revokeStamp = Date.now();
  const revokeEmail = `revoke.ui.${revokeStamp}@example.test`;
  const revokeSlug = `revoke-ui-${revokeStamp}`;
  await setValue('[data-testid="platform-invitation-email"]', revokeEmail);
  await setValue('[data-testid="platform-invitation-store-name"]', "Revoke UI Store");
  await setValue('[data-testid="platform-invitation-store-slug"]', revokeSlug);
  await click('[data-testid="platform-invitation-issue-submit"]');
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"platform-issued-invitation\"]'))",
    "one-time invitation reveal",
  );
  const issuedLink = await evaluate(
    "document.querySelector('[data-testid=\"platform-invitation-link\"]')?.value ?? ''",
  );
  assert(issuedLink.includes("/invite#token="), "Issued link should use the fragment token");
  assert(
    !(await evaluate("window.location.href")).includes("#token="),
    "The invitation management URL must not receive the token fragment",
  );
  const issuedToken = decodeURIComponent(issuedLink.split("#token=")[1] ?? "");
  assert(issuedToken.length > 0, "The issued link should contain a token");

  const issuedRows = await pgClient`
    select id, revoked_at::text as revoked_at, revoked_by_user_id
    from merchant_invitation
    where invited_email = ${revokeEmail}
  `;
  assert(issuedRows.length === 1, "The issued invitation should be persisted");
  const issuedInvitation = issuedRows[0];
  assert(issuedInvitation.revoked_at === null, "The issued invitation starts pending");

  await evaluate(`(() => {
    window.__platformRevokePosts = 0;
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
      if (init && init.method === "POST") {
        window.__platformRevokePosts += 1;
      }
      return originalFetch.call(this, input, init);
    };
    return true;
  })()`);

  const revokeButton = `[data-testid="platform-revoke-${issuedInvitation.id}"]`;
  const revokeDialog = "document.querySelector('[data-testid=\"platform-revoke-dialog\"]')";

  await click(revokeButton);
  await waitFor(cdp, `Boolean(${revokeDialog})`, "revoke confirmation dialog");
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="platform-revoke-dialog"]')?.innerText.includes(${JSON.stringify(revokeEmail)})`,
    "revoke dialog names the invitation",
  );
  assert(
    (await evaluate("document.activeElement?.getAttribute('data-testid')")) ===
      "platform-revoke-cancel",
    "Opening the dialog should focus Cancel",
  );
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await waitFor(
    cdp,
    `!document.querySelector('[data-testid="platform-revoke-dialog"]')`,
    "Escape closes the revoke dialog",
  );
  await waitFor(
    cdp,
    `document.activeElement?.getAttribute('data-testid') === ${JSON.stringify(`platform-revoke-${issuedInvitation.id}`)}`,
    "Escape restores focus to the row action",
  );
  assert(
    (await evaluate("window.__platformRevokePosts")) === 0,
    "Escape must not send a revoke request",
  );
  assert(
    (
      await pgClient`
        select revoked_at::text as revoked_at from merchant_invitation where id = ${issuedInvitation.id}
      `
    )[0].revoked_at === null,
    "Escape must not revoke the invitation",
  );

  await click(revokeButton);
  await waitFor(cdp, `Boolean(${revokeDialog})`, "revoke dialog for Cancel");
  await click('[data-testid="platform-revoke-cancel"]');
  await waitFor(
    cdp,
    `!document.querySelector('[data-testid="platform-revoke-dialog"]')`,
    "Cancel closes the revoke dialog",
  );
  assert(
    (await evaluate("window.__platformRevokePosts")) === 0,
    "Cancel must not send a revoke request",
  );
  assert(
    (
      await pgClient`
        select revoked_at::text as revoked_at from merchant_invitation where id = ${issuedInvitation.id}
      `
    )[0].revoked_at === null,
    "Cancel must not revoke the invitation",
  );

  await click(revokeButton);
  await waitFor(cdp, `Boolean(${revokeDialog})`, "revoke dialog for confirmation");
  await evaluate(`(() => {
    const button = document.querySelector('[data-testid="platform-revoke-confirm"]');
    button.click();
    button.click();
    return true;
  })()`);
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="platform-revoke-confirm"]')?.textContent?.includes("Revoking…") === true`,
    "revoke pending state",
  );
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"platform-revoke-feedback\"]')) && !document.querySelector('[data-testid=\"platform-revoke-dialog\"]')",
    "revoke success feedback",
  );
  await waitFor(
    cdp,
    `document.activeElement?.getAttribute('data-testid') === 'platform-revoke-feedback'`,
    "success focus moves to the feedback",
  );
  assert(
    (await text('[data-testid="platform-revoke-feedback"]')).includes(revokeEmail),
    "Success feedback should name the revoked invitation",
  );
  assert(
    (await evaluate("window.__platformRevokePosts")) === 1,
    "A repeated confirmation must start exactly one revoke request",
  );

  const revokedRows = await pgClient`
    select revoked_at, revoked_by_user_id
    from merchant_invitation
    where id = ${issuedInvitation.id}
  `;
  assert(revokedRows[0].revoked_at !== null, "Confirm should persist revoked_at");
  assert(
    revokedRows[0].revoked_by_user_id === fixture.adminUserId,
    "Confirm should audit the revoking Super Admin",
  );
  await waitFor(
    cdp,
    `document.querySelector('[data-testid="platform-invitation-${issuedInvitation.id}"]')?.innerText.includes("Revoked")`,
    "revoked row status",
  );
  assert(
    (await evaluate(`document.querySelector('[data-testid="platform-invitation-${issuedInvitation.id}"]')?.innerText ?? ""`)).includes(
      adminRows[0].email,
    ),
    "The invitation history should show the revoking Super Admin",
  );

  const revokedPreview = await postJson("/api/merchant-invitations/preview", {
    token: issuedToken,
  });
  assert(revokedPreview.status === 400, "A revoked invitation token should be rejected");
  await navigate(`${BASE_URL}/invite#token=${encodeURIComponent(issuedToken)}`);
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-testid=\"invite-error\"]'))",
    "revoked invitation link rejection",
  );
  assert(
    (await evaluate("document.body.innerText")).includes(
      "هذه الدعوة غير صالحة أو منتهية",
    ),
    "The revoked link should explain that it can no longer be used",
  );
  log("Invitation revocation Cancel, Confirm, audit and invalid-link checks passed.");

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
      "JSON.stringify({ path: window.location.pathname, text: document.body.innerText.slice(0, 500), rows: Array.from(document.querySelectorAll('[data-testid=\"merchant-product-row\"]')).map((row) => ({ id: row.getAttribute('data-product-id'), text: row.innerText.slice(0, 120) })), categories: Array.from(document.querySelectorAll('[data-testid=\"merchant-category-row\"]')).map((row) => ({ id: row.getAttribute('data-category-id'), saved: row.querySelector('[data-testid^=\"merchant-category-saved-\"]')?.textContent, path: row.querySelector('[data-testid^=\"merchant-category-path-\"]')?.getAttribute('data-path-visible'), conflict: Boolean(row.querySelector('[data-testid^=\"merchant-category-conflict-\"]')), text: row.innerText.slice(0, 160) })) })",
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
