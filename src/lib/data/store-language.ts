import "server-only";

import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  botSetting,
  buyerLanguagePreference,
  language,
  storeLanguageSetting,
} from "@/db/schema";
import {
  BUYER_LOCALE_META,
  buyerLocaleFromLanguageCode,
  isBuyerLocale,
  type BuyerLocale,
} from "@/lib/commerce/buyer-language";
import { mapDatabaseError } from "./errors";
import { assertStoreScope, type StoreScope } from "./store-scope";

/**
 * Store-scoped customer language resolution.
 *
 * Buyer-facing UI language is stored as a validated `ar`/`en` locale. It is
 * intentionally independent from the global catalog `language` rows: choosing
 * Arabic UI must not create or enable Arabic catalog metadata, and a fresh
 * store must be able to select either UI language even when those rows are
 * missing or disabled.
 *
 * Resolution order:
 *
 *   1. the buyer's explicit choice for this exact store;
 *   2. the merchant's explicit default for this store;
 *   3. a compatible same-store legacy `bot_setting` default;
 *   4. the existing Telegram profile hint (`ar*` → Arabic, otherwise English).
 *
 * An unowned legacy singleton is not used as every managed store's default.
 * The global language table only participates in step 3, and only when its row
 * exists, is enabled and belongs to the same store.
 */

export type StoreLanguageChoice = {
  code: BuyerLocale;
  label: string;
  textDirection: "ltr" | "rtl";
};

export type ResolvedBuyerLanguage = {
  locale: BuyerLocale;
  source: "buyer" | "store_default" | "profile";
  storeDefaultCode: BuyerLocale | null;
};

function choiceFor(code: BuyerLocale): StoreLanguageChoice {
  const meta = BUYER_LOCALE_META[code];
  return {
    code,
    label: meta.label,
    textDirection: meta.textDirection,
  };
}

/**
 * Reads the explicit per-store UI language, if one has been saved.
 */
export async function readStoreLanguageChoice(
  db: Database,
  storeId: string,
): Promise<StoreLanguageChoice | null> {
  if (typeof storeId !== "string" || storeId.trim().length === 0) return null;

  const rows = await db
    .select({ locale: storeLanguageSetting.locale })
    .from(storeLanguageSetting)
    .where(eq(storeLanguageSetting.storeId, storeId))
    .limit(1);

  const locale = rows[0]?.locale;
  return isBuyerLocale(locale) ? choiceFor(locale) : null;
}

/**
 * Resolves the merchant default for one store.
 *
 * The explicit per-store locale wins. A legacy `bot_setting` row is a fallback
 * only when it belongs to this same store and its language is enabled; an
 * unowned singleton is deliberately ignored.
 */
export async function readStoreDefaultLanguage(
  db: Database,
  storeId: string,
): Promise<StoreLanguageChoice | null> {
  const explicit = await readStoreLanguageChoice(db, storeId);
  if (explicit) return explicit;

  if (typeof storeId !== "string" || storeId.trim().length === 0) return null;

  const legacy = await db
    .select({ code: language.code })
    .from(botSetting)
    .innerJoin(language, eq(language.id, botSetting.defaultLanguageId))
    .where(
      and(
        eq(botSetting.id, 1),
        eq(botSetting.storeId, storeId),
        eq(language.isEnabled, true),
      ),
    )
    .limit(1);

  const code = legacy[0]?.code;
  return isBuyerLocale(code) ? choiceFor(code) : null;
}

/**
 * Reads the store's legacy catalog default language used for merchant-entered
 * catalog content.
 *
 * This is intentionally separate from the buyer UI locale. `store_language_setting`
 * and `buyer_language_preference` change only menus, buttons, prompts,
 * checkout and receipt copy; they never choose a catalog translation.
 *
 * A missing row means the older store has no canonical catalog marker. The
 * catalog reader then uses its deterministic English -> Arabic -> other-code
 * fallback, independent of the buyer UI.
 */
export async function readStoreCatalogLanguageCode(
  db: Database,
  storeId: string,
): Promise<string | null> {
  if (typeof storeId !== "string" || storeId.trim().length === 0) return null;

  const rows = await db
    .select({ code: language.code })
    .from(botSetting)
    .innerJoin(language, eq(language.id, botSetting.defaultLanguageId))
    .where(
      and(eq(botSetting.id, 1), eq(botSetting.storeId, storeId)),
    )
    .limit(1);

  return rows[0]?.code ?? null;
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
    .select({ locale: buyerLanguagePreference.locale })
    .from(buyerLanguagePreference)
    .where(
      and(
        eq(buyerLanguagePreference.storeId, input.storeId),
        eq(buyerLanguagePreference.telegramUserId, input.telegramUserId),
      ),
    )
    .limit(1);

  const buyerLocale = preference[0]?.locale;

  if (isBuyerLocale(buyerLocale)) {
    return {
      locale: buyerLocale,
      source: "buyer",
      storeDefaultCode,
    };
  }

  if (storeDefault) {
    return {
      locale: storeDefault.code,
      source: "store_default",
      storeDefaultCode,
    };
  }

  return {
    locale: buyerLocaleFromLanguageCode(input.profileLanguageCode),
    source: "profile",
    storeDefaultCode,
  };
}

/**
 * Persists one buyer's explicit UI language for one store.
 *
 * The composite primary key makes the write idempotent and keeps the
 * preference strictly per store. No global language row is read or written.
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
    await db
      .insert(buyerLanguagePreference)
      .values({
        storeId: scope.storeId,
        telegramUserId: input.telegramUserId,
        locale: input.code,
      })
      .onConflictDoUpdate({
        target: [
          buyerLanguagePreference.storeId,
          buyerLanguagePreference.telegramUserId,
        ],
        set: {
          locale: input.code,
          updatedAt: new Date(),
        },
      });

    return { ok: true, locale: input.code };
  } catch (error) {
    throw mapDatabaseError(error);
  }
}
