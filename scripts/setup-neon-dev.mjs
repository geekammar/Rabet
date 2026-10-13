#!/usr/bin/env node
/**
 * scripts/setup-neon-dev.mjs — the one-command Neon development database wizard.
 *
 *   npm run db:setup:dev
 *
 * ===========================================================================
 * What this does
 * ===========================================================================
 *
 * The product owner sets up the Rabet *development* database from a VPS or a
 * laptop with one command. The wizard:
 *
 *   1. verifies it is running inside the Rabet repository, on a clean-ish tree,
 *      with the committed migration files and a supported Node.js;
 *   2. verifies the local dependencies (offering `npm ci` when they are
 *      missing — `package-lock.json` is never modified);
 *   3. asks for the Neon **direct / unpooled** connection string for the
 *      dedicated `Rabet_dev` project, reads it without echoing it, requires
 *      TLS, and opens a **read-only** connection;
 *   4. inspects the real database state (tables, migration journal, data)
 *      through read-only SQL only;
 *   5. reviews the committed migration chain and runs `drizzle-kit check`;
 *   6. asks for explicit approval — default **no** — and only then applies the
 *      committed chain through `npm run db:migrate`, with the verified
 *      development URL passed through a **sanitized** child-process
 *      environment;
 *   7. validates the result through read-only SQL and a read-only Neon HTTP
 *      batch, then prints a concise report.
 *
 * ===========================================================================
 * What it never does
 * ===========================================================================
 *
 * Never touches production (it is never given a production URL and never
 * connects to one); never runs `drizzle-kit push`; never regenerates or
 * invents migration SQL; never drops a table, a database or a branch; never
 * repairs schema drift automatically; never seeds fake records; never sets
 * `RABET_TEST_PG_URL` (that variable belongs to the disposable test cluster
 * only); never passes a credential on the command line; never prints or logs a
 * connection string; and never commits anything (`.env.local` stays
 * git-ignored, and the wizard runs no `git` write command).
 *
 * ===========================================================================
 * Modes
 * ===========================================================================
 *
 *   npm run db:setup:dev              interactive setup (default)
 *   npm run db:setup:dev -- --check   read-only preflight: steps 1–5, no
 *                                     writes, no approval asked, exit 0/1
 *   npm run db:setup:dev -- --vercel-preview
 *                                     also offer the OPTIONAL Vercel Preview
 *                                     step (disabled by default)
 *   npm run db:setup:dev -- --help
 *
 * The script is written as a library with an injected IO/database/subprocess
 * surface, so the whole flow is exercised by automated tests with mocks and a
 * disposable PostgreSQL cluster — never against a real Neon account.
 * (tests/wizard/setup-neon-dev.test.ts, tests/db/wizard-sql.test.ts)
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import { neon } from "@neondatabase/serverless";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// Constants — the expectations the wizard verifies. They mirror the committed
// schema and migration chain, so a change to either is a deliberate review
// item here.
// ---------------------------------------------------------------------------

const WIZARD = "rabet db:setup:dev";

/** The fourteen domain tables created by the committed chain. */
export const EXPECTED_TABLES = [
  "bot_setting",
  "category",
  "category_translation",
  "customer",
  "inquiry",
  "inquiry_message",
  "language",
  "message_template",
  "message_translation",
  "product",
  "product_action",
  "product_action_translation",
  "product_translation",
  "telegram_update",
];

/** The committed migration tags, in chain order (drizzle/meta/_journal.json). */
export const EXPECTED_MIGRATION_TAGS = [
  "0000_initial_schema",
  "0001_tree_and_snapshot_integrity",
];

/**
 * Indexes the wizard requires. The five partial unique indexes carry the
 * integrity rules, the business-key indexes protect the natural unique keys,
 * and the composite translation indexes protect the per-language uniqueness.
 */
export const EXPECTED_INDEXES = [
  "category_sibling_sort_order_idx",
  "category_root_sort_order_idx",
  "product_action_sibling_sort_order_idx",
  "product_action_root_sort_order_idx",
  "inquiry_active_per_customer_product_idx",
  "category_slug_unique",
  "product_slug_unique",
  "language_code_unique",
  "message_template_key_unique",
  "customer_telegram_id_unique",
  "telegram_update_update_id_unique",
  "inquiry_reference_unique",
  "inquiry_message_telegram_message_idx",
  "category_translation_category_language_idx",
  "product_translation_product_language_idx",
  "product_action_translation_action_language_idx",
  "message_translation_template_language_idx",
];

/** CHECK constraints the wizard requires (domain rules the schema enforces). */
export const CRITICAL_CONSTRAINTS = [
  "bot_setting_singleton_check",
  "bot_setting_currency_allowlist_check",
  "category_no_self_parent_check",
  "product_action_no_self_parent_check",
  "product_price_nonnegative_check",
  "product_action_url_https_check",
  "product_action_navigation_target_exclusive_check",
  "product_action_navigation_target_type_check",
  "language_text_direction_check",
  "inquiry_message_body_length_check",
  "message_translation_body_length_check",
  "product_action_translation_label_length_check",
];

/** The two self-referencing foreign keys — proof both recursive trees exist. */
export const EXPECTED_TREE_FKS = {
  category: "category_parent_id_category_id_fk",
  product_action: "product_action_parent_action_id_product_action_id_fk",
};

/** The GitHub repository this wizard is allowed to provision. */
export const EXPECTED_REPO = "github.com/geekammar/rabet";

/** The dedicated Neon development project the owner created. */
export const EXPECTED_NEON_PROJECT = "Rabet_dev";

export const MIN_NODE_MAJOR = 18;
export const RECOMMENDED_NODE_MAJOR = 22;

/** Keys forwarded to migration/check subprocesses. Nothing else is inherited:
 * the verified development URL is the only credential in the child env, and
 * `RABET_TEST_PG_URL` is deliberately never forwarded. */
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NPM_CONFIG_CACHE",
  "npm_config_cache",
];

/** Connection retry policy for transient network failures. */
const CONNECT_MAX_ATTEMPTS = 3;

/**
 * How many times the wizard may ask "try connecting again?" for one URL. The
 * automatic retries above handle transient failures; this bounds the manual
 * loop so an interrupted session (SSH died, piped stdin ended) can never spin
 * forever on a confirm whose default is "yes".
 */
const MAX_MANUAL_CONNECT_RETRIES = 3;

// ---------------------------------------------------------------------------
// Credential hygiene — nothing sensitive is ever displayed or logged.
// ---------------------------------------------------------------------------

const URL_PATTERN =
  /postgres(?:ql)?:\/\/[^\s"'<>\\]*/gi;

/**
 * Replaces every connection string in a piece of text with a masked form.
 *
 * Every error message, subprocess output line and report line the wizard emits
 * is passed through this, so a credential can never reach the terminal, a log
 * or scrollback even by accident (a driver or CLI can echo more than we expect).
 */
export function redact(text) {
  if (typeof text !== "string") return text;
  return text.replace(URL_PATTERN, (match) => maskUrl(match));
}

/**
 * Masks a connection string for display: the password is removed entirely, the
 * endpoint host is shortened to its first label and its region suffix, and only
 * the `sslmode` query parameter is kept.
 */
export function maskUrl(url) {
  const parsed = parsePgUrl(url);

  if (!parsed.ok) return "postgresql://***";

  const host = maskEndpoint(parsed.host);
  const creds = parsed.user ? `${parsed.user}:***@` : "";
  const params =
    parsed.params && /sslmode/i.test(parsed.params) ? "?sslmode=require" : "";

  return `${parsed.scheme}://${creds}${host}/${parsed.dbname}${params}`;
}

/** Shortens a Neon endpoint host so the region is recognizable, nothing else. */
export function maskEndpoint(host) {
  if (typeof host !== "string") return "***";

  const dot = host.indexOf(".");

  // A single-label host (localhost) is not sensitive; show it as-is.
  if (dot === -1) return host;

  const first = host.slice(0, dot);
  const rest = host.slice(dot);
  const keep = first.length > 8 ? first.slice(0, 8) : first;

  return `${keep}***${rest}`;
}

/**
 * Parses a PostgreSQL connection string into its parts without ever printing it.
 *
 * Deliberately conservative: it understands the `user:password@host:port/db`
 * shape and a query string, and rejects anything else rather than guessing.
 */
export function parsePgUrl(raw) {
  const value = String(raw).trim();

  const schemeMatch = /^(postgres(?:ql)?:\/\/)/i.exec(value);

  if (!schemeMatch) {
    return {
      ok: false,
      error:
        "Not a PostgreSQL connection string. It must start with postgresql:// " +
        "(or postgres://). In the Neon dashboard: Rabet_dev → Connection " +
        "Details → the 'Direct connection' tab → copy the Connection string.",
    };
  }

  const scheme = schemeMatch[1].toLowerCase();
  const rest = value.slice(schemeMatch[1].length);

  // Split credentials/host from the database and query string. The database is
  // the first path segment after the host portion; the query string is optional.
  const queryStart = rest.indexOf("?");
  const beforeQuery = queryStart === -1 ? rest : rest.slice(0, queryStart);
  const params = queryStart === -1 ? "" : rest.slice(queryStart + 1);

  const slash = beforeQuery.indexOf("/");
  const authority = slash === -1 ? beforeQuery : beforeQuery.slice(0, slash);
  const dbname = slash === -1 ? "" : beforeQuery.slice(slash + 1);

  const at = authority.lastIndexOf("@");

  if (at === -1 || at === 0) {
    return {
      ok: false,
      error:
        "The connection string is missing its credentials. A Neon connection " +
        "string looks like postgresql://USER:PASSWORD@HOST/DATABASE — the " +
        "password is the part after the colon. Copy it from the Neon dashboard " +
        "(Rabet_dev → Connection Details → 'Direct connection'), never type it " +
        "by hand.",
      scheme,
    };
  }

  const credentials = authority.slice(0, at);
  const hostPort = authority.slice(at + 1);
  const colon = credentials.indexOf(":");
  const user = colon === -1 ? credentials : credentials.slice(0, colon);
  const password = colon === -1 ? "" : credentials.slice(colon + 1);

  const hostColon = hostPort.lastIndexOf(":");
  const isV6 = hostPort.startsWith("[");
  let host;
  let port = "";

  if (isV6) {
    const close = hostPort.indexOf("]");
    host = hostPort.slice(1, close);
    const after = hostPort.slice(close + 1);

    if (after.startsWith(":")) port = after.slice(1);
  } else if (hostColon !== -1 && /^\d+$/.test(hostPort.slice(hostColon + 1))) {
    host = hostPort.slice(0, hostColon);
    port = hostPort.slice(hostColon + 1);
  } else {
    host = hostPort;
  }

  if (!host) {
    return {
      ok: false,
      error: "The connection string is missing its host.",
      scheme,
    };
  }

  return {
    ok: true,
    scheme,
    user,
    password,
    host,
    port,
    dbname,
    params,
  };
}

/** True when the host is loopback or a private address — i.e. not external. */
function isInternalHost(host) {
  return (
    host === "localhost" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^::1$/.test(host) ||
    /\.internal$/.test(host)
  );
}

function param(params, name) {
  const match = new RegExp(`(?:^|&)${name}=([^&]*)`, "i").exec(params);

  return match ? match[1].toLowerCase() : "";
}

/**
 * Validates a connection string syntactically and applies the TLS requirement.
 *
 * Returns the URL the wizard should use (which may gain `sslmode=require`) plus
 * human-readable, credential-free problems the caller can act on.
 */
export function validateConnectionUrl(raw) {
  const parsed = parsePgUrl(raw);

  if (!parsed.ok) {
    return { ok: false, error: parsed.error, url: null, warnings: [] };
  }

  const warnings = [];
  let url = String(raw).trim();

  if (!parsed.password) {
    warnings.push(
      "The connection string has no password. A Neon database requires one; " +
        "copy the full string from the Neon dashboard rather than editing it.",
    );
  }

  if (!parsed.dbname) {
    return {
      ok: false,
      url: null,
      warnings,
      error:
        "The connection string does not name a database. It must end with the " +
        "database name, e.g. ...neon.tech/rabet_dev.",
    };
  }

  // External hosts (Neon) must use TLS. If the parameter is absent, add it and
  // say so — never silently rewrite a credential-bearing string, and never
  // accept sslmode=disable off the loopback.
  const external = !isInternalHost(parsed.host);

  if (external) {
    const sslmode = param(parsed.params, "sslmode");

    if (!sslmode) {
      url = appendParam(url, "sslmode=require");
      warnings.push(
        "Added sslmode=require: the connection is external and Neon requires " +
          "TLS. The wizard uses the adjusted string, with the password hidden.",
      );
    } else if (sslmode === "disable" || sslmode === "allow" || sslmode === "prefer") {
      return {
        ok: false,
        url: null,
        warnings,
        error:
          "The connection string disables TLS (sslmode=" +
          sslmode +
          "). An external " +
          "Neon connection must require TLS. Remove the sslmode parameter or " +
          "set sslmode=require in the Neon dashboard's connection string.",
      };
    }
  }

  return { ok: true, url, warnings, parsed };
}

function appendParam(url, param) {
  return url.includes("?") ? `${url}&${param}` : `${url}?${param}`;
}

// ---------------------------------------------------------------------------
// Committed migration files — read from disk, never regenerated.
// ---------------------------------------------------------------------------

/** Reads and parses the Drizzle migration journal. */
export function readJournal(root) {
  const journalPath = path.join(root, "drizzle", "meta", "_journal.json");

  try {
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));

    if (
      !journal ||
      !Array.isArray(journal.entries) ||
      journal.entries.length === 0
    ) {
      return {
        ok: false,
        entries: [],
        error: "drizzle/meta/_journal.json has no migration entries.",
      };
    }

    const entries = journal.entries.map((entry, index) => ({
      idx: index,
      tag: String(entry.tag),
      when: Number(entry.when),
    }));

    return { ok: true, entries };
  } catch (error) {
    return {
      ok: false,
      entries: [],
      error: `Could not read the migration journal (drizzle/meta/_journal.json): ${
        error.message
      }. The journal is what drizzle-kit migrate reads; without it the chain cannot be applied safely.`,
    };
  }
}

