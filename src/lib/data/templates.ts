import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/db/client";
import { language, messageTemplate, messageTranslation } from "@/db/schema";

import {
  invalidInput,
  mapDatabaseError,
  RabetDataError,
} from "./errors";
import { languageCodeSchema, requireLanguage, resolveDefaultLanguage } from "./languages";

/**
 * ===========================================================================
 * Message template data access — server-only (DATA_MODEL.md §2, §7).
 * ===========================================================================
 *
 * Global bot strings are keyed by a **stable code identifier** (`inquiry_received`,
 * `empty_menu`, …) rather than by id, so a dashboard rename can never break a
 * handler and a new bot string is added by referencing a new key. Each template
 * has one row per language in `message_translation`, resolved at read time
 * through the single fallback chain shared by every translatable entity.
 *
 * The resolution contract (DATA_MODEL.md §7), implemented exactly:
 *
 *   1. the row for the **requested** language;
 *   2. if absent, the row for the configured **default** language;
 *   3. if absent too, an explicit `missing` result — **never a fabricated
 *      string**. It is the caller's job (the bot layer, a later phase) to
 *      substitute a generic safe message, and it decides what "safe" means.
 *
 * Template contents are data, never code: `{{placeholders}}` are substituted
 * server-side from a fixed allowlist of context values, and no content here is
 * ever parsed, compiled or evaluated (§7, §5.2).
 */

/** A `message_template` row. */
export type MessageTemplateRow = typeof messageTemplate.$inferSelect;

/** A `message_translation` row. */
export type MessageTranslationRow = typeof messageTranslation.$inferSelect;

/**
 * A translation row with the language it belongs to, for the admin surface.
 *
 * The join to `language` is what lets the dashboard render one form per language
 * without a second round trip per row.
 */
export type MessageTranslationWithLanguage = {
  id: string;
  languageId: string;
  languageCode: string;
  textDirection: "ltr" | "rtl";
  body: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A stable template key: lowercase snake_case. This is the identifier the code
 * references, so it must never contain spaces, case ambiguity or punctuation
 * that could be mistaken for a placeholder.
 */
export const templateKeySchema = z
  .string()
  .trim()
  .min(1, "Template key is required")
  .max(64, "Template key is too long")
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "Template key must be lowercase letters, digits and underscores, starting with a letter",
  );

/** An admin-facing description of where a string is used. Optional. */
export const templateDescriptionSchema = z
  .string()
  .trim()
  .max(200, "Template description is too long")
  .nullish();

/**
 * A message body.
 *
 * The 4096-character cap is Telegram's message-text limit and the database's own
 * `CHECK (length(body) <= 4096)` (`message_translation_body_length_check`).
 * Validating here keeps an overlong body from reaching SQL at all; the database
 * remains the authority, so a body that somehow bypasses this layer is still
 * rejected.
 */
export const messageBodySchema = z
  .string()
  .trim()
  .min(1, "Message body is required")
  .max(4096, "Message body is too long (4096 characters maximum)");

