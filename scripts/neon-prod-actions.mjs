#!/usr/bin/env node
/**
 * scripts/neon-prod-actions.mjs — the manual GitHub Actions runner for the
 * Rabet *production* database.
 *
 *   NEON_PROD_DATABASE_URL=... \
 *   NEON_PROD_EXPECTED_HOST=... \
 *   NEON_PROD_EXPECTED_DB_NAME=... \
 *   node scripts/neon-prod-actions.mjs
 *
 *   NEON_PROD_MODE=inspect     (default — strictly read-only)
 *   NEON_PROD_MODE=migrate     (requires NEON_PROD_MIGRATE_CONFIRM=MIGRATE_RABET_PROD)
 *
 * ===========================================================================
 * Why this exists
 * ===========================================================================
 *
 * Development VPS environments cannot reach Neon endpoints on TCP 5432,
 * but GitHub-hosted Actions runners can. This script provides a dedicated,
 * audited, and strictly bounded runner for inspecting and migrating the
 * Production database from GitHub Actions.
 *
 * It is deliberately NOT a second migration engine. It uses the reviewed
 * Drizzle migration chain (`npm run db:migrate`) and read-only inspection
 * queries. Nothing here regenerates SQL, runs `drizzle-kit push`, or attempts
 * automated drift repair.
 *
 * ===========================================================================
 * Target Protection & Trust Boundary
 * ===========================================================================
 *
 * Because no Production endpoint exists prior to owner provisioning, this
 * runner does NOT hard-code a fake production host or derive the target from
 * the connection secret. Instead:
 *
 * 1. Target settings (NEON_PROD_EXPECTED_HOST and NEON_PROD_EXPECTED_DB_NAME)
 *    must be explicitly configured non-secret variables in the Production
 *    GitHub Environment.
 * 2. The connection string (NEON_PROD_DATABASE_URL) is stored as a secret in
 *    the Production GitHub Environment.
 * 3. The runner refuses to connect if target settings are missing.
 * 4. The runner strictly validates the connection string before any network
 *    activity:
 *    - Validates PostgreSQL syntax and requires TLS (sslmode=require).
 *    - Rejects pooled endpoints (host containing "-pooler").
 *    - Explicitly rejects the known Rabet_dev endpoint
 *      (ep-tiny-star-b4dpybus.c-6.us-east-2.aws.neon.tech).
 *    - Rejects loopback, local, and arbitrary non-Neon hosts in production CLI.
 *    - Requires exact hostname match against NEON_PROD_EXPECTED_HOST.
 *    - Requires exact database name match against NEON_PROD_EXPECTED_DB_NAME.
 * 5. After connecting, the server is verified live:
 *    - current_database() must match expected database name.
 *    - Identity query failures fail closed immediately (never fall back to URL).
 *    - Read or permission failures during inspection fail closed immediately
 *      (never treated as an empty database).
 *    - Absence of migration ledger is handled explicitly and distinctly from
 *      failed queries.
 *
 * ===========================================================================
 * Modes
 * ===========================================================================
 *
 * inspect (default): Strictly read-only schema/identity/migration inspection.
 * migrate: Requires exact confirmation (MIGRATE_RABET_PROD), passes all gates,
 *          applies committed chain, and verifies real objects and hashes live.
 */

import { pathToFileURL } from "node:url";
import path from "node:path";
import postgres from "postgres";

import {
  CRITICAL_CONSTRAINTS,
  EXPECTED_INDEXES,
  EXPECTED_INDEXES_V1,
  EXPECTED_TABLES,
  EXPECTED_TABLES_V1,
  EXPECTED_TREE_FKS,
  QUERIES,
  buildChildEnv,
  buildRowCountQuery,
  classifyDbState,
  computeMigrationHashes,
  connectWithRetry,
  describeConnectionError,
  maskEndpoint,
  parsePgUrl,
  redact,
  runCommandReal,
  validateConnectionUrl,
  verifyMigrationFiles,
} from "./setup-neon-dev.mjs";

// ---------------------------------------------------------------------------
// Constants and Environment Variables
// ---------------------------------------------------------------------------

/**
 * The known development endpoint host of Rabet_dev. This runner strictly
 * refuses this host under all circumstances.
 */
export const KNOWN_DEV_HOST =
  "ep-tiny-star-b4dpybus.c-6.us-east-2.aws.neon.tech";

/** The phrase the workflow user must type to authorize migrate mode. */
export const MIGRATE_CONFIRMATION = "MIGRATE_RABET_PROD";

/** The environment variable carrying the direct Production database URL secret. */
export const PROD_URL_ENV = "NEON_PROD_DATABASE_URL";

/** The environment variable carrying the expected direct Production hostname. */
export const EXPECTED_HOST_ENV = "NEON_PROD_EXPECTED_HOST";

/** The environment variable carrying the expected Production database name. */
export const EXPECTED_DB_NAME_ENV = "NEON_PROD_EXPECTED_DB_NAME";

/** The environment variable carrying the requested mode. */
export const MODE_ENV = "NEON_PROD_MODE";

/** The environment variable carrying the migrate confirmation phrase. */
export const CONFIRM_ENV = "NEON_PROD_MIGRATE_CONFIRM";

const RUNNER = "rabet neon-prod-actions";

// ---------------------------------------------------------------------------
// Mode and Confirmation Validation
// ---------------------------------------------------------------------------

/**
 * Parses the requested mode. Default is `inspect` (read-only).
 */
export function parseMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();

  if (mode === "") return { ok: true, mode: "inspect" };

  if (mode === "inspect" || mode === "migrate") return { ok: true, mode };

  return {
    ok: false,
    mode: null,
    error: `Unknown mode "${mode}". Use "inspect" (read-only, default) or "migrate".`,
  };
}

/**
 * True only when the confirmation exactly matches MIGRATE_RABET_PROD (literal match, no trim).
 */
export function verifyConfirmation(value, expected = MIGRATE_CONFIRMATION) {
  return typeof value === "string" && value === expected;
}

// ---------------------------------------------------------------------------
// GitHub Context Validation
// ---------------------------------------------------------------------------

/**
 * Enforces workflow_dispatch and refs/heads/main when running on GitHub Actions.
 * When requireGithub is true, strictly refuses execution outside GitHub Actions.
 */
