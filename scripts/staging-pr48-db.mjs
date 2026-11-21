#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import postgres from "postgres";

import {
  QUERIES,
  computeMigrationHashes,
  createPostgresSql,
  maskEndpoint,
  parsePgUrl,
  redact,
  verifyMigrationFiles,
} from "./setup-neon-dev.mjs";

const EXPECTED_DEV_HOST = "ep-tiny-star-b4dpybus.c-6.us-east-2.aws.neon.tech";
const EXPECTED_DEV_DB_NAME = "neondb";
const STAGING_DB_NAME = "rabet_staging_pr48";
const STAGING_DB_USER = "rabet_staging";
const STAGING_ENV_NAME = "staging-pr48";
const REVIEWED_SHA = "e484a2ec59cbc39d58265f3be485821779c8713a";
const CONFIRMATION = "PROVISION_STAGING_DB";
const MODES = new Set(["all", "provision", "migrate", "seed", "verify"]);

const mode = process.env.RABET_STAGING_MODE ?? "all";
const candidateSha = (process.env.RABET_CANDIDATE_SHA ?? "").trim().toLowerCase();
const codeRoot = path.resolve(process.env.RABET_CODE_ROOT ?? process.cwd());
const devUrl = process.env.NEON_DEV_DATABASE_URL ?? "";
const stagingPassword = process.env.STAGING_DB_PASSWORD ?? "";
const confirmation = process.env.RABET_CONFIRM ?? "";

function out(message) {
  process.stdout.write(`[staging-pr48] ${redact(String(message))}\n`);
}

