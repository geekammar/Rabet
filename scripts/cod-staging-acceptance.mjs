#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import postgres from "postgres";

const CANDIDATE_SHA = (process.env.CANDIDATE_SHA ?? "").trim().toLowerCase();
const SERVICE_ID = (process.env.RENDER_SERVICE_ID ?? "").trim();
const APP_URL = (process.env.APP_URL ?? "").trim().replace(/\/$/, "");
const DEV_URL = process.env.NEON_DEV_DATABASE_URL ?? "";
const RENDER_API_KEY = process.env.RENDER_API_KEY ?? "";
const CODE_ROOT = path.resolve(process.env.RABET_CODE_ROOT ?? "/tmp/rabet-candidate");
const HASH_A = process.env.SEED_MERCHANT_A_PASSWORD_HASH ?? "";
const HASH_B = process.env.SEED_MERCHANT_B_PASSWORD_HASH ?? "";
const DB_NAME = "rabet_cod_pr56";
const DB_ROLE = "rabet_cod_pr56";
const SUMMARY_PATH = "/tmp/cod-staging-summary.json";

function log(message) {
  process.stdout.write(`[cod-staging] ${String(message)}\n`);
}

function fail(message) {
  process.stderr.write(`[cod-staging:FAIL] ${String(message)}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function redact(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_DB_URL]");
}

function requireSha(value) {
  if (!/^[0-9a-f]{40}$/.test(value)) fail("CANDIDATE_SHA must be a full 40-character SHA");
  return value;
}

function requireServiceId(value) {
  if (!/^srv-[a-z0-9]+$/i.test(value)) fail("RENDER_SERVICE_ID must look like srv-…");
  return value;
}

function requireHttps(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("APP_URL must be a valid URL");
  }
  if (parsed.protocol !== "https:") fail("APP_URL must be https");
  if (parsed.username || parsed.password) fail("APP_URL must not contain credentials");
  return parsed;
}

function safeIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) fail("Unsafe PostgreSQL identifier");
  return value;
}

function parseDevUrl() {
  let url;
  try {
    url = new URL(DEV_URL);
  } catch {
    fail("NEON_DEV_DATABASE_URL is missing or invalid");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) fail("NEON_DEV_DATABASE_URL must be postgres");
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".neon.tech")) fail("NEON_DEV_DATABASE_URL must target Neon");
  if (host.includes("-pooler")) fail("NEON_DEV_DATABASE_URL must be an unpooled endpoint");
  if (!url.username || !url.password) fail("NEON_DEV_DATABASE_URL must contain credentials");
  return url;
}

function buildUrl(base, user, password, database) {
  const url = new URL(base.toString());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  url.searchParams.set("sslmode", "require");
  return url.toString();
}

async function renderApi(method, apiPath, body, secrets) {
  let response;
  try {
    response = await fetch(`https://api.render.com/v1${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${RENDER_API_KEY}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(redact(`Render API network error: ${error instanceof Error ? error.message : String(error)}`, secrets));
  }

  const text = await response.text();
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {}
  }
  if (!response.ok) {
    fail(
      redact(
        `Render API ${method} ${apiPath} failed HTTP ${response.status}: ${
          payload?.message ?? text.slice(0, 300)
        }`,
        secrets,
      ),
    );
  }
  return payload;
}

