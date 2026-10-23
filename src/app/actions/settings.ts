"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { requireAdmin } from "@/lib/auth/session";
import {
  CURRENCIES,
  Currency,
  currencySchema,
  displayNameSchema,
  ensureLanguage,
  hasCatalogPrices,
  initializeSettings,
  languageCodeSchema,
  RabetDataError,
  requireSettings,
  setLanguageEnabled,
  supportReplyTimeSchema,
  toSafeErrorMessage,
  updateSettings,
} from "@/lib/data";

/**
 * Languages supported for first-time store initialization.
 */
const SUPPORTED_INITIAL_LANGUAGES = ["en", "ar"] as const;

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
 * Helper to extract boolean fields from FormData supporting hidden-input + checkbox patterns.
 *
 * Contract:
 * - If fieldName is completely omitted from FormData, returns `undefined` (crucial for partial updates).
 * - If submitted from a standard HTML form pattern:
 *     <input type="hidden" name="field" value="false" />
 *     <input type="checkbox" name="field" value="true" />
 *   - When checked: FormData has ["false", "true"]. Returns true.
 *   - When unchecked: FormData has ["false"]. Returns false.
 * - If submitted programmatically:
 *   - Direct "true" / "on" -> true
 *   - Direct "false" / "off" / "0" / "" -> false
 */
function parseBooleanField(
  formData: FormData,
  fieldName: string,
): boolean | undefined {
  if (!formData.has(fieldName)) {
    return undefined;
  }

  const values = formData
    .getAll(fieldName)
    .map((v) => v.toString().trim().toLowerCase());

  if (values.length === 0) {
    return undefined;
  }

  if (values.includes("true") || values.includes("on")) {
    return true;
  }

  return false;
}

/**
 * Helper to extract support categories from FormData.
 *
 * Contract:
 * - If neither 'supportCategory' nor 'supportCategoriesJson' is present, returns `undefined`
 *   (preserving existing categories in a partial update).
 * - If fields are present, extracts non-blank trimmed strings.
 * - If explicitly submitted with no items or empty JSON '[]', returns `[]`.
 */
