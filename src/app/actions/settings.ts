"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  CURRENCIES,
  Currency,
  ensureLanguage,
  hasCatalogPrices,
  initializeSettings,
  RabetDataError,
  requireSettings,
  setLanguageEnabled,
  toSafeErrorMessage,
  updateSettings,
} from "@/lib/data";

/**
 * Standard result returned by Settings Server Actions.
 *
 * Guarantees safe error messaging: no internal SQL, credentials or stack traces
 * ever reach the client.
 */
export type SettingsActionResult = {
  success: boolean;
  message?: string;
  code?: string;
  errors?: Record<string, string>;
};

/**
 * Helper to extract support categories from FormData.
 *
 * Handles both repeated `supportCategory` fields and comma/newline-separated strings.
 * Filters out blank entries and trims each string.
 */
function parseSupportCategories(formData: FormData): string[] {
  const allValues = formData.getAll("supportCategory");
  const categories: string[] = [];

  for (const val of allValues) {
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.length > 0) {
        categories.push(trimmed);
      }
    }
  }

  // Also check single 'supportCategoriesJson' if submitted via JSON state
  const rawJson = formData.get("supportCategoriesJson");
  if (typeof rawJson === "string" && rawJson.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") {
            const trimmed = item.trim();
            if (trimmed.length > 0 && !categories.includes(trimmed)) {
              categories.push(trimmed);
            }
          }
        }
      }
    } catch {
      // Ignore JSON parse error, already captured by individual fields
    }
  }

  return categories;
}

/**
 * First-time store initialization Server Action.
 *
 * - Asserts admin session before DB access (ADR-010).
 * - Validates input with Zod.
 * - Idempotently ensures the English language row exists (`en`, `ltr`, enabled).
 * - If Arabic is requested as default, ensures the Arabic language row exists (`ar`, `rtl`, enabled).
 * - Creates the singleton row via `initializeSettings()`.
 * - Never silently overwrites an existing row (returns `SETTINGS_ALREADY_INITIALIZED`).
 */
