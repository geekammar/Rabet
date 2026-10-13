#!/usr/bin/env node
/**
 * scripts/neon-dev-actions.mjs — the manual GitHub Actions runner for the
 * Rabet *development* database.
 *
 *   NEON_DEV_DATABASE_URL=... node scripts/neon-dev-actions.mjs
 *   NEON_DEV_MODE=inspect     (default — strictly read-only)
 *   NEON_DEV_MODE=migrate     (requires NEON_DEV_MIGRATE_CONFIRM=MIGRATE_RABET_DEV)
 *
 * ===========================================================================
 * Why this exists
 * ===========================================================================
 *
 * The development VPS cannot reach the Neon `Rabet_dev` endpoint on TCP 5432,
 * but GitHub-hosted Actions runners can. This script lets the owner run
 * development migrations from GitHub Actions instead of from the VPS, while
 * keeping the VPS for coding.
 *
 * It is deliberately NOT a second migration engine. It is a thin, non-
 * interactive wrapper around the same tested functions the interactive wizard
 * (`scripts/setup-neon-dev.mjs`, `npm run db:setup:dev`) uses: the same URL
 * parsing and TLS enforcement, the same read-only inspection SQL, the same
 * byte-for-byte migration-history comparison, the same sanitized child-process
 * environment, and the same `npm run db:migrate` command. Nothing here
 * regenerates SQL, runs `drizzle-kit push`, or repairs drift.
 *
 * ===========================================================================
 * What it never does
 * ===========================================================================
 *
 * Never touches a production database: the endpoint host and the database name
 * are pinned to the committed development identity and anything else is
 * refused before a connection is opened. Never accepts a pooled endpoint.
 * Never accepts a connection string that disables TLS. Never reads the URL
 * from the command line or a workflow input — only from the
 * `NEON_DEV_DATABASE_URL` environment variable. Never prints a connection
 * string or a password: every line is filtered, and subprocess output is
 * filtered too. Never runs without the explicit `MIGRATE_RABET_DEV`
 * confirmation in migrate mode. Never runs from a GitHub event other than
 * `workflow_dispatch`, nor from a ref other than `refs/heads/main`. Never
 * trusts an exit code alone — the database is re-inspected after migrating.
 *
 * ===========================================================================
 * Where the secret lives
 * ===========================================================================
 *
 * `NEON_DEV_DATABASE_URL` is a GitHub Actions secret. Prefer a GitHub
 * *environment* secret in the `neon-dev` environment (deployment branches
 * restricted to `main`, and a required reviewer if the owner wants one); the
 * workflow passes the environment name as an input. On a plan without
 * environments, use a repository Actions secret instead — the runtime gates
 * below apply identically either way. See docs/NEON_DEV_SETUP.md §15.1.
 */

import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  CRITICAL_CONSTRAINTS,
  EXPECTED_INDEXES,
  EXPECTED_TABLES,
  EXPECTED_TREE_FKS,
  QUERIES,
  buildChildEnv,
  buildRowCountQuery,
  classifyDbState,
  computeMigrationHashes,
  connectWithRetry,
  createPostgresSql,
  describeConnectionError,
  maskEndpoint,
  parsePgUrl,
  redact,
  runCommandReal,
  validateConnectionUrl,
  verifyMigrationFiles,
} from "./setup-neon-dev.mjs";

// ---------------------------------------------------------------------------
// The pinned development identity.
//
// Both values are committed and reviewed: a change to the development endpoint
// or database name is a deliberate code change with a review, never a runtime
// override. This is what "fail closed when the endpoint changes" means — the
// runner refuses the new host until these constants are updated on main.
// ---------------------------------------------------------------------------

/**
 * The exact Neon endpoint host of the `Rabet_dev` project's **direct /
 * unpooled** connection. Any other host — Neon's pooled endpoint, another
 * project, a production endpoint, a loopback address — is refused.
 */
export const EXPECTED_DEV_HOST =
  "ep-tiny-star-b4dpybus.c-6.us-east-2.aws.neon.tech";

/**
 * The exact database name on that endpoint. The Neon project's *display* name
 * is `Rabet_dev` and its branch is `Development`, but the SQL database inside
 * it is named `neondb` — a project display name is not a database name, and
 * confusing the two is exactly how a wrong target gets approved. This constant
 * is the database identity the runner requires, and it is the development
 * database only — never a production-named database.
 */