/**
 * Verifies the committed migration files match the journal: every journal tag
 * has a SQL file and a snapshot, and no unexpected SQL file sits in drizzle/.
 *
 * This is a read-only check of the repository, not of any database.
 */
export function verifyMigrationFiles(root) {
  const problems = [];
  const warnings = [];

  const journal = readJournal(root);

  if (!journal.ok) {
    return { ok: false, problems: [journal.error], warnings };
  }

  const drizzleDir = path.join(root, "drizzle");
  const metaDir = path.join(drizzleDir, "meta");

  for (const entry of journal.entries) {
    const sql = path.join(drizzleDir, `${entry.tag}.sql`);

    if (!fs.existsSync(sql)) {
      problems.push(`Missing migration file: drizzle/${entry.tag}.sql`);
    }
  }

  // Snapshots carry the schema state each migration starts from; drizzle-kit
  // names them `<prefix>_snapshot.json` (the zero-padded journal index by
  // default, a timestamp when the project is configured that way), so the
  // count is checked rather than one exact name.
  const snapshots = fs.existsSync(metaDir)
    ? fs.readdirSync(metaDir).filter((name) => name.endsWith("_snapshot.json"))
    : [];

  if (snapshots.length !== journal.entries.length) {
    problems.push(
      `Expected ${journal.entries.length} snapshot file(s) in drizzle/meta/ ` +
        `(one per migration, named <index>_snapshot.json), found ` +
        `${snapshots.length}. Regenerate with \`npm run db:generate\` and commit.`,
    );
  }

  if (!fs.existsSync(path.join(metaDir, "_journal.json"))) {
    problems.push("Missing drizzle/meta/_journal.json");
  }

  // Unexpected migration files mean someone generated migrations without
  // committing the journal entry (or without reviewing) — that is a drift the
  // wizard must not paper over.
  const sqlFiles = fs
    .readdirSync(drizzleDir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.replace(/\.sql$/, ""));

  const known = new Set(journal.entries.map((entry) => entry.tag));

  for (const name of sqlFiles) {
    if (!known.has(name)) {
      problems.push(
        `Unexpected migration file with no journal entry: drizzle/${name}.sql. ` +
          "Run `npm run db:generate` and commit the journal, or remove the file.",
      );
    }
  }

  return { ok: problems.length === 0, problems, warnings, journal };
}

/**
 * The sha256 of each committed migration file's exact contents — the same hash
 * Drizzle records in `drizzle.__drizzle_migrations` when it applies the file
 * (drizzle-orm/migrator.js), so the wizard can prove the applied history
 * matches the committed files byte for byte.
 */
export function computeMigrationHashes(root) {
  const journal = readJournal(root);
  const hashes = [];

  if (!journal.ok) return hashes;

  for (const entry of journal.entries) {
    const file = path.join(root, "drizzle", `${entry.tag}.sql`);

    try {
      const contents = fs.readFileSync(file, "utf8");

      hashes.push({
        tag: entry.tag,
        when: entry.when,
        hash: crypto.createHash("sha256").update(contents).digest("hex"),
      });
    } catch {
      // verifyMigrationFiles reports the missing file; here we just skip.
    }
  }

  return hashes;
}

// ---------------------------------------------------------------------------
// Read-only inspection SQL. Every statement is a SELECT.
// ---------------------------------------------------------------------------

export const QUERIES = {
  selectOne: "select 1 as result",
  currentDatabase: "select current_database() as name",
  pgVersion: "select version() as version",
  currentUser: "select current_user as name",
  appTables:
    "select table_name as name from information_schema.tables where table_schema = 'public' order by table_name",
  drizzleMigrations:
    "select id, hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at",
  indexes: "select indexname as name from pg_indexes where schemaname = 'public'",
  constraints:
    "select conname as name, contype as type from pg_constraint where connamespace = 'public'::regnamespace",
  treeFks:
    "select conname as name, conrelid::regclass::text as table_name from pg_constraint where contype = 'f' and conrelid = confrelid",
};

const ROWCOUNT_MARKER = "/* rabet:rowcount */";

/**
 * Builds a single read-only statement that sums the row counts of the given
 * tables. Only names from {@link EXPECTED_TABLES} are ever interpolated, and
 * they are double-quoted, so this cannot be an injection vector.
 */
export function buildRowCountQuery(tables) {
  const safe = tables.filter((name) => EXPECTED_TABLES.includes(name));

  if (safe.length === 0) {
    return `${ROWCOUNT_MARKER} select 0::bigint as total`;
  }

  const parts = safe.map(
    (name) => `select count(*)::bigint as total from "${name}"`,
  );

  return `${ROWCOUNT_MARKER} select sum(total)::bigint as total from (${parts.join(
    " union all ",
  )}) as counts`;
}

/**
 * Classifies the database state from the read-only inspection.
 *
 * The journal is the source of truth. The state is only considered safe to
 * continue when the applied migrations are exactly a prefix of the committed
 * chain — anything else (unknown tables, hashes that match no committed file,
 * gaps, or a journal that says done while tables are missing) is ambiguity the
 * wizard stops for instead of guessing.
 */
export function classifyDbState({
  appTables,
  appliedMigrations,
  committedHashes,
  journal,
  totalRows,
}) {
  const present = new Set(appTables);
  const expected = new Set(EXPECTED_TABLES);
  const unknownTables = [...present].filter((name) => !expected.has(name));
  const missingTables = [...expected].filter((name) => !present.has(name));

  const applied = (appliedMigrations ?? []).map((row) => ({
    id: Number(row.id),
    hash: String(row.hash),
    when: Number(row.created_at),
  }));

  const byHash = new Map(committedHashes.map((entry) => [entry.hash, entry]));
  const appliedMatchingFile = applied.filter((row) => byHash.has(row.hash));

  // The applied history must be a prefix of the committed chain, in order.
  const prefixOk = appliedMatchingFile.every((row, index) => {
    const entry = byHash.get(row.hash);

    return journal.entries[index] && journal.entries[index].tag === entry.tag;
  });

  const appliedCount = applied.length;
  const journalCount = journal.entries.length;

  let status;
  let pending = [];
  let stopReason = null;

  if (unknownTables.length > 0) {
    status = "drift";
    stopReason =
      `The database contains tables that are not part of the Rabet schema: ` +
      `${unknownTables.join(", ")}. This may be a different database, or a ` +
      `previous migration drift. The wizard will not modify it; inspect the ` +
      `database manually first (the Neon console has a SQL editor).`;
  } else if (appliedCount > journalCount) {
    status = "drift";
    stopReason =
      `The database records ${appliedCount} applied migrations, but the ` +
      `committed chain has ${journalCount}. The database is ahead of the ` +
      `repository — inspect drizzle.__drizzle_migrations manually before ` +
      `doing anything else.`;
  } else if (
    appliedCount !== appliedMatchingFile.length ||
    (appliedCount > 0 && !prefixOk)
  ) {
    status = "drift";
    stopReason =
      `The applied migration history does not match the committed chain. The ` +
      `journal is the source of truth, and the wizard will not guess how the ` +
      `database reached this state. Inspect drizzle.__drizzle_migrations and ` +
      `the drizzle/ folder manually, or restore the Neon branch snapshot.`;
  } else {
    pending = journal.entries.slice(appliedCount).map((entry) => entry.tag);

    if (pending.length === 0) {
      if (missingTables.length === 0) {
        status = "configured";
      } else {
        status = "inconsistent";
        stopReason =
          `The migration journal says every migration is applied, but the ` +
          `expected tables are missing: ${missingTables.join(", ")}. The ` +
          `schema does not match the journal — restore the Neon branch ` +
          `snapshot and re-run, or inspect the database manually.`;
      }
    } else if (appliedCount === 0) {
      status = "empty";
    } else {
      status = "partial";
    }
  }

  return {
    status,
    pending,
    unknownTables,
    missingTables,
    appliedCount,
    journalCount,
    totalRows: Number(totalRows ?? 0),
    hasData: Number(totalRows ?? 0) > 0,
    stopReason,
  };
}

