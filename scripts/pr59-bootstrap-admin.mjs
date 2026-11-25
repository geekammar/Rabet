#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { parseOptions } from "@node-rs/argon2";

const RENDER_API_KEY = process.env.RENDER_API_KEY ?? "";
const ADMIN_HASH = process.env.PR59_QA_PLATFORM_ADMIN_PASSWORD_HASH ?? "";
const SERVICE_ID = "srv-dc3jiiff3r2c738okfsg";
const EXPECTED_HOST = "ep-tiny-star-b4dpybus.c-6.us-east-2.aws.neon.tech";
const EXPECTED_DB = "rabet_buyer_lang_qa_pr59";
const ADMIN_EMAIL = "pr59.qa.admin@example.test";
const SUMMARY_PATH = process.env.SUMMARY_OUT ?? "/tmp/pr59-admin/summary.json";

function fail(message) {
  process.stderr.write(`[pr59-admin:FAIL] ${message}\n`);
  process.exit(1);
}

function validateHash(value) {
  if (typeof value !== "string") return false;
  const hash = value.trim();
  if (hash.length < 20 || hash.length > 1024) return false;
  if (!/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(hash)) {
    return false;
  }
  try {
    const parsed = parseOptions(hash);
    return (
      parsed.algorithm === 2 &&
      parsed.version === 1 &&
      parsed.memoryCost === 19456 &&
      parsed.timeCost === 2 &&
      parsed.parallelism === 1 &&
      parsed.saltLen === 16 &&
      parsed.outputLen === 32
    );
  } catch {
    return false;
  }
}

async function readDatabaseUrl() {
  const response = await fetch(
    `https://api.render.com/v1/services/${SERVICE_ID}/env-vars?limit=100`,
    {
      headers: {
        Authorization: `Bearer ${RENDER_API_KEY}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`Render env read failed HTTP ${response.status}`);
  const payload = JSON.parse(text);
  const rows = Array.isArray(payload) ? payload : payload?.envVars ?? [];
  for (const entry of rows) {
    const row = entry?.envVar ?? entry;
    if (row?.key === "DATABASE_URL" && typeof row.value === "string") return row.value;
  }
  throw new Error("PR59 QA DATABASE_URL is missing");
}

async function main() {
  if (!RENDER_API_KEY) fail("RENDER_API_KEY is missing");
  if (!validateHash(ADMIN_HASH)) fail("The QA admin password hash is missing or invalid");

  const databaseUrl = await readDatabaseUrl();
  const parsed = new URL(databaseUrl);
  if (parsed.hostname !== EXPECTED_HOST) fail("QA database host does not match the approved host");
  if (parsed.pathname.replace(/^\//, "") !== EXPECTED_DB) fail("QA database name does not match the approved database");

  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 30,
    idle_timeout: 30,
    connection: { statement_timeout: 30_000 },
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    serviceId: SERVICE_ID,
    database: EXPECTED_DB,
    host: parsed.hostname,
    adminEmail: ADMIN_EMAIL,
    outcome: null,
    userId: null,
  };

  try {
    const [identity] = await sql`
      select current_database() as database, current_user as role
    `;
    if (identity?.database !== EXPECTED_DB) fail("Live database identity does not match");

    const result = await sql.begin(async (tx) => {
      await tx`
        select pg_advisory_xact_lock(
          hashtextextended(${`pr59-qa-platform-admin:${ADMIN_EMAIL}`}, 0)
        )
      `;
      const existing = await tx`
        select id, email, status, platform_role, session_version
        from app_user
        where lower(email) = ${ADMIN_EMAIL}
        limit 1
        for update
      `;

      if (existing.length === 0) {
        const [created] = await tx`
          insert into app_user (email, status, platform_role)
          values (${ADMIN_EMAIL}, 'active', 'super_admin')
          returning id, email, session_version
        `;
        await tx`
          insert into merchant_credential (user_id, password_hash)
          values (${created.id}, ${ADMIN_HASH})
        `;
        return { outcome: "created", userId: created.id, email: created.email };
      }

      const account = existing[0];
      if (account.platform_role !== "super_admin") {
        throw new Error("An existing account with this email is not a Super Admin");
      }
      if (account.status !== "active") {
        throw new Error("The existing QA Super Admin is not active");
      }
      const [credential] = await tx`
        select password_hash from merchant_credential
        where user_id = ${account.id}
        limit 1
      `;
      if (!credential) {
        await tx`
          insert into merchant_credential (user_id, password_hash)
          values (${account.id}, ${ADMIN_HASH})
        `;
        return { outcome: "credential_added", userId: account.id, email: account.email };
      }
      if (credential.password_hash !== ADMIN_HASH) {
        throw new Error("The existing QA Super Admin credential differs from the supplied hash");
      }
      return { outcome: "already_provisioned", userId: account.id, email: account.email };
    });

    summary.outcome = result.outcome;
    summary.userId = result.userId;

    const [counts] = await sql`
      select
        (select count(*)::int from app_user where platform_role = 'super_admin' and status = 'active') as active_super_admins,
        (select count(*)::int from store) as stores,
        (select count(*)::int from "order") as orders,
        (select count(*)::int from inventory_reservation) as reservations,
        (select count(*)::int from cart) as carts
    `;
    summary.counts = counts;

    fs.mkdirSync(path.dirname(SUMMARY_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
