#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import postgres from "postgres";

const CANDIDATE_SHA = (process.env.CANDIDATE_SHA ?? "").trim().toLowerCase();
const BASELINE_SHA = (process.env.BASELINE_SHA ?? "").trim().toLowerCase();
const BASELINE_SERVICE_ID = (process.env.BASELINE_SERVICE_ID ?? "").trim();
const QA_SERVICE_ID = (process.env.QA_SERVICE_ID ?? "").trim();
const QA_APP_URL = (process.env.QA_APP_URL ?? "").trim().replace(/\/$/, "");
const RENDER_API_KEY = process.env.RENDER_API_KEY ?? "";
const OWNER_URL_RAW = process.env.NEON_DEV_DATABASE_URL ?? "";
const CODE_ROOT = path.resolve(process.env.RABET_CODE_ROOT ?? "/tmp/rabet-candidate");
const QA_DB_NAME = "rabet_cod_qa_pr57";
const QA_DB_ROLE = "rabet_cod_qa_pr57";
const BASELINE_DB_NAME = "rabet_cod_pr56";
const WORK_DIR = "/tmp/cod-qa-pr57";
const DUMP_PATH = path.join(WORK_DIR, "baseline.dump");
const SUMMARY_PATH = "/tmp/cod-qa-pr57-summary.json";

let stage = "validate";
const summary = {
  status: "blocked",
  candidateSha: CANDIDATE_SHA,
  baselineSha: BASELINE_SHA,
  baselineServiceId: BASELINE_SERVICE_ID,
  qaServiceId: QA_SERVICE_ID,
  qaAppUrl: QA_APP_URL,
  stage,
  generatedAt: new Date().toISOString(),
};
const secrets = [RENDER_API_KEY, OWNER_URL_RAW];

function log(message) {
  process.stdout.write(`[cod-qa-pr57] ${String(message)}\n`);
}

function redact(value) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_DB_URL]");
}

function fail(message) {
  throw new Error(redact(message));
}

function requireSha(value, label) {
  if (!/^[0-9a-f]{40}$/.test(value)) fail(`${label} must be a full 40-character SHA`);
  return value;
}

function requireServiceId(value, label) {
  if (!/^srv-[a-z0-9]+$/i.test(value)) fail(`${label} must look like srv-…`);
  return value;
}

function requireHttps(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("QA_APP_URL must be a valid URL");
  }
  if (parsed.protocol !== "https:") fail("QA_APP_URL must be https");
  if (parsed.username || parsed.password) fail("QA_APP_URL must not contain credentials");
  return parsed;
}

function safeIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) fail("Unsafe PostgreSQL identifier");
  return value;
}