// ---------------------------------------------------------------------------
// Child-process environment — sanitized, and always the verified DEV URL.
// ---------------------------------------------------------------------------

/**
 * Builds the environment for `npm run db:migrate` / `db:check`.
 *
 * Only neutral, non-secret keys are inherited, plus the single verified
 * development URL as `DATABASE_URL`. `drizzle.config.ts` skips environment
 * keys that are already set, so this value wins over any `DATABASE_URL` in
 * `.env.local` — the migration always runs against the URL the wizard just
 * verified, never a stale or production one. `RABET_TEST_PG_URL` is never
 * forwarded: it belongs to the disposable test cluster only.
 */
export function buildChildEnv(verifiedUrl, processEnv = process.env) {
  const env = {};

  for (const key of CHILD_ENV_ALLOWLIST) {
    if (processEnv[key] !== undefined && processEnv[key] !== null) {
      env[key] = processEnv[key];
    }
  }

  env.DATABASE_URL = verifiedUrl;

  return env;
}

// ---------------------------------------------------------------------------
// Interactive IO — the real terminal implementation. Tests inject a fake.
// ---------------------------------------------------------------------------

/**
 * Reads a line from a real terminal without echoing it.
 *
 * Raw mode is entered BEFORE the prompt is written, so no keystroke arriving in
 * response to the prompt can be echoed by the kernel's line discipline (the
 * same ordering the reviewed `scripts/generate-admin-hash.mjs` uses). Control
 * characters are handled explicitly because raw mode disables their default
 * behaviour. The terminal is always restored before the promise settles.
 */
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    const bytes = [];
    let settled = false;

    const restore = () => {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
      stdin.removeListener("close", onClose);

      try {
        stdin.setRawMode(false);
      } catch {
        // The stream may already be closed; the terminal restores itself.
      }

      stdin.pause();
    };

    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          // Ctrl-C: mirror a normal terminal interrupt.
          restore();
          stdout.write("\n");
          process.exit(130);
          return;
        }

        if (byte === 0x04) {
          // Ctrl-D: end of input; an empty line is a cancellation.
          if (bytes.length === 0) {
            restore();
            stdout.write("\n");
            console.error("Aborted: nothing was entered.");
            process.exit(1);
          }

          continue;
        }

        if (byte === 0x0d || byte === 0x0a) {
          // Enter: submit, decoded as UTF-8 in one piece.
          restore();
          stdout.write("\n");
          resolve(Buffer.from(bytes).toString("utf8"));
          return;
        }

        if (byte === 0x7f || byte === 0x08) {
          // DEL/Backspace: drop one whole UTF-8 character.
          while (bytes.length > 0) {
            const last = bytes[bytes.length - 1];

            bytes.pop();

            if (last <= 0x7f || last >= 0xc2) break;
          }

          continue;
        }

        if (byte === 0x15) {
          // Ctrl-U: clear the line.
          bytes.length = 0;
          continue;
        }

        bytes.push(byte);
      }
    };

    const onError = (error) => {
      restore();
      reject(error);
    };

    const onClose = () => {
      restore();
      reject(new Error("stdin closed before a value was submitted"));
    };

    stdin.on("data", onData);
    stdin.on("error", onError);
    stdin.on("close", onClose);
    // Raw mode first, then the prompt — see the docstring.
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(prompt);
  });
}

/** Parses a yes/no answer; an empty answer uses the default. */
export function parseYesNo(value, defaultValue = false) {
  const trimmed = String(value ?? "")
    .trim()
    .toLowerCase();

  if (trimmed === "") return defaultValue;

  return trimmed === "y" || trimmed === "yes";
}

/**
 * The terminal IO surface. Everything written is passed through {@link redact}
 * as a safety net, so no connection string can reach the screen by accident.
 *
 * One readline interface is created lazily and shared by every prompt. It is
 * deliberately not driven through `rl.question()`: on a piped stream the input
 * can end before the last prompt is asked, and `question()` on a closed
 * interface never calls back. Instead the prompt is written and the answer is
 * taken from the lines the interface has already buffered, from the next
 * `line` event, or — when the input has ended — as an empty string, which every
 * consumer treats as "use the default" or "cancel". That keeps scripted runs
 * and an interrupted pipe from hanging the wizard.
 */
export function createRealIo() {
  const output = [];
  let interface_ = null;
  let lineQueue = null;
  let pending = null;
  let closed = false;

  function open() {
    if (interface_ !== null) return interface_;

    interface_ = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    lineQueue = [];

    interface_.on("line", (line) => {
      if (pending !== null) {
        const resolve = pending;

        pending = null;
        resolve(line);
      } else {
        lineQueue.push(line);
      }
    });

    interface_.on("close", () => {
      closed = true;

      if (pending !== null) {
        const resolve = pending;

        pending = null;
        resolve("");
      }
    });

    return interface_;
  }

  function close() {
    if (interface_ !== null) {
      interface_.close();
      interface_ = null;
      lineQueue = null;
      pending = null;
      closed = false;
    }
  }

  /**
   * True once the input stream ended with no answer queued. The wizard uses
   * this to stop retrying when a session was interrupted (SSH died, a piped
   * input ran out) instead of answering its own "try again?" with the default.
   */
  function isInputExhausted() {
    return closed && (lineQueue === null || lineQueue.length === 0);
  }

  function write(text) {
    const safe = redact(String(text));

    output.push(safe);
    process.stdout.write(safe);
  }

  function line(text = "") {
    write(`${text}\n`);
  }

  function question(query) {
    return new Promise((resolve) => {
      open();
      process.stdout.write(query);

      if (lineQueue !== null && lineQueue.length > 0) {
        resolve(lineQueue.shift());
      } else if (closed) {
        resolve("");
      } else {
        pending = resolve;
      }
    });
  }

  async function prompt({ message, hidden = false, required = false }) {
    if (hidden) {
      const canHide =
        process.stdin.isTTY && typeof process.stdin.setRawMode === "function";

      if (canHide) {
        // Raw input manages stdin itself, so detach the line reader for the
        // duration of this prompt and let the next one re-open it.
        close();

        const value = await readHidden(message);

        if (required && value.trim() === "") {
          throw new CancelledError("No value was entered.");
        }

        return value.trim();
      }

      // Not a terminal: nothing echoes, so the value cannot be exposed and a
      // normal line prompt is safe (and scriptable) here.
    }

    const answer = await question(message);

    if (required && answer.trim() === "") {
      throw new CancelledError("No value was entered.");
    }

    return answer.trim();
  }

  async function confirm({ message, default: defaultValue = false }) {
    const hint = defaultValue ? "[Y/n]" : "[y/N]";
    const answer = await question(`${message} ${hint} `);

    return parseYesNo(answer, defaultValue);
  }

  async function confirmStrong({ message, expected }) {
    line(message);
    line(
      `Type the database name (${expected}) to confirm, or press Enter to stop:`,
    );

    const answer = await question("> ");

    return answer.trim() === expected;
  }

  return { write, line, prompt, confirm, confirmStrong, close, output, isInputExhausted };
}

/** Raised when the user cancels an interactive prompt. */
export class CancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = "CancelledError";
  }
}

// ---------------------------------------------------------------------------
// Database surface — the real Neon HTTP client. Tests inject a fake.
// ---------------------------------------------------------------------------

/**
 * Connects to Neon over HTTPS with the Neon serverless driver — the
 * application's runtime transport — and returns a read-only query surface.
 *
 * Used for the one check that is specific to that path: a read-only batch
 * through the real HTTP API. It cannot reach anything that is not a Neon HTTP
 * endpoint (a local cluster speaks the wire protocol, not this API), which is
 * why the wizard's inspection uses {@link createPostgresSql} instead.
 */
export function createNeonSql(url) {
  const sql = neon(url);

  return {
    async query(text, params = []) {
      return params.length > 0 ? sql.query(text, params) : sql.query(text);
    },

    async batch(statements, { readOnly = true } = {}) {
      const queries = statements.map((text) => sql.query(text));

      return sql.transaction(queries, { readOnly });
    },

    async close() {
      // The HTTP driver holds no connection, so there is nothing to close.
    },
  };
}

/**
 * Connects over the PostgreSQL wire protocol with `postgres` — the same driver
 * `drizzle-kit migrate` uses — and returns the read-only query surface.
 *
 * This is the wizard's inspection transport because it reaches any PostgreSQL
 * the migration command can reach, including Neon's **direct / unpooled**
 * endpoint (with `sslmode=require`, which the driver maps to TLS) and a local
 * cluster. The first query — not the constructor — is the first network call,
 * so a connection problem surfaces on the probe below.
 *
 * `query` runs one static SELECT. `batch` runs several statements in one
 * read-only transaction, mirroring the atomic request the application gets from
 * the Neon HTTP driver's `db.batch()` (ADR-015).
 */