export const createTemplateSchema = z.object({
  key: templateKeySchema,
  description: templateDescriptionSchema,
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z.object({
  key: templateKeySchema,
  description: templateDescriptionSchema,
});

export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

export const saveTranslationSchema = z.object({
  templateKey: templateKeySchema,
  languageCode: languageCodeSchema,
  body: messageBodySchema,
});

export type SaveTranslationInput = z.infer<typeof saveTranslationSchema>;

/**
 * Reads a template by its stable key, or `null` when no such template exists.
 */
export async function readTemplate(
  db: Database,
  key: string,
): Promise<MessageTemplateRow | null> {
  const parsed = templateKeySchema.safeParse(key);

  if (!parsed.success) return null;

  const rows = await db
    .select()
    .from(messageTemplate)
    .where(eq(messageTemplate.key, parsed.data))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Reads a template by key, throwing `TEMPLATE_NOT_FOUND` when it is absent.
 */
export async function requireTemplate(
  db: Database,
  key: string,
): Promise<MessageTemplateRow> {
  const template = await readTemplate(db, key);

  if (template === null) {
    throw new RabetDataError(
      "TEMPLATE_NOT_FOUND",
      `No message template exists with the key "${key}".`,
    );
  }

  return template;
}

/**
 * Lists every template, ordered by key.
 */
export async function listTemplates(db: Database): Promise<MessageTemplateRow[]> {
  return db.select().from(messageTemplate).orderBy(messageTemplate.key);
}

/**
 * Reads one template together with all of its translations, each carrying its
 * language code and text direction.
 *
 * Throws `TEMPLATE_NOT_FOUND` when the template does not exist. A template that
 * exists but has no translations resolves to an empty array — that is a valid
 * state the admin surface renders as "falls back to the default language".
 */
export async function readTranslations(
  db: Database,
  templateKey: string,
): Promise<MessageTranslationWithLanguage[]> {
  const template = await requireTemplate(db, templateKey);

  const rows = await db
    .select({
      id: messageTranslation.id,
      languageId: messageTranslation.languageId,
      languageCode: language.code,
      textDirection: language.textDirection,
      body: messageTranslation.body,
      createdAt: messageTranslation.createdAt,
      updatedAt: messageTranslation.updatedAt,
    })
    .from(messageTranslation)
    .innerJoin(language, eq(language.id, messageTranslation.languageId))
    .where(eq(messageTranslation.templateId, template.id))
    .orderBy(language.code);

  return rows.map((row) => ({
    id: row.id,
    languageId: row.languageId,
    languageCode: row.languageCode,
    // Narrowed by the schema's `CHECK (text_direction IN ('ltr','rtl'))`.
    textDirection: row.textDirection === "rtl" ? "rtl" : "ltr",
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Creates a template for a stable key if none exists, and returns the template.
 *
 * Idempotent on the key: a repeat call for the same key is a no-op that returns
 * the existing row and **never overwrites** its description. Keys are stable
 * identifiers, so content edits belong to `saveTranslation`, not here.
 */
export async function createTemplate(
  db: Database,
  input: CreateTemplateInput,
): Promise<MessageTemplateRow> {
  let parsed: z.output<typeof createTemplateSchema>;

  try {
    parsed = createTemplateSchema.parse(input);
  } catch (error) {
    throw invalidInput(error);
  }

  try {
    const inserted = await db
      .insert(messageTemplate)
      .values({
        key: parsed.key,
        description: parsed.description ?? null,
      })
      // The unique constraint on `key` is the idempotency site.
      .onConflictDoNothing({ target: messageTemplate.key })
      .returning();

    if (inserted.length > 0) return inserted[0];
  } catch (error) {
    throw mapDatabaseError(error);
  }

  // Nothing was inserted, so the key already existed. Return it untouched.
  return requireTemplate(db, parsed.key);
}

/**
 * Updates a template's admin-facing description.
 *
 * The key is immutable by design — it is the stable identifier handlers
 * reference — so only the description is writable through this layer.
 */
export async function updateTemplate(
  db: Database,
  input: UpdateTemplateInput,
): Promise<MessageTemplateRow> {
  let parsed: z.output<typeof updateTemplateSchema>;

  try {
    parsed = updateTemplateSchema.parse(input);
  } catch (error) {
    throw invalidInput(error);
  }

  try {
    const updated = await db
      .update(messageTemplate)
      .set({ description: parsed.description ?? null })
      .where(eq(messageTemplate.key, parsed.key))
      .returning();

    if (updated.length > 0) return updated[0];
  } catch (error) {
    throw mapDatabaseError(error);
  }

  throw new RabetDataError(
    "TEMPLATE_NOT_FOUND",
    `No message template exists with the key "${parsed.key}".`,
  );
}

/**
 * Saves a validated localized body for one template in one language.
 *
 * An **upsert** on `(template_id, language_id)`: the first call creates the
 * translation, a later call replaces the body. Exactly one row per template per
 * language is therefore guaranteed by the unique index
 * `message_translation_template_language_idx`, and a repeated call is a
 * idempotent overwrite of the same site (ADR-015).
 *
 * The language is **not** required to be enabled. Preparing Arabic content
 * before enabling Arabic is a legitimate workflow, and disabling a language
 * preserves its translations (DATA_MODEL.md §7) — so re-enabling later restores
 * everything that was written.
 *
 * Throws `TEMPLATE_NOT_FOUND` / `LANGUAGE_NOT_FOUND` for unknown keys or codes,
 * and `INVALID_INPUT` for an empty or overlong body before any query runs.
 */
export async function saveTranslation(
  db: Database,
  input: SaveTranslationInput,
): Promise<MessageTranslationRow> {
  let parsed: z.output<typeof saveTranslationSchema>;

  try {
    parsed = saveTranslationSchema.parse(input);
  } catch (error) {
    throw invalidInput(error);
  }

  const template = await requireTemplate(db, parsed.templateKey);
  const targetLanguage = await requireLanguage(db, parsed.languageCode);

  try {
    const upserted = await db
      .insert(messageTranslation)
      .values({
        templateId: template.id,
        languageId: targetLanguage.id,
        body: parsed.body,
      })
      .onConflictDoUpdate({
        target: [messageTranslation.templateId, messageTranslation.languageId],
        set: { body: parsed.body },
      })
      .returning();

    if (upserted.length > 0) return upserted[0];
  } catch (error) {
    throw mapDatabaseError(error);
  }

  // Unreachable: the upsert either inserts or updates the one matching row.
  throw new RabetDataError("UNCATEGORIZED", "The translation could not be saved.");
}

/**
 * The outcome of resolving one template's text. A discriminated union, because
 * "missing" is a real result the caller must handle and must never be papered
 * over with an invented string (DATA_MODEL.md §7).
 */
export type ResolvedMessage =
  | {
      status: "resolved";
      /** The text to render. */
      body: string;
      /** The language the body was actually found in. */
      languageCode: string;
      /** That language's text direction, for RTL rendering. */
      direction: "ltr" | "rtl";
      /** Which step of the fallback chain supplied the text. */
      matched: "requested" | "default";
    }
  | {
      status: "missing";
      /** No template row carries this key at all. */
      reason: "template_missing";
      /** The template key that was requested. */
      templateKey: string;
    }
  | {
      status: "missing";
      /**
       * No requested-language row and no configured default language either —
       * the bot has not been initialized, so the fallback chain has no second
       * step.
       */
      reason: "no_default_language";
      templateKey: string;
    }
  | {
      status: "missing";
      /**
       * The template exists and a default language is configured, but neither
       * the requested nor the default translation is present.
       */
      reason: "translation_missing";
      templateKey: string;
    };

/**
 * Resolves the text for one template through the single fallback chain.
 *
 * Two indexed queries: the settings→default-language join, and one left join
 * from the template to its translations. On the neon-http driver that is two
 * HTTP requests, and neither reads a row it just wrote (ADR-015).
 *
 * A well-formed but unknown `languageCode` (a language the bot has no
 * translations for) simply misses step 1 and falls back to step 2 — that is the
 * documented behaviour for a partially translated bot. A malformed code is an
 * `INVALID_INPUT` error, because the caller passed something the schema cannot
 * represent.
 */
export async function resolveMessageText(
  db: Database,
  params: { templateKey: string; languageCode?: string },
): Promise<ResolvedMessage> {
  let key: string;
  let requestedCode: string | undefined;

  try {
    key = templateKeySchema.parse(params.templateKey);
    requestedCode =
      params.languageCode === undefined
        ? undefined
        : languageCodeSchema.parse(params.languageCode);
  } catch (error) {
    throw invalidInput(error);
  }

  // Step 2 of the chain is read first so it can inform the "missing" reason.
  const defaultLanguage = await resolveDefaultLanguage(db);

  // One left join: when the template exists but has no translations, this
  // yields a single row with null body/code, which is how "template exists,
  // no content" is distinguished from "no such template".
  const rows = await db
    .select({
      templateId: messageTemplate.id,
      body: messageTranslation.body,
      languageCode: language.code,
      textDirection: language.textDirection,
    })
    .from(messageTemplate)
    .leftJoin(
      messageTranslation,
      eq(messageTranslation.templateId, messageTemplate.id),
    )
    .leftJoin(language, eq(language.id, messageTranslation.languageId))
    .where(eq(messageTemplate.key, key));

  if (rows.length === 0) {
    return { status: "missing", reason: "template_missing", templateKey: key };
  }

  // The fallback chain, ordered: the requested language first, then the
  // configured default. Candidates are collected up front so the chain is one
  // explicit loop rather than a nested closure per step.
  const candidates: Array<{ code: string; matched: "requested" | "default" }> = [];

  if (requestedCode !== undefined) {
    candidates.push({ code: requestedCode, matched: "requested" });
  }

  if (defaultLanguage !== null) {
    candidates.push({ code: defaultLanguage.code, matched: "default" });
  }

  for (const candidate of candidates) {
    const row = rows.find((row) => row.languageCode === candidate.code);

    if (row !== undefined && row.body !== null) {
      return {
        status: "resolved",
        body: row.body,
        languageCode: row.languageCode as string,
        direction: row.textDirection === "rtl" ? "rtl" : "ltr",
        matched: candidate.matched,
      };
    }
  }

  return {
    status: "missing",
    reason:
      defaultLanguage === null ? "no_default_language" : "translation_missing",
    templateKey: key,
  };
}
