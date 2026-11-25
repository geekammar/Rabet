import "server-only";

import { and, eq, isNull, or } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  botSetting,
  buyerLanguagePreference,
  language,
  storeLanguageSetting,
} from "@/db/schema";
import {
  buyerLocaleFromLanguageCode,
  isBuyerLocale,
  type BuyerLocale,
} from "@/lib/commerce/buyer-language";
import { mapDatabaseError } from "./errors";
import { assertStoreScope, type StoreScope } from "./store-scope";

/**
 * Store-scoped customer language resolution.
 *
 * Priority is deliberate and stored, not inferred from the request:
 *
 *   1. the buyer's explicit choice for this exact store;
 *   2. the merchant's configured default for this store;
 *   3. the legacy `bot_setting` default for the same store, when one exists;
 *   4. the existing Telegram profile hint (`ar*` → Arabic, otherwise English).
 *
 * The legacy row is only a compatibility fallback. A row that belongs to a
 * different store never affects this store, and a disabled language is ignored
 * at read time so an old preference can never trap a buyer in a language the
 * store no longer offers.
 */

export type StoreLanguageChoice = {
  id: string;
  code: string;
  label: string;
  textDirection: "ltr" | "rtl";
  isEnabled: boolean;
};

export type ResolvedBuyerLanguage = {
  locale: BuyerLocale;
  languageId: string | null;
  source: "buyer" | "store_default" | "profile";
  storeDefaultCode: string | null;
};

function toChoice(row: {
  id: string;
  code: string;
  label: string;
  textDirection: string;
  isEnabled: boolean;
}): StoreLanguageChoice {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    textDirection: row.textDirection === "rtl" ? "rtl" : "ltr",
    isEnabled: row.isEnabled,
  };
}

/**
 * Reads the explicit per-store row even when its language is disabled, so the
 * merchant settings card can explain the current value honestly. Buyer
 * resolution below uses the enabled-only reader instead.
 */
export async function readStoreLanguageChoice(
  db: Database,
  storeId: string,
): Promise<StoreLanguageChoice | null> {
  if (typeof storeId !== "string" || storeId.trim().length === 0) return null;

  const rows = await db
    .select({
      id: language.id,
      code: language.code,
      label: language.label,
      textDirection: language.textDirection,
      isEnabled: language.isEnabled,
    })
    .from(storeLanguageSetting)
    .innerJoin(language, eq(language.id, storeLanguageSetting.defaultLanguageId))
    .where(eq(storeLanguageSetting.storeId, storeId))
    .limit(1);

  return rows[0] ? toChoice(rows[0]) : null;
}

/**
 * Resolves the merchant default for one store.
 *
 * The explicit per-store setting wins. Existing stores without that row keep
 * the default they already configured on the legacy singleton, but only when
 * that singleton is either unowned (the historical single-store state) or
 * belongs to the same store.
 */
export async function readStoreDefaultLanguage(
  db: Database,
  storeId: string,
): Promise<StoreLanguageChoice | null> {
  if (typeof storeId !== "string" || storeId.trim().length === 0) return null;

  const explicit = await db
    .select({
      id: language.id,
      code: language.code,
      label: language.label,
      textDirection: language.textDirection,
      isEnabled: language.isEnabled,
    })
    .from(storeLanguageSetting)
    .innerJoin(language, eq(language.id, storeLanguageSetting.defaultLanguageId))
    .where(
      and(
        eq(storeLanguageSetting.storeId, storeId),
        eq(language.isEnabled, true),
      ),
    )
    .limit(1);

  if (explicit[0]) return toChoice(explicit[0]);

  const legacy = await db
    .select({
      id: language.id,
      code: language.code,
      label: language.label,
      textDirection: language.textDirection,
      isEnabled: language.isEnabled,
    })
    .from(botSetting)
    .innerJoin(language, eq(language.id, botSetting.defaultLanguageId))
    .where(
      and(
        eq(botSetting.id, 1),
        or(eq(botSetting.storeId, storeId), isNull(botSetting.storeId)),
        eq(language.isEnabled, true),
      ),
    )
    .limit(1);

  return legacy[0] ? toChoice(legacy[0]) : null;
}

/**
 * Resolves the effective buyer language for one trusted store/buyer pair.
 *
 * `telegramUserId` is the verified sender id, never a callback payload value.
 */
export async function resolveBuyerLanguage(
  db: Database,
  input: {
    storeId: string;
    telegramUserId: number;
    profileLanguageCode?: string | undefined;
  },
): Promise<ResolvedBuyerLanguage> {
  const storeDefault = await readStoreDefaultLanguage(db, input.storeId);
  const storeDefaultCode = storeDefault?.code ?? null;

  const preference = await db
    .select({
      id: language.id,
      code: language.code,
    })
    .from(buyerLanguagePreference)
    .innerJoin(language, eq(language.id, buyerLanguagePreference.languageId))
    .where(
      and(
        eq(buyerLanguagePreference.storeId, input.storeId),
        eq(buyerLanguagePreference.telegramUserId, input.telegramUserId),
        eq(language.isEnabled, true),
      ),
    )
    .limit(1);

  if (preference[0] && isBuyerLocale(preference[0].code)) {
    return {
      locale: preference[0].code,
      languageId: preference[0].id,
      source: "buyer",
      storeDefaultCode,
    };
  }

  if (storeDefault && isBuyerLocale(storeDefault.code)) {
    return {
      locale: storeDefault.code,
      languageId: storeDefault.id,
      source: "store_default",
      storeDefaultCode,
    };
  }

  return {
    locale: buyerLocaleFromLanguageCode(input.profileLanguageCode),
    languageId: null,
    source: "profile",
    storeDefaultCode,
  };
}

/**
 * Persists one buyer's explicit language for one store.
 *
 * Only an enabled Arabic/English row may be written. The composite primary key
 * makes the write idempotent and keeps the preference strictly per store.
 */
export async function saveBuyerLanguagePreference(
  db: Database,
  scope: StoreScope,
  input: { telegramUserId: number; code: unknown },
): Promise<{ ok: true; locale: BuyerLocale } | { ok: false; error: "INVALID_LANGUAGE" }> {
  assertStoreScope(scope);

  if (!isBuyerLocale(input.code)) {
    return { ok: false, error: "INVALID_LANGUAGE" };
  }

  try {
    const rows = await db
      .select({ id: language.id })
      .from(language)
      .where(and(eq(language.code, input.code), eq(language.isEnabled, true)))
      .limit(1);

    const row = rows[0];

    if (!row) {
      return { ok: false, error: "INVALID_LANGUAGE" };
    }

    await db
      .insert(buyerLanguagePreference)
      .values({
        storeId: scope.storeId,
        telegramUserId: input.telegramUserId,
        languageId: row.id,
      })
      .onConflictDoUpdate({
        target: [
          buyerLanguagePreference.storeId,
          buyerLanguagePreference.telegramUserId,
        ],
        set: {
          languageId: row.id,
          updatedAt: new Date(),
        },
      });

    return { ok: true, locale: input.code };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}
