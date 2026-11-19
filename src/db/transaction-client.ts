import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

/**
 * ===========================================================================
 * The transactional database client — server-only, postgres-js.
 * ===========================================================================
 *
 * The application client (`src/db/client.ts`) uses Neon HTTP, which has no
 * interactive transactions. The merchant invitation service needs a real
 * `BEGIN … COMMIT` boundary with row locks and advisory locks, so this module
 * adds the smallest postgres-js client that can provide one against the same
 * database. It is deliberately not a generic driver abstraction, and the HTTP
 * client and its callers stay unchanged.
 *
 * **Runtime contract.** The client reads the existing `DATABASE_URL`
 * environment variable, so both drivers always target the same database. The
 * value keeps its original semantics: a PostgreSQL URL, with `sslmode=require`
 * for a Neon endpoint. Connection strings for `*.neon.tech` are forced to TLS
 * (`ssl: "require"`) even when the URL omits `sslmode` or asks for an
 * insecure mode; an explicit `sslmode=verify-full` is left intact. Other hosts
 * (including the disposable local test cluster) use their URL as written.
 *
 * **Lazy initialization.** Importing this module neither requires
 * `DATABASE_URL` nor opens a connection. `getTransactionDb()` reads and
 * validates the configuration on first use, then memoizes one client for the
 * life of the process. The pool is bounded: at most 5 connections, a 10 second
 * connection timeout, a 20 second idle timeout, and a 5 minute maximum
 * connection lifetime. A pool is therefore never created per invitation.
 *
 * **Test construction.** `createTransactionClient(url)` is the same
 * construction path the runtime uses, but takes an explicit URL and never
 * falls back to `DATABASE_URL`. It returns a client with `close()` so the
 * disposable PostgreSQL harness can release its connection before the test
 * database is dropped.
 *
 * `server-only` keeps this module and its credentials out of browser bundles;
 * postgres-js also requires Node's TCP stack and is not an Edge runtime client.
 */

const POOL_MAX_CONNECTIONS = 5;
const CONNECT_TIMEOUT_SECONDS = 10;
const IDLE_TIMEOUT_SECONDS = 20;
const MAX_LIFETIME_SECONDS = 5 * 60;

type ParsedDatabaseUrl = {
  url: string;
  hostname: string;
  sslMode: string | null;
};

let sharedClient: TransactionClient | null = null;

function parseDatabaseUrl(
  raw: string | undefined,
  explicit: boolean,
): ParsedDatabaseUrl {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(
      explicit
        ? "A PostgreSQL connection string is required to create the transaction " +
            "database client. It is passed explicitly so a test can never fall " +
            "back to the runtime DATABASE_URL."
        : "DATABASE_URL is not configured. The transactional database is required " +
            "for this operation. Provision it in the deployment environment " +
            "(see .env.example) — it is not required to build the app or to " +
            "serve a route that does not use interactive transactions.",
    );
  }

  const url = raw.trim();

  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error(
      "The database connection string is not a valid PostgreSQL connection " +
        "string. It must start with postgresql:// (see .env.example).",
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "The database connection string is not a valid PostgreSQL connection " +
        "string. It must be a complete postgresql:// URL (see .env.example).",
    );
  }

  if (parsed.hostname.length === 0) {
    throw new Error(
      "The database connection string is not a valid PostgreSQL connection " +
        "string. It must name a database host (see .env.example).",
    );
  }

  return {
    url,
    hostname: parsed.hostname.toLowerCase(),
    sslMode: parsed.searchParams.get("sslmode"),
  };
}

function isNeonHostname(hostname: string): boolean {
  return hostname === "neon.tech" || hostname.endsWith(".neon.tech");
}

function connectionOptions(parsed: ParsedDatabaseUrl) {
  const insecurelyConfigured =
    parsed.sslMode === null ||
    parsed.sslMode === "disable" ||
    parsed.sslMode === "allow" ||
    parsed.sslMode === "prefer";

  return {
    max: POOL_MAX_CONNECTIONS,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    max_lifetime: MAX_LIFETIME_SECONDS,
    ...(isNeonHostname(parsed.hostname) && insecurelyConfigured
      ? { ssl: "require" as const }
      : {}),
  };
}

function createPool(
  url: string,
  options: ReturnType<typeof connectionOptions>,
) {
  try {
    return postgres(url, options);
  } catch {
    throw new Error(
      "The transaction database client could not be initialized because its " +
        "connection configuration is invalid.",
    );
  }
}

function createDrizzle(pool: ReturnType<typeof createPool>) {
  return drizzle({ client: pool, schema });
}

/** The Drizzle client type the invitation service accepts. */
export type TransactionDatabase = ReturnType<typeof createDrizzle>;

export type TransactionClient = {
  readonly db: TransactionDatabase;
  /** Releases every pooled connection. Safe to call more than once. */
  close(): Promise<void>;
};

function buildClient(parsed: ParsedDatabaseUrl): TransactionClient {
  const pool = createPool(parsed.url, connectionOptions(parsed));
  const db = createDrizzle(pool);

  let closed: Promise<void> | null = null;

  return {
    db,
    close() {
      closed ??= pool.end();
      return closed;
    },
  };
}

/**
 * Builds a client from an explicitly supplied PostgreSQL URL.
 *
 * The argument is required and is never replaced by `DATABASE_URL`. This is
 * the same construction path as the runtime singleton below, so the
 * disposable PostgreSQL tests exercise the real pool, driver and Drizzle
 * session rather than a fixture client.
 */
export function createTransactionClient(databaseUrl: string): TransactionClient {
  return buildClient(parseDatabaseUrl(databaseUrl, true));
}

/**
 * The process-wide transactional client.
 *
 * The first call validates `DATABASE_URL` and creates the bounded pool; later
 * calls reuse it. Importing this module never triggers any of that.
 */
export function getTransactionDb(): TransactionDatabase {
  if (sharedClient === null) {
    sharedClient = buildClient(parseDatabaseUrl(process.env.DATABASE_URL, false));
  }

  return sharedClient.db;
}

/** True when the process-wide client has been created. */
export function isTransactionClientInitialized(): boolean {
  return sharedClient !== null;
}
