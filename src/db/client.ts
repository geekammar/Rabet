import "server-only";

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema";

/**
 * ===========================================================================
 * The application database client — server-only, Neon HTTP.
 * ===========================================================================
 *
 * Deliberate driver choice (ADR-015, DATA_MODEL.md §15.3): `drizzle-orm/
 * neon-http` over Neon's pooled HTTP endpoint. One HTTP request per query or
 * per batch, no connection to hold open — the fastest option on Vercel
 * serverless, where process memory is not durable across invocations.
 *
 * **There are no interactive transactions on this driver.** `db.transaction()
 * throws in the driver source, so every atomic multi-step write is expressed
 * as a non-interactive `db.batch([...])` — a fixed list of statements sent in
 * one HTTP request, executed server-side in a single transaction that commits
 * or rolls back atomically — with per-site idempotency (`ON CONFLICT DO
 * NOTHING` against `telegram_update.update_id`, `UNIQUE (inquiry_id,
 * telegram_message_id)` and the active-inquiry partial unique index) carrying
 * the correctness load. The write paths are shaped to never need to read a
 * row they just wrote. `drizzle-orm/neon-serverless` (WebSocket `Pool`) is the
 * documented escape hatch and is intentionally not installed here.
 *
 * **Lazy initialization.** The client is created on first use through
 * `getDb()`, not at module load. Importing this module therefore never
 * requires `DATABASE_URL`: a production build, a preview deployment without
 * database variables, or a dashboard route that does not touch the database
 * must not fail because a database is not configured. The first actual query
 * fails loudly with a clear, credential-free message instead.
 *
 * `server-only` guarantees this module can never reach a client bundle, and
 * with it any database credential.
 */

let client: Database | null = null;

/**
 * Reads and validates the database connection string.
 *
 * Throws a deliberate, credential-free error when `DATABASE_URL` is missing or
 * not a PostgreSQL connection string. The thrown message never echoes the
 * value, which may contain a password.
 */
function readDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(
      "DATABASE_URL is not configured. The application database is required " +
        "for this operation. Provision it in the deployment environment " +
        "(see .env.example) — it is deliberately not required to build the " +
        "app or to serve a route that does not use the database.",
    );
  }

  const url = raw.trim();

  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error(
      "DATABASE_URL is not a valid PostgreSQL connection string. It must " +
        "start with postgresql:// (see .env.example).",
    );
  }

  return url;
}

function createDb() {
  // `neon()` builds a fetch-based client and performs no network I/O here; the
  // first query is the first request. Its return type is exactly what the
  // `neon-http` driver's `drizzle()` accepts, so no cast is needed.
  const query = neon(readDatabaseUrl());
  return drizzle({ client: query, schema });
}

/**
 * The Drizzle client type, including the relation map for `db.query.*`.
 *
 * Declared after `createDb` and derived from it: an explicit return annotation
 * on the function would make the alias and the annotation reference each other.
 */
export type Database = ReturnType<typeof createDb>;

/**
 * The application database client.
 *
 * Use this for every read and write. A single client is memoized per process,
 * which is what the HTTP driver is designed for; there is no pool to manage.
 *
 * Atomic multi-query writes go through `db.batch([...])` — see the module
 * docstring for why `db.transaction()` cannot be used on this driver.
 */
export function getDb(): Database {
  if (client === null) {
    client = createDb();
  }
  return client;
}

/**
 * True when a database client has been initialized in this process.
 *
 * Lets a caller distinguish "no database configured" from "not yet needed"
 * without triggering initialization.
 */
export function isDbInitialized(): boolean {
  return client !== null;
}

/** The schema map, for callers that need table or enum metadata directly. */
export { schema };