export function createPostgresSql(url) {
  const sql = postgres(url, {
    max: 1,
    // Short enough to be actionable, long enough for a cold-starting endpoint.
    connect_timeout: 30,
    idle_timeout: 30,
  });

  return {
    async query(text, params = []) {
      return params.length > 0
        ? sql.unsafe(text, params)
        : sql.unsafe(text);
    },

    async batch(statements, { readOnly = true } = {}) {
      const mode = readOnly ? "read only" : "";

      // One transaction over the wire; a read-only one cannot write.
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

/** True when the URL points at a Neon endpoint the HTTP API can serve. */
export function isNeonHttpCapable(url) {
  const parsed = parsePgUrl(url);

  if (!parsed.ok) return false;

  return /\.neon\.tech$/i.test(parsed.host);
}

/**
 * Verifies the application's real runtime path — a read-only batch through
 * Neon's HTTP API — when the target can be served by it. For a target that
 * cannot (a local cluster, or any endpoint that is not Neon's HTTP API) the
 * check is reported as not applicable rather than failed: the wizard's own
 * wire-protocol inspection already proved the database works over the wire.
 *
 * Uses the injected {@link WizardCtx.httpConnect} surface, so the automated
 * tests drive this without any network access, exactly as they drive the wire
 * connection. The two checks are reported as separate result rows and are never
 * conflated: a wire-protocol success does not imply the HTTP API works, and an
 * HTTP failure does not undo the wire-protocol result above it.
 */
async function checkNeonHttpBatch(ctx, url) {
  if (!isNeonHttpCapable(url)) {
    record(ctx, "neon-http-batch", true, "not applicable to this endpoint");

    note(ctx, "✓ neon-http-batch — not applicable to this endpoint (the wire-protocol inspection above already proved it is reachable and read-only)");

    return;
  }

  try {
    const http = ctx.httpConnect(url);
    const batch = await http.batch(
      [QUERIES.selectOne, QUERIES.currentDatabase],
      { readOnly: true },
    );

    await http.close();

    const ok =
      Array.isArray(batch) &&
      batch.length === 2 &&
      Number(batch[0]?.[0]?.result) === 1 &&
      typeof batch[1]?.[0]?.name === "string";

    record(ctx, "neon-http-batch", ok, ok ? "read-only batch over the Neon HTTP API" : "unexpected batch result");

    if (!ok) note(ctx, "✗ neon-http-batch — the batch returned an unexpected shape");
  } catch (error) {
    record(ctx, "neon-http-batch", false, redact(String(error.message ?? error)));
    note(ctx, `✗ neon-http-batch — ${redact(String(error.message ?? error))}`);
  }
}

/** Connects, retrying transient failures with a bounded backoff. */
export async function connectWithRetry(
  connect,
  url,
  { attempts = CONNECT_MAX_ATTEMPTS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRetry } = {},
) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const sql = await connect(url);

      // A construction that does no I/O is not proof of reachability: probe it.
      await sql.query(QUERIES.selectOne);

      return { ok: true, sql };
    } catch (error) {
      lastError = error;

      if (attempt < attempts) {
        const backoff = 500 * 2 ** (attempt - 1);

        if (onRetry) onRetry({ attempt, backoff, error: lastError });

        await sleep(backoff);
      }
    }
  }

  return { ok: false, error: lastError };
}

/**
 * Turns a connection error into actionable, credential-free guidance. The
 * connection string itself is never included.
 */
export function describeConnectionError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();

  if (/password|authentication|auth failed|28p01|invalid credentials/.test(message)) {
    return (
      "The database rejected the credentials. The password or the username is " +
      "wrong, or the string was copied incompletely. In the Neon dashboard: " +
      "Rabet_dev → Connection Details → 'Direct connection' tab → reset the " +
      "password or copy the whole string again. The wizard never prints the " +
      "value you pasted."
    );
  }

  if (/fetch failed|enotfound|econnrefused|getaddrinfo|network|timeout|socket hang up|epipe|econnreset/.test(
    message,
  )) {
    return (
      "The database could not be reached (network error). This is usually " +
      "transient: the VPS lost its route to Neon, or the endpoint is cold " +
      "starting. The wizard retries automatically; if it keeps failing, check " +
      "the host in the connection string and the VPS's outbound network. The " +
      "value you pasted is never printed."
    );
  }

  if (/does not exist|3d000|invalid catalog name/.test(message)) {
    return (
      "The connection reached Neon but the database name in the string does " +
      "not exist on that endpoint. In the Neon dashboard: Rabet_dev → " +
      "Connection Details → pick the branch → copy the string for that branch."
    );
  }

  return (
    "Could not connect to the database. The error carried no credential, and " +
    "the connection string is never printed. Check the Neon dashboard " +
    "(Rabet_dev → Connection Details → 'Direct connection') and paste the " +
    "string again. Detail: " +
    redact(String(error?.message ?? error)).slice(0, 200)
  );
}

// ---------------------------------------------------------------------------
// Subprocess surface — the real implementation. Tests inject a fake.
// ---------------------------------------------------------------------------

/**
 * Runs a command, capturing its output. stdout/stderr are streamed to the
 * caller through {@link redact} so a tool that echoes a connection string can
 * never put one on screen, and are returned for interpretation.
 */