export const EXPECTED_DEV_DB_NAME = "neondb";

/** The phrase the workflow user must type to authorize migrate mode. */
export const MIGRATE_CONFIRMATION = "MIGRATE_RABET_DEV";

/** The only environment variable the URL is ever read from. */
export const DEV_URL_ENV = "NEON_DEV_DATABASE_URL";

/** The environment variable carrying the requested mode. */
export const MODE_ENV = "NEON_DEV_MODE";

/** The environment variable carrying the migrate confirmation. */
export const CONFIRM_ENV = "NEON_DEV_MIGRATE_CONFIRM";

const RUNNER = "rabet neon-dev-actions";

// ---------------------------------------------------------------------------
// Mode and confirmation
// ---------------------------------------------------------------------------

/**
 * Parses the requested mode. An unset value means `inspect` — the safe default
 * — and anything else must be one of the two known modes.
 */
export function parseMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();

  if (mode === "") return { ok: true, mode: "inspect" };

  if (mode === "inspect" || mode === "migrate") return { ok: true, mode };

  return {
    ok: false,
    mode: null,
    error: `Unknown mode "${mode}". Use "inspect" (read-only, the default) or "migrate".`,
  };
}

/**
 * True only when the confirmation is exactly the expected phrase. Migrate mode
 * is refused without it, before any connection is opened.
 */
export function verifyConfirmation(value, expected = MIGRATE_CONFIRMATION) {
  return typeof value === "string" && value.trim() === expected;
}

// ---------------------------------------------------------------------------
// GitHub context — the workflow's own restrictions, re-checked in code
// ---------------------------------------------------------------------------

/**
 * When running on GitHub Actions, requires the `workflow_dispatch` event and
 * the `main` ref. Both are already enforced by the workflow file's trigger and
 * by `workflow_dispatch` only running from the default branch; checking them
 * here too means a future trigger edit cannot silently widen execution.
 *
 * Off GitHub (a local manual run) there is nothing to enforce — the workflow's
 * branch and trigger restrictions do not apply to a laptop.
 */
export function validateGithubContext(env) {
  if (env.GITHUB_ACTIONS !== "true") {
    return { ok: true, problems: [], context: "local" };
  }

  const problems = [];

  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    problems.push(
      "This run is executing from a GitHub Actions event other than " +
        "workflow_dispatch. The development migration workflow is manual by " +
        "design; it never runs on push, pull request or a schedule. Refusing " +
        "to continue.",
    );
  }

  if (env.GITHUB_REF !== "refs/heads/main") {
    problems.push(
      "This run is executing on a ref other than refs/heads/main " +
        `(${redact(String(env.GITHUB_REF ?? "unknown"))}). The development ` +
        "migration workflow runs against the code on main only, so the " +
        "applied migrations always match a reviewed revision. Refusing to " +
        "continue.",
    );
  }

  return { ok: problems.length === 0, problems, context: "github" };
}

// ---------------------------------------------------------------------------
// Target validation — happens before any network connection
// ---------------------------------------------------------------------------

/**
 * Validates the development connection string and pins it to the approved
 * development target.
 *
 * Reuses the wizard's `validateConnectionUrl` (syntax and TLS enforcement) and
 * layers the exact-identity checks on top: the host must be the committed
 * development endpoint, it must not be Neon's pooled endpoint, and the
 * database name must be the committed development database. Everything is
 * reported with masked values only.
 */