async function setEnvVars(envVars, secrets) {
  const bodyVariants = [
    envVars.map(({ key, value }) => ({ key, value })),
    { envVars: envVars.map(({ key, value }) => ({ key, value })) },
  ];
  let lastError = null;
  for (const body of bodyVariants) {
    try {
      return await renderApi("PUT", `/services/${SERVICE_ID}/env-vars`, body, secrets);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function deployExactCommit(secrets) {
  const deploy = await renderApi(
    "POST",
    `/services/${SERVICE_ID}/deploys`,
    { commitId: CANDIDATE_SHA },
    secrets,
  );
  if (!deploy?.id) fail("Render did not return a deploy id");
  log(`Render deploy ${deploy.id} started for ${CANDIDATE_SHA}`);
  const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const current = await renderApi("GET", `/services/${SERVICE_ID}/deploys/${deploy.id}`, null, secrets);
    const status = String(current?.status ?? "unknown");
    log(`Render deploy status: ${status}`);
    if (status === "live") return current;
    if (["build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"].includes(status)) {
      fail(`Render deploy failed with status ${status}`);
    }
  }
  fail("Timed out waiting for Render deploy to become live");
}

async function waitForHealth(secrets) {
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${APP_URL}/api/healthz`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.status === "ok" && payload?.sha === CANDIDATE_SHA) {
        return payload;
      }
      log(`Health not ready: HTTP ${response.status} sha ${String(payload?.sha ?? "missing")}`);
    } catch (error) {
      log(`Health request failed: ${redact(error instanceof Error ? error.message : String(error), secrets)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  fail("Timed out waiting for deployed SHA in /api/healthz");
}

async function main() {
  requireSha(CANDIDATE_SHA);
  requireServiceId(SERVICE_ID);
  requireHttps(APP_URL);
  if (!RENDER_API_KEY) fail("RENDER_API_KEY is missing");
  if (!HASH_A || !HASH_B) fail("Merchant password hashes are missing");
  if (!fs.existsSync(path.join(CODE_ROOT, "drizzle", "meta", "_journal.json"))) {
    fail("Candidate worktree has no Drizzle journal");
  }

  const devUrl = parseDevUrl();
  const secrets = [devUrl.password, DEV_URL];
  const dbPassword = crypto.randomBytes(24).toString("hex");
  secrets.push(dbPassword);

  const admin = postgres(devUrl.toString(), {
    max: 1,
    connect_timeout: 30,
    ssl: "require",
  });

  try {
    const [identity] = await admin`
      select current_database() as database, current_user as role,
             (select rolcreatedb from pg_roles where rolname = current_user) as can_create_db
    `;
    if (!identity?.can_create_db) fail("NEON_DEV_DATABASE_URL role cannot create a dedicated test database");
    if (typeof identity?.role !== "string") fail("Neon owner role could not be identified");
    safeIdentifier(identity.role);
    log(`Neon owner identity verified; creating dedicated database ${DB_NAME}`);

    safeIdentifier(DB_NAME);
    safeIdentifier(DB_ROLE);

    await admin.unsafe(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${DB_NAME}' and pid <> pg_backend_pid()`,
    ).catch(() => {});
    await admin.unsafe(`drop database if exists "${DB_NAME}" with (force)`);
    await admin.unsafe(`drop role if exists "${DB_ROLE}"`);
    await admin.unsafe(
      `create role "${DB_ROLE}" with login password '${dbPassword.replace(/'/g, "''")}' nosuperuser nocreatedb nocreaterole noreplication`,
    );
    await admin.unsafe(`grant "${DB_ROLE}" to "${identity.role}"`);
    await admin.unsafe(`create database "${DB_NAME}" owner "${DB_ROLE}"`);
  } finally {
    await admin.end({ timeout: 5 }).catch(() => {});
  }

  const testDbUrl = buildUrl(devUrl, DB_ROLE, dbPassword, DB_NAME);
  secrets.push(testDbUrl);

  log("Applying committed migration chain through 0013");
  const migrate = spawnSync("npm", ["run", "db:migrate"], {
    cwd: CODE_ROOT,
    env: { ...process.env, DATABASE_URL: testDbUrl },
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
  });
  if (migrate.status !== 0) {
    fail(redact(`Migration failed: ${migrate.stderr || migrate.stdout}`, secrets));
  }

  const testDb = postgres(testDbUrl, { max: 1, connect_timeout: 30, ssl: "require" });
  let migrationCount;
  let tableCount;
  try {
    const [migrations] = await testDb`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `;
    const [tables] = await testDb`
      select count(*)::int as count from information_schema.tables where table_schema = 'public'
    `;
    migrationCount = migrations.count;
    tableCount = tables.count;
    if (migrationCount !== 14) fail(`Expected 14 migrations, found ${migrationCount}`);
    if (tableCount !== 35) fail(`Expected 35 public tables, found ${tableCount}`);
    const [orderTable] = await testDb`select to_regclass('public."order"') as name`;
    if (!orderTable?.name) fail("Expected commerce tables are missing");
  } finally {
    await testDb.end({ timeout: 5 }).catch(() => {});
  }
  log(`Migration verification: ${migrationCount}/14 migrations, ${tableCount}/35 tables`);

  log("Seeding synthetic stores, merchants and a COD order");
  const seedOutput = "/tmp/cod-staging-seed.json";
  const seed = spawnSync(
    "npx",
    [
      "tsx",
      "--tsconfig",
      path.join(CODE_ROOT, "scripts", "tsconfig.seed.json"),
      path.join(path.dirname(new URL(import.meta.url).pathname), "cod-staging-seed.ts"),
    ],
    {
      cwd: CODE_ROOT,
      env: {
        ...process.env,
        SEED_DATABASE_URL: testDbUrl,
        SEED_OUTPUT: seedOutput,
        SEED_MERCHANT_A_PASSWORD_HASH: HASH_A,
        SEED_MERCHANT_B_PASSWORD_HASH: HASH_B,
        RABET_COD_ORDERS_ENABLED: "true",
      },
      encoding: "utf8",
      timeout: 10 * 60 * 1000,
    },
  );
  if (seed.status !== 0) {
    fail(redact(`Seed failed: ${seed.stderr || seed.stdout}`, secrets));
  }
  const seeded = JSON.parse(fs.readFileSync(seedOutput, "utf8"));

  const authSecret = crypto.randomBytes(32).toString("base64");
  secrets.push(authSecret);
  log("Setting isolated Render environment (values not printed)");
  await setEnvVars(
    [
      { key: "DATABASE_URL", value: testDbUrl },
      { key: "AUTH_SECRET", value: authSecret },
      { key: "AUTH_URL", value: APP_URL },
      { key: "APP_URL", value: APP_URL },
      { key: "AUTH_TRUST_HOST", value: "true" },
      { key: "RABET_MERCHANT_APP_ENABLED", value: "true" },
      { key: "RABET_COD_ORDERS_ENABLED", value: "true" },
      { key: "RABET_BUILD_SHA", value: CANDIDATE_SHA },
    ],
    secrets,
  );

  await deployExactCommit(secrets);
  const health = await waitForHealth(secrets);
  log(`Deployed ${health.sha} at ${APP_URL}`);

  const { encode } = await import("next-auth/jwt");
  const { default: postgresVerify } = await import("postgres");
  const verifyDb = postgresVerify(testDbUrl, { max: 1, connect_timeout: 30, ssl: "require" });
  let dbEvidence;
  try {
    const [orders] = await verifyDb`
      select count(*)::int as count from "order" where store_id = ${seeded.stores.a.id}
    `;
    const [reservations] = await verifyDb`
      select count(*)::int as count from "inventory_reservation"
      where store_id = ${seeded.stores.a.id}
    `;
    const [inventory] = await verifyDb`
      select on_hand, reserved from "product_inventory"
      where store_id = ${seeded.stores.a.id}
      limit 1
    `;
    dbEvidence = {
      orders: orders.count,
      reservations: reservations.count,
      onHand: inventory.on_hand,
      reserved: inventory.reserved,
    };
    if (orders.count !== 1 || reservations.count !== 1) fail("Live DB order/reservation count mismatch");
    if (dbEvidence.onHand !== 5 || dbEvidence.reserved !== 2) fail("Live DB inventory mismatch");
  } finally {
    await verifyDb.end({ timeout: 5 }).catch(() => {});
  }

  async function merchantFetch(user, pathName) {
    const cookie = await encode({
      token: {
        merchantId: user.userId,
        role: "merchant",
        sessionVersion: user.sessionVersion,
        sub: user.userId,
      },
      secret: authSecret,
      salt: "rabet-merchant.session-token",
    });
    return fetch(`${APP_URL}${pathName}`, {
      headers: {
        Cookie: `rabet-merchant.session-token=${cookie}`,
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(30_000),
    });
  }

  const setupResponse = await merchantFetch(seeded.merchants.a, `/app/setup?cod=${Date.now()}`);
  const setupHtml = await setupResponse.text();
  if (setupResponse.status !== 200) fail(`Merchant A setup returned HTTP ${setupResponse.status}`);
  if (!setupHtml.includes('data-testid="merchant-orders-link"')) {
    fail("Merchant A setup does not expose the COD Orders navigation entry");
  }

  const ordersResponse = await merchantFetch(seeded.merchants.a, `/app/orders?cod=${Date.now()}`);
  const ordersHtml = await ordersResponse.text();
  if (ordersResponse.status !== 200) fail(`Merchant A orders returned HTTP ${ordersResponse.status}`);
  if (!ordersHtml.includes(seeded.order.reference)) fail("Merchant A orders page is missing the seeded reference");
  if (!ordersHtml.includes("طلبات الدفع عند الاستلام")) fail("Merchant A orders page is missing Arabic RTL title");
  if (!ordersHtml.includes("بانتظار التحصيل")) fail("Merchant A orders page is not awaiting collection");

  const otherStoreResponse = await merchantFetch(seeded.merchants.b, `/app/orders?cod=${Date.now()}`);
  const otherStoreHtml = await otherStoreResponse.text();
  if (otherStoreResponse.status !== 200) fail(`Merchant B orders returned HTTP ${otherStoreResponse.status}`);
  if (otherStoreHtml.includes(seeded.order.reference)) fail("Store B can see store A's order");

  const managerWebhook = await fetch(`${APP_URL}/api/telegram/manager/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);

  const summary = {
    serviceId: SERVICE_ID,
    appUrl: APP_URL,
    deployedSha: CANDIDATE_SHA,
    migrations: { applied: migrationCount, expected: 14 },
    tables: { public: tableCount, expected: 35 },
    stores: seeded.stores,
    merchantAEmail: seeded.merchants.a.email,
    merchantBEmail: seeded.merchants.b.email,
    order: seeded.order,
    duplicateReferenceMatched: true,
    database: dbEvidence,
    ordersNavigation: {
      setupLinkPresent: true,
      merchantAOrderVisible: true,
      merchantBOrderHidden: true,
      arabicRtlTitle: true,
      awaitingCollection: true,
    },
    webhookRoute: {
      managerHttpStatus: managerWebhook?.status ?? null,
      liveTelegramDelivery: "NOT RUN - no test Manager Bot/managed bot credentials",
    },
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o644 });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