export function runCommandReal({
  command,
  args = [],
  env,
  cwd,
  onOutput,
}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const stdout = [];
    const stderr = [];

    const emit = (stream, chunks) => (chunk) => {
      const text = chunk.toString("utf8");
      const safe = redact(text);

      chunks.push(safe);

      if (onOutput) onOutput(safe);
    };

    child.stdout.on("data", emit(child.stdout, stdout));
    child.stderr.on("data", emit(child.stderr, stderr));

    child.on("error", (error) => {
      resolve({
        code: 1,
        signal: null,
        stdout: stdout.join(""),
        stderr: [stderr.join(""), redact(String(error.stack ?? error.message))]
          .filter(Boolean)
          .join("\n"),
        error,
      });
    });

    child.on("close", (code, signal) => {
      resolve({
        code: code ?? 1,
        signal,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Repository checks
// ---------------------------------------------------------------------------

/** Normalizes a git remote URL so both HTTPS and SSH forms compare equal. */
export function normalizeRemote(url) {
  return String(url ?? "")
    .trim()
    .toLowerCase()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "");
}

function lineToPath(line) {
  return String(line).trim().split(/\s+/).pop() ?? "";
}

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------

/**
 * Runs the whole setup.
 *
 * Every external surface is injected: `io` (prompts and output), `connect`
 * (database over the wire protocol), `httpConnect` (the Neon HTTP API),
 * `runCommand` (git/npm/drizzle-kit) and `sleep`. That is what lets the
 * automated tests drive every branch with mocks, and it is why the function
 * itself never touches `process.stdin`, `fetch` or `spawn` directly. The two
 * database surfaces are kept separate because they are different transports:
 * the wire protocol is what `drizzle-kit migrate` speaks, and the HTTP API is
 * what the application speaks at runtime — the wizard validates both and
 * reports them separately.
 *
 * Returns a result the CLI turns into the final report; tests assert on it.
 */
export async function runWizard({
  io,
  connect,
  httpConnect = createNeonSql,
  runCommand,
  options = {},
  root = process.cwd(),
  env = process.env,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const ctx = {
    io,
    connect,
    httpConnect,
    runCommand,
    root,
    env,
    options,
    sleep,
    sql: null,
    url: null,
    target: null,
    writes: { migrationsApplied: [], envLocalSaved: false, envLocalPath: null },
    checks: [],
    outcome: null,
    ok: false,
  };

  const step = (index, name, fn) => fn();

  try {
    await step(1, "Checking project", () => runCheckProject(ctx));
    if (ctx.outcome || hasBlockingProblems(ctx)) return finalize(ctx);

    await step(2, "Checking local dependencies", () => runCheckDependencies(ctx));
    if (ctx.outcome || hasBlockingProblems(ctx)) return finalize(ctx);

    await step(3, "Connecting to Neon", () => runConnect(ctx));
    if (ctx.outcome) return finalize(ctx);

    await step(4, "Inspecting database state", () => runInspect(ctx));
    if (ctx.outcome) return finalize(ctx);

    await step(5, "Reviewing migrations", () => runReview(ctx));
    if (ctx.outcome) return finalize(ctx);

    if (options.check) {
      ctx.outcome = ctx.problems?.length ? "preflight-issues" : "preflight-ok";
      ctx.ok = !ctx.problems?.length;
      return finalize(ctx);
    }

    await step(6, "Applying approved changes", () => runApply(ctx));
    if (ctx.outcome) return finalize(ctx);

    await step(7, "Validating results", () => runValidate(ctx));
    if (ctx.outcome) return finalize(ctx);

    await runOptionalEnvLocal(ctx);

    if (options.vercelPreview) {
      await runVercelPreviewStep(ctx);
    }

    ctx.outcome = "configured";
    ctx.ok = true;
  } catch (error) {
    if (error instanceof CancelledError) {
      ctx.outcome = "cancelled";
      ctx.ok = false;
      io.line("");
      io.line("Cancelled. No changes were made to the database.");
    } else {
      ctx.outcome = "failed";
      ctx.ok = false;
      io.line("");
      io.line(`Setup stopped: ${redact(String(error.message ?? error))}`);
      io.line(
        "No changes were made unless a step above says it completed. Re-run " +
          "the wizard to inspect the actual database state; it never repeats " +
          "work it can prove is already done.",
      );
    }
  } finally {
    try {
      await ctx.sql?.close();
    } catch {
      // Closing is best-effort; the HTTP driver holds nothing open.
    }
  }

  return finalize(ctx);
}

function hasBlockingProblems(ctx) {
  if (!ctx.problems || ctx.problems.length === 0) return false;

  ctx.io.line("");
  ctx.io.line("  Stopping before any database write:");

  for (const problem of ctx.problems) {
    ctx.io.line(`  ✗ ${problem}`);
  }

  ctx.outcome = "failed";
  ctx.ok = false;

  return true;
}

function header(ctx, index, name) {
  ctx.io.line("");
  ctx.io.line(`[${index}/7] ${name}…`);
}

function note(ctx, text) {
  ctx.io.line(`  ${text}`);
}

/** Records a named check result for the final report. */
function record(ctx, name, passed, detail = "") {
  ctx.checks.push({ name, passed: Boolean(passed), detail });
}

// --- Step 1: the project itself --------------------------------------------

async function runCheckProject(ctx) {
  const { io, runCommand, root } = ctx;

  header(ctx, 1, "Checking project");

  const problems = [];
  ctx.problems = problems;

  // The wizard must be running inside the Rabet repository.
  const hasPackageJson = fs.existsSync(path.join(root, "package.json"));
  const hasMigrations = fs.existsSync(path.join(root, "drizzle", "meta", "_journal.json"));

  if (!hasPackageJson) {
    problems.push(
      "No package.json here — run the wizard from the Rabet repository root.",
    );
  }

  if (!hasMigrations) {
    problems.push(
      "No drizzle/meta/_journal.json here — the committed migrations are " +
        "missing. Run the wizard from the Rabet repository root on the branch " +
        "that has them.",
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) note(ctx, `✗ ${problem}`);

    return;
  }

  // GitHub repository identity.
  const remote = await runCommand({
    command: "git",
    args: ["remote", "get-url", "origin"],
    cwd: root,
  });

  if (remote.code !== 0) {
    problems.push(
      "Could not read the git remote (is this a git checkout?). The wizard " +
        "verifies the repository identity before touching any database.",
    );
  } else {
    const normalized = normalizeRemote(remote.stdout);

    if (!normalized.includes(EXPECTED_REPO)) {
      problems.push(
        `The git remote is ${redact(remote.stdout).trim()}, which is not the ` +
          `Rabet repository (${EXPECTED_REPO}). The wizard refuses to migrate ` +
          "a database from an unrelated checkout.",
      );
    } else {
      note(ctx, `Repository   ${EXPECTED_REPO} ✓`);
    }
  }

  // Working directory: the repository root, and clean where it matters.
  const toplevel = await runCommand({
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd: root,
  });

  if (toplevel.code === 0) {
    const resolvedRoot = path.resolve(root);
    const resolvedTop = path.resolve(toplevel.stdout.trim());

    if (resolvedRoot !== resolvedTop) {
      note(
        ctx,
        `Working directory is inside the checkout (${path.basename(resolvedTop)}); the wizard uses ${resolvedRoot}.`,
      );
    }
  }

  const status = await runCommand({
    command: "git",
    args: ["status", "--porcelain"],
    cwd: root,
  });

  const dirty = status.code === 0
    ? status.stdout
        .split("\n")
        .map((line) => lineToPath(line))
        .filter((line) => line.length > 0)
    : [];

  if (dirty.length > 0) {
    const risky = dirty.filter((file) =>
      /^(drizzle\/|package\.json$|package-lock\.json$|drizzle\.config\.ts$|src\/db\/)/.test(
        file,
      ),
    );

    if (risky.length > 0) {
      note(
        ctx,
        `! Uncommitted changes affect the migration chain: ${risky.join(", ")}`,
      );
      note(
        ctx,
        "  The wizard applies the COMMITTED files in drizzle/. Commit or stash " +
          "first so the database matches a reviewable revision.",
      );

      const proceed = await io.confirm({
        message: "Continue with uncommitted migration changes present?",
        default: false,
      });

      if (!proceed) {
        ctx.outcome = "cancelled";
        return;
      }
    } else {
      note(ctx, `Working tree has ${dirty.length} uncommitted file(s) (not migration-related).`);
    }
  } else {
    note(ctx, "Working tree clean ✓");
  }

  // Record the exact revision in the report.
  const revision = await runCommand({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: root,
  });

  ctx.revision = revision.code === 0 ? revision.stdout.trim() : "unknown";

  // Node.js and npm.
  const nodeVersion = process.versions.node;
  const major = Number(nodeVersion.split(".")[0]);

  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    problems.push(
      `Node.js ${nodeVersion} is too old. The wizard needs Node.js ${MIN_NODE_MAJOR}+ ` +
        "(Node.js 22 is what CI uses).",
    );
  } else {
    const npmVersion = await runCommand({
      command: "npm",
      args: ["--version"],
      cwd: root,
    });
    const npm = npmVersion.code === 0 ? npmVersion.stdout.trim() : "unknown";

    note(
      ctx,
      `Node.js      ${nodeVersion} ✓${major < RECOMMENDED_NODE_MAJOR ? " (22 recommended)" : ""}  (npm ${npm})`,
    );

    if (major < RECOMMENDED_NODE_MAJOR) {
      note(
        ctx,
        "! CI runs Node.js 22; migrating from an older runtime is allowed but " +
          "re-run on 22 before trusting the result.",
      );
    }
  }

  // The committed migration chain on disk.
  const files = verifyMigrationFiles(root);

  if (!files.ok) {
    for (const problem of files.problems) problems.push(problem);

    return;
  }

  const tags = files.journal.entries.map((entry) => entry.tag);

  note(
    ctx,
    `Migrations   ${tags.length} committed (${tags.join(", ")}) — journal + snapshots ✓`,
  );

  ctx.journal = files.journal;
  ctx.committedHashes = computeMigrationHashes(root);

  record(ctx, "project", problems.length === 0);

  if (problems.length > 0) {
    for (const problem of problems) note(ctx, `✗ ${problem}`);
  }
}

// --- Step 2: local dependencies --------------------------------------------

async function runCheckDependencies(ctx) {
  const { io, runCommand, root } = ctx;

  header(ctx, 2, "Checking local dependencies");

  const problems = [];
  const nodeModules = path.join(root, "node_modules");

  const has = (pkg) => fs.existsSync(path.join(nodeModules, pkg, "package.json"));

  const missing = [
    "@neondatabase/serverless",
    "drizzle-kit",
    "drizzle-orm",
  ].filter((pkg) => !has(pkg));

  if (missing.length > 0) {
    if (!fs.existsSync(nodeModules)) {
      note(ctx, "node_modules is missing.");
    } else {
      note(ctx, `Missing packages: ${missing.join(", ")}`);
    }

    const install = await io.confirm({
      message:
        "Install the committed dependencies with `npm ci`? (package-lock.json is not modified)",
      default: true,
    });

    if (!install) {
      problems.push(
        "Required dependencies are missing and installation was declined. " +
          "Run `npm ci` in the repository root, then re-run the wizard.",
      );

      record(ctx, "dependencies", false);
      ctx.problems.push(...problems);

      return;
    }

    note(ctx, "Running npm ci…");

    const installed = await runCommand({
      command: "npm",
      args: ["ci"],
      cwd: root,
      onOutput: (chunk) => process.stdout.write(chunk),
    });

    if (installed.code !== 0) {
      problems.push(
        "`npm ci` failed. Resolve the error above and re-run the wizard; " +
          "package-lock.json was not modified.",
      );

      record(ctx, "dependencies", false);
      ctx.problems.push(...problems);

      return;
    }

    note(ctx, "Dependencies installed ✓");
  } else {
    note(ctx, "node_modules, drizzle-kit, @neondatabase/serverless ✓");
  }

  record(ctx, "dependencies", true);
}

// --- Step 3: connect to Neon ------------------------------------------------

async function runConnect(ctx) {
  const { io, connect, env } = ctx;

  header(ctx, 3, "Connecting to Neon");

  let rawUrl = null;

  // An already-exported DATABASE_URL can be reused without re-typing it; it is
  // still verified exactly like a pasted one.
  if (typeof env.DATABASE_URL === "string" && env.DATABASE_URL.trim() !== "") {
    note(ctx, "DATABASE_URL is already set in this shell.");

    const useEnv = await io.confirm({
      message: "Use it (it is verified and never printed)?",
      default: true,
    });

    if (useEnv) rawUrl = env.DATABASE_URL;
  }

  if (rawUrl === null) {
    note(ctx, "Paste the DIRECT (unpooled) connection string for the dedicated");
    note(ctx, `${EXPECTED_NEON_PROJECT} project. In the Neon dashboard:`);
    note(ctx, "  Rabet_dev → Connection Details → 'Direct connection' tab →");
    note(ctx, "  Connection string. (Input is hidden — it contains a password.)");

    rawUrl = await io.prompt({
      message: "URL: ",
      hidden: true,
      required: true,
    });
  }

  const validation = validateConnectionUrl(rawUrl);

  if (!validation.ok) {
    io.line("");
    io.line(`  ✗ ${validation.error}`);

    ctx.outcome = "failed";
    ctx.ok = false;
    return;
  }

  for (const warning of validation.warnings) {
    note(ctx, `! ${warning}`);
  }

  const url = validation.url;
  const parsed = parsePgUrl(url);

  // Neon's pooled endpoint cannot run DDL through drizzle-kit reliably; the
  // migration needs the direct connection. Warn, and let the owner re-paste.
  if (/-pooler/.test(parsed.host)) {
    note(ctx, "! This looks like Neon's POOLED endpoint (the host contains");
    note(ctx, "  '-pooler'). `drizzle-kit migrate` needs the DIRECT / unpooled");
    note(ctx, "  connection, or the DDL can fail inside the pooler.");

    const accept = await io.confirm({
      message: "Use this pooled URL anyway?",
      default: false,
    });

    if (!accept) {
      const again = await io.confirm({
        message: "Paste the direct (unpooled) URL instead?",
        default: true,
      });

      if (!again) {
        ctx.outcome = "cancelled";
        return;
      }

      rawUrl = await io.prompt({
        message: "URL: ",
        hidden: true,
        required: true,
      });

      const revalidated = validateConnectionUrl(rawUrl);

      if (!revalidated.ok) {
        io.line("");
        io.line(`  ✗ ${revalidated.error}`);
        ctx.outcome = "failed";
        ctx.ok = false;
        return;
      }

      return runConnectWith(ctx, connect, revalidated);
    }
  }

  return runConnectWith(ctx, connect, validation);
}

async function runConnectWith(ctx, connect, validation, manualAttempt = 1) {
  const { io } = ctx;
  const url = validation.url;
  const parsed = parsePgUrl(url);

  const connection = await connectWithRetry(
    connect,
    url,
    {
      sleep: ctx.sleep,
      onRetry: ({ attempt, backoff }) => {
        note(
          ctx,
          `Connection attempt ${attempt} failed; retrying in ${Math.round(backoff / 100) / 10}s…`,
        );
      },
    },
  );

  if (!connection.ok) {
    io.line("");
    io.line(`  ✗ ${describeConnectionError(connection.error)}`);

    // An interrupted session leaves stdin ended; a confirm would then answer
    // with its default ("yes") and loop forever. Stop the moment the input is
    // gone, and never ask more than the bounded number of times anyway.
    const inputGone = typeof io.isInputExhausted === "function" && io.isInputExhausted();
    const retriesLeft = manualAttempt < MAX_MANUAL_CONNECT_RETRIES;

    if (inputGone) {
      io.line("");
      io.line(
        "  Input ended (the session was interrupted). Stopping without a " +
          "connection; nothing was written. Re-run the wizard to try again.",
      );

      ctx.outcome = "failed";
      ctx.ok = false;
      return;
    }

    if (!retriesLeft) {
      io.line("");
      io.line(
        "  Still unreachable after several attempts. Stopping rather than " +
          "looping; nothing was written. Check the endpoint and the VPS's " +
          "outbound network, then re-run the wizard.",
      );

      ctx.outcome = "failed";
      ctx.ok = false;
      return;
    }

    const retry = await io.confirm({
      message: "Try connecting again (a new attempt, same URL)?",
      default: true,
    });

    if (!retry) {
      ctx.outcome = "failed";
      ctx.ok = false;
      return;
    }

    return runConnectWith(ctx, connect, validation, manualAttempt + 1);
  }

  const sql = connection.sql;

  ctx.sql = sql;
  ctx.url = url;

  // Non-sensitive metadata only. The endpoint is masked, the password never
  // leaves the string.
  const [dbNameRow, versionRow, userRow] = await Promise.all([
    sql.query(QUERIES.currentDatabase).catch(() => [{ name: null }]),
    sql.query(QUERIES.pgVersion).catch(() => [{ version: null }]),
    sql.query(QUERIES.currentUser).catch(() => [{ name: null }]),
  ]);

  const dbName = dbNameRow[0]?.name ?? parsed.dbname;
  const pgVersion = String(versionRow[0]?.version ?? "unknown");
  const role = userRow[0]?.name ?? "unknown";

  ctx.target = {
    dbName,
    pgVersion,
    role,
    endpoint: maskEndpoint(parsed.host),
    tls: isInternalHost(parsed.host) ? "local" : "required",
  };

  io.line("  Connected. Target metadata (read-only):");
  note(ctx, `Database      ${dbName}`);
  note(ctx, `PostgreSQL    ${pgVersion.split(",").slice(0, 1).join("")}`);
  note(ctx, `Role          ${role}`);
  note(ctx, `Endpoint      ${ctx.target.endpoint}`);
  note(ctx, `TLS           ${ctx.target.tls} ✓`);

  // The connection target is confirmed against the owner's dashboard before any
  // write. Naming alone proves nothing, so this is always an explicit answer.
  const looksNonDev = /prod|production|live|primary/.test(String(dbName).toLowerCase());

  if (looksNonDev) {
    io.line("");
    io.line(
      "  ! The database name suggests a non-development target. A name is not",
    );
    io.line(
      "    proof of environment — a branch named 'production' inside a dev-only",
    );
    io.line(
      "    project is not the Rabet production database. Confirm from the Neon",
    );
    io.line("    dashboard which project and branch this URL belongs to.");
  }

  const confirmed = await io.confirm({
    message: `Confirm this is the dedicated ${EXPECTED_NEON_PROJECT} development database?`,
    default: false,
  });

  if (!confirmed) {
    io.line(
      "  Stopped: the target was not confirmed. The wizard made no changes. " +
        "Re-run it with the dedicated development connection string.",
    );

    ctx.outcome = "cancelled";
    return;
  }

  ctx.target.environment = "DEVELOPMENT";

  record(ctx, "connection", true);
}

// --- Step 4: inspect the database ------------------------------------------

async function runInspect(ctx) {
  const { io, sql } = ctx;

  header(ctx, 4, "Inspecting database state");

  const tableRows = await sql.query(QUERIES.appTables).catch(() => []);
  const appTables = tableRows.map((row) => String(row.name));

  const appliedRows = await sql
    .query(QUERIES.drizzleMigrations)
    .catch(() => []); // no drizzle schema yet → empty database

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

  ctx.state = state;

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

  note(ctx, `Application data rows: ${state.totalRows}`);

  if (state.status === "drift" || state.status === "inconsistent") {
    io.line("");
    io.line(`  ✗ ${state.stopReason}`);
    io.line(
      "  Stopped for manual review. The wizard does not repair drift, drop " +
        "tables or reset branches. Take a Neon snapshot before any manual fix.",
    );

    ctx.outcome = "manual-review";
    ctx.ok = false;
    return;
  }

  if (state.hasData) {
    note(
      ctx,
      `! Existing application data detected (${state.totalRows} rows). Strong`,
    );
    note(
      ctx,
      "  confirmation will be required before any migration, and a Neon",
    );
    note(ctx, "  snapshot is recommended before proceeding.");
  }

  record(ctx, "inspection", true);
}

// --- Step 5: review the migrations -----------------------------------------

async function runReview(ctx) {
  const { io, runCommand, root, state } = ctx;

  header(ctx, 5, "Reviewing migrations");

  io.line("  Committed chain:");

  for (const entry of ctx.journal.entries) {
    const applied = !state.pending.includes(entry.tag);

    note(ctx, `${entry.tag} ${applied ? "applied" : "pending"}`);
  }

  // drizzle-kit check compares the committed journal and snapshots. It is a
  // consistency check of the repository metadata, NOT a preview of the SQL that
  // will run on the target — it reports success even on an empty database — so
  // it is never advertised as a dry-run here.
  const check = await runCommand({
    command: "npm",
    args: ["run", "db:check"],
    cwd: root,
    env: buildChildEnv(ctx.url, ctx.env),
    onOutput: (chunk) => process.stdout.write(chunk),
  });

  if (check.code === 0) {
    note(ctx, "drizzle-kit check: committed journal + snapshots are consistent ✓");
    record(ctx, "migration-check", true);
  } else {
    const stderr = String(check.stderr ?? "");

    if (/drizzle\.\w+__drizzle_migrations|relation .* does not exist/i.test(stderr)) {
      note(
        ctx,
        "drizzle-kit check could not read a migration table yet (this database",
      );
      note(
        ctx,
        "  has none) — consistent with an empty target; the chain is applied below.",
      );
      record(ctx, "migration-check", true, "no migrations table yet");
    } else {
      io.line("");
      io.line("  ✗ drizzle-kit check reported a problem (schema/migration drift).");
      io.line(`    ${stderr.split("\n").filter(Boolean).slice(-3).join("\n    ")}`);
      io.line(
        "    Stopped for manual review. Regenerate and commit migrations with " +
          "`npm run db:generate`, or restore the Neon branch snapshot.",
      );

      record(ctx, "migration-check", false);
      ctx.outcome = "manual-review";
      ctx.ok = false;
      return;
    }
  }

  io.line("");
  io.line("  Read-only inspection summary (no writes have happened yet):");
  note(ctx, `Target       ${ctx.target.dbName}`);
  note(ctx, `Environment  DEVELOPMENT (dedicated ${EXPECTED_NEON_PROJECT})`);
  note(ctx, `Pending      ${state.pending.length} migration(s)${state.pending.length ? ` (${state.pending.join(", ")})` : ""}`);
  note(ctx, `Existing data ${state.hasData ? `${state.totalRows} rows` : "none"}`);
  note(
    ctx,
    `Revision      ${String(ctx.revision).slice(0, 12)}`,
  );

  record(ctx, "review", true);
}

// --- Step 6: apply, only after explicit approval ----------------------------

async function runApply(ctx) {
  const { io, runCommand, root, state } = ctx;

  header(ctx, 6, "Applying approved changes");

  // Idempotency: nothing to do when the dedicated database is already set up.
  if (state.status === "configured") {
    note(ctx, "Development database is already configured.");
    note(ctx, "No migrations are pending, so nothing is written. Validating instead.");
    record(ctx, "apply", true, "already configured");

    return;
  }

  if (state.pending.length === 0) {
    note(ctx, "No migrations are pending — nothing to write.");
    record(ctx, "apply", true, "nothing pending");

    return;
  }

  io.line("");
  io.line(`  Target:      ${ctx.target.dbName}`);
  io.line(`  Environment: DEVELOPMENT`);
  io.line(`  Pending migrations: ${state.pending.length}`);
  io.line("");

  const approved = await io.confirm({
    message: "Proceed with migrations?",
    default: false,
  });

  if (!approved) {
    io.line("  Not approved. No changes were made to the database.");
    ctx.outcome = "cancelled";
    return;
  }

  // Existing application data demands a stronger, deliberate confirmation: the
  // typed database name proves the operator is looking at the right target.
  if (state.hasData) {
    const strong = await io.confirmStrong({
      message:
        "  Existing application data was detected on this database. Migrating " +
        "it is usually fine, but a wrong target is not recoverable without the " +
        "Neon snapshot. Take one first if you have not.",
      expected: ctx.target.dbName,
    });

    if (!strong) {
      io.line("  Confirmation did not match. No changes were made.");
      ctx.outcome = "cancelled";
      return;
    }
  }

  // The verified development URL is the only credential in the child env, and
  // it wins over any DATABASE_URL in .env.local (drizzle.config.ts keeps
  // already-set environment keys). Never drizzle-kit push; never regenerated SQL.
  const beforeTags = ctx.state.appliedCount > 0
    ? ctx.journal.entries.slice(0, ctx.state.appliedCount).map((entry) => entry.tag)
    : [];

  note(ctx, "Running npm run db:migrate with the verified development URL…");
  note(
    ctx,
    "The wizard verifies the real database state afterwards rather than trusting",
  );
  note(
    ctx,
    "the command's exit code alone — drizzle-kit can exit non-zero silently.",
  );

  const migration = await runCommand({
    command: "npm",
    args: ["run", "db:migrate"],
    cwd: root,
    env: buildChildEnv(ctx.url, ctx.env),
    onOutput: (chunk) => process.stdout.write(chunk),
  });

  if (migration.code !== 0) {
    await reportMigrationFailure(ctx, migration);

    return;
  }

  // Verify what actually landed instead of trusting the exit code, and learn
  // what is still pending. A migration that recorded nothing and built nothing
  // is safe to retry; anything ambiguous stops for manual review.
  const after = await inspectApplied(ctx);

  // The report below describes the database as it is now, not as it was at
  // inspection time, so the header does not under-report a run that succeeded.
  ctx.state = after.state;

  // Report only what this run applied, not the whole applied prefix.
  ctx.writes.migrationsApplied = after.appliedTags.filter(
    (tag) => !beforeTags.includes(tag),
  );

  if (after.stopReason) {
    io.line("");
    io.line(`  ✗ ${after.stopReason}`);
    io.line(
      "  Stopped for manual review. The wizard does not retry an ambiguous " +
        "partial result and never claims success after an incomplete operation.",
    );

    ctx.outcome = "manual-review";
    ctx.ok = false;
    return;
  }

  const stillPending = after.state.pending;

  if (stillPending.length > 0) {
    io.line("");
    io.line(
      `  ! The command exited 0 but ${stillPending.length} migration(s) are still pending: ${stillPending.join(", ")}.`,
    );
    io.line(
      "    Inspect the database and the journal (see the report below); do not " +
        "blindly re-run.",
    );

    ctx.outcome = "manual-review";
    ctx.ok = false;
    return;
  }

  note(ctx, `${after.appliedTags.length} migration(s) applied ✓`);
  record(ctx, "apply", true, after.appliedTags.join(", "));
}

async function reportMigrationFailure(ctx, migration) {
  const { io } = ctx;
  const after = await inspectApplied(ctx);

  io.line("");
  io.line(`  ✗ npm run db:migrate exited with code ${migration.code}.`);

  // drizzle-kit 0.31 renders its progress with a terminal library that clears
  // the line on failure, so its output regularly shows the spinner and nothing
  // else — both on a terminal and piped. The wizard therefore diagnoses from
  // the database itself, which is authoritative, instead of from that output.
  const output = [migration.stdout, migration.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();

  if (output.length > 0) {
    io.line(`  drizzle-kit output (last lines):`);
    for (const line of output.split("\n").slice(-4)) {
      io.line(`    ${line}`);
    }
  } else {
    io.line(
      "  drizzle-kit printed no error detail (its terminal renderer clears the",
    );
    io.line(
      "  failing line), so the wizard inspects the database to diagnose it.",
    );
  }

  // A probe that fails now means the connection itself died mid-run (a cold
  // start, a dropped route, a rotated password) rather than a bad SQL statement.
  let reachable = true;

  try {
    await ctx.sql.query(QUERIES.selectOne);
  } catch (error) {
    reachable = false;
    io.line("");
    io.line(`  ✗ ${describeConnectionError(error)}`);
  }

  io.line("");

  if (after.state.status === "empty" && after.appliedCount === 0) {
    if (reachable) {
      io.line(
        "  Nothing was recorded as applied and no application tables were built,",
      );
      io.line(
        "  so this database is still empty. The failing statement is almost",
      );
      io.line(
        "  certainly a permission problem on this role (it may connect but not",
      );
      io.line(
        "  create objects). In the Neon dashboard, check the role's grants for",
      );
      io.line(
        "  the Rabet_dev branch; then re-run the wizard, which applies the",
      );
      io.line("  chain from the beginning and repeats nothing already done.");
    } else {
      io.line(
        "  The connection failed during the run and nothing was applied, so the",
      );
      io.line(
        "  database is still empty. Fix the connectivity problem above and",
      );
        io.line("  re-run the wizard.");
    }
  } else {
    io.line(`  Applied so far: ${after.appliedCount} of ${after.state.journalCount}.`);
    io.line(
      "  Stopped for manual review — do not blindly re-run. Inspect",
      );
    io.line(
      "  drizzle.__drizzle_migrations and the tables in the Neon console, or",
      );
    io.line(
      "  restore the Neon branch snapshot, then re-run the wizard to inspect",
      );
    io.line("  the real state before deciding.");
  }

  ctx.outcome = "failed";
  ctx.ok = false;
}

/** Read-only re-inspection of the journal and tables after a migration run. */
async function inspectApplied(ctx) {
  const tableRows = await ctx.sql.query(QUERIES.appTables).catch(() => []);
  const appTables = tableRows.map((row) => String(row.name));
  const appliedRows = await ctx.sql.query(QUERIES.drizzleMigrations).catch(() => []);

  const state = classifyDbState({
    appTables,
    appliedMigrations: appliedRows,
    committedHashes: ctx.committedHashes,
    journal: ctx.journal,
    totalRows: 0,
  });

  const appliedTags = ctx.journal.entries
    .slice(0, state.appliedCount)
    .map((entry) => entry.tag);

  return { state, appliedCount: state.appliedCount, appliedTags, stopReason: state.stopReason };
}

// --- Step 7: validate the result -------------------------------------------

async function runValidate(ctx) {
  const { io, sql } = ctx;

  header(ctx, 7, "Validating results");

  const tableRows = await sql.query(QUERIES.appTables);
  const tables = tableRows.map((row) => String(row.name));
  const tableSet = new Set(tables);

  const missing = EXPECTED_TABLES.filter((name) => !tableSet.has(name));
  const unknown = tables.filter((name) => !EXPECTED_TABLES.includes(name));
  const tablesOk = missing.length === 0 && unknown.length === 0;

  record(ctx, "tables", tablesOk, missing.length ? `missing ${missing.join(", ")}` : "14/14");

  // The applied hashes must equal the committed files' sha256 values, in order.
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
    historyOk ? "matches committed files" : `${applied.length} applied / ${expectedHashes.length} committed`,
  );

  const indexRows = await sql.query(QUERIES.indexes).catch(() => []);
  const indexSet = new Set(indexRows.map((row) => String(row.name)));
  const missingIndexes = EXPECTED_INDEXES.filter((name) => !indexSet.has(name));

  record(
    ctx,
    "indexes",
    missingIndexes.length === 0,
    missingIndexes.length ? `missing ${missingIndexes.join(", ")}` : `${EXPECTED_INDEXES.length}/${EXPECTED_INDEXES.length}`,
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
    missingConstraints.length ? `missing ${missingConstraints.join(", ")}` : `${CRITICAL_CONSTRAINTS.length}/${CRITICAL_CONSTRAINTS.length}`,
  );

  const treeRows = await sql.query(QUERIES.treeFks).catch(() => []);
  const treeSet = new Set(treeRows.map((row) => String(row.name)));
  const trees = Object.entries(EXPECTED_TREE_FKS).map(([tree, fk]) => ({
    tree,
    fk,
    ok: treeSet.has(fk),
  }));
  const treesOk = trees.every((entry) => entry.ok);

  record(
    ctx,
    "recursive-trees",
    treesOk,
    trees.map((entry) => `${entry.tree} ${entry.ok ? "✓" : "✗"}`).join(", "),
  );

  const one = await sql.query(QUERIES.selectOne).catch(() => []);
  const selectOk = Number(one[0]?.result) === 1;

  record(ctx, "select-1", selectOk);

  // A read-only batched query over the connection the wizard actually holds —
  // several statements in one transaction that cannot write.
  let wireBatchOk = false;

  try {
    const batch = await sql.batch(
      [QUERIES.selectOne, QUERIES.currentDatabase],
      { readOnly: true },
    );

    wireBatchOk =
      Array.isArray(batch) &&
      batch.length === 2 &&
      Number(batch[0]?.[0]?.result) === 1 &&
      typeof batch[1]?.[0]?.name === "string";
  } catch (error) {
    record(
      ctx,
      "batch-read-only",
      false,
      redact(String(error.message ?? error)),
    );
  }

  if (wireBatchOk) {
    record(ctx, "batch-read-only", true, "2 statements in one read-only transaction");
  }

  // A genuine read-only batch — the same request shape the application's
  // atomic writes use, exercised read-only. Over the Neon HTTP API when the
  // target can be served by it; the wire-protocol transaction above already
  // proved the database is reachable and read-only in every case.
  await checkNeonHttpBatch(ctx, ctx.url);

  for (const check of ctx.checks) {
    note(
      ctx,
      `${check.passed ? "✓" : "✗"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`,
    );
  }

  const failed = ctx.checks.filter((check) => !check.passed);

  if (failed.length > 0) {
    io.line("");
    io.line(
      `  ✗ ${failed.length} validation check(s) failed. The database may be usable,`,
    );
    io.line(
      "    but the wizard does not report success unless every check passes.",
    );
    io.line("    Inspect the failing objects, or restore the Neon branch snapshot.");

    ctx.outcome = "failed";
    ctx.ok = false;
    return;
  }

  record(ctx, "validation", true);
}

// --- Optional: persist the development URL locally --------------------------

async function runOptionalEnvLocal(ctx) {
  const { io, root, url } = ctx;

  const target = path.join(root, ".env.local");
  const existing = fs.existsSync(target);
  const existingUrl = readEnvLocalUrl(target);

  io.line("");

  if (existing && existingUrl !== null) {
    io.line(
      `  .env.local already has a DATABASE_URL (mask: ${maskUrl(existingUrl)}).`,
    );

    const replace = await io.confirm({
      message:
        "Replace it with the verified development URL (existing unrelated values are preserved)?",
      default: false,
    });

    if (!replace) {
      note(ctx, "Left .env.local untouched. Pass DATABASE_URL to `db:migrate` manually.");
      record(ctx, "env-local", true, "preserved existing value");

      return;
    }
  } else {
    const save = await io.confirm({
      message:
        "Save the development URL to .env.local (mode 0600, git-ignored) for npm run db:migrate / db:check?",
      default: false,
    });

    if (!save) {
      note(ctx, "Not saved — the wizard keeps the URL in memory only, for this session.");
      record(ctx, "env-local", true, "in-memory only");

      return;
    }
  }

  writeEnvLocalUrl(target, url);

  ctx.writes.envLocalSaved = true;
  ctx.writes.envLocalPath = target;

  note(ctx, `Wrote ${path.relative(root, target)} (DATABASE_URL, mode 0600).`);
  note(ctx, "Unrelated values were preserved; the file stays git-ignored.");

  record(ctx, "env-local", true);
}

/** Reads DATABASE_URL from a local env file, or null when absent/unreadable. */
export function readEnvLocalUrl(file) {
  try {
    const contents = fs.readFileSync(file, "utf8");

    for (const line of contents.split("\n")) {
      const trimmed = line.trim();

      if (trimmed === "" || trimmed.startsWith("#")) continue;

      const equals = trimmed.indexOf("=");

      if (equals === -1) continue;

      const key = trimmed.slice(0, equals).trim();

      if (key === "DATABASE_URL") {
        return trimmed
          .slice(equals + 1)
          .trim()
          .replace(/^"([\s\S]*)"$/, "$1");
      }
    }
  } catch {
    // Missing file is expected; a value simply is not set.
  }

  return null;
}

/**
 * Writes DATABASE_URL into a local env file, preserving every other line and
 * tightening the file mode to 0600 so only the owner can read the credential.
 */
export function writeEnvLocalUrl(file, url) {
  const lines = [];

  try {
    const contents = fs.readFileSync(file, "utf8");
    const seen = new Set();

    for (const line of contents.split("\n")) {
      const trimmed = line.trim();

      if (trimmed === "" || trimmed.startsWith("#")) {
        lines.push(line);
        continue;
      }

      const equals = trimmed.indexOf("=");

      if (equals === -1) {
        lines.push(line);
        continue;
      }

      const key = trimmed.slice(0, equals).trim();

      if (key === "DATABASE_URL") {
        seen.add(key);
        continue;
      }

      lines.push(line);
    }

    // The original had no DATABASE_URL at all; append one after the others.
    lines.push(`DATABASE_URL=${url}`);
  } catch {
    // No existing file: a single line is the whole content.
    lines.push(`# Rabet development database — generated by npm run db:setup:dev`);
    lines.push(`# Development only. Never commit this file.`);
    lines.push(`DATABASE_URL=${url}`);
  }

  fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });

  // An existing file may have been created with a looser mode; tighten it.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort; the write above already requested 0600.
  }
}

// --- Optional: Vercel Preview (disabled by default) -------------------------

/**
 * The OPTIONAL Vercel Preview step. It runs only when the owner explicitly asks
 * (`--vercel-preview`), and it degrades to a manual-step report whenever
 * identity cannot be verified. It never writes Production variables, never
 * applies migrations from a Vercel build, and never puts the URL on the command
 * line — `vercel env add` reads it from stdin.
 */
async function runVercelPreviewStep(ctx) {
  const { io, runCommand, root, url } = ctx;

  io.line("");
  io.line("Optional: Vercel Preview setup");

  const cli = await runCommand({
    command: "vercel",
    args: ["--version"],
    cwd: root,
  });

  if (cli.code !== 0) {
    manualStep(
      ctx,
      "The Vercel CLI is not installed. Skipping the optional Preview setup.",
      "npm i -g vercel, then re-run with --vercel-preview, or set the Preview " +
        "variable in the Vercel dashboard (Settings → Environment Variables → " +
        "the Preview scope of the Rabet project).",
    );

    return;
  }

  const whoami = await runCommand({
    command: "vercel",
    args: ["whoami"],
    cwd: root,
  });

  if (whoami.code !== 0) {
    manualStep(
      ctx,
      "The Vercel CLI is not logged in, so the project identity cannot be verified.",
      "Run `vercel login`, then re-run the wizard with --vercel-preview. The " +
        "development database setup itself is already complete.",
    );

    return;
  }

  const account = whoami.stdout.trim();

  // The link state is what proves which Vercel project this repository is.
  // The CLI records it in `.vercel/project.json` and, in newer versions, in
  // `.vercel/repo.json`; either is accepted, and neither is trusted blindly —
  // the owner confirms the ids below before anything is written.
  const linkFile = path.join(root, ".vercel", "project.json");

  let projectId = "unknown";
  let orgId = "unknown";

  const readLink = [
    () => {
      const linked = JSON.parse(fs.readFileSync(linkFile, "utf8"));

      return {
        projectId: linked.projectId,
        orgId: linked.orgId,
        name: null,
      };
    },
    () => {
      const repo = JSON.parse(
        fs.readFileSync(path.join(root, ".vercel", "repo.json"), "utf8"),
      );
      const project = (repo.projects ?? [])[0];

      return {
        projectId: project?.id,
        orgId: project?.orgId,
        name: project?.name,
      };
    },
  ];

  let linkName = null;

  for (const read of readLink) {
    try {
      const linked = read();

      if (linked.projectId && linked.orgId) {
        projectId = String(linked.projectId);
        orgId = String(linked.orgId);
        linkName = linked.name ?? null;

        break;
      }
    } catch {
      // Try the next record; neither may exist.
    }
  }

  if (projectId === "unknown") {
    manualStep(
      ctx,
      "This repository is not linked to a Vercel project, so the Preview scope cannot be verified.",
      "Run `vercel link` and choose the Rabet project, then re-run the wizard " +
        "with --vercel-preview. Never link a project you do not recognize.",
    );

    return;
  }

  io.line(`  Account      ${account}`);
  io.line(`  Project      ${linkName ?? "linked"}`);
  io.line(`  Project id   ${projectId}`);
  io.line(`  Org id       ${orgId}`);
  io.line("  Scope        Preview only (never Production)");
  io.line(`  Value        ${maskUrl(url)}`);
  io.line("");

  const confirmed = await io.confirm({
    message:
      "Write DATABASE_URL to the PREVIEW environment scope of this linked Vercel project?",
    default: false,
  });

  if (!confirmed) {
    manualStep(
      ctx,
      "Declined — nothing was written to Vercel.",
      "In the Vercel dashboard: Rabet → Settings → Environment Variables → " +
        "add DATABASE_URL with the Preview scope, using the development " +
        "connection string.",
    );

    return;
  }

  // `vercel env add` prompts for the value on stdin when it is piped, so the
  // URL never appears on the command line or in the process list.
  const added = await runCommand({
    command: "vercel",
    args: ["env", "add", "DATABASE_URL", "preview"],
    cwd: root,
    stdin: `${url}\n`,
  });

  if (added.code !== 0) {
    manualStep(
      ctx,
      "`vercel env add` did not succeed (see its output above).",
      "Nothing was written. Set the Preview variable from the Vercel dashboard " +
        "instead, in the Preview scope only.",
    );

    return;
  }

  note(ctx, "DATABASE_URL written to the Vercel Preview scope ✓");
  note(ctx, "Production was not touched; migrations are never run by Vercel.");
  record(ctx, "vercel-preview", true);
}

function manualStep(ctx, summary, manual) {
  ctx.io.line(`  ${summary}`);
  ctx.io.line(`  Manual step: ${manual}`);
  record(ctx, "vercel-preview", true, "manual step reported");
}

// --- The report ------------------------------------------------------------

function finalize(ctx) {
  const { io } = ctx;
  const lines = [];

  lines.push("");
  lines.push("─".repeat(60));

  const title = {
    configured: "Development database setup complete",
    "already-configured": "Development database is already configured",
    "preflight-ok": "Read-only preflight: no problems found",
    "preflight-issues": "Read-only preflight: problems found",
    cancelled: "Setup cancelled — nothing was written",
    failed: "Setup did not complete",
    "manual-review": "Stopped for manual review",
  }[ctx.outcome] ?? "Setup finished";

  lines.push(`${WIZARD} — ${title}`);
  lines.push("─".repeat(60));

  if (ctx.target) {
    lines.push(`Target       ${ctx.target.dbName} (environment: DEVELOPMENT)`);
    lines.push(`Endpoint     ${ctx.target.endpoint}`);
    lines.push(`PostgreSQL   ${ctx.target.pgVersion.split(",").slice(0, 1).join("")}`);
  }

  if (ctx.revision) {
    lines.push(`Revision     ${String(ctx.revision).slice(0, 12)}`);
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

  if (ctx.writes.envLocalSaved) {
    lines.push(
      `Stored       ${path.basename(ctx.writes.envLocalPath)} (mode 0600, git-ignored)`,
    );
  }

  const failed = ctx.checks.filter((check) => !check.passed);

  lines.push(`Checks       ${ctx.checks.length - failed.length}/${ctx.checks.length} passed`);

  lines.push("");
  lines.push("Production was not contacted and was not modified.");
  lines.push("No tables were dropped, no branch was reset, and drizzle-kit push");
  lines.push("was not run. Re-running this wizard is safe: it inspects the real");
  lines.push("database state and repeats nothing that is already done.");

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
  `${WIZARD} — interactive Neon development database setup`,
  "",
  "Usage:",
  "  npm run db:setup:dev                  interactive setup (default)",
  "  npm run db:setup:dev -- --check       read-only preflight (no writes)",
  "  npm run db:setup:dev -- --vercel-preview",
  "                                        also offer the optional Vercel",
  "                                        Preview step (off by default)",
  "  npm run db:setup:dev -- --help        this help",
  "",
  "The wizard asks for the Neon DIRECT (unpooled) connection string of the",
  `dedicated ${EXPECTED_NEON_PROJECT} project, verifies the target read-only,`,
  "applies the committed migration chain after your approval, and validates",
  "the result. It never touches production and never runs drizzle-kit push.",
].join("\n");

function parseArgs(argv) {
  const options = { check: false, vercelPreview: false, help: false };
  const unknown = [];

  for (const arg of argv.slice(2)) {
    if (arg === "--check" || arg === "--preflight") {
      options.check = true;
    } else if (arg === "--vercel-preview") {
      options.vercelPreview = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("--")) {
      unknown.push(arg);
    }
  }

  return { options, unknown };
}

async function runCli() {
  const { options, unknown } = parseArgs(process.argv);

  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }

  if (unknown.length > 0) {
    process.stderr.write(`Unknown option: ${unknown.join(", ")}\n\n${HELP}\n`);
    process.exit(2);
  }

  const io = createRealIo();

  const cancel = () => {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Nothing to restore.
    }

    io.close();
    io.line("");
    io.line("Interrupted. No changes were made to the database unless a step");
    io.line("above reported completing. Re-run the wizard to inspect real state.");
    process.exit(130);
  };

  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);

  if (options.check) {
    io.line(`${WIZARD} — read-only preflight. No writes will happen.`);
  } else {
    io.line(`${WIZARD} — interactive Neon development database setup.`);
    io.line("");
    io.line("This connects to the dedicated Neon development project");
    io.line(`(${EXPECTED_NEON_PROJECT}), reviews the committed migrations, applies`);
    io.line("them after your approval, and validates the result. Production is");
    io.line("never contacted, and drizzle-kit push is never run. Re-running is");
    io.line("safe: work already done is detected, not repeated.");
  }

  const result = await runWizard({
    io,
    connect: createPostgresSql,
    runCommand: (opts) =>
      opts.stdin !== undefined
        ? runCommandWithStdin(opts)
        : runCommandReal(opts),
    options,
  });

  // Release the shared readline interface so the process can exit.
  io.close();

  const code =
    result.ok || result.outcome === "cancelled"
      ? result.outcome === "cancelled"
        ? 1
        : 0
      : 1;

  process.exit(code);
}

/** Runs a command with a string piped to stdin (for `vercel env add`). */
function runCommandWithStdin({ command, args = [], env, cwd, stdin, onOutput }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    const stdout = [];
    const stderr = [];

    const emit = (chunks) => (chunk) => {
      const safe = redact(chunk.toString("utf8"));

      chunks.push(safe);

      if (onOutput) onOutput(safe);
    };

    child.stdout.on("data", emit(stdout));
    child.stderr.on("data", emit(stderr));

    child.on("error", (error) => {
      resolve({
        code: 1,
        signal: null,
        stdout: stdout.join(""),
        stderr: [stderr.join(""), redact(String(error.message ?? error))]
          .filter(Boolean)
          .join("\n"),
        error,
      });
    });

    child.on("close", (code, signal) => {
      resolve({
        code: code ?? 1,
        signal,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      });
    });

    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

const isCli = import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href;

if (isCli) {
  runCli().catch((error) => {
    process.stderr.write(`${WIZARD}: ${redact(String(error.stack ?? error.message ?? error))}\n`);
    process.exit(1);
  });
}
