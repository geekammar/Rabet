import "server-only";

import { eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/db/client";
import { botSetting, product } from "@/db/schema";
import {
  resolveStorefrontMenuConfig,
  storefrontMenuConfigSchema,
  type StorefrontMenuConfig,
  type StorefrontMenuConfigSource,
} from "@/lib/storefront/menu";

import {
  invalidInput,
  isUndefinedColumnError,
  mapDatabaseError,
  RabetDataError,
} from "./errors";
import { languageCodeSchema, requireLanguage } from "./languages";

/**
 * ===========================================================================
 * `bot_setting` data access — server-only (DATA_MODEL.md §4.5).
 * ===========================================================================
 *
 * Four focused operations on the single configuration row:
 *
 *   - `readSettings` / `isConfigured` / `requireSettings` — reading the row and
 *     detecting the unconfigured state;
 *   - `initializeSettings` — the one explicit creation path;
 *   - `updateSettings` — changing an already-initialized row.
 *
 * The singleton is enforced by the schema itself: `id` is the primary key *and*
 * `CHECK (id = 1)`, so a second settings row cannot be written by anything
 * (constraint `bot_setting_singleton_check`). This layer adds the *initialization
 * contract* on top of it:
 *
 *   - initialization **requires explicit values** — the display name, the
 *     currency and the default language code have no defaults here and no
 *     defaults in the schema. Nothing invents a business currency or a display
 *     name on the owner's behalf;
 *   - the default language must **exist and be enabled** before settings can be
 *     initialized (DATA_MODEL.md §12.5);
 *   - initializing over an existing row is **rejected** with a clear typed
 *     error rather than silently updating it;
 *   - every write is idempotent at its own site (`ON CONFLICT DO NOTHING` on the
 *     primary key), so the neon-http driver needs no interactive transaction
 *     (ADR-015).
 */

/** A `bot_setting` row, as read from the database. */
export type BotSettings = typeof botSetting.$inferSelect;

/**
 * The currencies the schema's `CHECK` allows. The allowlist is duplicated here
 * deliberately: it lets a caller validate before any query runs and keeps the
 * two sources provably in step, because `CURRENCIES` is also what the Zod
 * schema below is built from. A currency outside this set cannot reach the
 * database through this layer.
 *
 * Which member the seller uses is a **product decision** (DATA_MODEL.md §19.6);
 * nothing here picks one.
 */
export const CURRENCIES = ["SAR", "USD", "AED", "EGP"] as const;

export type Currency = (typeof CURRENCIES)[number];

export const currencySchema = z.enum(CURRENCIES, {
  message: "Currency must be one of SAR, USD, AED, EGP",
});

/** The bot's display name, shown in the greeting. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Display name is required")
  .max(60, "Display name is too long");

/** A support reply-time line, e.g. "within 24 hours". Optional. */
export const supportReplyTimeSchema = z
  .string()
  .trim()
  .max(120, "Support reply time is too long")
  .nullish();

/** Support categories: a handful of short, editable strings (DATA_MODEL.md §4.5). */
const supportCategoryItemSchema = z.string().trim().min(1).max(60);

/**
 * The input for the **initial** setup.
 *
 * `displayName`, `currency` and `defaultLanguageCode` are required: they are the
 * bot's identity and cannot be invented. `askForLanguage` and `supportCategory`
 * carry only non-business defaults (a boolean and an empty array), so the owner
 * is never committed to content they did not enter.
 */
export const initializeSettingsSchema = z.object({
  defaultLanguageCode: languageCodeSchema,
  currency: currencySchema,
  displayName: displayNameSchema,
  askForLanguage: z.boolean().default(true),
  supportCategory: z.array(supportCategoryItemSchema).default([]),
  supportReplyTime: supportReplyTimeSchema,
});

export type InitializeSettingsInput = z.infer<typeof initializeSettingsSchema>;

/**
 * The input for updating an already-initialized row.
 *
 * Every field is optional and only the provided ones are written. The default
 * language may be changed to any other **enabled** language; the currency to any
 * member of the allowlist. The key is immutable — it is the stable identifier
 * the codebase's template keys and future handlers reference.
 */
export const updateSettingsSchema = z.object({
  defaultLanguageCode: languageCodeSchema.optional(),
  currency: currencySchema.optional(),
  displayName: displayNameSchema.optional(),
  askForLanguage: z.boolean().optional(),
  supportCategory: z.array(supportCategoryItemSchema).optional(),
  supportReplyTime: supportReplyTimeSchema,
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

/**
 * Reads the single settings row, or `null` when the bot has not been
 * initialized yet.
 *
 * `id` is constrained to `1`, so this is always a single-row lookup.
 */
export async function readSettings(db: Database): Promise<BotSettings | null> {
  // Explicit columns keep this read compatible with a database where the
  // additive storefront-menu migration has not been applied yet. The menu has
  // its own capability-aware reader below; treating it as `null` here preserves
  // the Phase 28 defaults for every existing caller.
  const rows = await db
    .select({
      id: botSetting.id,
      defaultLanguageId: botSetting.defaultLanguageId,
      currency: botSetting.currency,
      displayName: botSetting.displayName,
      askForLanguage: botSetting.askForLanguage,
      supportCategory: botSetting.supportCategory,
      supportReplyTime: botSetting.supportReplyTime,
      createdAt: botSetting.createdAt,
      updatedAt: botSetting.updatedAt,
    })
    .from(botSetting)
    .where(eq(botSetting.id, 1))
    .limit(1);

  const row = rows[0];
  return row ? { ...row, storeId: null, storefrontMenu: null } : null;
}

/**
 * True once the settings singleton exists — the lightest possible check for the
 * unconfigured state (it reads only the primary key).
 */
export async function isConfigured(db: Database): Promise<boolean> {
  const rows = await db
    .select({ id: botSetting.id })
    .from(botSetting)
    .where(eq(botSetting.id, 1))
    .limit(1);

  return rows.length === 1;
}

/**
 * The settings row, or a `SETTINGS_NOT_INITIALIZED` error when the bot has not
 * been set up. Surfaces that require configuration call this; the onboarding
 * flow checks `isConfigured` instead.
 */
export async function requireSettings(db: Database): Promise<BotSettings> {
  const settings = await readSettings(db);

  if (settings === null) {
    throw new RabetDataError(
      "SETTINGS_NOT_INITIALIZED",
      "Bot settings have not been initialized yet. Complete the initial setup " +
        "first.",
    );
  }

  return settings;
}

/**
 * Creates the settings singleton from **explicit** owner values.
 *
 * Precondition contract:
 *
 *   - a `language` row for `defaultLanguageCode` must exist — create it first
 *     with `ensureLanguage` (typically `en`, enabled);
 *   - that language must be **enabled**, because it is the fallback for every
 *     translatable entity (DATA_MODEL.md §7);
 *
 * Postcondition contract:
 *
 *   - exactly one row exists afterwards, with `id = 1`;
 *   - calling this again is rejected with `SETTINGS_ALREADY_INITIALIZED` and the
 *     existing row is left untouched — initialization is not an update;
 *   - no currency, display name or language is ever invented: a missing value
 *     fails validation before any query runs.
 */
export async function initializeSettings(
  db: Database,
  input: InitializeSettingsInput,
): Promise<BotSettings> {
  let parsed: z.output<typeof initializeSettingsSchema>;

  try {
    parsed = initializeSettingsSchema.parse(input);
  } catch (error) {
    throw invalidInput(error);
  }

  // Validate the default-language relationship before writing. This is the rule
  // a `CHECK` cannot express (DATA_MODEL.md §12.5): the referenced language must
  // exist *and* be enabled.
  const defaultLanguage = await requireLanguage(db, parsed.defaultLanguageCode);

  if (!defaultLanguage.isEnabled) {
    throw new RabetDataError(
      "LANGUAGE_NOT_ENABLED",
      `The language "${parsed.defaultLanguageCode}" is registered but disabled. ` +
        "Enable it before using it as the default language.",
    );
  }

  try {
    // Explicit column list, intentionally omitting `storefront_menu`: the
    // initialization contract must keep working on a database where the
    // additive storefront-menu migration has not been applied yet. The column
    // has no default and stays NULL, which is the documented "not customized"
    // state.
    const inserted = await db.execute<{ id: number }>(sql`
      insert into ${botSetting} (
        "id",
        "default_language_id",
        "currency",
        "display_name",
        "ask_for_language",
        "support_category",
        "support_reply_time"
      ) values (
        1,
        ${defaultLanguage.id},
        ${parsed.currency},
        ${parsed.displayName},
        ${parsed.askForLanguage},
        ${sql.param(parsed.supportCategory, botSetting.supportCategory)},
        ${parsed.supportReplyTime ?? null}
      )
      on conflict ("id") do nothing
      returning "id"
    `);

    const rawRows: unknown = Array.isArray(inserted)
      ? inserted
      : (inserted as { rows?: unknown[] })?.rows;
    const insertedRows = Array.isArray(rawRows) ? rawRows : [];

    if (insertedRows.length > 0) {
      const settings = await readSettings(db);
      if (settings) return settings;
    }
  } catch (error) {
    throw mapDatabaseError(error);
  }

  throw new RabetDataError(
    "SETTINGS_ALREADY_INITIALIZED",
    "Bot settings are already initialized. Use the settings update form to " +
      "change them.",
  );
}

/**
 * Updates the settings singleton, writing only the provided fields.
 *
 * Requires an initialized row (`SETTINGS_NOT_INITIALIZED` otherwise), and when a
 * new default language is given it must exist and be enabled — the same rule as
 * initialization. The currency allowlist is enforced by the Zod schema and again
 * by the database's `CHECK`.
 */
export async function updateSettings(
  db: Database,
  input: UpdateSettingsInput,
): Promise<BotSettings> {
  let parsed: z.output<typeof updateSettingsSchema>;

  try {
    parsed = updateSettingsSchema.parse(input);
  } catch (error) {
    throw invalidInput(error);
  }

  let defaultLanguageId: string | undefined;

  if (parsed.defaultLanguageCode !== undefined) {
    const defaultLanguage = await requireLanguage(db, parsed.defaultLanguageCode);

    if (!defaultLanguage.isEnabled) {
      throw new RabetDataError(
        "LANGUAGE_NOT_ENABLED",
        `The language "${parsed.defaultLanguageCode}" is registered but disabled. ` +
          "Enable it before using it as the default language.",
      );
    }

    defaultLanguageId = defaultLanguage.id;
  }

  try {
    const updated = await db
      .update(botSetting)
      .set({
        defaultLanguageId,
        currency: parsed.currency,
        displayName: parsed.displayName,
        askForLanguage: parsed.askForLanguage,
        supportCategory: parsed.supportCategory,
        supportReplyTime: parsed.supportReplyTime,
      })
      .where(eq(botSetting.id, 1))
      .returning({ id: botSetting.id });

    if (updated.length > 0) {
      return requireSettings(db);
    }
  } catch (error) {
    throw mapDatabaseError(error);
  }

  // No row matched the singleton key, so nothing was initialized to update.
  throw new RabetDataError(
    "SETTINGS_NOT_INITIALIZED",
    "Bot settings have not been initialized yet. Complete the initial setup " +
      "first.",
  );
}

export type StorefrontMenuSettings = {
  config: StorefrontMenuConfig;
  source: StorefrontMenuConfigSource;
};

/**
 * Reads the merchant's storefront menu choices.
 *
 * An uninitialized store keeps the `SETTINGS_NOT_INITIALIZED` contract. A
 * missing value is the backward-compatible Phase 28 default; malformed JSON is
 * reported as `invalid` but still yields the safe defaults so a bad row cannot
 * take customer navigation down.
 */
export async function readStorefrontMenuSettings(
  db: Database,
): Promise<StorefrontMenuSettings> {
  await requireSettings(db);

  try {
    const rows = await db
      .select({ storefrontMenu: botSetting.storefrontMenu })
      .from(botSetting)
      .where(eq(botSetting.id, 1))
      .limit(1);

    return resolveStorefrontMenuConfig(rows[0]?.storefrontMenu);
  } catch (error) {
    if (isUndefinedColumnError(error)) {
      // The additive migration has not been applied yet. Existing stores keep
      // the Phase 28 behavior instead of failing the customer home.
      return resolveStorefrontMenuConfig(null);
    }

    throw mapDatabaseError(error);
  }
}

/**
 * Persists a merchant-customized storefront menu.
 *
 * The complete ordered configuration is validated before the single settings
 * row is updated. The write is a no-op path (typed error) when settings have
 * not been initialized.
 */
export async function saveStorefrontMenuConfig(
  db: Database,
  input: unknown,
): Promise<StorefrontMenuConfig> {
  let parsed: StorefrontMenuConfig;

  try {
    parsed = storefrontMenuConfigSchema.parse(input);
  } catch (error) {
    throw invalidInput(error);
  }

  try {
    const updated = await db
      .update(botSetting)
      .set({ storefrontMenu: parsed })
      .where(eq(botSetting.id, 1))
      .returning({ storefrontMenu: botSetting.storefrontMenu });

    if (updated.length > 0) {
      return parsed;
    }
  } catch (error) {
    if (isUndefinedColumnError(error)) {
      throw new RabetDataError(
        "SCHEMA_UPGRADE_REQUIRED",
        "The storefront menu database upgrade has not been applied yet.",
        { cause: error },
      );
    }

    throw mapDatabaseError(error);
  }

  throw new RabetDataError(
    "SETTINGS_NOT_INITIALIZED",
    "Bot settings have not been initialized yet. Complete the initial setup " +
      "first.",
  );
}

/**
 * Restores the Phase 28 default menu by clearing the customization.
 *
 * `NULL` is the canonical "not customized" value; reset therefore never writes
 * a frozen copy of today's defaults, which keeps future default additions
 * backward compatible.
 */
export async function resetStorefrontMenuConfig(
  db: Database,
): Promise<StorefrontMenuConfig> {
  try {
    const updated = await db
      .update(botSetting)
      .set({ storefrontMenu: null })
      .where(eq(botSetting.id, 1))
      .returning({ id: botSetting.id });

    if (updated.length > 0) {
      return resolveStorefrontMenuConfig(null).config;
    }
  } catch (error) {
    if (isUndefinedColumnError(error)) {
      throw new RabetDataError(
        "SCHEMA_UPGRADE_REQUIRED",
        "The storefront menu database upgrade has not been applied yet.",
        { cause: error },
      );
    }

    throw mapDatabaseError(error);
  }

  throw new RabetDataError(
    "SETTINGS_NOT_INITIALIZED",
    "Bot settings have not been initialized yet. Complete the initial setup " +
      "first.",
  );
}

/**
 * True when the catalog contains at least one active product with a price.
 *
 * Used by the settings UI and actions to detect whether changing the store
 * currency requires explicit confirmation, ensuring existing product prices
 * are not silently reinterpreted in a new currency without the owner's consent
 * (DATA_MODEL.md §19.6).
 */
export async function hasCatalogPrices(db: Database): Promise<boolean> {
  const rows = await db
    .select({ id: product.id })
    .from(product)
    .where(isNull(product.deletedAt))
    .limit(1);

  return rows.length > 0;
}