export function validateGithubContext(env, { requireGithub = false } = {}) {
  const problems = [];

  if (env.GITHUB_ACTIONS !== "true") {
    if (requireGithub) {
      problems.push(
        "This runner must execute within GitHub Actions. Local or manual CLI " +
          "execution outside GitHub Actions is refused.",
      );
      return { ok: false, problems, context: "outside-github" };
    }
    return { ok: true, problems: [], context: "local" };
  }

  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    problems.push(
      "This run is executing from a GitHub Actions event other than " +
        "workflow_dispatch. The Production migration workflow is manual by " +
        "design; it never runs on push, pull request or a schedule. Refusing " +
        "to continue.",
    );
  }

  if (env.GITHUB_REF !== "refs/heads/main") {
    problems.push(
      "This run is executing on a ref other than refs/heads/main " +
        `(${redact(String(env.GITHUB_REF ?? "unknown"))}). The Production ` +
        "migration workflow runs against reviewed code on main only. " +
        "Refusing to continue.",
    );
  }

  return { ok: problems.length === 0, problems, context: "github" };
}

// ---------------------------------------------------------------------------
// Host Classification
// ---------------------------------------------------------------------------

/**
 * Detects loopback, local, test, or invalid target hostnames.
 */
export function isLoopbackOrTestHost(host) {
  if (typeof host !== "string" || !host) return true;
  const h = host.toLowerCase().trim();
  if (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]" ||
    h === "0.0.0.0" ||
    /^127\.\d+\.\d+\.\d+$/.test(h) ||
    h.endsWith(".local") ||
    h.endsWith(".localhost") ||
    h.endsWith(".test") ||
    h.endsWith(".example") ||
    h.endsWith(".invalid")
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// TLS and Production Target Validation (Before Any Connection)
// ---------------------------------------------------------------------------

/**
 * Parses and strictly validates TLS parameters in a PostgreSQL connection string.
 * Requires exactly one sslmode=require and rejects invalid, duplicate, or conflicting settings.
 */
export function parseAndValidateTlsParams(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return {
      ok: false,
      error:
        "The connection string does not require TLS. Production connections " +
        "must explicitly specify ?sslmode=require in NEON_PROD_DATABASE_URL.",
    };
  }

  const queryStart = rawUrl.indexOf("?");
  if (queryStart === -1) {
    return {
      ok: false,
      error:
        "The connection string does not require TLS. Production connections " +
        "must explicitly specify ?sslmode=require in NEON_PROD_DATABASE_URL.",
    };
  }

  const queryString = rawUrl.slice(queryStart + 1);
  let params;
  try {
    params = new URLSearchParams(queryString);
  } catch {
    return {
      ok: false,
      error: "The connection string contains an invalid query string.",
    };
  }

  const sslmodes = params.getAll("sslmode");
  if (sslmodes.length === 0) {
    return {
      ok: false,
      error:
        "The connection string does not require TLS. Production connections " +
        "must explicitly specify ?sslmode=require in NEON_PROD_DATABASE_URL.",
    };
  }

  if (sslmodes.length > 1) {
    return {
      ok: false,
      error:
        `The connection string contains duplicate sslmode parameters (${sslmodes.length} occurrences). ` +
        "Production connections require exactly one sslmode=require.",
    };
  }

  const sslmode = sslmodes[0];
  if (sslmode !== "require") {
    return {
      ok: false,
      error:
        `The connection string specifies invalid sslmode "${sslmode}". ` +
        "Production connections must specify sslmode=require.",
    };
  }

  // Reject conflicting or disabled TLS settings
  const sslValues = params.getAll("ssl");
  for (const val of sslValues) {
    if (/^(false|0|disable|no|off)$/i.test(val)) {
      return {
        ok: false,
        error:
          `The connection string contains conflicting TLS setting ssl=${val}. ` +
          "Production connections must require TLS without conflicting settings.",
      };
    }
  }

  for (const [key, val] of params.entries()) {
    const k = key.toLowerCase();
    if (k === "sslmode") continue;
    if (k.includes("ssl") && /^(false|0|disable|no|off|prefer|allow)$/i.test(val)) {
      return {
        ok: false,
        error:
          `The connection string contains conflicting TLS setting ${key}=${val}. ` +
          "Production connections must require TLS without conflicting settings.",
      };
    }
  }

  return { ok: true, sslmode };
}

/**
 * Validates the Production connection string and enforces exact match with
 * configured non-secret target settings.
 */
