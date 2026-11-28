#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import postgres from "postgres";

export const CANDIDATE = "dc59091f1424403b3e63674e1ff4bafc215be30d";
export const SERVICE_ID = "srv-dc2ao2e8bjmc73f5cjig";
const SERVICE_NAME = "nokmel-cod-staging";
const ORIGIN = "https://nokmel-cod-staging.onrender.com";
const PREVIOUS_SHA = "d914f6c10ade37559b77d8652e3add6738a6c3ba";
const PREVIOUS_DEPLOY = "dep-dc4ue0h7lnhs739tujr0";
const DATABASE_HOST = "ep-tiny-star-b4dpybus.c-6.us-east-2.aws.neon.tech";
const DATABASE_NAME = "rabet_cod_pr56";
const TAG = "0021_merchant_product_publish";
const HASH_0021 = "41166c44f1f7c674e4e763e31efaaa88d0fac2d4ba06351051413f4789af787d";
const CONFIRM = {
  inspect: undefined,
  migrate: "MIGRATE_BATCH01_0021_STAGING",
  deploy: "DEPLOY_BATCH01_STAGING",
};
const TERMINAL = new Set([
  "live", "deactivated", "canceled", "build_failed", "update_failed", "pre_deploy_failed",
]);

class StageError extends Error {}

function check(condition, message) {
  if (!condition) throw new StageError(message);
}

