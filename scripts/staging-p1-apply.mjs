#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";

import postgres from "postgres";

import {
  QUERIES,
  computeMigrationHashes,
  maskEndpoint,
  parsePgUrl,
  redact,
  verifyMigrationFiles,
} from "./setup-neon-dev.mjs";

const EXPECTED_DEV_HOST = "ep-tiny-star-b4dpybus.c-6.us-east-2.aws.neon.tech";
const EXPECTED_DEV_DB_NAME = "neondb";
const STAGING_DB_NAME = "rabet_staging_pr48";
const STAGING_DB_USER = "rabet_staging";
const CONFIRMATION = "MIGRATE_STAGING_P1";

const candidateSha = (process.env.RABET_CANDIDATE_SHA ?? "").trim().toLowerCase();
const devUrl = process.env.NEON_DEV_DATABASE_URL ?? "";
const stagingPassword = process.env.STAGING_DB_PASSWORD ?? "";
const platformAdminEmail = (process.env.PLATFORM_ADMIN_EMAIL ?? "").trim();
const platformAdminPasswordHash = (process.env.PLATFORM_ADMIN_PASSWORD_HASH ?? "").trim();
const confirmation = process.env.RABET_CONFIRM ?? "";

function out(message) {
  process.stdout.write(`[p1-staging] ${redact(String(message))}\n`);
}