function fail(message) {
  process.stderr.write(`[staging-pr48:FAIL] ${redact(String(message))}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function validateContext() {
  if (!MODES.has(mode)) fail(`Unknown mode "${mode}".`);
  if (mode !== "verify" && confirmation !== CONFIRMATION) {
    fail(`Confirmation must equal "${CONFIRMATION}".`);
  }
  if (candidateSha !== REVIEWED_SHA) {
    fail(`Candidate SHA must be the reviewed PR #48 head ${REVIEWED_SHA}.`);
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(STAGING_DB_NAME)) {
    fail("The staging database name is not a safe PostgreSQL identifier.");
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(STAGING_DB_USER)) {
    fail("The staging role name is not a safe PostgreSQL identifier.");
  }
  if (!devUrl) fail("NEON_DEV_DATABASE_URL is required.");
  if (!/^[a-f0-9]{48}$/.test(stagingPassword)) {
    fail("STAGING_DB_PASSWORD must be 48 lowercase hex characters.");
  }
  if (!fs.existsSync(path.join(codeRoot, "drizzle", "meta", "_journal.json"))) {
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

function buildStagingUrl(parsed) {
  const url = new URL(devUrl);
  url.username = STAGING_DB_USER;
  url.password = stagingPassword;
  url.pathname = `/${STAGING_DB_NAME}`;
  url.searchParams.set("sslmode", "require");
  return url.toString();
}

async function withDevSql(callback) {
  const sql = postgres(devUrl, {
    max: 1,
    connect_timeout: 30,
    idle_timeout: 30,
    ssl: "require",
  });

  try {
    return await callback(sql);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function assertStagingTarget(stagingUrl) {
  const sql = createPostgresSql(stagingUrl);

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
    await sql.close();
  }
}

async function writeHistorySummary(stagingUrl, expected) {
  const sql = createPostgresSql(stagingUrl);

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

    return rows.map((row, index) => ({
      tag: expected[index].tag,
      hash: String(row.hash),
      createdAt: String(row.created_at),
    }));
  } finally {
    await sql.close();
  }
}

async function provision() {
  const parsed = readDevTarget();
  const escapedPassword = stagingPassword.replace(/'/g, "''");

  await withDevSql(async (sql) => {
    const meta = (await sql`select current_database() as database`)[0];
    if (meta?.database !== EXPECTED_DEV_DB_NAME) {
      fail("Refusing to provision from an unexpected development database.");
    }

    const role = (await sql`select 1 as present from pg_roles where rolname = ${STAGING_DB_USER}`)[0];
    if (role) {
      await sql.unsafe(
        `alter role "${STAGING_DB_USER}" with login password '${escapedPassword}' ` +
          "nosuperuser nocreatedb nocreaterole noreplication",
      );
    } else {
      await sql.unsafe(
        `create role "${STAGING_DB_USER}" with login password '${escapedPassword}' ` +
          "nosuperuser nocreatedb nocreaterole noreplication",
      );
    }

    const database = (
      await sql`select 1 as present from pg_database where datname = ${STAGING_DB_NAME}`
    )[0];
    if (!database) {
      await sql.unsafe(`create database "${STAGING_DB_NAME}"`);
    }

    await sql.unsafe(`revoke all on database "${STAGING_DB_NAME}" from public`);
    await sql.unsafe(
      `grant connect, create, temporary on database "${STAGING_DB_NAME}" to "${STAGING_DB_USER}"`,
    );
    await sql
      .unsafe(
        `revoke connect on database "${EXPECTED_DEV_DB_NAME}" from "${STAGING_DB_USER}"`,
      )
      .catch(() => {});
  });

  const ownerUrl = new URL(devUrl);
  ownerUrl.pathname = `/${STAGING_DB_NAME}`;
  ownerUrl.searchParams.set("sslmode", "require");
  const ownerSql = postgres(ownerUrl.toString(), {
    max: 1,
    connect_timeout: 30,
    idle_timeout: 30,
    ssl: "require",
  });

  try {
    await ownerSql.unsafe(
      `grant create, usage on schema public to "${STAGING_DB_USER}"`,
    );
  } finally {
    await ownerSql.end({ timeout: 5 }).catch(() => {});
  }

  const stagingUrl = buildStagingUrl(parsed);
  await assertStagingTarget(stagingUrl);

  const bundle = {
    environment: STAGING_ENV_NAME,
    candidateSha,
    provider: "Neon",
    host: parsed.host,
    port: parsed.port || "5432",
    database: STAGING_DB_NAME,
    user: STAGING_DB_USER,
    databaseUrl: stagingUrl,
    provisionedAt: new Date().toISOString(),
  };

  fs.writeFileSync("/tmp/pr48-staging-bundle.json", `${JSON.stringify(bundle)}\n`, {
    mode: 0o600,
  });

  out(
    `provisioned ${maskEndpoint(parsed.host)}/${STAGING_DB_NAME} as ${STAGING_DB_USER}`,
  );
}

async function migrate() {
  const parsed = readDevTarget();
  const stagingUrl = buildStagingUrl(parsed);
  await assertStagingTarget(stagingUrl);

  const files = verifyMigrationFiles(codeRoot);
  if (!files.ok) fail(`Committed migration files are inconsistent: ${files.problems.join("; ")}`);

  const expected = computeMigrationHashes(codeRoot);
  if (expected.length === 0) fail("The candidate checkout has no committed migrations.");

  const result = spawnSync("npm", ["run", "db:migrate"], {
    cwd: codeRoot,
    env: { ...process.env, DATABASE_URL: stagingUrl },
    encoding: "utf8",
    timeout: 300_000,
  });

  if (result.status !== 0) {
    fail(`db:migrate exited ${result.status}: ${result.stderr || result.stdout}`);
  }

  out("db:migrate exited 0");

  const applied = await writeHistorySummary(stagingUrl, expected);
  out(`migration history: ${applied.length}/${expected.length} hashes match`);
  out(`migration tags: ${expected.map((entry) => entry.tag).join(", ")}`);

  return { applied, expected };
}

async function seed() {
  const parsed = readDevTarget();
  const stagingUrl = buildStagingUrl(parsed);
  await assertStagingTarget(stagingUrl);

  const existing = await (async () => {
    const sql = createPostgresSql(stagingUrl);

    try {
      return await sql.query(
        "select count(*)::int as count from public.store where slug like 'browser-store-%'",
      );
    } finally {
      await sql.close();
    }
  })();

  if (Number(existing[0]?.count ?? 0) > 0) {
    out("fixture store rows already exist; refusing to create duplicates");
    return { seeded: false };
  }

  const outputPath = "/tmp/pr48-merchant-fixture.json";
  const result = spawnSync(
    "npx",
    [
      "tsx",
      "--tsconfig",
      "scripts/tsconfig.seed.json",
      "scripts/merchant-browser-seed.ts",
    ],
    {
      cwd: codeRoot,
      env: {
        ...process.env,
        SEED_DATABASE_URL: stagingUrl,
        SEED_OUTPUT: outputPath,
      },
      encoding: "utf8",
      timeout: 300_000,
    },
  );

  if (result.status !== 0) {
    fail(`merchant fixture seed exited ${result.status}: ${result.stderr || result.stdout}`);
  }

  const fixture = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const summary = {
    environment: STAGING_ENV_NAME,
    candidateSha,
    hostMasked: maskEndpoint(parsed.host),
    database: STAGING_DB_NAME,
    user: STAGING_DB_USER,
    seededAt: new Date().toISOString(),
    stores: {
      a: { id: fixture.a.storeId, slug: fixture.a.storeSlug, name: fixture.a.storeName },
      b: { id: fixture.b.storeId, slug: fixture.b.storeSlug, name: fixture.b.storeName },
      empty: {
        id: fixture.empty.storeId,
        slug: fixture.empty.storeSlug,
        name: fixture.empty.storeName,
      },
      expired: { id: fixture.expired.invitationId },
      revoked: { id: fixture.revoked.invitationId },
      throttle: { id: fixture.throttle.invitationId },
      used: {
        id: fixture.used.invitationId,
        userId: fixture.used.userId,
        acceptedAt: fixture.used.acceptedAt,
      },
    },
    products: {
      a: fixture.a.products,
      b: fixture.b.products,
    },
  };

  fs.writeFileSync("/tmp/pr48-seed-summary.json", `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o644,
  });

  out("seeded A/B/empty/expired/revoked/throttle/used fixtures");
  return { seeded: true, fixture, summary };
}

async function verify() {
  const parsed = readDevTarget();
  const stagingUrl = buildStagingUrl(parsed);
  const target = await assertStagingTarget(stagingUrl);
  const expected = computeMigrationHashes(codeRoot);
  const applied = await writeHistorySummary(stagingUrl, expected);

  const sql = createPostgresSql(stagingUrl);
  let counts;
  try {
    counts = (
      await sql.query(
        [
          "select",
          " (select count(*) from public.store)::int as stores,",
          " (select count(*) from public.product)::int as products,",
          " (select count(*) from public.category)::int as categories,",
          " (select count(*) from public.store_membership)::int as memberships,",
          " (select count(*) from public.merchant_invitation)::int as invitations,",
          " (select count(*) from public.merchant_invitation where accepted_at is not null)::int as accepted_invitations,",
          " (select count(*) from public.merchant_invitation where revoked_at is not null)::int as revoked_invitations,",
          " (select count(*) from public.merchant_invitation where expires_at < now() and accepted_at is null and revoked_at is null)::int as expired_invitations",
        ].join("\n"),
      )
    )[0];
  } finally {
    await sql.close();
  }

  const summary = {
    environment: STAGING_ENV_NAME,
    candidateSha,
    hostMasked: maskEndpoint(parsed.host),
    database: STAGING_DB_NAME,
    user: STAGING_DB_USER,
    postgresVersion: String(target.version ?? "").split(" ").slice(0, 2).join(" "),
    migrations: {
      applied: applied.length,
      expected: expected.length,
      matches: applied.length === expected.length,
      tags: expected.map((entry) => entry.tag),
    },
    counts,
    verifiedAt: new Date().toISOString(),
  };

  fs.writeFileSync("/tmp/pr48-verify-summary.json", `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o644,
  });

  out(
    `verified ${maskEndpoint(parsed.host)}/${STAGING_DB_NAME}: ${applied.length}/${expected.length} migrations, ` +
      `${counts.stores} stores, ${counts.products} products, ${counts.categories} categories, ` +
      `${counts.memberships} memberships, ${counts.invitations} invitations`,
  );

  return summary;
}

async function main() {
  validateContext();

  if (mode === "provision") {
    await provision();
  } else if (mode === "migrate") {
    await migrate();
  } else if (mode === "seed") {
    await seed();
  } else if (mode === "verify") {
    await verify();
  } else {
    await provision();
    await migrate();
    await seed();
    await verify();
  }

  out("done");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