export function validateProdUrl(
  rawUrl,
  { expectedHost, expectedDbName, allowTestTarget = false } = {},
) {
  const problems = [];

  // 1. Target settings must be explicitly configured
  const hostTrimmed = typeof expectedHost === "string" ? expectedHost.trim() : "";
  const dbTrimmed = typeof expectedDbName === "string" ? expectedDbName.trim() : "";

  if (!hostTrimmed) {
    problems.push(
      `Production target host setting (${EXPECTED_HOST_ENV}) is not configured. ` +
        "The Production migration runner requires an explicitly configured, " +
        "owner-approved direct hostname variable in the Production GitHub " +
        "Environment. Target settings are never derived from connection strings.",
    );
  }

  if (!dbTrimmed) {
    problems.push(
      `Production target database setting (${EXPECTED_DB_NAME_ENV}) is not configured. ` +
        "The Production migration runner requires an explicitly configured, " +
        "owner-approved database name variable in the Production GitHub " +
        "Environment.",
    );
  }

  // Reject configured target pointing to known DEV host
  if (hostTrimmed.toLowerCase() === KNOWN_DEV_HOST.toLowerCase()) {
    problems.push(
      `Configured ${EXPECTED_HOST_ENV} points at the known Rabet_dev endpoint ` +
        `("${KNOWN_DEV_HOST}"). The Production runner strictly refuses the ` +
        "development target.",
    );
  }

  if (!allowTestTarget && hostTrimmed) {
    if (isLoopbackOrTestHost(hostTrimmed)) {
      problems.push(
        `Configured ${EXPECTED_HOST_ENV} is a loopback or test host ("${hostTrimmed}"). ` +
          "Production runs refuse local or loopback targets.",
      );
    } else if (!hostTrimmed.toLowerCase().endsWith(".neon.tech")) {
      problems.push(
        `Configured ${EXPECTED_HOST_ENV} ("${hostTrimmed}") is not a valid Neon ` +
          "endpoint hostname. Expected host must end with .neon.tech.",
      );
    }
  }

  // 2. Validate URL presence and syntax
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    problems.push(
      `${PROD_URL_ENV} is not configured. Add it as a secret in the ` +
        "Production GitHub Environment.",
    );
    return { ok: false, url: null, problems, target: null };
  }

  // Reject missing, duplicate, invalid, or conflicting TLS settings in connection string
  if (!allowTestTarget) {
    const tlsCheck = parseAndValidateTlsParams(rawUrl);
    if (!tlsCheck.ok) {
      problems.push(tlsCheck.error);
    }
  }

  const urlValidation = validateConnectionUrl(rawUrl);
  if (!urlValidation.ok) {
    problems.push(urlValidation.error);
    return { ok: false, url: null, problems, target: null };
  }

  const url = urlValidation.url;
  const parsed = parsePgUrl(url);

  // Reject URL pointing to known DEV host
  if (parsed.host.toLowerCase() === KNOWN_DEV_HOST.toLowerCase()) {
    problems.push(
      `The connection string points at the known Rabet_dev endpoint ` +
        `("${KNOWN_DEV_HOST}"). This Production runner strictly refuses the ` +
        "development target.",
    );
  }

  // Reject pooled endpoints
  if (/-pooler/i.test(parsed.host)) {
    problems.push(
      "The connection string is Neon's POOLED endpoint (the host contains " +
        "\"-pooler\"). drizzle-kit migrate requires the DIRECT / unpooled " +
        "connection. In the Neon dashboard: Rabet_prod → Connection Details → " +
        "the \"Direct connection\" tab → copy that connection string into the " +
        `${PROD_URL_ENV} secret.`,
    );
  }

  // Reject loopback / arbitrary hosts in real CLI path
  if (!allowTestTarget) {
    if (isLoopbackOrTestHost(parsed.host)) {
      problems.push(
        `The connection string points at a loopback or test host ("${parsed.host}"). ` +
          "The Production runner strictly refuses local or loopback targets.",
      );
    } else if (!parsed.host.toLowerCase().endsWith(".neon.tech")) {
      problems.push(
        `The connection string host ("${parsed.host}") is not a valid Neon ` +
          "endpoint hostname. Production host must end with .neon.tech.",
      );
    }
  }

  // Exact target host match
  if (hostTrimmed && parsed.host.toLowerCase() !== hostTrimmed.toLowerCase()) {
    problems.push(
      "The connection string does not point at the approved Production endpoint. " +
        `Expected exactly "${hostTrimmed}", but the URL points at ` +
        `${maskEndpoint(parsed.host)}. This runner refuses any unapproved host.`,
    );
  }

  // Exact target database name match (case-sensitive)
  if (dbTrimmed && parsed.dbname !== dbTrimmed) {
    problems.push(
      "The connection string does not name the approved Production database. " +
        `Expected "${dbTrimmed}", but the URL names "${parsed.dbname}". This ` +
        "runner migrates the dedicated Production database only.",
    );
  }

  if (problems.length > 0) {
    return { ok: false, url: null, problems, target: null };
  }

  return {
    ok: true,
    url,
    problems: [],
    target: {
      host: maskEndpoint(parsed.host),
      dbname: parsed.dbname,
      user: parsed.user,
      tls: !allowTestTarget || parseAndValidateTlsParams(rawUrl).ok
        ? "required"
        : "not requested",
    },
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL Adapter with Finite Timeouts
// ---------------------------------------------------------------------------

/**
 * Creates a postgres.js client adapter with finite connection and statement timeouts.
 */
export function createProdPostgresSql(
  url,
  { connectTimeout = 30, statementTimeoutMs = 30000 } = {},
) {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: connectTimeout,
    idle_timeout: connectTimeout,
    connection: {
      statement_timeout: statementTimeoutMs,
    },
  });

  return {
    async query(text, params = []) {
      return params.length > 0
        ? sql.unsafe(text, params)
        : sql.unsafe(text);
    },

    async batch(statements, { readOnly = true } = {}) {
      const mode = readOnly ? "read only" : "";
      return sql.begin(mode, async (tx) => {
        const results = [];
        for (const statement of statements) {
          results.push(await tx.unsafe(statement));
        }
        return results;
      });
    },

    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

// ---------------------------------------------------------------------------
// Inspection (Read-Only)
// ---------------------------------------------------------------------------

/**
 * Inspects schema, ledger, and table counts on the live database.
 * Query failures fail closed and are never treated as empty.
 */
export async function inspectTarget(ctx) {
  const { sql } = ctx;

  // 1. Application tables (fail closed on error)
  const tableRows = await sql.query(QUERIES.appTables);
  const appTables = tableRows.map((row) => String(row.name));

  // 2. Migration ledger check: distinguish absent ledger from query failure
  const regclassRows = await sql.query(
    "SELECT to_regclass('drizzle.__drizzle_migrations') AS regclass",
  );
  const ledgerExists = Boolean(regclassRows[0]?.regclass);

  let appliedRows = [];
  if (ledgerExists) {
    appliedRows = await sql.query(QUERIES.drizzleMigrations);
  }

  // 3. Application row count check
  const countRows = await sql.query(buildRowCountQuery(appTables));
  const totalRows = Number(countRows[0]?.total ?? 0);

  // 4. Classify state
  let state = classifyDbState({
    appTables,
    appliedMigrations: appliedRows,
    committedHashes: ctx.committedHashes,
    journal: ctx.journal,
    totalRows,
  });

  // Explicit check: app tables exist with zero recorded migrations (whether ledger is absent or empty)
  if (appTables.length > 0 && state.appliedCount === 0) {
    const ledgerDetail = !ledgerExists
      ? "the Drizzle migration ledger (drizzle.__drizzle_migrations) does not exist"
      : "the Drizzle migration ledger (drizzle.__drizzle_migrations) contains 0 recorded migrations";
    state = {
      ...state,
      status: "drift",
      stopReason:
        `The database contains ${appTables.length} application table(s) ` +
        `(${appTables.join(", ")}), but ${ledgerDetail}. The runner refuses ` +
        "to run on an unmanaged schema.",
    };
  }

  return { appTables, ledgerExists, state, totalRows };
}

// ---------------------------------------------------------------------------
// Validation (Live Object & Hash Verification)
// ---------------------------------------------------------------------------

/**
 * Verifies real schema objects and migration hashes byte-for-byte on the live database.
 */
export async function validateTarget(ctx, options = {}) {
  const { sql } = ctx;
  const expectedTables = options.expectedTables ?? EXPECTED_TABLES;
  const expectedIndexes = options.expectedIndexes ?? EXPECTED_INDEXES;
  const expectedHashes = options.expectedHashes ?? ctx.committedHashes.map((entry) => entry.hash);
  const expectedConstraints = options.expectedConstraints ?? CRITICAL_CONSTRAINTS;
  const expectedTreeFks = options.expectedTreeFks ?? EXPECTED_TREE_FKS;

  // 1. Tables check
  try {
    const tableRows = await sql.query(QUERIES.appTables);
    const tables = tableRows.map((row) => String(row.name));
    const tableSet = new Set(tables);

    const missingTables = expectedTables.filter((name) => !tableSet.has(name));
    const unknownTables = tables.filter((name) => !expectedTables.includes(name));

    record(
      ctx,
      "tables",
      missingTables.length === 0 && unknownTables.length === 0,
      missingTables.length
        ? `missing ${missingTables.join(", ")}`
        : unknownTables.length
          ? `unexpected ${unknownTables.join(", ")}`
          : `${expectedTables.length}/${expectedTables.length}`,
    );
  } catch (error) {
    record(ctx, "tables", false, `query error: ${redact(String(error.message ?? error))}`);
  }

  // 2. Migration history byte-for-byte check
  try {
    const appliedRows = await sql.query(QUERIES.drizzleMigrations);
    const applied = (appliedRows ?? []).map((row) => String(row.hash));
    const historyOk =
      applied.length === expectedHashes.length &&
      expectedHashes.every((hash, index) => applied[index] === hash);

    record(
      ctx,
      "migration-history",
      historyOk,
      historyOk
        ? "matches the committed files byte for byte"
        : `${applied.length} applied / ${expectedHashes.length} expected`,
    );
  } catch (error) {
    record(ctx, "migration-history", false, `query error: ${redact(String(error.message ?? error))}`);
  }

  // 3. Indexes check
  try {
    const indexRows = await sql.query(QUERIES.indexes);
    const indexSet = new Set(indexRows.map((row) => String(row.name)));
    const missingIndexes = expectedIndexes.filter((name) => !indexSet.has(name));

    record(
      ctx,
      "indexes",
      missingIndexes.length === 0,
      missingIndexes.length
        ? `missing ${missingIndexes.join(", ")}`
        : `${expectedIndexes.length}/${expectedIndexes.length}`,
    );
  } catch (error) {
    record(ctx, "indexes", false, `query error: ${redact(String(error.message ?? error))}`);
  }

  // 4. Constraints check
  try {
    const constraintRows = await sql.query(QUERIES.constraints);
    const constraintSet = new Set(constraintRows.map((row) => String(row.name)));
    const missingConstraints = expectedConstraints.filter(
      (name) => !constraintSet.has(name),
    );

    record(
      ctx,
      "constraints",
      missingConstraints.length === 0,
      missingConstraints.length
        ? `missing ${missingConstraints.join(", ")}`
        : `${expectedConstraints.length}/${expectedConstraints.length}`,
    );
  } catch (error) {
    record(ctx, "constraints", false, `query error: ${redact(String(error.message ?? error))}`);
  }

  // 5. Recursive trees foreign keys check
  try {
    const treeRows = await sql.query(QUERIES.treeFks);
    const treeSet = new Set(treeRows.map((row) => String(row.name)));
    const trees = Object.entries(expectedTreeFks).map(([tree, fk]) => ({
      tree,
      ok: treeSet.has(fk),
    }));

    record(
      ctx,
      "recursive-trees",
      trees.every((entry) => entry.ok),
      trees.map((entry) => `${entry.tree} ${entry.ok ? "ok" : "MISSING"}`).join(", "),
    );
  } catch (error) {
    record(ctx, "recursive-trees", false, `query error: ${redact(String(error.message ?? error))}`);
  }

  // 6. Select 1 probe
  try {
    const one = await sql.query(QUERIES.selectOne);
    record(ctx, "select-1", Number(one[0]?.result) === 1);
  } catch (error) {
    record(ctx, "select-1", false, `query error: ${redact(String(error.message ?? error))}`);
  }

  // 7. Batch read-only transaction probe
  try {
    const batch = await sql.batch(
      [QUERIES.selectOne, QUERIES.currentDatabase],
      { readOnly: true },
    );
    const batchOk =
      Array.isArray(batch) &&
      batch.length === 2 &&
      Number(batch[0]?.[0]?.result) === 1 &&
      typeof batch[1]?.[0]?.name === "string";

    record(
      ctx,
      "batch-read-only",
      batchOk,
      batchOk ? "2 statements in one read-only transaction" : "batch format mismatch",
    );
  } catch (error) {
    record(ctx, "batch-read-only", false, redact(String(error.message ?? error)));
  }

  const failed = ctx.checks.filter((check) => !check.passed);

  for (const check of ctx.checks) {
    note(
      ctx,
      `${check.passed ? "PASS" : "FAIL"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`,
    );
  }

  return failed.length === 0;
}

// ---------------------------------------------------------------------------
// Redacted Output Surface
// ---------------------------------------------------------------------------

/**
 * Creates terminal IO with automatic redaction of credentials and URLs.
 */
export function createRealIo() {
  const output = [];

  const line = (text = "") => {
    const safe = redact(String(text));
    output.push(safe);
    process.stdout.write(`${safe}\n`);
  };

  return {
    output,
    line,
    note: (text = "") => line(`  ${text}`),
    header: (text = "") => line(`\n${text}`),
  };
}

function note(ctx, text) {
  ctx.io.note(text);
}

function record(ctx, name, passed, detail = "") {
  ctx.checks.push({ name, passed: Boolean(passed), detail });
}

function journalTags(ctx, count) {
  return ctx.journal.entries.slice(0, count).map((entry) => entry.tag);
}

// ---------------------------------------------------------------------------
// State Report Summary
// ---------------------------------------------------------------------------

function reportState(ctx, { appTables, state, totalRows }) {
  const statusLabel = {
    empty: "empty — no application tables",
    configured: "configured — the full chain is applied",
    partial: `${state.appliedCount} of ${state.journalCount} migrations applied`,
    inconsistent: "journal says complete, but tables are missing",
    drift: "does not match the committed chain",
  }[state.status];

  note(ctx, `Application tables: ${appTables.length} (${statusLabel})`);

  if (state.unknownTables.length > 0) {
    note(ctx, `  Unknown tables: ${state.unknownTables.join(", ")}`);
  }

  if (state.missingTables.length > 0 && state.status !== "empty") {
    note(ctx, `  Missing tables: ${state.missingTables.join(", ")}`);
  }

  note(
    ctx,
    `Drizzle migration history: ${state.appliedCount} recorded / ${state.journalCount} committed`,
  );

  if (state.pending.length > 0) {
    note(ctx, `Pending migrations: ${state.pending.join(", ")}`);
  } else {
    note(ctx, "Pending migrations: none");
  }

  note(ctx, `Application data rows: ${totalRows}`);
  note(
    ctx,
    `History check: ${state.appliedCount} recorded migration(s) must match ` +
      "committed sha256 byte-for-byte in chain order.",
  );
}

// ---------------------------------------------------------------------------
// Migration Failure Reporting
// ---------------------------------------------------------------------------

async function reportMigrationFailure(ctx, migration) {
  const { io } = ctx;

  let after = null;
  try {
    after = await inspectTarget(ctx);
    ctx.state = after.state;
  } catch {
    // If post-failure inspect fails, after remains null
  }

  io.line("");
  io.line(`FAIL npm run db:migrate exited with code ${migration.code}.`);

  const output = [migration.stdout, migration.stderr].filter(Boolean).join("\n").trim();
  if (output.length > 0) {
    io.line("  drizzle-kit output (last lines):");
    for (const line of output.split("\n").slice(-4)) {
      io.line(`    ${redact(line)}`);
    }
  }

  let reachable = true;
  try {
    await ctx.sql.query(QUERIES.selectOne);
  } catch (error) {
    reachable = false;
    io.line("");
    io.line(`FAIL ${describeConnectionError(error)}`);
  }

  io.line("");
  if (after && after.state.status === "empty" && after.state.appliedCount === 0) {
    if (reachable) {
      io.line("  Nothing was recorded and no tables were built. Database is empty.");
      io.line("  Verify user permissions and role grants on the Production database.");
    } else {
      io.line("  Connection failed during execution. Fix connectivity and retry.");
    }
  } else if (after) {
    io.line(`  Applied so far: ${after.state.appliedCount} of ${after.state.journalCount}.`);
    io.line("  Stopped — do NOT blindly retry migration writes. Inspect the database");
    io.line("  and verify the target state before deciding.");
  } else {
    io.line("  Could not inspect database state following migration failure.");
  }

  ctx.outcome = "failed";
  ctx.ok = false;
}

// ---------------------------------------------------------------------------
// Final Report
// ---------------------------------------------------------------------------

function finalize(ctx) {
  const { io } = ctx;
  const lines = [];

  lines.push("");
  lines.push("─".repeat(60));

  const title = {
    inspected: "Read-only inspection complete — target is consistent",
    migrated: "Production migration complete",
    "already-configured": "Production database is already configured",
    refused: "Refused — the target or the request is not approved",
    "not-configured": "Refused — secret or target setting is not configured",
    unreachable: "Could not connect — nothing was written",
    "manual-review": "Stopped for manual review",
    failed: "Did not complete",
  }[ctx.outcome] ?? "Finished";

  lines.push(`${RUNNER} — ${title}`);
  lines.push("─".repeat(60));

  if (ctx.target) {
    lines.push(`Target       ${ctx.target.dbName} (environment: PRODUCTION)`);
    lines.push(`Endpoint     ${ctx.target.endpoint}`);
    if (ctx.target.pgVersion) {
      lines.push(`PostgreSQL   ${ctx.target.pgVersion.split(",").slice(0, 1).join("")}`);
    }
  } else if (ctx.url) {
    const parsed = parsePgUrl(ctx.url);
    lines.push(`Target       ${parsed.dbname} (environment: PRODUCTION)`);
    lines.push(`Endpoint     ${maskEndpoint(parsed.host)}`);
  }

  if (ctx.state) {
    lines.push(
      `Migrations   ${ctx.state.appliedCount} applied / ${ctx.state.journalCount} committed`,
    );
    lines.push(`Tables       ${EXPECTED_TABLES.length} expected`);
  }

  if (ctx.writes.migrationsApplied.length > 0) {
    lines.push(`Applied      ${ctx.writes.migrationsApplied.join(", ")}`);
  }

  const failed = ctx.checks.filter((check) => !check.passed);
  lines.push(`Checks       ${ctx.checks.length - failed.length}/${ctx.checks.length} passed`);
  lines.push(`Mode         ${ctx.mode}`);

  lines.push("");
  if (ctx.mode === "inspect") {
    lines.push("Inspect mode performed read-only statements only; no DDL ran and no");
    lines.push("migration history was modified.");
  } else if (ctx.ok && ctx.outcome === "migrated") {
    lines.push("Migrations were successfully applied and verified live on the target.");
  } else if (ctx.ok && ctx.outcome === "already-configured") {
    lines.push("Database was already up to date; no writes were executed.");
  } else {
    lines.push("No changes were claimed unless confirmed above. Re-run with mode");
    lines.push("inspect to verify the current target state.");
  }

  if (failed.length > 0) {
    lines.push("");
    lines.push("Failed checks:");
    for (const check of failed) {
      lines.push(`  ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
    }
  }

  const report = lines.join("\n");
  io.line(report);

  return {
    ok: ctx.ok,
    outcome: ctx.outcome,
    mode: ctx.mode,
    target: ctx.target,
    state: ctx.state,
    checks: ctx.checks,
    writes: ctx.writes,
    report,
  };
}

// ---------------------------------------------------------------------------
// Main Runner
// ---------------------------------------------------------------------------

/**
 * Executes the requested Production action (inspect or migrate).
 */
export async function runProdActions({
  io,
  connect,
  runCommand,
  mode = "inspect",
  confirm = "",
  env = process.env,
  root = process.cwd(),
  expectedHost = env[EXPECTED_HOST_ENV],
  expectedDbName = env[EXPECTED_DB_NAME_ENV],
  allowTestTarget = false,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  requireGithubContext = false,
}) {
  const ctx = {
    io,
    connect,
    runCommand,
    mode,
    confirm,
    env,
    root,
    expectedHost,
    expectedDbName,
    allowTestTarget,
    sleep,
    sql: null,
    url: null,
    target: null,
    state: null,
    problems: [],
    checks: [],
    writes: { migrationsApplied: [] },
    outcome: null,
    ok: false,
  };

  const header = (text) => io.header(text);

  try {
    // ------------------------------------------------------------------
    // 1. Validate GitHub context & requested mode
    // ------------------------------------------------------------------
    header(`${RUNNER} — mode: ${mode}`);

    const github = validateGithubContext(env, { requireGithub: requireGithubContext });
    if (!github.ok) {
      for (const problem of github.problems) {
        io.line(`FAIL ${problem}`);
      }
      ctx.outcome = "refused";
      return finalize(ctx);
    }

    const parsedMode = parseMode(mode);
    if (!parsedMode.ok) {
      io.line(`FAIL ${parsedMode.error}`);
      ctx.outcome = "refused";
      return finalize(ctx);
    }

    ctx.mode = parsedMode.mode;

    if (ctx.mode === "migrate") {
      note(ctx, "Mode migrate: writes are allowed ONLY after every gate passes.");
    } else {
      note(ctx, "Mode inspect: strictly read-only. No DDL, no ledger writes.");
    }

    // ------------------------------------------------------------------
    // 2. Validate Production target & connection string
    // ------------------------------------------------------------------
    const rawUrl = env[PROD_URL_ENV];

    const prodTarget = validateProdUrl(rawUrl, {
      expectedHost: ctx.expectedHost,
      expectedDbName: ctx.expectedDbName,
      allowTestTarget: ctx.allowTestTarget,
    });

    if (!prodTarget.ok) {
      io.line("");
      for (const problem of prodTarget.problems) {
        io.line(`FAIL ${problem}`);
      }
      io.line("");
      io.line(
        "No connection was opened and nothing was modified. The target is " +
          "not an approved Production database.",
      );

      ctx.outcome =
        typeof rawUrl !== "string" || rawUrl.trim() === ""
          ? "not-configured"
          : "refused";
      return finalize(ctx);
    }

    ctx.url = prodTarget.url;

    note(ctx, `Endpoint      ${prodTarget.target.host}`);
    note(ctx, `Database      ${prodTarget.target.dbname}`);
    note(ctx, `Role          ${redact(prodTarget.target.user)}`);
    note(ctx, `TLS           ${prodTarget.target.tls}`);

    // Confirmation check before connecting
    if (ctx.mode === "migrate" && !verifyConfirmation(confirm)) {
      io.line("");
      io.line(
        `FAIL Migrate mode requires the exact confirmation phrase. Type ` +
          `${MIGRATE_CONFIRMATION} into the workflow's "confirm" input.`,
      );
      ctx.outcome = "refused";
      return finalize(ctx);
    }

    // ------------------------------------------------------------------
    // 3. Verify committed migration chain
    // ------------------------------------------------------------------
    const files = verifyMigrationFiles(root);
    if (!files.ok) {
      io.line("");
      for (const problem of files.problems) {
        io.line(`FAIL ${problem}`);
      }
      ctx.outcome = "refused";
      return finalize(ctx);
    }

    ctx.journal = files.journal;
    ctx.committedHashes = computeMigrationHashes(root);

    note(
      ctx,
      `Migrations    ${ctx.journal.entries.length} committed (${ctx.journal.entries
        .map((entry) => entry.tag)
        .join(", ")}) — journal + snapshots ok`,
    );

    // ------------------------------------------------------------------
    // 4. Connect with retry
    // ------------------------------------------------------------------
    header("Connecting to the Production database");

    const connection = await connectWithRetry(connect, ctx.url, {
      sleep,
      onRetry: ({ attempt, backoff }) => {
        note(
          ctx,
          `Connection attempt ${attempt} failed; retrying in ${Math.round(backoff / 100) / 10}s…`,
        );
      },
    });

    if (!connection.ok) {
      io.line("");
      io.line(`FAIL ${describeConnectionError(connection.error)}`);
      io.line("");
      io.line("No connection was established and nothing was modified.");
      ctx.outcome = "unreachable";
      return finalize(ctx);
    }

    ctx.sql = connection.sql;

    // ------------------------------------------------------------------
    // 5. Query identity live (Fail closed — NEVER fall back to URL target)
    // ------------------------------------------------------------------
    let dbNameRow, versionRow, userRow;
    try {
      [dbNameRow, versionRow, userRow] = await Promise.all([
        ctx.sql.query(QUERIES.currentDatabase),
        ctx.sql.query(QUERIES.pgVersion),
        ctx.sql.query(QUERIES.currentUser),
      ]);
    } catch (error) {
      io.line("");
      io.line(
        `FAIL Failed to query identity metadata from live connection: ${redact(
          String(error.message ?? error),
        )}`,
      );
      io.line(
        "  Refusing to fall back to the database name parsed from the URL. " +
          "Target identity must be proven live by the server.",
      );
      ctx.outcome = "failed";
      return finalize(ctx);
    }

    const liveDbName = dbNameRow[0]?.name ? String(dbNameRow[0].name) : null;
    if (!liveDbName) {
      io.line("");
      io.line("FAIL Live current_database() returned empty or null. Refusing to proceed.");
      ctx.outcome = "failed";
      return finalize(ctx);
    }

    const pgVersion = String(versionRow[0]?.version ?? "unknown");
    const liveRole = String(userRow[0]?.name ?? "unknown");

    ctx.target = {
      dbName: liveDbName,
      pgVersion,
      role: liveRole,
      endpoint: prodTarget.target.host,
      tls: prodTarget.target.tls,
    };

    io.line("  Connected. Target metadata (read-only):");
    note(ctx, `Database      ${liveDbName}`);
    note(ctx, `PostgreSQL    ${pgVersion.split(",").slice(0, 1).join("")}`);
    note(ctx, `Role          ${liveRole}`);
    note(ctx, `Endpoint      ${ctx.target.endpoint}`);
    note(ctx, `TLS           ${ctx.target.tls}`);

    // Compare live database identity to approved target setting (case-sensitive)
    if (liveDbName !== prodTarget.target.dbname) {
      io.line("");
      io.line(
        `FAIL The connected database is "${liveDbName}", not the approved ` +
          `Production database "${prodTarget.target.dbname}". Refusing to proceed; ` +
          "no write was attempted.",
      );
      ctx.outcome = "refused";
      return finalize(ctx);
    }

    record(ctx, "connection", true, `${github.context}, live identity verified`);

    // ------------------------------------------------------------------
    // 6. Inspect current database state (Fail closed on query errors)
    // ------------------------------------------------------------------
    header("Inspecting the Production database (read-only)");

    let inspected;
    try {
      inspected = await inspectTarget(ctx);
    } catch (error) {
      io.line("");
      io.line(`FAIL Database inspection query failed: ${redact(String(error.message ?? error))}`);
      io.line(
        "  A permission, network, or query error is NEVER treated as an empty " +
          "database or a ready target. Inspect credentials and permissions.",
      );
      ctx.outcome = "failed";
      return finalize(ctx);
    }

    ctx.state = inspected.state;
    reportState(ctx, inspected);
    record(ctx, "inspection", true);

    // Schema drift or inconsistent state stops execution in either mode
    if (inspected.state.status === "drift" || inspected.state.status === "inconsistent") {
      io.line("");
      io.line(`FAIL ${inspected.state.stopReason}`);
      io.line("");
      io.line(
        "  Stopped. This runner does NOT repair drift, drop tables, or guess " +
          "recovery paths. Inspect the target manually before proceeding.",
      );
      ctx.outcome = "manual-review";
      return finalize(ctx);
    }

    // Inspect mode
    if (ctx.mode === "inspect") {
      header("Read-only inspection complete");
      note(
        ctx,
        `Pending migrations: ${inspected.state.pending.length}${
          inspected.state.pending.length
            ? ` (${inspected.state.pending.join(", ")})`
            : ""
        }`,
      );
      note(ctx, `Application data rows: ${inspected.totalRows}`);

      // When inspect sees a complete migration ledger, verify critical live schema objects before reporting success
      if (inspected.state.pending.length === 0 && inspected.ledgerExists) {
        header("Validating live schema objects on complete target (read-only)");
        const validated = await validateTarget(ctx);
        if (!validated) {
          io.line("");
          io.line(
            "  FAIL Inspection validation checks failed. Target ledger indicates " +
              "complete migrations, but critical live schema objects are missing or invalid.",
          );
          ctx.outcome = "manual-review";
          ctx.ok = false;
          return finalize(ctx);
        }
      } else if (
        inspected.state.status === "partial" &&
        inspected.state.appliedCount === 2 &&
        inspected.state.pending.length === 1 &&
        inspected.state.pending[0] === "0002_payment_methods"
      ) {
        header("Validating prior release schema on target (read-only)");
        const validated = await validateTarget(ctx, {
          expectedTables: EXPECTED_TABLES_V1,
          expectedIndexes: EXPECTED_INDEXES_V1,
          expectedHashes: ctx.committedHashes.slice(0, 2).map((e) => e.hash),
        });
        if (!validated) {
          io.line("");
          io.line(
            "  FAIL Inspection validation checks failed. Target has 2 migrations recorded, " +
              "but live schema does not match the supported prior release (0001_tree_and_snapshot_integrity).",
          );
          ctx.outcome = "manual-review";
          ctx.ok = false;
          return finalize(ctx);
        }
      }

      io.line("");
      io.line(
        "  No DDL ran, no migration ledger was modified, and nothing was " +
          "written. To apply pending migrations, run with mode migrate and " +
          `confirmation ${MIGRATE_CONFIRMATION}.`,
      );

      ctx.outcome = "inspected";
      ctx.ok = true;
      return finalize(ctx);
    }

    // ------------------------------------------------------------------
    // 7. Migrate mode
    // ------------------------------------------------------------------
    header("Migrating the Production database");

    if (!verifyConfirmation(confirm)) {
      io.line(
        `FAIL The ${MIGRATE_CONFIRMATION} confirmation is missing at point of writing.`,
      );
      ctx.outcome = "refused";
      return finalize(ctx);
    }

    // Refuse partial, unmanaged, or ambiguous states before any write,
    // unless verified as a healthy supported prior release upgrade baseline.
    let isSupportedUpgrade = false;

    if (inspected.state.status === "partial") {
      const isKnownPriorRelease =
        inspected.state.appliedCount === 2 &&
        inspected.state.pending.length === 1 &&
        inspected.state.pending[0] === "0002_payment_methods";

      if (isKnownPriorRelease) {
        header("Verifying prior release schema before migration");
        const priorValid = await validateTarget(ctx, {
          expectedTables: EXPECTED_TABLES_V1,
          expectedIndexes: EXPECTED_INDEXES_V1,
          expectedHashes: ctx.committedHashes.slice(0, 2).map((e) => e.hash),
        });

        if (priorValid) {
          isSupportedUpgrade = true;
          note(
            ctx,
            "Verified healthy prior release (0001_tree_and_snapshot_integrity). " +
              "Proceeding with migration to 0002_payment_methods.",
          );
        } else {
          io.line("");
          io.line(
            `FAIL Database has ${inspected.state.appliedCount} of ${inspected.state.journalCount} ` +
              "migrations applied, but does not match the verified prior release schema. " +
              "Refusing to write to an unverified or damaged schema.",
          );
          ctx.outcome = "manual-review";
          return finalize(ctx);
        }
      } else {
        io.line("");
        io.line(
          `FAIL The database is in a partial migration state (${inspected.state.appliedCount} of ` +
            `${inspected.state.journalCount} migrations applied). Production migrations must ` +
            "start from a clean empty target, a verified prior release upgrade baseline, " +
            "or be an already-configured no-op. Refusing to write to a partially migrated database.",
        );
        ctx.outcome = "manual-review";
        return finalize(ctx);
      }
    }

    if (
      inspected.state.status !== "empty" &&
      inspected.state.status !== "configured" &&
      !isSupportedUpgrade
    ) {
      io.line("");
      io.line(
        `FAIL Database state is "${inspected.state.status}". Production migration refuses ` +
          "to write to an unmanaged, partial, or ambiguous schema.",
      );
      ctx.outcome = "manual-review";
      return finalize(ctx);
    }

    if (inspected.state.appliedCount > inspected.state.journalCount) {
      io.line(
        `FAIL Database records ${inspected.state.appliedCount} applied migrations, ` +
          `but repository has ${inspected.state.journalCount}. Refusing to write.`,
      );
      ctx.outcome = "manual-review";
      return finalize(ctx);
    }

    // Consistency check via drizzle-kit check (stop on any non-zero exit)
    const check = await runCommand({
      command: "npm",
      args: ["run", "db:check"],
      cwd: root,
      env: buildChildEnv(ctx.url, env),
      onOutput: (chunk) => process.stdout.write(redact(chunk)),
    });

    if (check.code === 0) {
      note(ctx, "drizzle-kit check: committed journal + snapshots are consistent");
      record(ctx, "migration-check", true);
    } else {
      const stderr = String(check.stderr ?? "");
      io.line("");
      io.line(`  FAIL drizzle-kit check reported a problem (exit code ${check.code}).`);
      for (const line of stderr.split("\n").filter(Boolean).slice(-3)) {
        io.line(`    ${line}`);
      }
      record(ctx, "migration-check", false, `exit code ${check.code}`);
      ctx.outcome = "manual-review";
      return finalize(ctx);
    }

    // Honest no-op when already configured
    if (inspected.state.pending.length === 0) {
      note(ctx, "The Production database is already configured.");
      note(ctx, "No migrations are pending. Validating live schema objects instead.");

      const validated = await validateTarget(ctx);
      if (!validated) {
        io.line("");
        io.line("  FAIL Validation checks failed after inspection.");
        ctx.outcome = "manual-review";
        return finalize(ctx);
      }

      record(ctx, "apply", true, "nothing pending (honest no-op)");
      ctx.outcome = "already-configured";
      ctx.ok = true;
      return finalize(ctx);
    }

    io.line("");
    io.line(`  Target:      ${ctx.target.dbName} (environment: PRODUCTION)`);
    io.line(`  Endpoint:    ${ctx.target.endpoint}`);
    io.line(`  Pending:     ${inspected.state.pending.length} migration(s)`);
    io.line("");

    const beforeTags = ctx.journal.entries
      .slice(0, inspected.state.appliedCount)
      .map((entry) => entry.tag);

    note(ctx, "Running npm run db:migrate with verified Production URL…");

    const migration = await runCommand({
      command: "npm",
      args: ["run", "db:migrate"],
      cwd: root,
      env: buildChildEnv(ctx.url, env),
      onOutput: (chunk) => process.stdout.write(redact(chunk)),
    });

    if (migration.code !== 0) {
      await reportMigrationFailure(ctx, migration);
      return finalize(ctx);
    }

    // Re-inspect live database
    let after;
    try {
      after = await inspectTarget(ctx);
      ctx.state = after.state;
      ctx.writes.migrationsApplied = journalTags(ctx, after.state.appliedCount).filter(
        (tag) => !beforeTags.includes(tag),
      );
    } catch (error) {
      io.line("");
      io.line(`FAIL Post-migration inspection failed: ${redact(String(error.message ?? error))}`);
      ctx.outcome = "manual-review";
      return finalize(ctx);
    }

    if (after.state.stopReason) {
      io.line("");
      io.line(`FAIL ${after.state.stopReason}`);
      io.line("  Stopped. The runner does not retry ambiguous partial results.");
      ctx.outcome = "manual-review";
      return finalize(ctx);
    }

    if (after.state.pending.length > 0) {
      io.line("");
      io.line(
        `FAIL Command exited 0 but ${after.state.pending.length} migration(s) ` +
          `remain pending: ${after.state.pending.join(", ")}.`,
      );
      ctx.outcome = "manual-review";
      return finalize(ctx);
    }

    note(ctx, `${after.state.appliedCount} migration(s) recorded in ledger ✓`);

    // Validate real database objects
    header("Validating the result on live database");
    const validated = await validateTarget(ctx);

    if (!validated) {
      io.line("");
      io.line("  FAIL One or more validation checks failed after migration.");
      ctx.outcome = "manual-review";
      return finalize(ctx);
    }

    record(ctx, "apply", true, ctx.writes.migrationsApplied.join(", "));
    ctx.outcome = "migrated";
    ctx.ok = true;
  } catch (error) {
    ctx.outcome = "failed";
    ctx.ok = false;
    io.line("");
    io.line(`FAIL Unexpected runner error: ${redact(String(error.message ?? error))}`);
  } finally {
    try {
      await ctx.sql?.close();
    } catch {
      // Best-effort close
    }
  }

  return finalize(ctx);
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

const HELP = [
  `${RUNNER} — manual runner for the Rabet Production database`,
  "",
  "Environment variables (configured in Production GitHub Environment):",
  `  ${PROD_URL_ENV}        Direct unpooled connection string (secret)`,
  `  ${EXPECTED_HOST_ENV}       Expected direct hostname (non-secret variable)`,
  `  ${EXPECTED_DB_NAME_ENV}    Expected database name (non-secret variable)`,
  `  ${MODE_ENV}                 "inspect" (default, read-only) or "migrate"`,
  `  ${CONFIRM_ENV}       Required for migrate mode: ${MIGRATE_CONFIRMATION}`,
  "",
  "Refuses pooled hosts, loopback targets, DEV endpoints, unapproved hosts,",
  "missing confirmations, and unexpected schema states. drizzle-kit push is",
  "never run.",
].join("\n");

export async function runCli() {
  const io = createRealIo();
  const env = process.env;

  if (env.RABET_ACTIONS_HELP === "1") {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }

  // Refuse execution outside intended GitHub Actions context before any DB connection
  const github = validateGithubContext(env, { requireGithub: true });
  if (!github.ok) {
    for (const problem of github.problems) {
      process.stderr.write(`FAIL ${problem}\n`);
    }
    process.exit(1);
  }

  const parsedMode = parseMode(env[MODE_ENV]);
  if (!parsedMode.ok) {
    process.stderr.write(`${parsedMode.error}\n\n${HELP}\n`);
    process.exit(2);
  }

  const result = await runProdActions({
    io,
    connect: (url) => createProdPostgresSql(url),
    runCommand: (opts) =>
      runCommandReal({ ...opts, onOutput: (chunk) => process.stdout.write(chunk) }),
    mode: parsedMode.mode,
    confirm: typeof env[CONFIRM_ENV] === "string" ? env[CONFIRM_ENV] : "",
    env,
    root: process.cwd(),
    allowTestTarget: false, // Strict: CLI path never allows loopback or test bypass
    requireGithubContext: true,
  });

  process.exit(result.ok ? 0 : 1);
}

const isCli = import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href;

if (isCli) {
  runCli().catch((error) => {
    process.stderr.write(
      `${RUNNER}: ${redact(String(error.stack ?? error.message ?? error))}\n`,
    );
    process.exit(1);
  });
}