export function candidateMigrations() {
  // Read immutable Git objects even if the tooling worktree contains other SQL.
  const source = (path) => execFileSync("git", ["show", `${CANDIDATE}:${path}`], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const journal = JSON.parse(source("drizzle/meta/_journal.json")).entries;
  check(journal.length === 22 && journal.at(-1)?.tag === TAG, "Unexpected candidate journal");
  const migrations = journal.map(({ idx, tag, when }, index) => {
    check(idx === index && /^\d{4}_[a-z0-9_]+$/.test(tag) &&
      Number.isSafeInteger(when) && when > (journal[index - 1]?.when ?? 0),
    "Invalid candidate journal entry");
    const sql = source(`drizzle/${tag}.sql`);
    return { tag, when, sql, hash: createHash("sha256").update(sql).digest("hex") };
  });
  check(migrations.at(-1).hash === HASH_0021, "Unexpected 0021 file hash");
  return migrations;
}

export function stagingDatabaseOptions(value) {
  let parsed;
  let password;
  try {
    parsed = new URL(value);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw new StageError("Invalid Staging database configuration");
  }
  const options = [...parsed.searchParams];
  check(
    ["postgres:", "postgresql:"].includes(parsed.protocol) &&
      parsed.hostname === DATABASE_HOST && (!parsed.port || parsed.port === "5432") &&
      parsed.pathname === `/${DATABASE_NAME}` && parsed.username === DATABASE_NAME &&
      password && !parsed.hash &&
      options.length === 1 &&
      ["require", "verify-full"].includes(parsed.searchParams.get("sslmode")),
    "Database endpoint, database, role or TLS options do not match approved Staging",
  );
  return {
    host: DATABASE_HOST, port: 5432, database: DATABASE_NAME, username: DATABASE_NAME,
    password, ssl: { rejectUnauthorized: true },
    max: 1, connect_timeout: 10, prepare: false, onnotice: () => {},
  };
}

export function ledgerState(rows, migrations) {
  check(rows.length === 21 || rows.length === 22, "Unexpected migration ledger length");
  check(rows.every((row, i) =>
    row.hash === migrations[i].hash && String(row.created_at) === String(migrations[i].when)),
  "Migration ledger differs from the pinned candidate journal");
  return rows.length === 21 ? "0021_pending" : "0021_applied";
}

async function readDatabase(tx, migrations, lockLedger = false) {
  const [identity] = await tx`
    select current_database() as database, current_user as role, session_user as login_role
  `;
  check(
    [identity.database, identity.role, identity.login_role].every((value) => value === DATABASE_NAME),
    "Connected database or session role is not approved Staging",
  );
  if (lockLedger) {
    await tx`lock table drizzle.__drizzle_migrations in share row exclusive mode`;
  }
  const rows = await tx`select hash, created_at from drizzle.__drizzle_migrations order by id`;
  const state = ledgerState(rows, migrations);
  const [schema] = await tx`
    select
      (select count(*)::int from information_schema.columns
        where table_schema = 'public' and table_name = 'product' and column_name = 'image_url') as image,
      (select count(*)::int from information_schema.columns
        where table_schema = 'public' and table_name = 'store_commerce_setting'
          and column_name = 'delivery_fee_configured') as fee,
      (select count(*)::int from pg_constraint
        where conrelid = 'public.product'::regclass
          and conname = 'product_image_url_check') as image_check,
      (select count(*)::int from information_schema.columns
        where table_schema = 'public' and (
          (table_name = 'product' and column_name = 'image_url'
            and data_type = 'text' and is_nullable = 'YES') or
          (table_name = 'store_commerce_setting' and column_name = 'delivery_fee_configured'
            and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false')
        )) as valid_columns,
      (select count(*)::int from pg_constraint
        where conrelid = 'public.product'::regclass
          and conname = 'product_image_url_check' and contype = 'c' and convalidated) as valid_check
  `;
  const expected = state === "0021_applied" ? 1 : 0;
  check(schema.image === expected && schema.fee === expected &&
    schema.image_check === expected && schema.valid_columns === 2 * expected &&
    schema.valid_check === expected,
    "Staging schema does not agree with its 0021 ledger");
  return state;
}

export async function databaseAction(db, migrations, migrate) {
  return db.begin(migrate ? "" : "isolation level repeatable read read only", async (tx) => {
    await tx`set local statement_timeout = '60s'`;
    await tx`set local lock_timeout = '5s'`;
    await tx`set local search_path = pg_catalog, public`;
    const state = await readDatabase(tx, migrations, migrate);
    if (!migrate) return state;
    check(state === "0021_pending", "Migration requires exactly 0021 pending");
    const entry = migrations.at(-1);
    for (const statement of entry.sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await tx.unsafe(statement);
    }
    await tx`
      insert into drizzle.__drizzle_migrations (hash, created_at)
      values (${entry.hash}, ${entry.when})
    `;
    check(await readDatabase(tx, migrations) === "0021_applied", "0021 ledger verification failed");
    const [backfill] = await tx`
      select exists (
        select 1 from public.store_commerce_setting
        where delivery_fee_configured is distinct from (delivery_fee > 0)
      ) as mismatch
    `;
    check(!backfill.mismatch, "0021 delivery fee backfill verification failed");
    return "0021_applied";
  });
}

export function renderClient(apiKey, request = fetch) {
  return async (method, path, body) => {
    const response = await request(`https://api.render.com/v1/services/${SERVICE_ID}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        ...(body && { "Content-Type": "application/json" }),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    check(response.ok, `Render ${method} returned HTTP ${response.status}`);
    return response.json();
  };
}

export function validateService(service) {
  check(service.id === SERVICE_ID && service.name === SERVICE_NAME &&
    service.type === "web_service" && service.suspended === "not_suspended" &&
    service.serviceDetails?.url === ORIGIN &&
    /^https:\/\/github\.com\/geekammar\/nokmel(?:\.git)?\/?$/.test(service.repo) &&
    (service.autoDeployTrigger ?? (service.autoDeploy === "no" ? "off" : "")) === "off",
  "Render service identity or deployment settings differ from approved Staging");
}

function commitOf(deploy) {
  return deploy.commit?.id ?? deploy.commitId;
}

async function renderVariable(render, key) {
  const payload = await render("GET", `/env-vars/${key}`);
  const variable = payload.envVar ?? payload;
  check(variable.key === key && typeof variable.value === "string",
    "Render did not return the expected Staging variable");
  return variable.value;
}

function validDeployId(id) {
  return typeof id === "string" && /^dep-[a-z0-9]+$/.test(id);
}

async function fetchHealth(request) {
  const response = await request(`${ORIGIN}/api/healthz`, {
    headers: { "Cache-Control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return;
  const health = await response.json();
  if (health.status === "ok") return health.sha;
}

async function readLiveBaseline(render, request) {
  const payload = await render("GET", "/deploys?limit=20");
  check(Array.isArray(payload), "Unexpected Staging deploy list");
  const deploys = payload.map((entry) => entry.deploy ?? entry);
  check(deploys.every((deploy) => TERMINAL.has(deploy.status)),
    "Staging already has a deployment in progress or an unknown status");
  const live = deploys.filter((deploy) => deploy.status === "live");
  check(live.length === 1 && validDeployId(live[0]?.id), "Expected one current Live Staging deploy");
  const current = live[0];
  if (commitOf(current) === CANDIDATE) {
    check(await fetchHealth(request) === CANDIDATE, "Existing Live candidate health SHA does not match");
  } else {
    check(current.id === PREVIOUS_DEPLOY && commitOf(current) === PREVIOUS_SHA &&
      await fetchHealth(request) === PREVIOUS_SHA, "Staging deploy or health baseline has changed");
  }
  return current;
}

export async function deployCandidate(render, request = fetch, pause = sleep, attempts = 90) {
  const current = await readLiveBaseline(render, request);
  if (commitOf(current) === CANDIDATE) return current.id;
  const labelPath = "/env-vars/RABET_BUILD_SHA";
  const label = await renderVariable(render, "RABET_BUILD_SHA");
  check([PREVIOUS_SHA, CANDIDATE].includes(label), "Staging build SHA label has changed");
  if (label !== CANDIDATE) {
    await render("PUT", labelPath, { value: CANDIDATE });
    check(await renderVariable(render, "RABET_BUILD_SHA") === CANDIDATE,
      "Staging build SHA label was not saved");
  }
  const created = await render("POST", "/deploys", { commitId: CANDIDATE });
  check(validDeployId(created?.id), "Render did not return a usable deployment ID");
  for (let i = 0; i < attempts; i++) {
    const deploy = await render("GET", `/deploys/${created.id}`);
    check(deploy.id === created.id && commitOf(deploy) === CANDIDATE,
      "Render deploy identity or commit differs from the pinned candidate");
    if (deploy.status === "live" && await fetchHealth(request).catch(() => undefined) === CANDIDATE) {
      return created.id;
    }
    check(deploy.status === "live" || !TERMINAL.has(deploy.status), "Render deploy ended before Live");
    await pause(15_000);
  }
  throw new StageError("Timed out waiting for Render Live and the full candidate health SHA");
}

async function main([mode, confirmation, ...extra]) {
  check(Object.hasOwn(CONFIRM, mode) && confirmation === CONFIRM[mode] && extra.length === 0,
    "Usage: inspect | migrate MIGRATE_BATCH01_0021_STAGING | deploy DEPLOY_BATCH01_STAGING");
  const apiKey = process.env.NOKMEL_STAGING_RENDER_API_KEY;
  check(apiKey, "NOKMEL_STAGING_RENDER_API_KEY is required");
  const migrations = candidateMigrations();
  const render = renderClient(apiKey);
  const service = await render("GET", "");
  validateService(service.service ?? service);
  const value = await renderVariable(render, "DATABASE_URL");
  const db = postgres(stagingDatabaseOptions(value));
  let state;
  try {
    state = await databaseAction(db, migrations, mode === "migrate");
  } finally {
    await db.end({ timeout: 5 });
  }
  if (mode === "deploy") {
    check(state === "0021_applied", "Apply and verify 0021 before deployment");
    const deployId = await deployCandidate(render);
    console.log(`Staging Live deploy ${deployId}; Render commit and health SHA ${CANDIDATE}`);
  } else if (mode === "inspect") {
    const live = await readLiveBaseline(render, fetch);
    console.log(`Staging inspect: ${state}; Live ${live.id} at ${commitOf(live)}; candidate ${CANDIDATE}`);
  } else {
    console.log(`Staging ${mode}: ${state}; candidate ${CANDIDATE}`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    // Driver/fetch errors can include connection strings or environment payloads.
    console.error(error instanceof StageError ? error.message : "Staging operation failed. Check the last approved operation before retrying.");
    process.exitCode = 1;
  });
}