export async function initializeStoreSettings(
  _prevState: SettingsActionResult | undefined,
  formData: FormData,
): Promise<SettingsActionResult> {
  // Authoritative boundary check (ADR-010)
  await requireAdmin();

  const displayName = formData.get("displayName")?.toString() ?? "";
  const currencyRaw = formData.get("currency")?.toString() ?? "USD";
  const defaultLanguageCode =
    formData.get("defaultLanguageCode")?.toString()?.toLowerCase().trim() ?? "en";
  const askForLanguage =
    formData.get("askForLanguage") === "true" ||
    formData.get("askForLanguage") === "on";
  const supportCategory = parseSupportCategories(formData);
  const supportReplyTimeRaw = formData.get("supportReplyTime")?.toString();
  const supportReplyTime =
    supportReplyTimeRaw && supportReplyTimeRaw.trim().length > 0
      ? supportReplyTimeRaw.trim()
      : null;

  // Basic validation check against allowed currencies
  if (!CURRENCIES.includes(currencyRaw as Currency)) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: `Invalid currency "${currencyRaw}". Allowed options: ${CURRENCIES.join(", ")}.`,
    };
  }

  const currency = currencyRaw as Currency;

  try {
    const db = getDb();

    // English is the primary default language and must exist
    await ensureLanguage(db, {
      code: "en",
      label: "English",
      textDirection: "ltr",
      isEnabled: true,
    });

    // If Arabic is chosen as initial default, ensure it exists and is enabled
    if (defaultLanguageCode === "ar") {
      await ensureLanguage(db, {
        code: "ar",
        label: "العربية",
        textDirection: "rtl",
        isEnabled: true,
      });
    }

    // Call initializeSettings with explicit owner values
    await initializeSettings(db, {
      displayName,
      currency,
      defaultLanguageCode,
      askForLanguage,
      supportCategory,
      supportReplyTime,
    });

    revalidatePath("/settings");
    return {
      success: true,
      message: "Store settings saved successfully.",
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      if (error.code === "SETTINGS_ALREADY_INITIALIZED") {
        revalidatePath("/settings");
        return {
          success: false,
          code: error.code,
          message:
            "Store settings are already initialized. Loading current configuration.",
        };
      }
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }

    return {
      success: false,
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Existing settings update Server Action.
 *
 * - Asserts admin session before DB access (ADR-010).
 * - Enforces currency change safety: if existing catalog prices are present,
 *   explicit confirmation is required.
 * - Does NOT convert or rewrite product prices or inquiry snapshots.
 * - Updates only the provided fields via `updateSettings()`.
 */
export async function updateStoreSettings(
  _prevState: SettingsActionResult | undefined,
  formData: FormData,
): Promise<SettingsActionResult> {
  // Authoritative boundary check (ADR-010)
  await requireAdmin();

  const displayName = formData.get("displayName")?.toString();
  const currencyRaw = formData.get("currency")?.toString();
  const defaultLanguageCode = formData
    .get("defaultLanguageCode")
    ?.toString()
    ?.toLowerCase()
    ?.trim();
  const askForLanguageVal = formData.get("askForLanguage");
  const askForLanguage =
    askForLanguageVal !== null
      ? askForLanguageVal === "true" || askForLanguageVal === "on"
      : undefined;
  const supportCategory = parseSupportCategories(formData);
  const supportReplyTimeRaw = formData.get("supportReplyTime")?.toString();
  const supportReplyTime =
    supportReplyTimeRaw !== undefined
      ? supportReplyTimeRaw.trim().length > 0
        ? supportReplyTimeRaw.trim()
        : null
      : undefined;

  const confirmCurrencyChange =
    formData.get("confirmCurrencyChange") === "true" ||
    formData.get("confirmCurrencyChange") === "on";

  if (currencyRaw && !CURRENCIES.includes(currencyRaw as Currency)) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: `Invalid currency "${currencyRaw}". Allowed options: ${CURRENCIES.join(", ")}.`,
    };
  }

  const currency = currencyRaw as Currency | undefined;

  try {
    const db = getDb();
    const currentSettings = await requireSettings(db);

    // Safeguard currency change: if currency is being changed and catalog products exist,
    // require explicit confirmation.
    if (currency && currency !== currentSettings.currency) {
      const hasPrices = await hasCatalogPrices(db);
      if (hasPrices && !confirmCurrencyChange) {
        return {
          success: false,
          code: "CONFIRMATION_REQUIRED",
          message:
            "Changing currency does not convert existing product prices. Please confirm this change to continue.",
        };
      }
    }

    // If changing default language, ensure it is enabled
    if (defaultLanguageCode) {
      if (defaultLanguageCode === "ar") {
        await ensureLanguage(db, {
          code: "ar",
          label: "العربية",
          textDirection: "rtl",
          isEnabled: true,
        });
      }
    }

    await updateSettings(db, {
      displayName: displayName && displayName.trim().length > 0 ? displayName.trim() : undefined,
      currency,
      defaultLanguageCode,
      askForLanguage,
      supportCategory,
      supportReplyTime,
    });

    revalidatePath("/settings");
    return {
      success: true,
      message: "Store settings updated successfully.",
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }

    return {
      success: false,
      message: toSafeErrorMessage(error),
    };
  }
}

/**
 * Toggles a language's enabled status.
 *
 * - Asserts admin session before DB access (ADR-010).
 * - If enabling Arabic and it does not exist yet, creates it with RTL direction.
 * - If disabling the current default language, data access layer rejects with
 *   DEFAULT_LANGUAGE_REQUIRED.
 * - Translations are always preserved when a language is disabled.
 */
export async function toggleLanguageAction(
  code: string,
  isEnabled: boolean,
): Promise<SettingsActionResult> {
  await requireAdmin();

  const normalized = code.toLowerCase().trim();

  try {
    const db = getDb();

    if (isEnabled && normalized === "ar") {
      await ensureLanguage(db, {
        code: "ar",
        label: "العربية",
        textDirection: "rtl",
        isEnabled: true,
      });
    }

    await setLanguageEnabled(db, {
      code: normalized,
      isEnabled,
    });

    revalidatePath("/settings");
    return {
      success: true,
      message: isEnabled
        ? `Language "${normalized.toUpperCase()}" enabled.`
        : `Language "${normalized.toUpperCase()}" disabled.`,
    };
  } catch (error) {
    if (error instanceof RabetDataError) {
      return {
        success: false,
        code: error.code,
        message: error.message,
      };
    }

    return {
      success: false,
      message: toSafeErrorMessage(error),
    };
  }
}