export function validateDevUrl(
  rawUrl,
  { expectedHost = EXPECTED_DEV_HOST, expectedDbName = EXPECTED_DEV_DB_NAME } = {},
) {
  const validation = validateConnectionUrl(rawUrl);

  if (!validation.ok) {
    return { ok: false, url: null, problems: [validation.error], target: null };
  }

  const url = validation.url;
  const parsed = parsePgUrl(url);
  const problems = [];

  // Any host other than the pinned development endpoint is refused. This is
  // the single check that keeps a production endpoint, another project, or a
  // pooled endpoint out of the runner.
  if (parsed.host.toLowerCase() !== expectedHost.toLowerCase()) {
    problems.push(
      `The connection string does not point at the approved Rabet development ` +
        `endpoint. Expected exactly "${expectedHost}", but the URL points at ` +
        `${maskEndpoint(parsed.host)}. This runner refuses any other host — ` +
        `Neon's pooled endpoint, another Neon project, a production endpoint, ` +
        `a loopback address. If the development endpoint genuinely changed, ` +
        `update EXPECTED_DEV_HOST in scripts/neon-dev-actions.mjs in a ` +
        `reviewed commit on main, then re-run.`,
    );
  }

  // Neon's pooled endpoint cannot relay the DDL a migration runs; the exact
  // host check above already refuses it, but this gives the operator the
  // actionable message instead of a generic host mismatch.
  if (/-pooler/i.test(parsed.host)) {
    problems.push(
      "The connection string is Neon's POOLED endpoint (the host contains " +
        "\"-pooler\"). drizzle-kit migrate needs the DIRECT / unpooled " +
        "connection. In the Neon dashboard: Rabet_dev → Connection Details → " +
        "the \"Direct connection\" tab → copy that connection string into the " +
        "NEON_DEV_DATABASE_URL secret.",
    );
  }

  // The database identity must be the development database.
  if (parsed.dbname.toLowerCase() !== expectedDbName.toLowerCase()) {
    problems.push(
      `The connection string does not name the approved Rabet development ` +
        `database. Expected "${expectedDbName}", but the URL names ` +
        `"${parsed.dbname}". This runner migrates the dedicated development ` +
        `database only. If the development database was renamed, update ` +
        `EXPECTED_DEV_DB_NAME in scripts/neon-dev-actions.mjs in a reviewed ` +
        `commit on main, then re-run.`,
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
      // validateConnectionUrl guarantees sslmode=require on an external host;
      // a loopback target (the disposable test cluster) needs no TLS.
      tls: /(?:^|&)sslmode=require/i.test(parsed.params)
        ? "required"
        : "not requested",
    },
  };
}

// ---------------------------------------------------------------------------
// Inspection — read-only, on the live target
// ---------------------------------------------------------------------------

/**
 * Runs the wizard's read-only inspection statements and classifies the target.
 *
 * Every statement is a `SELECT` (proven by tests/db/wizard-sql.test.ts), and
 * the classification is the wizard's own: the applied history must be an exact
 * prefix of the committed chain, anything else is drift the runner stops for.
 */
async function inspectTarget(ctx) {
  const { sql } = ctx;

  const tableRows = await sql.query(QUERIES.appTables).catch(() => []);
  const appTables = tableRows.map((row) => String(row.name));

  // No drizzle schema yet means an empty database — the query is allowed to
  // fail for that reason, and classifyDbState treats it as zero applied.
  const appliedRows = await sql.query(QUERIES.drizzleMigrations).catch(() => []);

  const countRows = await sql
    .query(buildRowCountQuery(appTables))
    .catch(() => [{ total: 0 }]);

  const totalRows = Number(countRows[0]?.total ?? 0);

  const state = classifyDbState({
    appTables,
    appliedMigrations: appliedRows,
    committedHashes: ctx.committedHashes,
    journal: ctx.journal,
    totalRows,
  });

  return { appTables, state, totalRows };
}

/**
 * The post-migration validation the wizard performs: the real objects the
 * committed chain should have built, verified from the database rather than
 * from a process exit code.
 */