function fail(message) {
  process.stderr.write(`[p1-staging:FAIL] ${redact(String(message))}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function validateContext() {
  if (!/^[a-f0-9]{40}$/.test(candidateSha)) {
    fail("RABET_CANDIDATE_SHA must be a full 40-character lowercase SHA.");
  }
  if (confirmation !== CONFIRMATION) {
    fail(`Confirmation must equal "${CONFIRMATION}".`);
  }
  if (!devUrl) fail("NEON_DEV_DATABASE_URL is required.");
  if (!/^[a-f0-9]{48}$/.test(stagingPassword)) {
    fail("STAGING_DB_PASSWORD must be 48 lowercase hex characters.");
  }
  if (!/^[^@\s]+@[^@\s]+$/.test(platformAdminEmail)) {
    fail("PLATFORM_ADMIN_EMAIL must be a valid email address.");
  }
  if (!platformAdminPasswordHash.startsWith("$argon2id$")) {
    fail("PLATFORM_ADMIN_PASSWORD_HASH must be an Argon2id PHC string.");
  }
  if (!fs.existsSync("drizzle/meta/_journal.json")) {
    fail("The candidate checkout has no drizzle/meta/_journal.json.");
  }
}

function readDevTarget() {
  const parsed = parsePgUrl(devUrl);

  if (!parsed.ok) fail(parsed.error);
  if (/-pooler/i.test(parsed.host)) {
    fail("The development connection is pooled; a direct endpoint is required.");
  }
  if (parsed.host.toLowerCase() !== EXPECTED_DEV_HOST) {
    fail("NEON_DEV_DATABASE_URL does not point at the pinned development endpoint.");
  }
  if (parsed.dbname !== EXPECTED_DEV_DB_NAME) {
    fail("NEON_DEV_DATABASE_URL does not point at the pinned development database.");
  }
  if (!parsed.password) {
    fail("NEON_DEV_DATABASE_URL does not contain a password.");
  }

  return parsed;
}

function buildStagingUrl() {
  const url = new URL(devUrl);
  url.username = STAGING_DB_USER;
  url.password = stagingPassword;
  url.pathname = `/${STAGING_DB_NAME}`;
  url.searchParams.set("sslmode", "require");
  return url.toString();
}

async function assertStagingTarget(stagingUrl) {
  const sql = postgres(stagingUrl, {
    max: 1,
    connect_timeout: 30,
    idle_timeout: 30,
    ssl: "require",
  });

  try {
    const rows = await sql.query(
      "select current_database() as database, current_user as role, version() as version",
    );
    const row = rows[0];

    if (row?.database !== STAGING_DB_NAME) {
      fail(`Connected database "${row?.database}" is not the staging database.`);
    }
    if (row?.role !== STAGING_DB_USER) {
      fail(`Connected role "${row?.role}" is not the staging role.`);
    }

    return row;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function verifyMigrationHistory(stagingUrl) {
  const files = verifyMigrationFiles(process.cwd());
  if (!files.ok) {
    fail(`Committed migration files are inconsistent: ${files.problems.join("; ")}`);
  }

  const expected = computeMigrationHashes(process.cwd());
  if (expected.length === 0) {
    fail("The candidate checkout has no committed migrations.");
  }

  const sql = postgres(stagingUrl, {
    max: 1,
    connect_timeout: 30,
    idle_timeout: 30,
    ssl: "require",
  });

  try {
    const rows = await sql.query(QUERIES.drizzleMigrations);

    if (rows.length !== expected.length) {
      fail(
        `Migration history has ${rows.length} row(s); the candidate journal has ${expected.length}.`,
      );
    }

    for (let index = 0; index < expected.length; index += 1) {
      const row = rows[index];
      const entry = expected[index];

      if (String(row?.hash ?? "") !== entry.hash) {
        fail(`Migration hash mismatch at ${entry.tag}.`);
      }
      if (BigInt(String(row?.created_at ?? "")) !== BigInt(entry.when)) {
        fail(`Migration journal timestamp mismatch at ${entry.tag}.`);
      }
    }

    return {
      count: rows.length,
      tags: expected.map((entry) => entry.tag),
      hashes: expected.map((entry) => ({ tag: entry.tag, hash: entry.hash })),
    };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function main() {
  validateContext();

  const parsed = readDevTarget();
  const stagingUrl = buildStagingUrl();

  const target = await assertStagingTarget(stagingUrl);
  out(`target verified: ${maskEndpoint(parsed.host)}/${STAGING_DB_NAME} as ${STAGING_DB_USER}`);

  const migrated = spawnSync("npm", ["run", "db:migrate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: stagingUrl },
    encoding: "utf8",
    timeout: 300_000,
  });

  if (migrated.status !== 0) {
    fail(`db:migrate exited ${migrated.status}: ${migrated.stderr || migrated.stdout}`);
  }

  out("db:migrate exited 0");

  const history = await verifyMigrationHistory(stagingUrl);
  out(`migration history: ${history.count}/${history.tags.length} hashes match`);

  const seedOutputPath = "/tmp/p1-platform-admin-summary.json";
  const seeded = spawnSync(
    "npx",
    [
      "tsx",
      "--tsconfig",
      "scripts/tsconfig.seed.json",
      "scripts/staging-p1-platform-admin-seed.ts",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SEED_DATABASE_URL: stagingUrl,
        PLATFORM_ADMIN_EMAIL: platformAdminEmail,
        PLATFORM_ADMIN_PASSWORD_HASH: platformAdminPasswordHash,
        SEED_OUTPUT: seedOutputPath,
      },
      encoding: "utf8",
      timeout: 300_000,
    },
  );

  if (seeded.status !== 0) {
    fail(`platform admin seed exited ${seeded.status}: ${seeded.stderr || seeded.stdout}`);
  }

  const seedSummary = JSON.parse(fs.readFileSync(seedOutputPath, "utf8"));
  const summary = {
    environment: "staging-p1",
    candidateSha,
    hostMasked: maskEndpoint(parsed.host),
    database: STAGING_DB_NAME,
    user: STAGING_DB_USER,
    postgresVersion: String(target.version ?? "").split(" ").slice(0, 2).join(" "),
    migrations: {
      count: history.count,
      tags: history.tags,
    },
    platformAdmin: seedSummary,
    completedAt: new Date().toISOString(),
  };

  fs.writeFileSync("/tmp/p1-staging-summary.json", `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o644,
  });

  fs.rmSync(seedOutputPath, { force: true });

  out(`platform admin provisioned: ${seedSummary.email} (${seedSummary.userId})`);
  out("staging summary written");
}

main().catch((error) => {
  process.stderr.write(`[p1-staging:FAIL] ${redact(String(error?.message ?? error))}\n`);
  process.exitCode = 1;
});
