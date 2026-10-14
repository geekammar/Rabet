import "server-only";

import { ZodError } from "zod";

/**
 * ===========================================================================
 * Typed errors for the server-only data access layer.
 * ===========================================================================
 *
 * Every failure a data-access function raises is a `RabetDataError` carrying a
 * stable `code` the caller can switch on, plus a `message` that is **safe to
 * show to an admin or to log to the client console**. A raw PostgreSQL or
 * driver error is never raised directly: it may name internal constraint
 * identifiers, echo the offending SQL, or — worst case — repeat a connection
 * string that carries a password. Such detail is attached as `cause` for the
 * server-side logs only (ADR-012, DATA_MODEL.md §12.5).
 *
 * The two entry points:
 *
 *   - `mapDatabaseError(error)` — converts a driver error into a typed one by
 *     SQLSTATE class. Used to wrap every write.
 *   - `toSafeErrorMessage(error)` — collapses *anything* unknown into one
 *     generic sentence. This is the function a Server Action or Route Handler
 *     uses when it cannot say anything more specific, and it is the guarantee
 *     that no internal detail reaches the client.
 *
 * `server-only` keeps this module, and therefore every database error path,
 * out of client bundles.
 */

/**
 * The closed set of failure codes the data layer can produce.
 *
 * Kept deliberately small: a code exists only where a caller can meaningfully
 * *do* something different for it (retry, show a specific form field, offer the
 * setup flow). Everything uncategorized collapses to `UNCATEGORIZED` with the
 * generic safe message.
 */
export type DataErrorCode =
  /** The database could not be reached or refused the connection. */
  | "DATABASE_UNAVAILABLE"
  /** Input failed Zod validation before any query ran. */
  | "INVALID_INPUT"
  /** A row the operation names directly (by key or code) does not exist. */
  | "NOT_FOUND"
  /** A unique key is already taken. */
  | "CONFLICT"
  /** A database-level rule rejected the value (singleton, allowlist, length). */
  | "CONSTRAINT_VIOLATION"
  /** The `bot_setting` singleton has not been initialized yet. */
  | "SETTINGS_NOT_INITIALIZED"
  /** The `bot_setting` singleton already exists; use the update path. */
  | "SETTINGS_ALREADY_INITIALIZED"
  /** No `language` row carries this code. */
  | "LANGUAGE_NOT_FOUND"
  /** The language row exists but `is_enabled` is false. */
  | "LANGUAGE_NOT_ENABLED"
  /** The language is the configured default and cannot be disabled. */
  | "DEFAULT_LANGUAGE_REQUIRED"
  /** No `message_template` row carries this key. */
  | "TEMPLATE_NOT_FOUND"
  /** A driver or database error this layer does not map to anything specific. */
  | "UNCATEGORIZED";

/**
 * The one sentence an end user sees when the layer cannot be more specific.
 *
 * It deliberately names nothing about the database, the SQL, the constraint or
 * the connection — it cannot leak, because it contains no variables.
 */
export const SAFE_FALLBACK_MESSAGE =
  "This operation could not be completed. The details have been recorded in " +
  "the server logs.";

/**
 * The single error class for the data layer.
 *
 * `message` is always safe to surface; `cause` holds the original error for
 * server-side diagnostics and is never serialized to a client by this layer.
 */
export class RabetDataError extends Error {
  readonly code: DataErrorCode;

  constructor(code: DataErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);

    this.name = "RabetDataError";
    this.code = code;
  }
}

/**
 * Walks an error and its `cause` chain, depth-limited against a pathological
 * cycle.
 *
 * Two shapes reach this layer, and both are handled here:
 *
 *   - on the production driver (`neon-http`), a query failure surfaces as a raw
 *     `NeonDbError` carrying the SQLSTATE on `code`;
 *   - on `drizzle-orm`'s shared `pg-core` session (used by the integration
 *     suites' `postgres-js` client, and by any future driver), the driver error
 *     is rethrown as a `DrizzleQueryError` with the original on `cause` — and
 *     *that* wrapper's own message contains the SQL and the parameters, which
 *     is exactly why no message from this layer is ever built from an error's
 *     own text.
 */
function* errorChain(error: unknown): Generator<Record<string, unknown>> {
  let current: unknown = error;

  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    yield current as Record<string, unknown>;

    current = "cause" in current ? current.cause : undefined;
  }
}

/** True when a value looks like a SQLSTATE code (five alphanumerics). */
function isSqlState(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Z]{5}$/.test(value);
}