async function validateTarget(ctx) {
  const { sql } = ctx;

  const tableRows = await sql.query(QUERIES.appTables).catch(() => []);
  const tables = tableRows.map((row) => String(row.name));
  const tableSet = new Set(tables);

  const missingTables = EXPECTED_TABLES.filter((name) => !tableSet.has(name));
  const unknownTables = tables.filter((name) => !EXPECTED_TABLES.includes(name));

  record(
    ctx,
    "tables",
    missingTables.length === 0 && unknownTables.length === 0,
    missingTables.length
      ? `missing ${missingTables.join(", ")}`
      : unknownTables.length
        ? `unexpected ${unknownTables.join(", ")}`
        : `${EXPECTED_TABLES.length}/${EXPECTED_TABLES.length}`,
  );

  // The applied hashes must equal the committed files' sha256, in order. This
  // is the byte-for-byte check, not a row count.
  const appliedRows = await sql.query(QUERIES.drizzleMigrations).catch(() => []);
  const applied = (appliedRows ?? []).map((row) => String(row.hash));
  const expectedHashes = ctx.committedHashes.map((entry) => entry.hash);
  const historyOk =
    applied.length === expectedHashes.length &&
    expectedHashes.every((hash, index) => applied[index] === hash);

  record(
    ctx,
    "migration-history",
    historyOk,
    historyOk
      ? "matches the committed files byte for byte"
      : `${applied.length} applied / ${expectedHashes.length} committed`,
  );

  const indexRows = await sql.query(QUERIES.indexes).catch(() => []);
  const indexSet = new Set(indexRows.map((row) => String(row.name)));
  const missingIndexes = EXPECTED_INDEXES.filter((name) => !indexSet.has(name));

  record(
    ctx,
    "indexes",
    missingIndexes.length === 0,
    missingIndexes.length
      ? `missing ${missingIndexes.join(", ")}`
      : `${EXPECTED_INDEXES.length}/${EXPECTED_INDEXES.length}`,
  );

  const constraintRows = await sql.query(QUERIES.constraints).catch(() => []);
  const constraintSet = new Set(
    constraintRows.map((row) => String(row.name)),
  );
  const missingConstraints = CRITICAL_CONSTRAINTS.filter(
    (name) => !constraintSet.has(name),
  );

  record(
    ctx,
    "constraints",
    missingConstraints.length === 0,
    missingConstraints.length
      ? `missing ${missingConstraints.join(", ")}`
      : `${CRITICAL_CONSTRAINTS.length}/${CRITICAL_CONSTRAINTS.length}`,
  );

  const treeRows = await sql.query(QUERIES.treeFks).catch(() => []);
  const treeSet = new Set(treeRows.map((row) => String(row.name)));
  const trees = Object.entries(EXPECTED_TREE_FKS).map(([tree, fk]) => ({
    tree,
    ok: treeSet.has(fk),
  }));

  record(
    ctx,
    "recursive-trees",
    trees.every((entry) => entry.ok),
    trees.map((entry) => `${entry.tree} ${entry.ok ? "ok" : "MISSING"}`).join(", "),
  );

  const one = await sql.query(QUERIES.selectOne).catch(() => []);

  record(ctx, "select-1", Number(one[0]?.result) === 1);

  // A read-only batch over the connection the runner holds: several statements
  // in one transaction that cannot write.
  let batchOk = false;

  try {
    const batch = await sql.batch(
      [QUERIES.selectOne, QUERIES.currentDatabase],
      { readOnly: true },
    );

    batchOk =
      Array.isArray(batch) &&
      batch.length === 2 &&
      Number(batch[0]?.[0]?.result) === 1 &&
      typeof batch[1]?.[0]?.name === "string";
  } catch (error) {
    record(ctx, "batch-read-only", false, redact(String(error.message ?? error)));
  }

  if (batchOk) {
    record(ctx, "batch-read-only", true, "2 statements in one read-only transaction");
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
// Output — every line filtered, so a credential can never reach the log
// ---------------------------------------------------------------------------

/**
 * The terminal IO surface. `line` and `note` both push to an `output` array
 * (what tests assert on) and write to stdout, and everything is passed through
 * `redact` so a connection string can never reach the Actions log by accident.
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

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

function note(ctx, text) {
  ctx.io.note(text);
}

function record(ctx, name, passed, detail = "") {
  ctx.checks.push({ name, passed: Boolean(passed), detail });
}

/**
 * Runs the requested mode.
 *
 * Every external surface is injected — `io` (output), `connect` (the wire-
 * protocol database), `runCommand` (npm/drizzle-kit) — so the tests drive
 * every branch with mocks and with a disposable PostgreSQL cluster, never
 * against the real `Rabet_dev`.
 *
 * Returns a result the CLI turns into an exit status; tests assert on it.
 */
export async function runActions({
  io,
  connect,
  runCommand,
  mode = "inspect",
  confirm = "",
  env = process.env,
  root = process.cwd(),
  expectedHost = EXPECTED_DEV_HOST,
  expectedDbName = EXPECTED_DEV_DB_NAME,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
    // 1. Where is this running, and what was asked for?
    // ------------------------------------------------------------------
    header(`${RUNNER} — mode: ${mode}`);

    const github = validateGithubContext(env);

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
      note(ctx, "Mode migrate: writes are allowed, but only after every gate passes.");
    } else {
      note(ctx, "Mode inspect: strictly read-only. No DDL, no migration history change.");
    }

    // ------------------------------------------------------------------
    // 2. The development connection string, from the environment only.
    // ------------------------------------------------------------------
    const rawUrl = env[DEV_URL_ENV];

    if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
      io.line("");
      io.line(
        `FAIL ${DEV_URL_ENV} is not configured. Add it as a GitHub Actions ` +
          "secret (see docs/NEON_DEV_SETUP.md §15.1). The value is the DIRECT / " +
          "unpooled connection string of the dedicated Rabet_dev project, and " +
          "it is read from the environment only — never from a workflow input " +
          "or the command line.",
      );

      ctx.outcome = "not-configured";
      return finalize(ctx);
    }

    const dev = validateDevUrl(rawUrl, { expectedHost, expectedDbName });

    if (!dev.ok) {
      io.line("");

      for (const problem of dev.problems) {
        io.line(`FAIL ${problem}`);
      }

      io.line("");
      io.line(
        "No connection was opened and nothing was written. The target is not " +
          "the approved Rabet development database.",
      );

      ctx.outcome = "refused";
      return finalize(ctx);
    }

    ctx.url = dev.url;

    note(ctx, `Endpoint      ${dev.target.host}`);
    note(ctx, `Database      ${dev.target.dbname}`);
    note(ctx, `Role          ${redact(dev.target.user)}`);
    note(ctx, `TLS           ${dev.target.tls}`);

    // Migrate mode needs the explicit confirmation, and it is checked before a
    // connection is opened so a wrong phrase never even reaches the database.
    if (ctx.mode === "migrate" && !verifyConfirmation(confirm)) {
      io.line("");
      io.line(
        `FAIL Migrate mode requires the confirmation phrase. Type ` +
          `${MIGRATE_CONFIRMATION} into the workflow's "confirm" input. The ` +
          "default mode stays inspect, so a missed or mistyped confirmation " +
          "runs nothing.",
      );

      ctx.outcome = "refused";
      return finalize(ctx);
    }

    // ------------------------------------------------------------------
    // 3. The committed migration chain, from the repository on main.
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
    // 4. Connect, read-only first.
    // ------------------------------------------------------------------
    header("Connecting to the development database");

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
      io.line(
        "No connection was opened and nothing was written. If the GitHub " +
          "runner also cannot reach the endpoint on TCP 5432, see " +
          "docs/NEON_DEV_SETUP.md §16 for what to do.",
      );

      ctx.outcome = "unreachable";
      return finalize(ctx);
    }

    ctx.sql = connection.sql;

    // Non-sensitive metadata only. The endpoint is masked, the password never
    // leaves the string.
    const [dbNameRow, versionRow, userRow] = await Promise.all([
      ctx.sql.query(QUERIES.currentDatabase).catch(() => [{ name: null }]),
      ctx.sql.query(QUERIES.pgVersion).catch(() => [{ version: null }]),
      ctx.sql.query(QUERIES.currentUser).catch(() => [{ name: null }]),
    ]);

    const liveDbName = String(dbNameRow[0]?.name ?? dev.target.dbname);
    const pgVersion = String(versionRow[0]?.version ?? "unknown");

    ctx.target = {
      dbName: liveDbName,
      pgVersion,
      role: String(userRow[0]?.name ?? "unknown"),
      endpoint: dev.target.host,
      tls: dev.target.tls,
    };

    io.line("  Connected. Target metadata (read-only):");
    note(ctx, `Database      ${liveDbName}`);
    note(ctx, `PostgreSQL    ${pgVersion.split(",").slice(0, 1).join("")}`);
    note(ctx, `Role          ${ctx.target.role}`);
    note(ctx, `Endpoint      ${ctx.target.endpoint}`);
    note(ctx, `TLS           ${ctx.target.tls}`);

    // Re-verify the database identity from the live connection, not just from
    // the string. A connection string can name one database and be rewritten
    // to another; the server is authoritative.
    if (liveDbName.toLowerCase() !== expectedDbName.toLowerCase()) {
      io.line("");
      io.line(
        `FAIL The connected database is "${liveDbName}", not the approved ` +
          `development database "${expectedDbName}". The runner refuses to ` +
          "proceed; no write was attempted.",
      );

      ctx.outcome = "refused";
      return finalize(ctx);
    }

    record(ctx, "connection", true, `${github.context}, read-only probe ok`);

    // ------------------------------------------------------------------
    // 5. Inspect the current state (both modes).
    // ------------------------------------------------------------------
    header("Inspecting the development database (read-only)");

    const inspected = await inspectTarget(ctx);

    ctx.state = inspected.state;

    reportState(ctx, inspected);

    record(ctx, "inspection", true);

    // Drift is reported in either mode. Inspect stops here; migrate refuses.
    if (inspected.state.status === "drift" || inspected.state.status === "inconsistent") {
      io.line("");
      io.line(`FAIL ${inspected.state.stopReason}`);
      io.line("");
      io.line(
        "  Stopped. This runner does not repair drift, drop tables or reset " +
          "branches. Take a Neon snapshot, inspect the database, then re-run " +
          "inspect once the state is understood.",
      );

      ctx.outcome = "manual-review";
      return finalize(ctx);
    }

    if (ctx.mode === "inspect") {
      header("Read-only inspection complete");

      note(ctx, `Pending migrations: ${inspected.state.pending.length}${inspected.state.pending.length ? ` (${inspected.state.pending.join(", ")})` : ""}`);
      note(ctx, `Application data rows: ${inspected.totalRows}`);
      io.line("");
      io.line(
        "  No DDL ran, no migration history was modified, and nothing was " +
          "written. To apply the pending migrations, run this workflow again " +
          "with mode migrate and the MIGRATE_RABET_DEV confirmation.",
      );

      ctx.outcome = "inspected";
      ctx.ok = true;
      return finalize(ctx);
    }

    // ------------------------------------------------------------------
    // 6. Migrate — every gate re-checked, then the existing command.
    // ------------------------------------------------------------------
    header("Migrating the development database");

    // The confirmation is re-verified at the point of writing.
    if (!verifyConfirmation(confirm)) {
      io.line(
        `FAIL The ${MIGRATE_CONFIRMATION} confirmation is missing at the ` +
          "point of writing. Nothing was written.",
      );

      ctx.outcome = "refused";
      return finalize(ctx);
    }

    // The applied history must be an exact prefix of the committed chain.
    // classifyDbState already proved this; state it plainly for the log.
    if (inspected.state.appliedCount > inspected.state.journalCount) {
      io.line(
        `FAIL The database records ${inspected.state.appliedCount} applied ` +
          `migrations but the committed chain has ` +
          `${inspected.state.journalCount}. The database is ahead of the ` +
          "repository; refusing to write.",
      );

      ctx.outcome = "manual-review";
      return finalize(ctx);
    }

    // The committed chain is consistent (journal ↔ snapshots ↔ SQL files).
    // drizzle-kit check compares the repository metadata; it is NOT a preview
    // of the SQL that will run — the pending list above is the preview.
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

      if (/drizzle\.\w+__drizzle_migrations|relation .* does not exist/i.test(stderr)) {
        note(ctx, "drizzle-kit check: no migrations table yet (empty target)");
        record(ctx, "migration-check", true, "no migrations table yet");
      } else {
        io.line("");
        io.line("  FAIL drizzle-kit check reported a problem (schema/migration drift).");
        for (const line of stderr.split("\n").filter(Boolean).slice(-3)) {
          io.line(`    ${line}`);
        }
        io.line(
          "  Stopped. Regenerate and commit migrations with `npm run " +
            "db:generate`, or restore the Neon branch snapshot.",
        );

        record(ctx, "migration-check", false);
        ctx.outcome = "manual-review";
        return finalize(ctx);
      }
    }

    // Nothing to do when the dedicated database is already up to date. Running
    // the command anyway is a harmless no-op, but reporting it as an apply
    // would be misleading.
    if (inspected.state.pending.length === 0) {
      note(ctx, "The development database is already configured.");
      note(ctx, "No migrations are pending, so nothing is written. Validating instead.");

      const validated = await validateTarget(ctx);

      if (!validated) {
        io.line("");
        io.line("  FAIL One or more validation checks failed after this run.");
        ctx.outcome = "manual-review";
        return finalize(ctx);
      }

      record(ctx, "apply", true, "nothing pending");
      ctx.outcome = "already-configured";
      ctx.ok = true;
      return finalize(ctx);
    }

    io.line("");
    io.line(`  Target:      ${ctx.target.dbName} (environment: DEVELOPMENT)`);
    io.line(`  Endpoint:    ${ctx.target.endpoint}`);
    io.line(`  Pending:     ${inspected.state.pending.length} migration(s)`);
    io.line("");

    const beforeTags = ctx.journal.entries
      .slice(0, inspected.state.appliedCount)
      .map((entry) => entry.tag);

    note(ctx, "Running npm run db:migrate with the verified development URL…");
    note(ctx, "The runner re-inspects the database afterwards rather than trusting");
    note(ctx, "the command's exit code alone — drizzle-kit can exit non-zero silently.");

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

    // Verify what actually landed instead of trusting the exit code.
    const after = await inspectTarget(ctx);

    ctx.state = after.state;
    ctx.writes.migrationsApplied = journalTags(ctx, after.state.appliedCount).filter(
      (tag) => !beforeTags.includes(tag),
    );

    if (after.state.stopReason) {
      io.line("");
      io.line(`FAIL ${after.state.stopReason}`);
      io.line(
        "  Stopped. The runner does not retry an ambiguous partial result and " +
          "never claims success after an incomplete operation.",
      );

      ctx.outcome = "manual-review";
      return finalize(ctx);
    }

    if (after.state.pending.length > 0) {
      io.line("");
      io.line(
        `FAIL The command exited 0 but ${after.state.pending.length} ` +
          `migration(s) are still pending: ${after.state.pending.join(", ")}.`,
      );
      io.line(
        "  Inspect the database and the journal; do not blindly re-run.",
      );

      ctx.outcome = "manual-review";
      return finalize(ctx);
    }

    note(ctx, `${after.state.appliedCount} migration(s) recorded ✓`);

    // ------------------------------------------------------------------
    // 7. Validate the result against the real objects.
    // ------------------------------------------------------------------
    header("Validating the result");

    const validated = await validateTarget(ctx);

    if (!validated) {
      io.line("");
      io.line("  FAIL One or more validation checks failed after the migration.");
      io.line(
        "    The migration may still have applied; inspect the database in the " +
          "Neon console before deciding. The runner does not report success " +
          "unless every check passes.",
      );

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
    io.line(`FAIL ${redact(String(error.message ?? error))}`);
    io.line(
      "  No changes were claimed unless a step above says it completed. Re-run " +
        "with mode inspect to see the real database state.",
    );
  } finally {
    try {
      await ctx.sql?.close();
    } catch {
      // Closing is best-effort.
    }
  }

  return finalize(ctx);
}

