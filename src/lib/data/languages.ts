import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/db/client";
import { botSetting, language } from "@/db/schema";

import { invalidInput, mapDatabaseError, RabetDataError } from "./errors";

/**
 * ===========================================================================
 * Language data access — server-only (DATA_MODEL.md §4.6, §7).
 * ===========================================================================
 *
 * Focused functions over the `language` table and the `bot_setting` default
 * language reference. There is intentionally **no** generic repository here:
 * each function is one query with a documented purpose.
 *
 * Policy implemented here, per the approved data model:
 *
 *   - **English is the primary/default language.** It is the fallback for every
 *     translatable entity, and the default lives in `bot_setting` — never as a
 *     boolean flag on `language` (there is one settings row, so there is one
 *     default).
 *   - **Arabic is optional** and renders RTL; enabling or disabling it is a
 *     configuration choice, not a schema one.
 *   - **Disabling a language preserves its translations.** Nothing is deleted;
 *     the rows simply stop being offered, and content falls back to the default.
 *   - **The active default language cannot be disabled** without first pointing
 *     the settings row at another valid, enabled language. Enforced here as an
 *     explicit typed error, because a `CHECK` cannot inspect another table.
 *
 * All functions take the database client as a parameter so tests inject a real
 * PostgreSQL client and the production path passes `getDb()` (ADR-015).
 */

/** A language row, as read from the database. */
export type LanguageRow = typeof language.$inferSelect;

/** The parts of a language that resolution and rendering need. */
export type ResolvedLanguage = {
  id: string;
  code: string;
  label: string;
  textDirection: "ltr" | "rtl";
};

/**
 * ISO 639-1: exactly two lowercase letters.
 *
 * The column is `char(2)` with a global unique constraint, so anything longer,
 * shorter or uppercase is wrong before it reaches SQL.
 */
export const languageCodeSchema = z
  .string()
  .trim()
  .length(2, "Language code must be exactly 2 characters")
  .regex(/^[a-z]{2}$/, "Language code must be two lowercase letters");

/** The two text directions the schema's `CHECK` allows. */
export const textDirectionSchema = z.enum(["ltr", "rtl"]);

/** A display label, e.g. "English" / "العربية". */
export const languageLabelSchema = z
  .string()
  .trim()
  .min(1, "Language label is required")
  .max(40, "Language label is too long");

/**
 * The input for creating a language prerequisite.
 *
 * `isEnabled` defaults to `false` because enabling a language is a separate,
 * explicit decision (`setLanguageEnabled`) — and English, the one language that
 * must be enabled for the bot to work, is created enabled by its caller.
 */
export const ensureLanguageSchema = z.object({
  code: languageCodeSchema,
  label: languageLabelSchema,
  textDirection: textDirectionSchema.default("ltr"),
  isEnabled: z.boolean().default(false),
});

export type EnsureLanguageInput = z.infer<typeof ensureLanguageSchema>;

/**
 * Lists every registered language, enabled and disabled, ordered by code.
 *
 * The admin surface needs the disabled ones too — they are what the seller
 * re-enables from the dashboard. Use `listEnabledLanguages` for the set offered
 * to customers.
 */
export async function listLanguages(db: Database): Promise<LanguageRow[]> {
  return db.select().from(language).orderBy(language.code);
}

/**
 * Lists the languages the bot may currently offer, ordered by code.
 *
 * This is the customer-facing set: language selection, keyboard rendering and
 * content resolution all start here. Disabling a language removes it from this
 * list while leaving every translation row intact (§7).
 */
export async function listEnabledLanguages(db: Database): Promise<LanguageRow[]> {
  return db
    .select()
    .from(language)
    .where(eq(language.isEnabled, true))
    .orderBy(language.code);
}

