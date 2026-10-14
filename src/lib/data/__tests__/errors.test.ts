import { describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { z } from "zod";

import {
  invalidInput,
  mapDatabaseError,
  RabetDataError,
  SAFE_FALLBACK_MESSAGE,
  toSafeErrorMessage,
} from "@/lib/data";

/**
 * The data layer's error contract (see `src/lib/data/errors.ts`).
 *
 * These are the properties that keep a database error from ever reaching a
 * client: SQLSTATE is mapped to a stable code, the safe message is a fixed
 * sentence, and the raw error survives only on `cause` for the server logs.
 */

/** A synthetic driver error carrying a SQLSTATE, the way `postgres` and Neon do. */
function pgError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };

  error.code = code;

  return error;
}

describe("mapDatabaseError", () => {
  it("maps a unique violation to CONFLICT", () => {
    const error = mapDatabaseError(
      pgError("23505", 'duplicate key value violates unique constraint "x"'),
    );

    expect(error).toBeInstanceOf(RabetDataError);
    expect(error.code).toBe("CONFLICT");
    expect(error.message).not.toContain("duplicate key");
  });

  it("maps a foreign-key violation to NOT_FOUND", () => {
    expect(mapDatabaseError(pgError("23503", "violates foreign key constraint")).code).toBe(
      "NOT_FOUND",
    );
  });

  it("maps a check violation to CONSTRAINT_VIOLATION", () => {
    // The singleton, currency-allowlist, text-direction and body-length rules
    // are all CHECK constraints, so this is the class they land in.
    expect(mapDatabaseError(pgError("23514", "violates check constraint")).code).toBe(
      "CONSTRAINT_VIOLATION",
    );
  });

  it("maps an integrity-constraint violation (RESTRICT) to CONSTRAINT_VIOLATION", () => {
    // ON DELETE RESTRICT raises SQLSTATE 23001, not 23503 — documented in
    // PHASE_03B_HANDOFF.md §14 item 1, and expected here.
    expect(mapDatabaseError(pgError("23001", "violates not null constraint")).code).toBe(
      "CONSTRAINT_VIOLATION",
    );
  });

  it("maps a not-null violation to INVALID_INPUT", () => {
    expect(mapDatabaseError(pgError("23502", "violates not null constraint")).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("maps a truncation violation to INVALID_INPUT", () => {
    expect(mapDatabaseError(pgError("22001", "value too long for type")).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("maps the connection class to DATABASE_UNAVAILABLE", () => {
    expect(mapDatabaseError(pgError("08006", "connection failure")).code).toBe(
      "DATABASE_UNAVAILABLE",
    );
  });

  it("maps a network error with no SQLSTATE to DATABASE_UNAVAILABLE", () => {
    const error = new Error("getaddrinfo ENOTFOUND ep-example.neon.tech");
    error.name = "ENOTFOUND";

    expect(mapDatabaseError(error).code).toBe("DATABASE_UNAVAILABLE");
  });

  it("keeps the original error as the cause for server-side logs", () => {
    const original = pgError("23505", 'duplicate key value violates unique constraint "x"');
    const mapped = mapDatabaseError(original);

    expect(mapped.cause).toBe(original);
  });

  it("reads the SQLSTATE through Drizzle's wrapped error, and never repeats its SQL", () => {
    // `drizzle-orm`'s shared session rethrows the driver error as a
    // `DrizzleQueryError` whose own message holds the query text and parameters —
    // a strong reason no safe message here is ever built from an error's text.
    const wrapped = new DrizzleQueryError(
      'select "id" from "bot_setting" where "id" = $1',
      ["1"],
      pgError("23505", 'duplicate key value violates unique constraint "x"'),
    );

    const mapped = mapDatabaseError(wrapped);

    expect(mapped.code).toBe("CONFLICT");
    expect(mapped.message).not.toContain("select");
    expect(mapped.message).not.toContain("bot_setting");
    expect(mapped.cause).toBe(wrapped);
  });

  it("falls back to a typed, safe error for an unrecognized code", () => {
    const mapped = mapDatabaseError(pgError("XX000", "something unprecedented"));

    expect(mapped.code).toBe("UNCATEGORIZED");
    expect(mapped.message).toBe(SAFE_FALLBACK_MESSAGE);
  });

  it("falls back to a typed, safe error for a non-database error", () => {
    expect(mapDatabaseError(new Error("anything at all")).code).toBe("UNCATEGORIZED");
  });
});

describe("toSafeErrorMessage", () => {
  it("returns a data layer error's own message, which is safe by construction", () => {
    const error = new RabetDataError("TEMPLATE_NOT_FOUND", "No template exists.");

    expect(toSafeErrorMessage(error)).toBe("No template exists.");
  });

  it("never repeats a connection string or password from an unknown error", () => {
    const password = "sup3r-s3kr3t-pw";
    const host = "ep-hidden-abc123.neon.tech";
    const leaked =
      `connect ECONNREFUSED postgresql://owner:${password}@${host}/rabet?sslmode=require`;

    const raw = new Error(leaked);

    // A raw error is never surfaced: the caller gets the one generic sentence.
    expect(toSafeErrorMessage(raw)).toBe(SAFE_FALLBACK_MESSAGE);

    // And neither does a mapped one repeat it.
    const mapped = mapDatabaseError(raw);

    expect(toSafeErrorMessage(mapped)).not.toContain(password);
    expect(toSafeErrorMessage(mapped)).not.toContain(host);
    expect(toSafeErrorMessage(mapped)).not.toContain("ECONNREFUSED");
  });

  it("does not attach internal detail to the error a caller would log either", () => {
    const password = "do-not-leak";
    const raw = new Error(`postgresql://owner:${password}@host/rabet`);

    const mapped = mapDatabaseError(raw);

    // The safe message is what a client sees; the raw text lives only on `cause`.
    expect(mapped.message).not.toContain(password);
    expect((mapped.cause as Error).message).toContain(password);
  });
});

describe("invalidInput", () => {
  it("turns a Zod failure into an INVALID_INPUT error naming the field", () => {
    const schema = z.object({ currency: z.enum(["SAR", "USD"]) });

    let error: RabetDataError | null = null;

    try {
      schema.parse({ currency: "EUR" });
    } catch (zodError) {
      error = invalidInput(zodError);
    }

    expect(error?.code).toBe("INVALID_INPUT");
    expect(error?.message).toContain("currency");
    // Zod's messages quote the allowed values, never the received value.
    expect(error?.message).not.toContain("EUR");
  });

  it("produces a stable message for an empty object schema failure", () => {
    const schema = z.object({ code: z.string().min(2) });

    expect(() => schema.parse({})).toThrow();
  });
});