function parseDbUrl(raw, label) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${label} is missing or invalid`);
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) fail(`${label} must be postgres`);
  if (!parsed.hostname.toLowerCase().endsWith(".neon.tech")) fail(`${label} must target Neon`);
  if (parsed.hostname.toLowerCase().includes("-pooler")) fail(`${label} must be an unpooled endpoint`);
  if (!parsed.username || !parsed.password) fail(`${label} must contain credentials`);
  if (!parsed.pathname || parsed.pathname === "/") fail(`${label} must name a database`);
  secrets.push(raw, parsed.password);
  return parsed;
}

function dbHostAndName(parsed) {
  return {
    host: parsed.hostname,
    database: parsed.pathname.replace(/^\//, ""),
    user: parsed.username,
    port: parsed.port || "5432",
  };
}

async function renderApi(method, apiPath, body) {
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
    fail(`Render API network error: ${error instanceof Error ? error.message : String(error)}`);
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
      `Render API ${method} ${apiPath} failed HTTP ${response.status}: ${
        payload?.message ?? text.slice(0, 300)
      }`,
    );
  }
  return payload;
}

function normalizeEnvList(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.envVars)
      ? payload.envVars
      : null;
  if (!list) fail("Unexpected Render env-vars response shape");
  return list.map((entry) => {
    const row = entry?.envVar ?? entry;
    return { key: String(row?.key ?? ""), value: row?.value };
  });
}

async function getEnvMap(serviceId) {
  const rows = normalizeEnvList(
    await renderApi("GET", `/services/${serviceId}/env-vars?limit=100`),
  );
  return new Map(rows.filter((row) => row.key).map((row) => [row.key, row.value]));
}

async function setEnvVars(serviceId, envVars) {
  await renderApi(
    "PUT",
    `/services/${serviceId}/env-vars`,
    envVars.map(({ key, value }) => ({ key, value })),
  );
  const keys = normalizeEnvList(
    await renderApi("GET", `/services/${serviceId}/env-vars?limit=100`),
  ).map((row) => row.key).sort();
  return keys;
}

async function getService(serviceId) {
  const payload = await renderApi("GET", `/services/${serviceId}`);
  return payload?.service ?? payload;
}

function buildTargetUrl(ownerUrl, role, password, database) {
  const url = new URL(ownerUrl.toString());
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  url.searchParams.set("sslmode", "require");
  return url.toString();
}

function runPostgresTool(tool, args, databaseUrl) {
  const url = new URL(databaseUrl);
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: url.pathname.replace(/^\//, ""),
    PGUSER: url.username,
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: "require",
    PGAPPNAME: "rabet-cod-qa-pr57",
  };
  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    "host",
    "-v",
    `${WORK_DIR}:/work`,
  ];
  for (const key of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE", "PGAPPNAME"]) {
    dockerArgs.push("-e", key);
  }
  dockerArgs.push("postgres:18", tool, ...args);
  const result = spawnSync("docker", dockerArgs, {
    env,
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
  });
  if (result.status !== 0) {
    fail(`${tool} failed: ${result.stderr || result.stdout || "no output"}`);
  }
}

function hashRows(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function snapshot(sql, label) {
  const stores = await sql`
    select id, name, slug, status, created_at, updated_at
    from store order by id
  `;
  const orders = await sql`
    select id, store_id, connection_id, telegram_user_id, telegram_chat_id,
      reference, checkout_key, status, payment_method, payment_status,
      fulfillment_status, currency, subtotal, delivery_fee, total,
      customer_name, customer_phone, delivery_address, placed_at, created_at, updated_at
    from "order" order by reference
  `;
  const orderItems = await sql`
    select id, order_id, product_id, product_name, unit_price, quantity,
      line_total, product_snapshot, created_at
    from order_item order by id
  `;
  const reservations = await sql`
    select id, order_id, order_item_id, product_id, store_id, quantity, status,
      reserved_at, committed_at, released_at, release_reason, created_at, updated_at
    from inventory_reservation order by id
  `;
  const inventory = await sql`
    select product_id, store_id, on_hand, reserved, created_at, updated_at
    from product_inventory order by product_id
  `;
  const connections = await sql`
    select store_id, bot_id::text as bot_id, bot_username, status, created_at, verified_at
    from telegram_connection order by store_id, bot_id
  `;
  const ordersByStatus = await sql`
    select status, count(*)::int as count from "order" group by status order by status
  `;
  const reservationsByStatus = await sql`
    select status, count(*)::int as count from inventory_reservation group by status order by status
  `;
  const [counts] = await sql`
    select
      (select count(*)::int from store) as stores,
      (select count(*)::int from "order") as orders,
      (select count(*)::int from order_item) as order_items,
      (select count(*)::int from inventory_reservation) as reservations,
      (select count(*)::int from product_inventory) as inventory_rows,
      (select count(*)::int from telegram_connection) as connections,
      (select count(*)::int from drizzle.__drizzle_migrations) as migrations
  `;
  const [targetOrder] = await sql`
    select reference, status, payment_status, fulfillment_status, subtotal,
      delivery_fee, total, currency
    from "order" where reference = 'ORD-X2EZD9'
  `;
  const cancelled = await sql`
    select reference, status, updated_at
    from "order" where status = 'cancelled' order by reference
  `;
  const [dbIdentity] = await sql`
    select current_database() as database, current_user as role,
      current_setting('neon.project_id', true) as project_id,
      current_setting('neon.branch_id', true) as branch_id
  `;

  return {
    label,
    dbIdentity,
    hashes: {
      stores: hashRows(stores),
      orders: hashRows(orders),
      orderItems: hashRows(orderItems),
      reservations: hashRows(reservations),
      inventory: hashRows(inventory),
      connections: hashRows(connections),
    },
    data: {
      stores: stores.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
      })),
      connections: connections.map((row) => ({
        storeId: row.store_id,
        botId: row.bot_id,
        botUsername: row.bot_username,
        status: row.status,
      })),
      counts,
      ordersByStatus,
      reservationsByStatus,
      targetOrder: targetOrder
        ? {
            reference: targetOrder.reference,
            status: targetOrder.status,
            paymentStatus: targetOrder.payment_status,
            fulfillmentStatus: targetOrder.fulfillment_status,
            subtotal: targetOrder.subtotal,
            deliveryFee: targetOrder.delivery_fee,
            total: targetOrder.total,
            currency: targetOrder.currency,
          }
        : null,
      cancelled,
    },
  };
}

function assertHashesEqual(before, after, label) {
  for (const key of Object.keys(before.hashes)) {
    if (before.hashes[key] !== after.hashes[key]) {
      fail(`${label} hash mismatch: ${key}`);
    }
  }
}

async function main() {
  stage = "validate";
  requireSha(CANDIDATE_SHA, "CANDIDATE_SHA");
  requireSha(BASELINE_SHA, "BASELINE_SHA");
  requireServiceId(BASELINE_SERVICE_ID, "BASELINE_SERVICE_ID");
  requireServiceId(QA_SERVICE_ID, "QA_SERVICE_ID");
  if (BASELINE_SERVICE_ID === QA_SERVICE_ID) fail("QA service must be different from baseline service");
  const appUrl = requireHttps(QA_APP_URL);
  if (!RENDER_API_KEY) fail("RENDER_API_KEY is missing");
  if (!fs.existsSync(path.join(CODE_ROOT, "drizzle", "meta", "_journal.json"))) {
    fail("Candidate worktree has no Drizzle journal");
  }
  fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });

  const baselineService = await getService(BASELINE_SERVICE_ID);
  const qaService = await getService(QA_SERVICE_ID);
  const qaServiceUrl = String(qaService?.serviceDetails?.url ?? "").replace(/\/$/, "");
  if (new URL(qaServiceUrl).hostname !== appUrl.hostname) {
    fail("QA_APP_URL does not match the Render QA service URL");
  }
  const baselineEnv = await getEnvMap(BASELINE_SERVICE_ID);
  const baselineBuildSha = String(baselineEnv.get("RABET_BUILD_SHA") ?? "").toLowerCase();
  if (baselineBuildSha !== BASELINE_SHA) {
    fail(`Baseline RABET_BUILD_SHA is ${baselineBuildSha || "missing"}, expected ${BASELINE_SHA}`);
  }
  const baselineUrlRaw = baselineEnv.get("DATABASE_URL");
  if (!baselineUrlRaw) fail("Baseline DATABASE_URL is missing");
  const baselineUrl = parseDbUrl(baselineUrlRaw, "Baseline DATABASE_URL");
  const baselineDb = dbHostAndName(baselineUrl);
  if (baselineDb.database !== BASELINE_DB_NAME) {
    fail(`Baseline database is ${baselineDb.database}, expected ${BASELINE_DB_NAME}`);
  }
  const ownerUrl = parseDbUrl(OWNER_URL_RAW, "NEON_DEV_DATABASE_URL");
  const qaEnvBefore = await getEnvMap(QA_SERVICE_ID);

  summary.baseline = {
    serviceId: BASELINE_SERVICE_ID,
    serviceName: baselineService?.name,
    serviceUrl: String(baselineService?.serviceDetails?.url ?? ""),
    buildSha: baselineBuildSha,
    database: { host: baselineDb.host, name: baselineDb.database, role: baselineDb.user },
  };
  summary.qaService = {
    serviceId: QA_SERVICE_ID,
    serviceName: qaService?.name,
    appUrl: qaServiceUrl,
    envKeysBefore: [...qaEnvBefore.keys()].sort(),
  };
  log(`Baseline ${BASELINE_SERVICE_ID} at ${baselineBuildSha}; DB ${baselineDb.host}/${baselineDb.database}`);
  log(`QA service ${QA_SERVICE_ID} at ${qaServiceUrl}`);

  stage = "create-isolated-db";
  safeIdentifier(QA_DB_NAME);
  safeIdentifier(QA_DB_ROLE);
  const rolePassword = crypto.randomBytes(24).toString("hex");
  const owner = postgres(ownerUrl.toString(), {
    max: 1,
    connect_timeout: 30,
    ssl: "require",
  });
  let ownerRole;
  try {
    const [identity] = await owner`
      select current_user as role,
        (select rolcreatedb from pg_roles where rolname = current_user) as can_create_db
    `;
    ownerRole = identity?.role;
    if (!ownerRole) fail("Neon owner role could not be identified");
    if (!identity?.can_create_db) fail("NEON_DEV_DATABASE_URL role cannot create a dedicated test database");
    const existingDb = await owner`select datname from pg_database where datname = ${QA_DB_NAME}`;
    const existingRole = await owner`select rolname from pg_roles where rolname = ${QA_DB_ROLE}`;
    if (existingDb.length > 0) {
      const ownerTargetUrl = buildTargetUrl(ownerUrl, ownerRole, decodeURIComponent(ownerUrl.password), QA_DB_NAME);
      const probe = postgres(ownerTargetUrl, { max: 1, connect_timeout: 30, ssl: "require" });
      let probeTables = null;
      try {
        const rows = await probe`
          select count(*)::int as count from information_schema.tables
          where table_schema in ('public', 'drizzle')
        `;
        probeTables = rows[0]?.count ?? null;
      } catch {
        probeTables = null;
      } finally {
        await probe.end({ timeout: 5 }).catch(() => {});
      }
      if (probeTables !== 0) {
        fail(`Database ${QA_DB_NAME} already exists with tables; refusing to overwrite it`);
      }
      log(`Removing empty failed-attempt database ${QA_DB_NAME}`);
      await owner.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${QA_DB_NAME}' and pid <> pg_backend_pid()`).catch(() => {});
      await owner.unsafe(`drop database "${QA_DB_NAME}" with (force)`);
    }
    if (existingRole.length > 0) {
      if (existingDb.length === 0) fail(`Role ${QA_DB_ROLE} already exists without the QA database; refusing to overwrite it`);
      await owner.unsafe(`drop role if exists "${QA_DB_ROLE}"`);
    }
    await owner.unsafe(
      `create role "${QA_DB_ROLE}" with login password '${rolePassword.replace(/'/g, "''")}' nosuperuser nocreatedb nocreaterole noreplication`,
    );
    await owner.unsafe(`grant "${QA_DB_ROLE}" to "${ownerRole}"`);
    await owner.unsafe(`create database "${QA_DB_NAME}" owner "${QA_DB_ROLE}"`);
  } finally {
    await owner.end({ timeout: 5 }).catch(() => {});
  }

  const targetUrlRaw = buildTargetUrl(ownerUrl, QA_DB_ROLE, rolePassword, QA_DB_NAME);
  secrets.push(targetUrlRaw, rolePassword);
  const targetUrl = new URL(targetUrlRaw);
  const targetDb = dbHostAndName(targetUrl);
  summary.isolatedDatabase = {
    host: targetDb.host,
    name: targetDb.database,
    role: targetDb.user,
    recovery: "new isolated database; baseline database is untouched and can be re-copied",
  };
  log(`Created isolated database ${targetDb.host}/${targetDb.database}`);

  stage = "baseline-snapshot";
  const baselineSql = postgres(baselineUrl.toString(), { max: 1, connect_timeout: 30, ssl: "require" });
  let baselineSnapshot;
  try {
    baselineSnapshot = await snapshot(baselineSql, "baseline");
    if (baselineSnapshot.data.counts.migrations !== 14) {
      fail(`Baseline ledger has ${baselineSnapshot.data.counts.migrations} migrations, expected 14`);
    }
    if (!baselineSnapshot.data.targetOrder || baselineSnapshot.data.targetOrder.reference !== "ORD-X2EZD9") {
      fail("Baseline ORD-X2EZD9 is missing");
    }
    if (baselineSnapshot.data.stores.length !== 3) {
      fail(`Baseline store count is ${baselineSnapshot.data.stores.length}, expected 3`);
    }
    summary.baseline.snapshot = {
      counts: baselineSnapshot.data.counts,
      stores: baselineSnapshot.data.stores,
      ordersByStatus: baselineSnapshot.data.ordersByStatus,
      reservationsByStatus: baselineSnapshot.data.reservationsByStatus,
      targetOrder: baselineSnapshot.data.targetOrder,
      connections: baselineSnapshot.data.connections,
      hashes: baselineSnapshot.hashes,
    };
    log("Captured baseline snapshot (stores, orders, items, reservations, inventory, connections)");
  } finally {
    await baselineSql.end({ timeout: 5 }).catch(() => {});
  }

  stage = "copy-baseline";
  log("Dumping baseline with PostgreSQL 18 and restoring into the isolated database");
  runPostgresTool(
    "pg_dump",
    ["--format=custom", "--no-owner", "--no-privileges", "--file", "/work/baseline.dump"],
    baselineUrl.toString(),
  );
  runPostgresTool(
    "pg_restore",
    [
      "--no-owner",
      "--no-privileges",
      "--no-comments",
      "--dbname",
      targetDb.database,
      "/work/baseline.dump",
    ],
    targetUrl.toString(),
  );

  stage = "verify-copy";
  const targetSql = postgres(targetUrl.toString(), { max: 1, connect_timeout: 30, ssl: "require" });
  let copiedSnapshot;
  try {
    copiedSnapshot = await snapshot(targetSql, "copied");
    if (copiedSnapshot.data.counts.migrations !== 14) {
      fail(`Copied ledger has ${copiedSnapshot.data.counts.migrations} migrations, expected 14`);
    }
    assertHashesEqual(baselineSnapshot, copiedSnapshot, "Copied baseline");
    summary.isolatedDatabase.snapshotBeforeMigration = {
      counts: copiedSnapshot.data.counts,
      hashes: copiedSnapshot.hashes,
      dbIdentity: copiedSnapshot.dbIdentity,
    };
    log("Isolated copy matches the baseline before migration");
  } finally {
    await targetSql.end({ timeout: 5 }).catch(() => {});
  }

  stage = "apply-0014";
  const migrate = spawnSync("npm", ["run", "db:migrate"], {
    cwd: CODE_ROOT,
    env: { ...process.env, DATABASE_URL: targetUrl.toString() },
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
  });
  if (migrate.status !== 0) {
    fail(`Migration failed: ${migrate.stderr || migrate.stdout}`);
  }
  const journalPath = path.join(CODE_ROOT, "drizzle", "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (!Array.isArray(journal.entries) || journal.entries.length !== 15) {
    fail(`Candidate journal has ${journal.entries?.length ?? "no"} entries, expected 15`);
  }
  const lastTag = journal.entries[journal.entries.length - 1]?.tag;
  if (lastTag !== "0014_sparkling_captain_stacy") {
    fail(`Candidate journal last tag is ${lastTag}, expected 0014_sparkling_captain_stacy`);
  }

  stage = "verify-migration";
  const promotedSql = postgres(targetUrl.toString(), { max: 1, connect_timeout: 30, ssl: "require" });
  let promotedSnapshot;
  try {
    promotedSnapshot = await snapshot(promotedSql, "promoted");
    if (promotedSnapshot.data.counts.migrations !== 15) {
      fail(`Promoted ledger has ${promotedSnapshot.data.counts.migrations} migrations, expected 15`);
    }
    assertHashesEqual(baselineSnapshot, promotedSnapshot, "Post-migration");
    const constraints = await promotedSql`
      select conname from pg_constraint
      where conname in (
        'order_status_check',
        'order_merchant_progress_check',
        'order_cancellation_state_check',
        'order_cancellation_reason_length_check'
      ) order by conname
    `;
    if (constraints.length !== 4) fail("Expected four order constraints after migration");
    const newColumns = await promotedSql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'order'
        and column_name in ('accepted_at','preparing_at','cancelled_at','cancellation_reason')
      order by column_name
    `;
    if (newColumns.length !== 4) fail("Expected four new order columns after migration");
    const legacyCancellation = await promotedSql`
      select reference, status, cancellation_reason, cancelled_at, updated_at
      from "order" where status = 'cancelled' order by reference
    `;
    for (const row of legacyCancellation) {
      if (!row.cancellation_reason || !row.cancelled_at) {
        fail(`Legacy cancelled order ${row.reference} was not backfilled`);
      }
    }
    const ledger = await promotedSql`
      select id, hash, created_at from drizzle.__drizzle_migrations order by created_at, id
    `;
    const migrationFile = path.join(CODE_ROOT, "drizzle", "0014_sparkling_captain_stacy.sql");
    const expectedHash = crypto.createHash("sha256").update(fs.readFileSync(migrationFile)).digest("hex");
    if (String(ledger[ledger.length - 1]?.hash) !== expectedHash) {
      fail("Ledger last hash does not match candidate migration 0014");
    }
    summary.isolatedDatabase.migration = {
      ledgerBefore: copiedSnapshot.data.counts.migrations,
      ledgerAfter: promotedSnapshot.data.counts.migrations,
      pending: 0,
      lastTag,
      lastHash: expectedHash,
      constraints: constraints.map((row) => row.conname),
      newColumns: newColumns.map((row) => row.column_name),
    };
    summary.isolatedDatabase.snapshotAfterMigration = {
      counts: promotedSnapshot.data.counts,
      hashes: promotedSnapshot.hashes,
      targetOrder: promotedSnapshot.data.targetOrder,
      cancelled: promotedSnapshot.data.cancelled,
      legacyCancellation,
      dbIdentity: promotedSnapshot.dbIdentity,
    };
    log("Migration 0014 verified: 15/15 ledger, four constraints, baseline rows preserved");
  } finally {
    await promotedSql.end({ timeout: 5 }).catch(() => {});
  }

  stage = "configure-qa-service";
  const authSecret = crypto.randomBytes(32).toString("base64");
  secrets.push(authSecret);
  const envVars = [
    { key: "DATABASE_URL", value: targetUrl.toString() },
    { key: "AUTH_SECRET", value: authSecret },
    { key: "AUTH_URL", value: QA_APP_URL },
    { key: "APP_URL", value: QA_APP_URL },
    { key: "AUTH_TRUST_HOST", value: "true" },
    { key: "RABET_MERCHANT_APP_ENABLED", value: "true" },
    { key: "RABET_COD_ORDERS_ENABLED", value: "true" },
    { key: "RABET_BUILD_SHA", value: CANDIDATE_SHA },
  ];
  const envKeys = await setEnvVars(QA_SERVICE_ID, envVars);
  if (envKeys.some((key) => key.startsWith("TELEGRAM_"))) {
    fail("QA service unexpectedly still has Telegram credentials");
  }
  summary.qaService.envKeysAfter = envKeys;
  log(`QA service environment set (${envKeys.length} keys); no Telegram credentials copied`);

  stage = "deploy-candidate";
  const deploy = await renderApi("POST", `/services/${QA_SERVICE_ID}/deploys`, {
    commitId: CANDIDATE_SHA,
  });
  if (!deploy?.id) fail("Render did not return a deploy id");
  summary.qaService.deployId = deploy.id;
  log(`Render QA deploy ${deploy.id} started for ${CANDIDATE_SHA}`);
  const deployDeadline = Date.now() + 25 * 60 * 1000;
  let liveDeploy = null;
  while (Date.now() < deployDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const current = await renderApi("GET", `/services/${QA_SERVICE_ID}/deploys/${deploy.id}`);
    const status = String(current?.status ?? "unknown");
    log(`Render QA deploy status: ${status}`);
    if (status === "live") {
      liveDeploy = current;
      break;
    }
    if (["build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"].includes(status)) {
      fail(`Render QA deploy failed with status ${status}`);
    }
  }
  if (!liveDeploy) fail("Timed out waiting for Render QA deploy");

  stage = "verify-health";
  const healthDeadline = Date.now() + 8 * 60 * 1000;
  let health = null;
  while (Date.now() < healthDeadline) {
    try {
      const response = await fetch(`${QA_APP_URL}/api/healthz`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.status === "ok" && payload?.sha === CANDIDATE_SHA) {
        health = payload;
        break;
      }
      log(`Health not ready: HTTP ${response.status} sha ${String(payload?.sha ?? "missing")}`);
    } catch (error) {
      log(`Health request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (!health) fail("Timed out waiting for candidate SHA in QA /api/healthz");

  summary.qaService.deployStatus = "live";
  summary.qaService.deployCommit = liveDeploy.commit?.id ?? CANDIDATE_SHA;
  summary.qaService.health = health;
  summary.status = "ready";
  summary.stage = "complete";
  summary.generatedAt = new Date().toISOString();
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o644 });
  log(`QA candidate is live at ${QA_APP_URL} with SHA ${health.sha}`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  summary.status = "blocked";
  summary.stage = stage;
  summary.error = redact(error instanceof Error ? error.message : String(error));
  summary.generatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o644 });
  } catch {}
  process.stderr.write(`[cod-qa-pr57:FAIL] ${summary.error}\n`);
  process.exitCode = 1;
});