/** Reads one language by its code, or `null` when no such language exists. */
export async function readLanguage(
  db: Database,
  code: string,
): Promise<LanguageRow | null> {
  const parsed = languageCodeSchema.safeParse(code);

  if (!parsed.success) return null;

  const rows = await db
    .select()
    .from(language)
    .where(eq(language.code, parsed.data))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Reads one language by code, throwing `LANGUAGE_NOT_FOUND` when it is absent.
 *
 * The thrown message includes the code (two harmless characters) because that is
 * what the caller needs to correct; it never includes internal identifiers.
 */
export async function requireLanguage(
  db: Database,
  code: string,
): Promise<LanguageRow> {
  const found = await readLanguage(db, code);

  if (found === null) {
    throw new RabetDataError(
      "LANGUAGE_NOT_FOUND",
      `No language is registered with the code "${code}".`,
    );
  }

  return found;
}

/**
 * Creates a language row if none exists for the code, and returns the row.
 *
 * This is the **prerequisite helper** for the initialization contract
 * (see `docs/PROGRESS.md`, "Initialization contract"): settings cannot be
 * initialized until a default language exists, and the default must be enabled.
 * It is an explicit, idempotent call — nothing seeds itself, and re-running it
 * **never overwrites** an existing row's label, direction or enabled state, so
 * the seller's edits survive every re-run of setup.
 *
 * It is deliberately *not* an upsert: changing a language's label or enabling it
 * are separate, explicit operations.
 */
export async function ensureLanguage(
  db: Database,
  input: EnsureLanguageInput,
): Promise<LanguageRow> {
  // `parse` returns the output type, so the defaulted `textDirection` and
  // `isEnabled` are present even when the caller omitted them.
  let parsed: z.output<typeof ensureLanguageSchema>;

  try {
    parsed = ensureLanguageSchema.parse(input);
  } catch (error) {
    throw invalidInput(error);
  }

  try {
    const inserted = await db
      .insert(language)
      .values({
        code: parsed.code,
        label: parsed.label,
        textDirection: parsed.textDirection,
        isEnabled: parsed.isEnabled,
      })
      // The unique constraint on `code` is the idempotency site: a repeat call
      // for the same code is a no-op that returns the existing row below.
      .onConflictDoNothing({ target: language.code })
      .returning();

    if (inserted.length > 0) return inserted[0];
  } catch (error) {
    throw mapDatabaseError(error);
  }

  // Nothing was inserted, so the language already existed. Return it untouched.
  const existing = await readLanguage(db, parsed.code);

  if (existing === null) {
    // Unreachable unless the row was deleted between the conflict and this read.
    throw new RabetDataError(
      "LANGUAGE_NOT_FOUND",
      `No language is registered with the code "${parsed.code}".`,
    );
  }

  return existing;
}

/** Input for enabling or disabling an optional language. */
export const setLanguageEnabledSchema = z.object({
  code: languageCodeSchema,
  isEnabled: z.boolean(),
});

export type SetLanguageEnabledInput = z.infer<typeof setLanguageEnabledSchema>;

/**
 * Enables or disables an optional language.
 *
 * - **Enabling** is idempotent: enabling an already-enabled language is a
 *   successful no-op.
 * - **Disabling** is idempotent too, and is refused when the language is the
 *   configured default: the seller must first point the settings row at another
 *   valid, enabled language. The typed error says so, and the language stays
 *   enabled.
 *
 * When settings have not been initialized yet there is no default to protect, so
 * either direction is allowed — the bot is not live in that state anyway.
 *
 * Disabling never touches translation rows (§7).
 */
export async function setLanguageEnabled(
  db: Database,
  input: SetLanguageEnabledInput,
): Promise<LanguageRow> {
  let parsed: z.output<typeof setLanguageEnabledSchema>;

  try {
    parsed = setLanguageEnabledSchema.parse(input);
  } catch (error) {
    throw invalidInput(error);
  }

  const target = await requireLanguage(db, parsed.code);

  if (parsed.isEnabled === false) {
    const settings = await db
      .select({ defaultLanguageId: botSetting.defaultLanguageId })
      .from(botSetting)
      .where(eq(botSetting.id, 1))
      .limit(1);

    if (settings.length === 1 && settings[0].defaultLanguageId === target.id) {
      throw new RabetDataError(
        "DEFAULT_LANGUAGE_REQUIRED",
        `The language "${parsed.code}" is the configured default and cannot be ` +
          "disabled. Choose another default language in the bot settings first.",
      );
    }
  }

  try {
    const updated = await db
      .update(language)
      .set({ isEnabled: parsed.isEnabled })
      .where(eq(language.id, target.id))
      .returning();

    // An update that sets the same value still returns the row, so this is the
    // idempotent path as well as the changing one.
    if (updated.length > 0) return updated[0];
  } catch (error) {
    throw mapDatabaseError(error);
  }

  return target;
}

/**
 * Resolves the configured default language by joining the settings singleton to
 * its language row, or `null` when settings have not been initialized.
 *
 * One indexed query: `bot_setting` is a single-row lookup and the join to
 * `language` is a primary-key equality. `null` is the unconfigured state —
 * callers that need it as an error use `requireDefaultLanguage`.
 */
export async function resolveDefaultLanguage(
  db: Database,
): Promise<ResolvedLanguage | null> {
  const rows = await db
    .select({
      id: language.id,
      code: language.code,
      label: language.label,
      textDirection: language.textDirection,
    })
    .from(botSetting)
    .innerJoin(language, eq(language.id, botSetting.defaultLanguageId))
    .where(eq(botSetting.id, 1))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];

  return {
    id: row.id,
    code: row.code,
    label: row.label,
    // Narrowed by the schema's `CHECK (text_direction IN ('ltr','rtl'))`.
    textDirection: row.textDirection === "rtl" ? "rtl" : "ltr",
  };
}

/**
 * The configured default language, or a `SETTINGS_NOT_INITIALIZED` error when
 * the bot has not been set up yet.
 */
export async function requireDefaultLanguage(db: Database): Promise<ResolvedLanguage> {
  const resolved = await resolveDefaultLanguage(db);

  if (resolved === null) {
    throw new RabetDataError(
      "SETTINGS_NOT_INITIALIZED",
      "Bot settings have not been initialized yet, so there is no default " +
        "language. Complete the initial setup first.",
    );
  }

  return resolved;
}