function parseSupportCategories(
  formData: FormData,
): string[] | undefined {
  const hasCategoryFields =
    formData.has("supportCategory") || formData.has("supportCategoriesJson");

  if (!hasCategoryFields) {
    return undefined;
  }

  const allValues = formData.getAll("supportCategory");
  const categories: string[] = [];

  for (const val of allValues) {
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.length > 0 && !categories.includes(trimmed)) {
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
 * - Requires explicit displayName, currency, and defaultLanguageCode (no action defaults).
 * - Fully validates all input before ANY database write occurs.
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

  // Explicit values are required for initialization. Do not invent defaults.
  const rawDisplayName = formData.get("displayName");
  const rawCurrency = formData.get("currency");
  const rawDefaultLanguageCode = formData.get("defaultLanguageCode");

  if (
    rawDisplayName === null ||
    rawCurrency === null ||
    rawDefaultLanguageCode === null
  ) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message:
        "Display name, currency, and default language code are required.",
    };
  }

  const displayNameStr = rawDisplayName.toString();
  const currencyStr = rawCurrency.toString().trim();
  const defaultLanguageCodeStr = rawDefaultLanguageCode
    .toString()
    .trim()
    .toLowerCase();

  const nameResult = displayNameSchema.safeParse(displayNameStr);
  if (!nameResult.success) {
    const msg = nameResult.error.issues[0]?.message ?? "Display name is required";
    return {
      success: false,
      code: "INVALID_INPUT",
      message: msg,
      errors: {
        displayName: msg,
      },
    };
  }

  const currencyResult = currencySchema.safeParse(currencyStr);
  if (!currencyResult.success) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: `Invalid currency "${currencyStr}". Allowed options: ${CURRENCIES.join(", ")}.`,
      errors: {
        currency: `Invalid currency "${currencyStr}". Allowed options: ${CURRENCIES.join(", ")}.`,
      },
    };
  }

  const langResult = languageCodeSchema.safeParse(defaultLanguageCodeStr);
  if (
    !langResult.success ||
    !SUPPORTED_INITIAL_LANGUAGES.includes(
      defaultLanguageCodeStr as (typeof SUPPORTED_INITIAL_LANGUAGES)[number],
    )
  ) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: `Invalid or unsupported default language "${defaultLanguageCodeStr}". Allowed options: ${SUPPORTED_INITIAL_LANGUAGES.join(", ")}.`,
      errors: {
        defaultLanguageCode: `Invalid or unsupported default language "${defaultLanguageCodeStr}".`,
      },
    };
  }

  const askForLanguage = parseBooleanField(formData, "askForLanguage") ?? true;
  const supportCategory = parseSupportCategories(formData) ?? [];
  for (const cat of supportCategory) {
    if (cat.length > 60) {
      return {
        success: false,
        code: "INVALID_INPUT",
        message: "Support category cannot exceed 60 characters.",
        errors: {
          supportCategory: "Support category cannot exceed 60 characters.",
        },
      };
    }
  }

  const rawSupportReplyTime = formData.get("supportReplyTime")?.toString();
  const supportReplyTime =
    rawSupportReplyTime && rawSupportReplyTime.trim().length > 0
      ? rawSupportReplyTime.trim()
      : null;
  const replyTimeResult = supportReplyTimeSchema.safeParse(supportReplyTime);
  if (!replyTimeResult.success) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message:
        replyTimeResult.error.issues[0]?.message ?? "Support reply time is too long",
    };
  }

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
    if (defaultLanguageCodeStr === "ar") {
      await ensureLanguage(db, {
        code: "ar",
        label: "العربية",
        textDirection: "rtl",
        isEnabled: true,
      });
    }

    // Call initializeSettings with explicit owner values
    await initializeSettings(db, {
      displayName: nameResult.data,
      currency: currencyResult.data,
      defaultLanguageCode: langResult.data,
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
 * - Validates all inputs before performing any database write.
 * - Correctly handles partial updates (omitted fields) vs empty/cleared submissions.
 * - Updates only the provided fields via `updateSettings()`.
 */
export async function updateStoreSettings(
  _prevState: SettingsActionResult | undefined,
  formData: FormData,
): Promise<SettingsActionResult> {
  // Authoritative boundary check (ADR-010)
  await requireAdmin();

  // 1. Validate displayName if present
  let displayName: string | undefined;
  if (formData.has("displayName")) {
    const rawDisplayName = formData.get("displayName")?.toString() ?? "";
    const nameResult = displayNameSchema.safeParse(rawDisplayName);
    if (!nameResult.success) {
      const msg = nameResult.error.issues[0]?.message ?? "Display name is required";
      return {
        success: false,
        code: "INVALID_INPUT",
        message: msg,
        errors: {
          displayName: msg,
        },
      };
    }
    displayName = nameResult.data;
  }

  // 2. Validate currency if present
  let currency: Currency | undefined;
  if (formData.has("currency")) {
    const currencyRaw = formData.get("currency")?.toString() ?? "";
    const currencyResult = currencySchema.safeParse(currencyRaw);
    if (!currencyResult.success) {
      return {
        success: false,
        code: "INVALID_INPUT",
        message: `Invalid currency "${currencyRaw}". Allowed options: ${CURRENCIES.join(", ")}.`,
        errors: {
          currency: `Invalid currency "${currencyRaw}". Allowed options: ${CURRENCIES.join(", ")}.`,
        },
      };
    }
    currency = currencyResult.data;
  }

  // 3. Validate defaultLanguageCode if present
  let defaultLanguageCode: string | undefined;
  if (formData.has("defaultLanguageCode")) {
    const langRaw =
      formData.get("defaultLanguageCode")?.toString()?.toLowerCase()?.trim() ?? "";
    const langResult = languageCodeSchema.safeParse(langRaw);
    if (!langResult.success) {
      const msg = langResult.error.issues[0]?.message ?? "Invalid language code.";
      return {
        success: false,
        code: "INVALID_INPUT",
        message: msg,
        errors: {
          defaultLanguageCode: msg,
        },
      };
    }
    defaultLanguageCode = langResult.data;
  }

  // 4. Parse boolean askForLanguage (handles hidden "false" + checkbox "true", direct strings, or undefined if omitted)
  const askForLanguage = parseBooleanField(formData, "askForLanguage");

  // 5. Parse support categories (undefined if omitted, [] if cleared, string[] if present)
  const supportCategory = parseSupportCategories(formData);
  if (supportCategory !== undefined) {
    for (const cat of supportCategory) {
      if (cat.length > 60) {
        return {
          success: false,
          code: "INVALID_INPUT",
          message: "Support category cannot exceed 60 characters.",
          errors: {
            supportCategory: "Support category cannot exceed 60 characters.",
          },
        };
      }
    }
  }

  // 6. Support reply time (undefined if omitted, null if blank, string if provided)
  let supportReplyTime: string | null | undefined;
  if (formData.has("supportReplyTime")) {
    const rawReplyTime = formData.get("supportReplyTime")?.toString();
    supportReplyTime =
      rawReplyTime !== undefined && rawReplyTime.trim().length > 0
        ? rawReplyTime.trim()
        : null;
    const replyTimeResult = supportReplyTimeSchema.safeParse(supportReplyTime);
    if (!replyTimeResult.success) {
      const msg =
        replyTimeResult.error.issues[0]?.message ?? "Support reply time is too long";
      return {
        success: false,
        code: "INVALID_INPUT",
        message: msg,
      };
    }
  }

  const confirmCurrencyChange =
    formData.get("confirmCurrencyChange") === "true" ||
    formData.get("confirmCurrencyChange") === "on";

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