/**
 * Reads a SQLSTATE code from a driver error, walking the `cause` chain.
 *
 * Both drivers in play surface Postgres error codes on a string `code`
 * property (`postgres`'s `PostgresError`, Neon's `NeonDbError`), though the
 * former may be wrapped one level deep by Drizzle. Reading it defensively, and
 * shape-checking the value, keeps the mapper honest if that ever changes.
 */
function sqlState(error: unknown): string | undefined {
  for (const node of errorChain(error)) {
    if ("code" in node) {
      const code = (node as Record<string, unknown>).code;

      if (isSqlState(code)) return code;
    }
  }

  return undefined;
}

/**
 * True when the failure looks like the database could not be reached at all —
 * the connection class of SQLSTATE, or one of the network errors the fetch- or
 * socket-based drivers raise before any SQL ran.
 */
function isConnectionFailure(error: unknown): boolean {
  const code = sqlState(error);

  if (typeof code === "string" && code.startsWith("08")) return true;

  for (const node of errorChain(error)) {
    if (
      node instanceof Error &&
      [
        "ENOTFOUND",
        "ECONNREFUSED",
        "ECONNRESET",
        "EPIPE",
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "NeonDbError",
      ].includes(node.name)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Converts a caught driver or database error into a typed application error.
 *
 * Mapping is by SQLSTATE class, which is the contract PostgreSQL promises to
 * keep stable. Anything unrecognized still produces a safe, typed error —
 * never the raw one.
 */
export function mapDatabaseError(error: unknown): RabetDataError {
  const code = sqlState(error);

  switch (code) {
    case "23505": // unique_violation
      return new RabetDataError(
        "CONFLICT",
        "A record with this key already exists.",
        { cause: error },
      );

    case "23503": // foreign_key_violation
      return new RabetDataError(
        "NOT_FOUND",
        "A record this operation depends on does not exist.",
        { cause: error },
      );

    case "23514": // check_violation — the singleton, currency, direction and length rules
      return new RabetDataError(
        "CONSTRAINT_VIOLATION",
        "The value is not allowed by a database constraint.",
        { cause: error },
      );

    case "23001": // integrity_constraint_violation — e.g. an ON DELETE RESTRICT block
      return new RabetDataError(
        "CONSTRAINT_VIOLATION",
        "The operation is blocked by a database integrity rule.",
        { cause: error },
      );

    case "23502": // not_null_violation
      return new RabetDataError(
        "INVALID_INPUT",
        "A required value is missing.",
        { cause: error },
      );

    case "22001": // string_data_right_truncation
      return new RabetDataError(
        "INVALID_INPUT",
        "One of the provided values is too long.",
        { cause: error },
      );

    default:
      break;
  }

  if (isConnectionFailure(error)) {
    return new RabetDataError(
      "DATABASE_UNAVAILABLE",
      "The database is not reachable right now. Try again in a moment.",
      { cause: error },
    );
  }

  return new RabetDataError("UNCATEGORIZED", SAFE_FALLBACK_MESSAGE, { cause: error });
}

/**
 * Converts a Zod validation failure into a typed error.
 *
 * The detail message names the offending *fields* and Zod's own messages, never
 * the received values, so it is safe to surface on a form: a caller learns
 * `currency: Invalid input` rather than anything they submitted.
 */
export function invalidInput(error: unknown): RabetDataError {
  const issues = error instanceof ZodError ? error.issues : undefined;
  const hasIssues = Array.isArray(issues) && issues.length > 0;

  const detail = hasIssues
    ? issues!
        .map((issue) => {
          const path = issue.path.filter((segment) => segment !== undefined);

          return path.length > 0
            ? `${path.join(".")}: ${issue.message}`
            : issue.message;
        })
        .join("; ")
    : "The provided values are not valid.";

  return new RabetDataError("INVALID_INPUT", detail, { cause: error });
}

/**
 * Returns a message safe to show to any client, for any error whatsoever.
 *
 * A `RabetDataError` is already safe by construction, so its own message is
 * returned. Anything else — an unexpected driver error, a Node system error, a
 * stray string — collapses to the generic fallback. This is the boundary that
 * guarantees no connection string, password or internal identifier is ever
 * echoed to the client (DATA_MODEL.md §12.5).
 */
export function toSafeErrorMessage(error: unknown): string {
  if (error instanceof RabetDataError) return error.message;

  return SAFE_FALLBACK_MESSAGE;
}
