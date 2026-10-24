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

type ParseCategoriesResult =
  | { kind: "omitted" }
  | { kind: "valid"; categories: string[] }
  | { kind: "invalid"; message: string };

/**
 * Helper to extract and strictly validate support categories from FormData.
 *
 * Contract:
 * - If neither 'supportCategory' nor 'supportCategoriesJson' is present, returns { kind: "omitted" }
 *   (preserving existing categories in a partial update).
 * - If explicitly submitted with empty JSON '[]', returns { kind: "valid", categories: [] }
 *   (clearing categories).
 * - If valid strings are submitted, trims and validates each (min 1, max 60 chars), returning { kind: "valid", categories }.
 * - If malformed JSON, wrong structure, non-string items, empty strings, strings > 60 chars,
 *   or conflicting values between representations are detected, returns { kind: "invalid", message }.
 */
function parseSupportCategories(formData: FormData): ParseCategoriesResult {
  const hasJson = formData.has("supportCategoriesJson");
  const hasFields = formData.has("supportCategory");

  if (!hasJson && !hasFields) {
    return { kind: "omitted" };
  }

  let jsonCategories: string[] | undefined;
  if (hasJson) {
    const rawJsonEntry = formData.get("supportCategoriesJson");
    if (typeof rawJsonEntry !== "string") {
      return {
        kind: "invalid",
        message: "Invalid support categories format: expected string data.",
      };
    }
    const rawJson = rawJsonEntry.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return {
        kind: "invalid",
        message: "Invalid support categories format: malformed JSON.",
      };
    }

    if (!Array.isArray(parsed)) {
      return {
        kind: "invalid",
        message: "Invalid support categories format: expected an array.",
      };
    }

    const items: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") {
        return {
          kind: "invalid",
          message: "Invalid support category: every category must be a string.",
        };
      }
      const trimmed = item.trim();
      if (trimmed.length === 0) {
        return {
          kind: "invalid",
          message: "Support category cannot be empty.",
        };
      }
      if (trimmed.length > 60) {
        return {
          kind: "invalid",
          message: "Support category cannot exceed 60 characters.",
        };
      }
      if (!items.includes(trimmed)) {
        items.push(trimmed);
      }
    }
    jsonCategories = items;
  }

  let fieldCategories: string[] | undefined;
  if (hasFields) {
    const rawFieldEntries = formData.getAll("supportCategory");
    const items: string[] = [];
    for (const entry of rawFieldEntries) {
      if (typeof entry !== "string") {
        return {
          kind: "invalid",
          message: "Invalid support category input.",
        };
      }
      const trimmed = entry.trim();
      if (trimmed.length === 0) {
        return {
          kind: "invalid",
          message: "Support category cannot be empty.",
        };
      }
      if (trimmed.length > 60) {
        return {
          kind: "invalid",
          message: "Support category cannot exceed 60 characters.",
        };
      }
      if (!items.includes(trimmed)) {
        items.push(trimmed);
      }
    }
    fieldCategories = items;
  }

  // If both representations are provided, check for conflicts
  if (jsonCategories !== undefined && fieldCategories !== undefined) {
    if (
      jsonCategories.length !== fieldCategories.length ||
      !jsonCategories.every((v, i) => v === fieldCategories[i])
    ) {
      return {
        kind: "invalid",
        message: "Conflicting support categories representations submitted.",
      };
    }
    return { kind: "valid", categories: jsonCategories };
  }

  if (jsonCategories !== undefined) {
    return { kind: "valid", categories: jsonCategories };
  }

  return { kind: "valid", categories: fieldCategories! };
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

  const categoriesResult = parseSupportCategories(formData);
  if (categoriesResult.kind === "invalid") {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: categoriesResult.message,
      errors: {
        supportCategory: categoriesResult.message,
      },
    };
  }
  const supportCategory =
    categoriesResult.kind === "valid" ? categoriesResult.categories : [];

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

  // 5. Parse support categories (undefined if omitted, [] if cleared, string[] if present, error if invalid)
  const categoriesResult = parseSupportCategories(formData);
  if (categoriesResult.kind === "invalid") {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: categoriesResult.message,
      errors: {
        supportCategory: categoriesResult.message,
      },
    };
  }
  const supportCategory =
    categoriesResult.kind === "valid" ? categoriesResult.categories : undefined;

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