/** The committed tags for the first `count` journal entries, in chain order. */
function journalTags(ctx, count) {
  return ctx.journal.entries.slice(0, count).map((entry) => entry.tag);
}

/** Prints the inspection summary the wizard prints, masked and read-only. */
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

  note(ctx, `Drizzle migration history: ${state.appliedCount} recorded / ${state.journalCount} committed`);

  if (state.pending.length > 0) {
    note(ctx, `Pending migrations: ${state.pending.join(", ")}`);
  } else {
    note(ctx, "Pending migrations: none");
  }

  note(ctx, `Application data rows: ${totalRows}`);

  // The comparison the classification is built on, stated for the log: each
  // recorded hash is the sha256 of a committed file, in chain order.
  const appliedHashes = state.appliedCount;

  note(
    ctx,
    `History check: the ${appliedHashes} recorded migration(s) must be an exact ` +
      "prefix of the committed chain (byte-for-byte sha256), and no unknown " +
      "table may be present. Anything else is reported as drift above.",
  );
}

/** Diagnoses a failed migration from the database itself, like the wizard. */
async function reportMigrationFailure(ctx, migration) {
  const { io } = ctx;

  const after = await inspectTarget(ctx);

  ctx.state = after.state;

  io.line("");
  io.line(`FAIL npm run db:migrate exited with code ${migration.code}.`);

  // drizzle-kit clears its failing line, so its own output is often useless;
  // the database is authoritative.
  const output = [migration.stdout, migration.stderr].filter(Boolean).join("\n").trim();

  if (output.length > 0) {
    io.line("  drizzle-kit output (last lines):");

    for (const line of output.split("\n").slice(-4)) {
      io.line(`    ${redact(line)}`);
    }
  } else {
    io.line("  drizzle-kit printed no error detail (its terminal renderer clears the");
    io.line("  failing line), so the runner inspects the database to diagnose it.");
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

  if (after.state.status === "empty" && after.state.appliedCount === 0) {
    if (reachable) {
      io.line("  Nothing was recorded and no tables were built, so the database is");
      io.line("  still empty. This is almost always a permission problem on the role.");
      io.line("  Check the role's grants for the Rabet_dev branch in the Neon");
      io.line("  dashboard, then re-run: the chain applies from the beginning and");
      io.line("  repeats nothing already done.");
    } else {
      io.line("  The connection failed during the run and nothing was applied. Fix");
      io.line("  the connectivity problem and re-run.");
    }
  } else {
    io.line(`  Applied so far: ${after.state.appliedCount} of ${after.state.journalCount}.`);
    io.line("  Stopped — do not blindly re-run. Inspect drizzle.__drizzle_migrations");
    io.line("  and the tables in the Neon console, or restore the Neon branch");
    io.line("  snapshot, then re-run inspect before deciding.");
  }

  ctx.outcome = "failed";
  ctx.ok = false;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function finalize(ctx) {
  const { io } = ctx;
  const lines = [];

  lines.push("");
  lines.push("─".repeat(60));

  const title = {
    inspected: "Read-only inspection complete — target is consistent",
    migrated: "Development migration complete",
    "already-configured": "Development database is already configured",
    refused: "Refused — the target or the request is not approved",
    "not-configured": "Refused — the development secret is not configured",
    unreachable: "Could not connect — nothing was written",
    "manual-review": "Stopped for manual review",
    failed: "Did not complete",
  }[ctx.outcome] ?? "Finished";

  lines.push(`${RUNNER} — ${title}`);
  lines.push("─".repeat(60));

  if (ctx.target) {
    lines.push(`Target       ${ctx.target.dbName} (environment: DEVELOPMENT)`);
    lines.push(`Endpoint     ${ctx.target.endpoint}`);
    lines.push(`PostgreSQL   ${ctx.target.pgVersion.split(",").slice(0, 1).join("")}`);
  } else if (ctx.url) {
    const parsed = parsePgUrl(ctx.url);

    lines.push(`Target       ${parsed.dbname} (environment: DEVELOPMENT)`);
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
  lines.push("Production was not contacted and was not modified. No tables were");
  lines.push("dropped, no branch was reset, and drizzle-kit push was never run.");

  if (ctx.mode === "inspect") {
    lines.push("Inspect mode performed read-only statements only; no DDL ran and no");
    lines.push("migration history was modified.");
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
// CLI entry point
// ---------------------------------------------------------------------------

const HELP = [
  `${RUNNER} — manual GitHub Actions runner for the Rabet development database`,
  "",
  "Reads the development connection string from the environment only:",
  `  ${DEV_URL_ENV}          the DIRECT / unpooled Rabet_dev connection string`,
  `  ${MODE_ENV}               "inspect" (default, read-only) or "migrate"`,
  `  ${CONFIRM_ENV}     required for migrate mode: ${MIGRATE_CONFIRMATION}`,
  "",
  "The target is pinned to the committed development endpoint and database, so",
  "any other host or database — pooled, another project, production — is",
  "refused before a connection is opened. Migrate mode never runs without the",
  "confirmation phrase. Production is never contacted and drizzle-kit push is",
  "never run.",
].join("\n");

async function runCli() {
  const io = createRealIo();
  const env = process.env;

  const parsedMode = parseMode(env[MODE_ENV]);

  if (!parsedMode.ok) {
    process.stderr.write(`${parsedMode.error}\n\n${HELP}\n`);
    process.exit(2);
  }

  if (env.RABET_ACTIONS_HELP === "1") {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }

  const result = await runActions({
    io,
    connect: createPostgresSql,
    runCommand: (opts) =>
      runCommandReal({ ...opts, onOutput: (chunk) => process.stdout.write(chunk) }),
    mode: parsedMode.mode,
    confirm: typeof env[CONFIRM_ENV] === "string" ? env[CONFIRM_ENV] : "",
    env,
    root: process.cwd(),
  });

  process.exit(result.ok ? 0 : 1);
}

const isCli = import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href;

if (isCli) {
  runCli().catch((error) => {
    process.stderr.write(`${RUNNER}: ${redact(String(error.stack ?? error.message ?? error))}\n`);
    process.exit(1);
  });
}
